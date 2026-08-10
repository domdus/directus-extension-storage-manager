import type { Request, Response, NextFunction, Router } from 'express';
import { accountabilityIsAdmin } from '../shared/admin';
import { migrateFiles } from './migrate';
import { detectOrphans, deleteOrphans, importOrphans } from './orphans';
import {
	buildStorageLocationInfo,
	getLocationDriver,
	listConfiguredLocations,
} from './usage';
import type { MigrateMode } from '../shared/types';

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

async function collectFolderIds(database: any, rootId: string | null, recursive: boolean): Promise<string[]> {
	if (!rootId) {
		// Root = files with null folder only (non-recursive sense)
		return [];
	}

	if (!recursive) return [rootId];

	const all = await database('directus_folders').select('id', 'parent');
	const childrenMap = new Map<string | null, string[]>();
	for (const row of all) {
		const parent = row.parent == null ? null : String(row.parent);
		const id = String(row.id);
		if (!childrenMap.has(parent)) childrenMap.set(parent, []);
		childrenMap.get(parent)!.push(id);
	}

	const result: string[] = [];
	const stack = [String(rootId)];
	while (stack.length) {
		const current = stack.pop()!;
		result.push(current);
		const kids = childrenMap.get(current) || [];
		for (const kid of kids) stack.push(kid);
	}
	return result;
}

async function resolveFileIds(
	database: any,
	body: {
		file_ids?: string[];
		source_storage?: string;
		folder_id?: string | null;
		recursive?: boolean;
	},
): Promise<string[]> {
	if (Array.isArray(body.file_ids) && body.file_ids.length > 0) {
		return body.file_ids.map(String);
	}

	const query = database('directus_files').select('id');

	if (body.source_storage) {
		query.where('storage', String(body.source_storage));
	}

	if (body.folder_id !== undefined) {
		if (body.folder_id === null || body.folder_id === '') {
			query.whereNull('folder');
		} else {
			const folderIds = await collectFolderIds(database, String(body.folder_id), Boolean(body.recursive));
			if (folderIds.length === 0) {
				query.where('folder', String(body.folder_id));
			} else {
				query.whereIn('folder', folderIds);
			}
		}
	}

	const rows = await query;
	return rows.map((r: { id: string }) => String(r.id));
}

function parseFilterParam(raw: unknown): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignore
	}
	return null;
}

/** Apply a small subset of Directus filter ops used by system-filter (_eq/_neq/_null/_nnull/_contains/_in). */
function applySimpleFilter(qb: any, filter: Record<string, unknown> | null) {
	if (!filter) return;

	const applyNode = (query: any, node: Record<string, unknown>) => {
		if (node._and && Array.isArray(node._and)) {
			for (const child of node._and) {
				if (child && typeof child === 'object') applyNode(query, child as Record<string, unknown>);
			}
			return;
		}
		if (node._or && Array.isArray(node._or)) {
			query.andWhere((inner: any) => {
				for (const child of node._or as any[]) {
					if (child && typeof child === 'object') {
						inner.orWhere((branch: any) => applyNode(branch, child as Record<string, unknown>));
					}
				}
			});
			return;
		}

		for (const [field, value] of Object.entries(node)) {
			if (field.startsWith('_')) continue;
			if (!value || typeof value !== 'object') continue;
			const ops = value as Record<string, unknown>;
			if ('_eq' in ops) query.andWhere(field, ops._eq);
			if ('_neq' in ops) query.andWhereNot(field, ops._neq);
			if ('_null' in ops) query.whereNull(field);
			if ('_nnull' in ops) query.whereNotNull(field);
			if ('_contains' in ops) query.andWhere(field, 'like', `%${String(ops._contains)}%`);
			if ('_in' in ops && Array.isArray(ops._in)) query.whereIn(field, ops._in);
		}
	};

	applyNode(qb, filter);
}

