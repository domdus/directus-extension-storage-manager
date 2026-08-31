import type { Request, Response, NextFunction, Router } from 'express';
import { accountabilityIsAdmin } from '../shared/admin';
import { LIFECYCLE_DEFAULTS, normalizeLifecycleSettings } from '../shared/lifecycle';
import { loadSettings } from '../hook/settings';
import { deleteUnreferencedFiles, scanUnreferencedFiles } from './unreferenced';
import type { UnreferencedScanProgress, UnreferencedScanResult } from './unreferenced';

type EndpointContext = {
	services: Record<string, any>;
	database: any;
	getSchema: () => Promise<any>;
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
};

function requireAdmin(req: Request, res: Response): boolean {
	if (!accountabilityIsAdmin((req as any).accountability)) {
		res.status(403).json({ errors: [{ message: 'Admin access required', extensions: { code: 'FORBIDDEN' } }] });
		return false;
	}
	return true;
}

type ScanBody = {
	min_age_minutes?: number;
	scan_text_fields?: boolean;
	storage?: string | null;
	folder?: string | null;
	limit?: number;
	offset?: number;
};

async function resolveScanOptions(database: any, body: ScanBody) {
	const settings = await loadSettings(database);
	const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
	return {
		minAgeMinutes:
			body.min_age_minutes !== undefined ? Number(body.min_age_minutes) : lifecycle.scan_min_age_minutes,
		scanTextFields:
			body.scan_text_fields !== undefined ? Boolean(body.scan_text_fields) : lifecycle.scan_text_fields,
		storage: body.storage ?? null,
		folder: body.folder === undefined ? undefined : body.folder,
		limit: body.limit,
		offset: body.offset,
	};
}

export function registerUnreferencedRoutes(router: Router, context: EndpointContext): void {
	const { database, logger, services, getSchema } = context;

	/** Dry-run JSON (small libraries / scripting). Prefer `/unreferenced/scan/stream` in the UI. */
	router.post('/unreferenced/scan', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const body = (req.body || {}) as ScanBody;
			const options = await resolveScanOptions(database, body);
			const schema = await getSchema();
			const result = await scanUnreferencedFiles(database, schema, { ...options, logger });

			logger.info(
				`[storage-manager] unreferenced scan: files=${result.meta.total_files} used≈${result.meta.used_count} unreferenced=${result.meta.unreferenced_count} relations=${result.meta.relation_targets} text=${result.meta.text_targets} ${result.meta.elapsed_ms}ms`,
			);

			res.json({ data: result.files, meta: result.meta });
		} catch (error) {
			next(error);
		}
	});

	/**
	 * SSE scan with progress + heartbeats so reverse proxies do not idle-time out long runs.
	 */
	router.post('/unreferenced/scan/stream', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const body = (req.body || {}) as ScanBody;
			const options = await resolveScanOptions(database, body);
			const schema = await getSchema();

			res.status(200);
			res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
			res.setHeader('Cache-Control', 'no-cache, no-transform');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no');
			(res as any).flushHeaders?.();

			let closed = false;
			const markClosed = () => {
				closed = true;
			};
			req.on('close', markClosed);
			res.on('close', markClosed);

			const send = (event: Record<string, unknown>) => {
				if (closed) return;
				res.write(`data: ${JSON.stringify(event)}\n\n`);
				const flush = (res as any).flush;
				if (typeof flush === 'function') flush.call(res);
			};

			const heartbeat = setInterval(() => {
				send({ type: 'heartbeat', ts: Date.now() });
			}, 12_000);

			try {
				send({ type: 'start', message: 'Starting unreferenced scan' });

				const result: UnreferencedScanResult = await scanUnreferencedFiles(database, schema, {
					...options,
					logger,
					isCancelled: () => closed,
					onProgress: (event: UnreferencedScanProgress) => {
						send({ type: 'progress', ...event });
					},
				});

				if (closed) return;

				logger.info(
					`[storage-manager] unreferenced scan (stream): files=${result.meta.total_files} used≈${result.meta.used_count} unreferenced=${result.meta.unreferenced_count} ${result.meta.elapsed_ms}ms`,
				);

				send({ type: 'done', data: result.files, meta: result.meta });
			} catch (err) {
				send({
					type: 'error',
					message: err instanceof Error ? err.message : String(err),
				});
			} finally {
				clearInterval(heartbeat);
				if (!closed) res.end();
			}
		} catch (error) {
			if (!res.headersSent) {
				next(error);
				return;
			}
			try {
				res.write(
					`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n\n`,
				);
				res.end();
			} catch {
				// ignore
			}
		}
	});

	/** Delete selected files only if still unreferenced (refcount + text scan). */
	router.post('/unreferenced/delete', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const body = (req.body || {}) as { file_ids?: string[]; scan_text_fields?: boolean };
			const fileIds = Array.isArray(body.file_ids) ? body.file_ids.map(String).filter(Boolean) : [];

			if (!fileIds.length) {
				res.status(400).json({ errors: [{ message: 'Provide file_ids — at least one file to delete' }] });
				return;
			}

			if (fileIds.length > 500) {
				res.status(400).json({ errors: [{ message: 'Delete at most 500 files per request' }] });
				return;
			}

			const schema = await getSchema();
			const results = await deleteUnreferencedFiles(
				database,
				schema,
				services,
				(req as any).accountability,
				fileIds,
				{
					scanTextFields:
						body.scan_text_fields !== undefined ? Boolean(body.scan_text_fields) : lifecycle.scan_text_fields,
					logger,
				},
			);

			logger.info(
				`[storage-manager] unreferenced delete: total=${results.length} deleted=${results.filter((r) => r.status === 'deleted').length}`,
			);

			res.json({
				data: {
					total: results.length,
					deleted: results.filter((r) => r.status === 'deleted').length,
					skipped: results.filter((r) => r.status === 'skipped').length,
					failed: results.filter((r) => r.status === 'failed').length,
					results,
				},
			});
		} catch (error) {
			next(error);
		}
	});

	/**
	 * Delete file ids when unreferenced (used by File with Storage deselect + hooks).
	 * Same as /unreferenced/delete but intended for smaller batches from the item form.
	 */
	router.post('/files/delete-if-unreferenced', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!(req as any).accountability?.user && !accountabilityIsAdmin((req as any).accountability)) {
				res.status(403).json({
					errors: [{ message: 'Authentication required', extensions: { code: 'FORBIDDEN' } }],
				});
				return;
			}

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const body = (req.body || {}) as { file_ids?: string[]; ids?: string[] };
			const fileIds = (Array.isArray(body.file_ids) ? body.file_ids : Array.isArray(body.ids) ? body.ids : [])
				.map(String)
				.filter(Boolean);

			if (!fileIds.length) {
				res.status(400).json({ errors: [{ message: 'Provide file_ids' }] });
				return;
			}
			if (fileIds.length > 50) {
				res.status(400).json({ errors: [{ message: 'At most 50 file ids per request' }] });
				return;
			}

			const schema = await getSchema();
			const results = await deleteUnreferencedFiles(
				database,
				schema,
				services,
				(req as any).accountability,
				fileIds,
				{ scanTextFields: lifecycle.scan_text_fields, logger },
			);

			res.json({
				data: {
					total: results.length,
					deleted: results.filter((r) => r.status === 'deleted').length,
					skipped: results.filter((r) => r.status === 'skipped').length,
					failed: results.filter((r) => r.status === 'failed').length,
					results,
				},
			});
		} catch (error) {
			next(error);
		}
	});
}
