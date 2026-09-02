import type { Request, Response, NextFunction, Router } from 'express';
import { accountabilityIsAdmin } from '../shared/admin';
import {
	createRecyclePurgeFlow,
	disableRecycle,
	enableRecycle,
	getRecycleStatus,
	moveFilesToRecycle,
	purgeExpiredRecycle,
	removeRecyclePurgeFlow,
	restoreFilesFromRecycle,
	restoreRecycleFilesBulk,
	type RecycleContext,
} from './recycle';
import { listConfiguredLocations } from './usage';
import { RECYCLE_DEFAULT_FOLDER_NAME, RECYCLE_DEFAULTS, RECYCLE_PURGE_FLOW_CRON } from '../shared/recycle';

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

function requireAdmin(req: Request, res: Response): boolean {
	if (!accountabilityIsAdmin((req as any).accountability)) {
		res.status(403).json({ errors: [{ message: 'Admin access required', extensions: { code: 'FORBIDDEN' } }] });
		return false;
	}
	return true;
}

function recycleCtx(context: EndpointContext, req?: Request): RecycleContext {
	return {
		database: context.database,
		env: context.env,
		services: context.services,
		getSchema: context.getSchema,
		accountability: (req as any)?.accountability ?? { admin: true },
		logger: context.logger,
	};
}

function parseIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.map(String).filter(Boolean))];
}