export default {
	id: 'storage-manager',
	handler: (router: Router, context: EndpointContext) => {
		const { database, env, logger } = context;

		router.get('/storages', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const locations = listConfiguredLocations(env);
				const storages = await Promise.all(locations.map((loc) => buildStorageLocationInfo(env, database, loc)));

				res.json({ data: storages });
			} catch (error) {
				next(error);
			}
		});

		router.get('/storages/:location', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}

				const info = await buildStorageLocationInfo(env, database, location);
				res.json({ data: info });
			} catch (error) {
				next(error);
			}
		});

		/** List files present on the storage disk but missing from directus_files.filename_disk. */
		router.get('/storages/:location/orphans', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}

				const result = await detectOrphans(database, location, env);
				res.json({
					data: result.orphans,
					meta: {
						scanned: result.scanned,
						known: result.known,
						orphan_count: result.orphans.length,
					},
				});
			} catch (error) {
				next(error);
			}
		});

		/** Create directus_files rows for orphan disk objects (file already on disk — no upload). */
		router.post('/storages/:location/import-orphans', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}

				const body = (req.body || {}) as { filename_disks?: string[]; folder?: string | null };
				let filenameDisks = Array.isArray(body.filename_disks) ? body.filename_disks.map(String) : [];

				if (filenameDisks.length === 0) {
					const detected = await detectOrphans(database, location, env);
					filenameDisks = detected.orphans.map((o) => o.filename_disk);
				}

				if (filenameDisks.length === 0) {
					res.json({
						data: {
							total: 0,
							imported: 0,
							skipped: 0,
							failed: 0,
							results: [],
						},
					});
					return;
				}

				const results = await importOrphans(database, location, filenameDisks, {
					folder: body.folder === undefined ? null : body.folder,
				});

				logger.info(
					`[storage-manager] import-orphans location=${location} total=${results.length} imported=${results.filter((r) => r.status === 'imported').length}`,
				);

				res.json({
					data: {
						total: results.length,
						imported: results.filter((r) => r.status === 'imported').length,
						skipped: results.filter((r) => r.status === 'skipped').length,
						failed: results.filter((r) => r.status === 'failed').length,
						results,
					},
				});
			} catch (error) {
				next(error);
			}
		});

		/** Permanently delete orphan disk objects (not in directus_files). Thumbnails are skipped. */
		router.post('/storages/:location/delete-orphans', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}

				const body = (req.body || {}) as { filename_disks?: string[] };
				const filenameDisks = Array.isArray(body.filename_disks)
					? body.filename_disks.map(String).filter(Boolean)
					: [];

				if (filenameDisks.length === 0) {
					res.status(400).json({
						errors: [{ message: 'Provide filename_disks — at least one orphan to delete' }],
					});
					return;
				}

				const results = await deleteOrphans(database, location, filenameDisks);

				logger.info(
					`[storage-manager] delete-orphans location=${location} total=${results.length} deleted=${results.filter((r) => r.status === 'deleted').length}`,
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

		router.get('/files', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const storage = req.query.storage ? String(req.query.storage) : null;
				const folder = req.query.folder !== undefined ? (req.query.folder === 'null' || req.query.folder === '' ? null : String(req.query.folder)) : undefined;
				const search = req.query.search ? String(req.query.search).trim() : '';
				const filter = parseFilterParam(req.query.filter);
				const recursive = String(req.query.recursive || '') === 'true';
				const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
				const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
				const sort = String(req.query.sort || '-uploaded_on');

				const base = database('directus_files').select(
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
				);

				if (storage) base.where('storage', storage);

				if (folder !== undefined) {
					if (folder === null) {
						base.whereNull('folder');
					} else if (recursive) {
						const folderIds = await collectFolderIds(database, folder, true);
						base.whereIn('folder', folderIds);
					} else {
						base.where('folder', folder);
					}
				}

				if (search) {
					const like = `%${search.replace(/[%_]/g, '\\$&')}%`;
					base.andWhere((qb: any) => {
						qb.where('title', 'like', like)
							.orWhere('filename_download', 'like', like)
							.orWhere('filename_disk', 'like', like);
					});
				}

				applySimpleFilter(base, filter);

				const countQuery = base.clone().clearSelect().count({ count: '*' }).first();
				const sumQuery = base.clone().clearSelect().sum({ total_bytes: 'filesize' }).first();

				const sortField = sort.startsWith('-') ? sort.slice(1) : sort;
				const sortDir = sort.startsWith('-') ? 'desc' : 'asc';
				const allowedSort = new Set([
					'uploaded_on',
					'modified_on',
					'filename_download',
					'filesize',
					'title',
					'storage',
					'type',
				]);
				const safeSort = allowedSort.has(sortField) ? sortField : 'uploaded_on';

				const rows = await base
					.clone()
					.orderBy(safeSort, sortDir)
					.limit(limit)
					.offset((page - 1) * limit);

				const countRow = await countQuery;
				const sumRow = await sumQuery;
				const total = Number((countRow as any)?.count || 0);
				const total_bytes = Number((sumRow as any)?.total_bytes || 0);

				res.json({
					data: rows,
					meta: {
						total_count: total,
						filter_count: total,
						total_bytes,
						page,
						limit,
					},
				});
			} catch (error) {
				next(error);
			}
		});

		router.get('/folders', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const parent =
					req.query.parent === undefined
						? undefined
						: req.query.parent === 'null' || req.query.parent === ''
							? null
							: String(req.query.parent);

				const storageFilter = req.query.storage ? String(req.query.storage) : null;

				let foldersQuery = database('directus_folders').select('id', 'name', 'parent').orderBy('name', 'asc');
				if (parent === null) {
					foldersQuery = foldersQuery.whereNull('parent');
				} else if (parent !== undefined) {
					foldersQuery = foldersQuery.where('parent', parent);
				}

				const folders = await foldersQuery;

				const result = [];
				for (const folder of folders) {
					const id = String(folder.id);

					let filesQuery = database('directus_files').where('folder', id);
					if (storageFilter) filesQuery = filesQuery.andWhere('storage', storageFilter);

					const agg = await filesQuery
						.select(
							database.raw('count(*) as file_count'),
							database.raw('coalesce(sum(filesize), 0) as total_bytes'),
						)
						.first();

					const childCountRow = await database('directus_folders')
						.where('parent', id)
						.count({ count: '*' })
						.first();

					result.push({
						id,
						name: folder.name,
						parent: folder.parent == null ? null : String(folder.parent),
						file_count: Number(agg?.file_count || 0),
						total_bytes: Number(agg?.total_bytes || 0),
						child_count: Number(childCountRow?.count || 0),
					});
				}

				// Root files summary when listing root
				let root_files = null;
				if (parent === null || parent === undefined) {
					let rootQuery = database('directus_files').whereNull('folder');
					if (storageFilter) rootQuery = rootQuery.andWhere('storage', storageFilter);
					const rootAgg = await rootQuery
						.select(
							database.raw('count(*) as file_count'),
							database.raw('coalesce(sum(filesize), 0) as total_bytes'),
						)
						.first();
					root_files = {
						file_count: Number(rootAgg?.file_count || 0),
						total_bytes: Number(rootAgg?.total_bytes || 0),
					};
				}

				res.json({ data: result, meta: { root_files } });
			} catch (error) {
				next(error);
			}
		});

		/** Flat folder list for building the left-nav tree (id, name, parent only). */
		router.get('/folders/tree', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const rows = await database('directus_folders').select('id', 'name', 'parent').orderBy('name', 'asc');
				const data = rows.map((row: { id: string; name: string; parent: string | null }) => ({
					id: String(row.id),
					name: row.name,
					parent: row.parent == null ? null : String(row.parent),
				}));

				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		router.get('/folders/:id/path', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const id = String(req.params.id);
				const path: Array<{ id: string; name: string }> = [];
				let current: string | null = id;

				for (let i = 0; i < 50 && current; i++) {
					const row = await database('directus_folders').select('id', 'name', 'parent').where({ id: current }).first();
					if (!row) break;
					path.unshift({ id: String(row.id), name: row.name });
					current = row.parent == null ? null : String(row.parent);
				}

				res.json({ data: path });
			} catch (error) {
				next(error);
			}
		});

		router.post('/migrate', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const body = (req.body || {}) as {
					target_storage?: string;
					mode?: MigrateMode;
					file_ids?: string[];
					source_storage?: string;
					folder_id?: string | null;
					recursive?: boolean;
					concurrency?: number;
				};

				const target = String(body.target_storage || '').trim();
				const mode = body.mode === 'copy' ? 'copy' : body.mode === 'move' ? 'move' : null;

				if (!target || !mode) {
					res.status(400).json({
						errors: [{ message: 'target_storage and mode ("copy"|"move") are required' }],
					});
					return;
				}

				const locations = listConfiguredLocations(env);
				if (!locations.includes(target)) {
					res.status(400).json({
						errors: [{ message: `Unknown target storage: ${target}. Available: ${locations.join(', ')}` }],
					});
					return;
				}

				// Validate driver exists
				getLocationDriver(env, target);

				if (body.source_storage && !locations.includes(String(body.source_storage))) {
					res.status(400).json({
						errors: [{ message: `Unknown source storage: ${body.source_storage}` }],
					});
					return;
				}

				const hasSelection =
					(Array.isArray(body.file_ids) && body.file_ids.length > 0) ||
					Boolean(body.source_storage) ||
					body.folder_id !== undefined;

				if (!hasSelection) {
					res.status(400).json({
						errors: [
							{
								message:
									'Provide file_ids, source_storage, and/or folder_id to select files to migrate',
							},
						],
					});
					return;
				}

				const fileIds = await resolveFileIds(database, body);

				if (fileIds.length === 0) {
					res.json({
						data: {
							mode,
							target_storage: target,
							total: 0,
							succeeded: 0,
							skipped: 0,
							failed: 0,
							results: [],
						},
					});
					return;
				}

				// Safety cap for interactive requests
				const MAX = 5000;
				if (fileIds.length > MAX) {
					res.status(400).json({
						errors: [
							{
								message: `Selection contains ${fileIds.length} files (max ${MAX} per request). Narrow the selection or run in batches.`,
							},
						],
					});
					return;
				}

				logger.info(
					`[storage-manager] Starting ${mode} of ${fileIds.length} file(s) → ${target} (by ${(req as any).accountability?.user || 'unknown'})`,
				);

				const result = await migrateFiles({
					fileIds,
					targetStorage: target,
					mode,
					concurrency: body.concurrency,
					database,
					logger,
				});

				res.json({ data: result });
			} catch (error) {
				next(error);
			}
		});

		/**
		 * SSE progress stream for interactive migrations.
		 * Emits `data: {json}\\n\\n` events until `done` or `error`.
		 */
		router.post('/migrate/stream', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const body = (req.body || {}) as {
					target_storage?: string;
					mode?: MigrateMode;
					file_ids?: string[];
					source_storage?: string;
					folder_id?: string | null;
					recursive?: boolean;
					concurrency?: number;
				};

				const target = String(body.target_storage || '').trim();
				const mode = body.mode === 'copy' ? 'copy' : body.mode === 'move' ? 'move' : null;

				if (!target || !mode) {
					res.status(400).json({
						errors: [{ message: 'target_storage and mode ("copy"|"move") are required' }],
					});
					return;
				}

				const locations = listConfiguredLocations(env);
				if (!locations.includes(target)) {
					res.status(400).json({
						errors: [{ message: `Unknown target storage: ${target}. Available: ${locations.join(', ')}` }],
					});
					return;
				}

				getLocationDriver(env, target);

				if (body.source_storage && !locations.includes(String(body.source_storage))) {
					res.status(400).json({
						errors: [{ message: `Unknown source storage: ${body.source_storage}` }],
					});
					return;
				}

				const hasSelection =
					(Array.isArray(body.file_ids) && body.file_ids.length > 0) ||
					Boolean(body.source_storage) ||
					body.folder_id !== undefined;

				if (!hasSelection) {
					res.status(400).json({
						errors: [
							{
								message:
									'Provide file_ids, source_storage, and/or folder_id to select files to migrate',
							},
						],
					});
					return;
				}

				const fileIds = await resolveFileIds(database, body);
				const MAX = 5000;
				if (fileIds.length > MAX) {
					res.status(400).json({
						errors: [
							{
								message: `Selection contains ${fileIds.length} files (max ${MAX} per request). Narrow the selection or run in batches.`,
							},
						],
					});
					return;
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
					// Encourage proxies to flush
					const flush = (res as any).flush;
					if (typeof flush === 'function') flush.call(res);
				};

				logger.info(
					`[storage-manager] Streaming ${mode} of ${fileIds.length} file(s) → ${target} (by ${(req as any).accountability?.user || 'unknown'})`,
				);

				try {
					await migrateFiles({
						fileIds,
						targetStorage: target,
						mode,
						// Sequential gives clearer File N/M UX; still allow override
						concurrency: body.concurrency ?? 1,
						database,
						logger,
						isCancelled: () => closed,
						onProgress: (event) => send(event as unknown as Record<string, unknown>),
					});
				} catch (err) {
					send({
						type: 'error',
						message: err instanceof Error ? err.message : String(err),
					});
				}

				if (!closed) {
					res.end();
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
	},
};
