import type { Request, Response, NextFunction, Router } from 'express';
import { accountabilityIsAdmin } from '../shared/admin';
import { LIFECYCLE_DEFAULTS, normalizeLifecycleSettings } from '../shared/lifecycle';
import { loadSettings } from '../hook/settings';
import { deleteUnreferencedFiles, scanUnreferencedFiles } from './unreferenced';
import type { UnreferencedScanProgress, UnreferencedScanResult } from './unreferenced';
import {
	getUnreferencedScanFolderId,
	getUnreferencedScanSession,
	removeIdsFromUnreferencedScanSession,
	saveUnreferencedScanSession,
	UNREFERENCED_SCAN_TTL_MS,
	type UnreferencedScanSessionContext,
} from './unreferenced-scan-session';

type EndpointContext = {
	services: Record<string, any>;
	database: any;
	getSchema: () => Promise<any>;
	env: Record<string, unknown>;
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
};

function sessionContext(context: EndpointContext, req?: Request): UnreferencedScanSessionContext {
	return {
		database: context.database,
		env: context.env,
		services: context.services,
		getSchema: context.getSchema,
		accountability: (req as any)?.accountability ?? null,
		logger: context.logger,
	};
}

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

const PAGE_SIZES = new Set([25, 50, 100, 250, 500, 1000]);

function normalizePageLimit(raw: unknown): number {
	const n = Number(raw);
	if (PAGE_SIZES.has(n)) return n;
	return 25;
}

function publicScanMeta(result: UnreferencedScanResult, scanId: string) {
	const { ids: _ids, ...rest } = result.meta;
	return {
		...rest,
		scan_id: scanId,
		ids_truncated: false,
		truncated: false,
	};
}

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

async function loadFilesByIds(database: any, ids: string[]) {
	if (!ids.length) return [] as Record<string, unknown>[];
	const rows = await database('directus_files')
		.select(
			'id',
			'title',
			'filename_download',
			'filename_disk',
			'storage',
			'type',
			'filesize',
			'folder',
			'uploaded_on',
			'modified_on',
		)
		.whereIn('id', ids);
	const byId = new Map(rows.map((r: Record<string, unknown>) => [String(r.id), r]));
	return ids.map((id) => byId.get(String(id))).filter(Boolean) as Record<string, unknown>[];
}

const ALLOWED_FILE_SORT = new Set([
	'id',
	'title',
	'type',
	'filesize',
	'storage',
	'folder',
	'uploaded_on',
	'modified_on',
	'created_on',
	'filename_download',
	'filename_disk',
]);

function parseSortParam(raw: unknown): { column: string; desc: boolean } | null {
	const first = Array.isArray(raw) ? raw[0] : raw;
	if (first == null || first === '') return null;
	const token = String(first);
	const desc = token.startsWith('-');
	const column = desc ? token.slice(1) : token;
	if (!ALLOWED_FILE_SORT.has(column)) return null;
	return { column, desc };
}

function compareSortValues(a: unknown, b: unknown, desc: boolean): number {
	const emptyA = a == null || a === '';
	const emptyB = b == null || b === '';
	if (emptyA && emptyB) return 0;
	if (emptyA) return 1;
	if (emptyB) return -1;
	const na = Number(a);
	const nb = Number(b);
	if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
		return desc ? nb - na : na - nb;
	}
	const sa = String(a).toLowerCase();
	const sb = String(b).toLowerCase();
	const cmp = sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
	return desc ? -cmp : cmp;
}

/** Order session ids by a directus_files column (chunked `WHERE IN`). */
async function sortFileIds(
	database: any,
	ids: string[],
	sort: { column: string; desc: boolean },
): Promise<string[]> {
	if (!ids.length) return ids;
	const CHUNK = 500;
	const values = new Map<string, unknown>();
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const rows: Array<Record<string, unknown>> = await database('directus_files')
			.select('id', sort.column)
			.whereIn('id', chunk);
		for (const row of rows) {
			values.set(String(row.id), row[sort.column]);
		}
	}
	return [...ids].sort((a, b) => compareSortValues(values.get(a), values.get(b), sort.desc));
}