export function registerRecycleRoutes(router: Router, context: EndpointContext): void {
	router.get('/recycle', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			// Avoid 304/ETag reuse of a prior “enabled: false” payload after enable.
			res.set('Cache-Control', 'no-store');
			const status = await getRecycleStatus(recycleCtx(context, req));
			res.json({ data: status });
		} catch (error) {
			next(error);
		}
	});

	router.post('/recycle/enable', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			const body = (req.body || {}) as {
				folder_id?: string | null;
				folder_name?: string;
				retention_days?: number;
			};
			const recycle = await enableRecycle(recycleCtx(context, req), {
				folder_id: body.folder_id,
				folder_name: body.folder_name || RECYCLE_DEFAULT_FOLDER_NAME,
				retention_days: body.retention_days,
			});
			const status = await getRecycleStatus(recycleCtx(context, req));
			res.json({ data: { ...status, ...recycle } });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Failed to enable Recycle Bin' }],
			});
		}
	});

	router.post('/recycle/disable', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			await disableRecycle(recycleCtx(context, req));
			const status = await getRecycleStatus(recycleCtx(context, req));
			res.json({ data: status });
		} catch (error) {
			next(error);
		}
	});

	router.patch('/recycle', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			const body = (req.body || {}) as {
				retention_days?: number;
				folder_id?: string | null;
			};
			const { loadSettings, saveSettings } = await import('../hook/settings');
			const { normalizeRecycleSettings } = await import('../shared/recycle');
			const settings = await loadSettings(context.database);
			const current = normalizeRecycleSettings(settings.recycle);
			if (!current.enabled) {
				res.status(400).json({ errors: [{ message: 'Recycle Bin is not enabled' }] });
				return;
			}

			let folderId = current.folder_id;
			if (body.folder_id !== undefined) {
				if (!body.folder_id) {
					res.status(400).json({ errors: [{ message: 'folder_id is required when changing folder' }] });
					return;
				}
				const row = await context.database('directus_folders').select('id').where({ id: body.folder_id }).first();
				if (!row?.id) {
					res.status(400).json({ errors: [{ message: 'Selected folder was not found' }] });
					return;
				}
				folderId = String(row.id);
			}

			const next = normalizeRecycleSettings({
				...current,
				folder_id: folderId,
				retention_days:
					body.retention_days !== undefined ? body.retention_days : current.retention_days,
				purge_flow_id: current.purge_flow_id,
			});
			next.enabled = true;
			await saveSettings(context.database, { ...settings, recycle: next });
			const { setCachedRecycleFolderId } = await import('../hook/settings');
			setCachedRecycleFolderId(next.folder_id);

			const status = await getRecycleStatus(recycleCtx(context, req));
			res.json({ data: status });
		} catch (error) {
			next(error);
		}
	});

	router.post('/recycle/move', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			const ids = parseIds((req.body as any)?.file_ids);
			if (!ids.length) {
				res.status(400).json({ errors: [{ message: 'file_ids is required' }] });
				return;
			}
			const result = await moveFilesToRecycle(recycleCtx(context, req), ids);

			// Keep unreferenced scan session in sync when caller passes scan_id.
			const scanId = (req.body as any)?.scan_id ? String((req.body as any).scan_id) : null;
			if (scanId && ids.length) {
				try {
					const { removeIdsFromUnreferencedScanSession } = await import('./unreferenced-scan-session');
					await removeIdsFromUnreferencedScanSession(
						{
							database: context.database,
							env: context.env,
							services: context.services,
							getSchema: context.getSchema,
							accountability: (req as any)?.accountability ?? null,
							logger: context.logger,
						},
						scanId,
						ids,
					);
				} catch {
					/* best-effort */
				}
			}

			res.json({ data: result });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Move to Recycle failed' }],
			});
		}
	});

	/**
	 * Lifecycle helper: move to Recycle only when still unreferenced.
	 * Soft-skips when Recycle Bin is off (does not fail the request).
	 * Authenticated users (not only admins) — same bar as delete-if-unreferenced.
	 */
	router.post('/recycle/move-if-unreferenced', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!(req as any).accountability?.user && !accountabilityIsAdmin((req as any).accountability)) {
				res.status(403).json({
					errors: [{ message: 'Authentication required', extensions: { code: 'FORBIDDEN' } }],
				});
				return;
			}
			const ids = parseIds((req.body as any)?.file_ids ?? (req.body as any)?.ids);
			if (!ids.length) {
				res.status(400).json({ errors: [{ message: 'Provide file_ids' }] });
				return;
			}
			if (ids.length > 50) {
				res.status(400).json({ errors: [{ message: 'At most 50 file ids per request' }] });
				return;
			}
			const { moveFilesToRecycleIfUnreferenced } = await import('./recycle');
			const result = await moveFilesToRecycleIfUnreferenced(recycleCtx(context, req), ids);
			res.json({ data: result });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Move to Recycle failed' }],
			});
		}
	});

	router.post('/recycle/restore', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			const ids = parseIds((req.body as any)?.file_ids);
			if (!ids.length) {
				res.status(400).json({ errors: [{ message: 'file_ids is required' }] });
				return;
			}
			const result = await restoreFilesFromRecycle(recycleCtx(context, req), ids);
			res.json({ data: result });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Restore failed' }],
			});
		}
	});

	/**
	 * SSE: restore every Recycle file (optional `storage` filter) in chunks.
	 * Safe for hundreds of thousands of rows — IDs stay on the server.
	 */
	router.post('/recycle/restore/stream', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;

			const body = (req.body || {}) as { storage?: string | null };
			const storageRaw = body.storage == null || body.storage === '' ? null : String(body.storage);
			if (storageRaw) {
				const locations = listConfiguredLocations(context.env);
				if (!locations.includes(storageRaw)) {
					res.status(400).json({
						errors: [{ message: `Unknown storage “${storageRaw}”` }],
					});
					return;
				}
			}

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
				send({
					type: 'start',
					message: storageRaw
						? `Restoring Recycle files on ${storageRaw}…`
						: 'Restoring Recycle files…',
					storage: storageRaw,
				});

				const result = await restoreRecycleFilesBulk(recycleCtx(context, req), {
					storage: storageRaw,
					isCancelled: () => closed,
					onProgress: (progress) => {
						send({ type: 'progress', ...progress });
					},
				});

				context.logger.info(
					`[storage-manager] recycle restore stream: restored=${result.restored} failed=${result.failed} total=${result.total} cancelled=${result.cancelled} storage=${storageRaw || '*'}`,
				);

				send({
					type: result.cancelled ? 'cancelled' : 'done',
					data: result,
				});
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
					`data: ${JSON.stringify({
						type: 'error',
						message: error instanceof Error ? error.message : String(error),
					})}\n\n`,
				);
				res.end();
			} catch {
				// ignore
			}
		}
	});

	router.post('/recycle/purge', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			const body = (req.body || {}) as {
				older_than_days?: number;
				dry_run?: boolean;
			};
			const result = await purgeExpiredRecycle(recycleCtx(context, req), {
				older_than_days: body.older_than_days,
				dry_run: Boolean(body.dry_run),
			});
			res.json({ data: result });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Purge failed' }],
			});
		}
	});

	router.post('/recycle/purge-flow', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			const flow = await createRecyclePurgeFlow(recycleCtx(context, req));
			const status = await getRecycleStatus(recycleCtx(context, req));
			res.json({ data: { ...status, purge_flow: flow } });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Failed to create purge Flow' }],
			});
		}
	});

	router.delete('/recycle/purge-flow', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			await removeRecyclePurgeFlow(recycleCtx(context, req));
			const status = await getRecycleStatus(recycleCtx(context, req));
			res.json({ data: status });
		} catch (error: any) {
			res.status(400).json({
				errors: [{ message: error?.message || 'Failed to remove purge Flow' }],
			});
		}
	});

	// Convenience defaults for UI forms.
	router.get('/recycle/defaults', async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (!requireAdmin(req, res)) return;
			res.json({
				data: {
					...RECYCLE_DEFAULTS,
					folder_name: RECYCLE_DEFAULT_FOLDER_NAME,
					purge_cron: RECYCLE_PURGE_FLOW_CRON,
				},
			});
		} catch (error) {
			next(error);
		}
	});
}