/** Sum `filesize` for the given ids (chunked `WHERE IN`). */
async function sumFilesizeByIds(database: any, ids: string[]): Promise<number> {
	if (!ids.length) return 0;
	const CHUNK = 500;
	let total = 0;
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const row = await database('directus_files').whereIn('id', chunk).sum({ total: 'filesize' }).first();
		total += Number(row?.total) || 0;
	}
	return total;
}

function parseFilterParam(raw: unknown): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Intersect scan-session IDs with Directus filter + search using ItemsService
 * (full operator support from system-filter). Chunked so `_in` stays proxy-safe.
 */
async function filterSessionIds(
	services: Record<string, any>,
	database: any,
	schema: any,
	accountability: unknown,
	sessionIds: string[],
	filter: Record<string, unknown> | null,
	search: string,
): Promise<string[]> {
	if (!filter && !search) return sessionIds;

	const ItemsService = services.ItemsService;
	if (!ItemsService) {
		throw new Error('ItemsService unavailable');
	}

	const service = new ItemsService('directus_files', {
		knex: database,
		schema,
		accountability,
	});

	const found = new Set<string>();
	const CHUNK = 500;
	const CONCURRENCY = 6;

	for (let i = 0; i < sessionIds.length; i += CHUNK * CONCURRENCY) {
		const batchStarts: number[] = [];
		for (let j = 0; j < CONCURRENCY && i + j * CHUNK < sessionIds.length; j++) {
			batchStarts.push(i + j * CHUNK);
		}

		await Promise.all(
			batchStarts.map(async (start) => {
				const chunk = sessionIds.slice(start, start + CHUNK);
				if (!chunk.length) return;

				const and: Record<string, unknown>[] = [{ id: { _in: chunk } }];
				if (filter) and.push(filter);

				const rows = await service.readByQuery({
					filter: { _and: and },
					search: search || undefined,
					fields: ['id'],
					limit: -1,
				});

				for (const row of rows || []) {
					if (row?.id != null) found.add(String(row.id));
				}
			}),
		);
	}

	return sessionIds.filter((id) => found.has(id));
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
			const session = await saveUnreferencedScanSession(sessionContext(context, req), result.meta.ids || [], {
				total_files: result.meta.total_files,
				used_count: result.meta.used_count,
				unreferenced_count: result.meta.unreferenced_count,
				unreferenced_bytes: result.meta.unreferenced_bytes || 0,
				relation_targets: result.meta.relation_targets,
				text_targets: result.meta.text_targets,
				collections_checked: result.meta.collections_checked,
				min_age_minutes: result.meta.min_age_minutes,
				scan_text_fields: result.meta.scan_text_fields,
				elapsed_ms: result.meta.elapsed_ms,
				truncated: false,
			});

			logger.info(
				`[storage-manager] unreferenced scan: files=${result.meta.total_files} used≈${result.meta.used_count} unreferenced=${result.meta.unreferenced_count} relations=${result.meta.relation_targets} text=${result.meta.text_targets} ${result.meta.elapsed_ms}ms`,
			);

			res.json({ data: result.files, meta: publicScanMeta(result, session.id) });
		} catch (error) {
			next(error);
		}
	});

	/**
	 * SSE scan with progress + heartbeats so reverse proxies do not idle-time out long runs.
	 * Final event includes `scan_id` for paged `/unreferenced/items` (ids stay server-side).
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

				const session = await saveUnreferencedScanSession(sessionContext(context, req), result.meta.ids || [], {
					total_files: result.meta.total_files,
					used_count: result.meta.used_count,
					unreferenced_count: result.meta.unreferenced_count,
					unreferenced_bytes: result.meta.unreferenced_bytes || 0,
					relation_targets: result.meta.relation_targets,
					text_targets: result.meta.text_targets,
					collections_checked: result.meta.collections_checked,
					min_age_minutes: result.meta.min_age_minutes,
					scan_text_fields: result.meta.scan_text_fields,
					elapsed_ms: result.meta.elapsed_ms,
					truncated: false,
				});

				logger.info(
					`[storage-manager] unreferenced scan (stream): files=${result.meta.total_files} used≈${result.meta.used_count} unreferenced=${result.meta.unreferenced_count} ${result.meta.elapsed_ms}ms scan_id=${session.id}`,
				);

				send({ type: 'done', data: [], meta: publicScanMeta(result, session.id) });
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

	/**
	 * Lightweight session probe for UI restore after navigation / refresh.
	 * Does not return the ID list.
	 */
	router.get('/unreferenced/sessions/:scanId', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const session = await getUnreferencedScanSession(sessionContext(context, req), String(req.params.scanId || ''));
			if (!session) {
				res.status(404).json({
					errors: [{ message: 'Scan session not found or expired — run Scan again.' }],
				});
				return;
			}

			const expiresAt = session.createdAt + UNREFERENCED_SCAN_TTL_MS;
			res.json({
				data: {
					scan_id: session.id,
					id_count: session.ids.length,
					created_at: session.createdAt,
					expires_at: expiresAt,
					meta: session.meta,
				},
			});
		} catch (error) {
			next(error);
		}
	});

	/**
	 * Page file rows for a scan session (no giant `id._in` querystrings).
	 * Optional `search` + Directus `filter` (JSON) intersect against the session ID set.
	 */
	router.get('/unreferenced/items', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const scanId = String(req.query.scan_id || '');
			const session = await getUnreferencedScanSession(sessionContext(context, req), scanId);
			if (!session) {
				res.status(404).json({
					errors: [{ message: 'Scan session not found or expired — run Scan again.' }],
				});
				return;
			}

			const page = Math.max(1, Number(req.query.page) || 1);
			const limit = normalizePageLimit(req.query.limit);
			const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
			const filter = parseFilterParam(req.query.filter);

			const schema = await getSchema();
			const filterKey = `${search}\n${JSON.stringify(filter || null)}`;
			let matchedIds: string[];

			if (!filter && !search) {
				matchedIds = session.ids;
			} else if (session.filterCache?.key === filterKey) {
				matchedIds = session.filterCache.ids;
			} else {
				matchedIds = await filterSessionIds(
					services,
					database,
					schema,
					(req as any).accountability,
					session.ids,
					filter,
					search,
				);
				session.filterCache = { key: filterKey, ids: matchedIds };
			}

			const sort = parseSortParam(req.query.sort);
			if (sort) {
				matchedIds = await sortFileIds(database, matchedIds, sort);
			}

			const total = matchedIds.length;
			const offset = (page - 1) * limit;
			const pageIds = matchedIds.slice(offset, offset + limit);
			const data = await loadFilesByIds(database, pageIds);

			let totalBytes: number;
			if (!filter && !search && typeof session.meta.unreferenced_bytes === 'number') {
				totalBytes = session.meta.unreferenced_bytes;
			} else if (session.filterCache?.key === filterKey && typeof session.filterCache.bytes === 'number') {
				totalBytes = session.filterCache.bytes;
			} else {
				totalBytes = await sumFilesizeByIds(database, matchedIds);
				if (session.filterCache?.key === filterKey) {
					session.filterCache.bytes = totalBytes;
				} else if (filter || search) {
					session.filterCache = { key: filterKey, ids: matchedIds, bytes: totalBytes };
				}
			}

			res.json({
				data,
				meta: {
					scan_id: session.id,
					total_count: total,
					filter_count: total,
					total_bytes: totalBytes,
					filtered: Boolean(filter || search),
					page,
					limit,
				},
			});
		} catch (error) {
			next(error);
		}
	});

	/** Delete selected files only if still unreferenced (refcount + text scan). */
	router.post('/unreferenced/delete', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const body = (req.body || {}) as { file_ids?: string[]; scan_text_fields?: boolean; scan_id?: string };
			const fileIds = Array.isArray(body.file_ids) ? body.file_ids.map(String).filter(Boolean) : [];

			if (!fileIds.length) {
				res.status(400).json({ errors: [{ message: 'Provide file_ids — at least one file to delete' }] });
				return;
			}

			// Match largest layout page size (select-all on one page), same as File Library UX.
			if (fileIds.length > 1000) {
				res.status(400).json({ errors: [{ message: 'Delete at most 1000 files per request' }] });
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

			const deletedIds = results.filter((r) => r.status === 'deleted').map((r) => r.id);
			if (body.scan_id && deletedIds.length) {
				await removeIdsFromUnreferencedScanSession(sessionContext(context, req), String(body.scan_id), deletedIds);
			}

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
