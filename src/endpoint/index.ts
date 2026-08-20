import type { Request, Response, NextFunction, Router } from 'express';
import { accountabilityIsAdmin } from '../shared/admin';
import { migrateFiles } from './migrate';
import { detectOrphans, deleteOrphans, importOrphans } from './orphans';
import {
	buildStorageLocationInfo,
	getLocationDriver,
	listConfiguredLocations,
	aggregateFileUsageGrouped,
} from './usage';
import {
	browseStorageFolders,
	browseStorageFolderTree,
	copyEmptyStorageFolders,
	createStorageFolder,
	deleteStorageFolders,
	ensureFileUnderPath,
	joinStoragePath,
	listEmptyStorageFolders,
	listStorageFolderPaths,
	moveFilesToStoragePath,
	moveStorageFolder,
	normalizeStoragePath,
	relocateFolderPath,
	relocateStorageFolder,
	relocateUnderTargetPath,
	renameStorageFolder,
} from './physical-folders';
import type { MigrateMode, StorageManagerSettings, StorageLocationSettings } from '../shared/types';
import { STORAGE_MANAGER_FIELD, STORAGE_MANAGER_LOCATION_DEFAULTS } from '../shared/types';
import { ensureSettingsField, getLocationSettings, invalidateSettingsCache, loadSettings } from '../hook/settings';
import { isDirectusFolderMirrorEnabled } from '../hook/prefix';
import { materializeDryRun, materializeRun } from './materialize';
import { checkForUpdates } from './update-check';

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
		source_path?: string;
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

	const sourcePath = body.source_path != null ? normalizeStoragePath(String(body.source_path)) : '';
	if (sourcePath) {
		if (!body.source_storage) {
			return [];
		}
		const prefix = `${sourcePath}/`;
		if (body.recursive === false) {
			// Immediate files only: under prefix, but not in nested subfolders.
			query.where('filename_disk', 'like', `${prefix}%`).whereNot('filename_disk', 'like', `${prefix}%/%`);
		} else {
			query.where('filename_disk', 'like', `${prefix}%`);
		}
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
		const { database, env, logger, services, getSchema } = context;

		router.use(async (_req: Request, _res: Response, next: NextFunction) => {
			try {
				await ensureSettingsField(database, services, getSchema, logger);
				next();
			} catch (error) {
				next(error);
			}
		});

		router.get('/storages', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const locations = listConfiguredLocations(env);
				const settings = await loadSettings(database);
				const usageByLocation = await aggregateFileUsageGrouped(database, locations);
				const storages = await Promise.all(
					locations.map(async (loc) => {
						const info = await buildStorageLocationInfo(env, database, loc, usageByLocation.get(loc));
						info.mirror_directus_folders = isDirectusFolderMirrorEnabled(getLocationSettings(settings, loc));
						return info;
					}),
				);

				res.json({ data: storages });
			} catch (error) {
				next(error);
			}
		});

		router.get('/update-check', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const force = String(req.query.force || '') === '1';
				const data = await checkForUpdates(force);
				res.json({ data });
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
				const settings = await loadSettings(database);
				info.mirror_directus_folders = isDirectusFolderMirrorEnabled(getLocationSettings(settings, location));
				res.json({ data: info });
			} catch (error) {
				next(error);
			}
		});

		/** Browse immediate storage folders under a path. */
		router.get('/storages/:location/browse', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const parentPath = normalizeStoragePath(String(req.query.path || ''));
				const data = await browseStorageFolders(database, location, parentPath, env);
				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		/** Full nested folder tree for left-nav (parity with Directus Folders). */
		router.get('/storages/:location/folder-tree', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const data = await browseStorageFolderTree(database, location, env);
				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		/** Create a storage folder (local mkdir / cloud .keep). */
		router.post('/storages/:location/folders', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const body = (req.body || {}) as { name?: string; parent_path?: string };
				const data = await createStorageFolder(
					location,
					String(body.name || ''),
					String(body.parent_path || ''),
					env,
				);
				res.json({ data });
			} catch (error: any) {
				if (error?.message && /required|Invalid|cannot contain/i.test(error.message)) {
					res.status(400).json({ errors: [{ message: error.message }] });
					return;
				}
				next(error);
			}
		});

		/** Delete storage folders (move contents up, or delete all registered content). */
		router.delete('/storages/:location/folders', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const body = (req.body || {}) as { paths?: string[]; mode?: string };
				const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
				if (!paths.length) {
					res.status(400).json({ errors: [{ message: 'Provide paths — at least one storage folder to delete' }] });
					return;
				}
				const mode = body.mode === 'delete' ? 'delete' : 'move';
				let filesService: { deleteMany: (keys: string[]) => Promise<unknown> } | undefined;
				try {
					const schema = await context.getSchema();
					const FilesService = context.services.FilesService;
					if (FilesService) {
						filesService = new FilesService({
							accountability: (req as any).accountability,
							schema,
						});
					}
				} catch {
					filesService = undefined;
				}
				const data = await deleteStorageFolders(database, location, paths, env, logger, {
					mode,
					filesService,
				});
				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		/** Rename or move a storage folder (path rewrite for all nested registered files). */
		router.patch('/storages/:location/folders', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const body = (req.body || {}) as { path?: string; name?: string; parent_path?: string };
				const folderPath = String(body.path || '');
				if (!folderPath) {
					res.status(400).json({ errors: [{ message: 'Provide path — the storage folder to update' }] });
					return;
				}

				const hasName = body.name !== undefined && body.name !== null;
				const hasParent = Object.prototype.hasOwnProperty.call(body, 'parent_path');
				if (!hasName && !hasParent) {
					res.status(400).json({
						errors: [{ message: 'Provide name (rename) and/or parent_path (move)' }],
					});
					return;
				}

				let data: { path: string; moved: number; failed: number };
				if (hasName && hasParent) {
					const name = String(body.name || '').trim();
					const to = joinStoragePath(String(body.parent_path ?? ''), name);
					data = await relocateStorageFolder(database, location, folderPath, to, env, logger);
				} else if (hasName) {
					data = await renameStorageFolder(database, location, folderPath, String(body.name || ''), env, logger);
				} else {
					data = await moveStorageFolder(
						database,
						location,
						folderPath,
						String(body.parent_path ?? ''),
						env,
						logger,
					);
				}
				res.json({ data });
			} catch (error: any) {
				if (error?.message && /required|Invalid|cannot|already exists|Failed to relocate/i.test(error.message)) {
					res.status(400).json({ errors: [{ message: error.message }] });
					return;
				}
				next(error);
			}
		});

		/** Move registered files into a storage folder path (same adapter). */
		router.post('/storages/:location/move-files', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const body = (req.body || {}) as {
					file_ids?: string[];
					target_path?: string;
					source_folders?: string[];
					include_empty_folders?: boolean;
					source_storage?: string;
					preserve_paths?: boolean;
				};
				const fileIds = Array.isArray(body.file_ids) ? body.file_ids.map(String) : [];
				const sourceFolders = Array.isArray(body.source_folders) ? body.source_folders.map(String) : [];
				if (!fileIds.length && !sourceFolders.length && !body.source_storage) {
					res.status(400).json({ errors: [{ message: 'Provide file_ids or source_folders' }] });
					return;
				}
				const data = fileIds.length
					? await moveFilesToStoragePath(
							database,
							location,
							fileIds,
							String(body.target_path ?? ''),
							logger,
							env,
							sourceFolders,
							Boolean(body.preserve_paths),
						)
					: { moved: 0, failed: 0, skipped: 0, results: [] };
				if (body.include_empty_folders !== false && (sourceFolders.length || body.source_storage)) {
					await copyEmptyStorageFolders({
						database,
						sourceLocation: String(body.source_storage || location),
						targetLocation: location,
						env,
						targetPath: String(body.target_path ?? ''),
						sourceFolders: sourceFolders.length ? sourceFolders : undefined,
						removeSource: true,
						logger,
					});
				}
				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		/** Place an already-uploaded file under a storage path (post-upload rename). */
		router.post('/storages/:location/place-file', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const location = String(req.params.location);
				const locations = listConfiguredLocations(env);
				if (!locations.includes(location)) {
					res.status(404).json({ errors: [{ message: `Unknown storage location: ${location}` }] });
					return;
				}
				const body = (req.body || {}) as { file_id?: string; target_path?: string };
				if (!body.file_id) {
					res.status(400).json({ errors: [{ message: 'Provide file_id' }] });
					return;
				}
				const filename_disk = await ensureFileUnderPath(
					database,
					String(body.file_id),
					location,
					String(body.target_path || ''),
				);
				res.json({ data: { id: body.file_id, filename_disk } });
			} catch (error: any) {
				res.status(400).json({ errors: [{ message: error?.message || 'Place file failed' }] });
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

				const pathFilter = typeof req.query.path === 'string' ? req.query.path : '';
				const result = await detectOrphans(database, location, env, pathFilter);
				res.json({
					data: result.orphans,
					meta: {
						scanned: result.scanned,
						known: result.known,
						orphan_count: result.orphans.length,
						path: result.path || null,
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

				const body = (req.body || {}) as { filename_disks?: string[]; folder?: string | null; path?: string };
				let filenameDisks = Array.isArray(body.filename_disks) ? body.filename_disks.map(String) : [];

				if (filenameDisks.length === 0) {
					const detected = await detectOrphans(database, location, env, body.path || '');
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

		/** Dry-run: count files, folders, and destination conflicts without moving anything. */
		router.post('/migrate/dry-run', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;

				const body = (req.body || {}) as {
					target_storage?: string;
					target_path?: string;
					preserve_paths?: boolean;
					source_folders?: string[];
					file_ids?: string[];
					source_storage?: string;
					source_path?: string;
					folder_id?: string | null;
					recursive?: boolean;
				};

				const target = String(body.target_storage || '').trim();
				const locations = listConfiguredLocations(env);
				if (!target || !locations.includes(target)) {
					res.status(400).json({ errors: [{ message: 'Provide a valid target_storage' }] });
					return;
				}

				const targetPath = body.target_path != null ? String(body.target_path) : '';
				const preservePaths = Boolean(body.preserve_paths);
				const sourceFolders = Array.isArray(body.source_folders) ? body.source_folders.map(String) : [];
				const fileIds = await resolveFileIds(database, body);

				const rows: Array<{
					id: string;
					storage: string;
					filesize: number | null;
					filename_disk: string | null;
				}> = fileIds.length
					? await database('directus_files')
						.select('id', 'storage', 'filesize', 'filename_disk')
						.whereIn('id', fileIds)
					: [];

				const destFolders = new Set<string>();
				const samples: Array<{ from: string; to: string; skipped: boolean }> = [];
				const planned = rows.map((row) => {
					const from = String(row.filename_disk || '');
					const to = relocateUnderTargetPath(from, targetPath, sourceFolders, preservePaths);
					const dir = normalizeStoragePath(to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '');
					if (dir) destFolders.add(dir);
					return { id: String(row.id), storage: String(row.storage), from, to };
				});

				const destKeys = [...new Set(planned.map((p) => p.to).filter(Boolean))];
				const occupants = destKeys.length
					? await database('directus_files')
						.select('id', 'filename_disk')
						.where({ storage: target })
						.whereIn('filename_disk', destKeys)
					: [];
				const occupantByPath = new Map<string, string>();
				for (const occupant of occupants) {
					occupantByPath.set(String(occupant.filename_disk), String(occupant.id));
				}

				let skipped = 0;
				for (const item of planned) {
					const occupantId = occupantByPath.get(item.to);
					const isSkipped = Boolean(occupantId && occupantId !== item.id);
					if (isSkipped) skipped += 1;
					if (samples.length < 20) {
						samples.push({
							from: `${item.storage}:${item.from}`,
							to: `${target}:${item.to}`,
							skipped: isSkipped,
						});
					}
				}

				let empty_folders = 0;
				const sourceStorage = body.source_storage ? String(body.source_storage) : '';
				if (sourceStorage && locations.includes(sourceStorage)) {
					const sourcePath = body.source_path != null ? normalizeStoragePath(String(body.source_path)) : '';
					const empty = (await listEmptyStorageFolders(database, sourceStorage, env)).filter((p) => {
						if (sourceFolders.length) {
							return sourceFolders.some((f) => {
								const prefix = normalizeStoragePath(f);
								return p === prefix || p.startsWith(`${prefix}/`);
							});
						}
						if (sourcePath) return p === sourcePath || p.startsWith(`${sourcePath}/`);
						return true;
					});
					empty_folders = empty.length;
					for (const folder of empty) {
						const dest = relocateFolderPath(folder, targetPath, sourceFolders.length ? sourceFolders : undefined);
						if (dest) destFolders.add(dest);
					}
				}

				res.json({
					data: {
						total_files: rows.length,
						total_folders: destFolders.size,
						empty_folders,
						total_bytes: rows.reduce((sum, r) => sum + (Number(r.filesize) || 0), 0),
						skipped,
						samples,
					},
				});
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
					keep_source_file_on_disk?: boolean;
					target_path?: string;
					source_folders?: string[];
					include_empty_folders?: boolean;
					preserve_paths?: boolean;
					file_ids?: string[];
					source_storage?: string;
					source_path?: string;
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
					keepSourceFileOnDisk: Boolean(body.keep_source_file_on_disk),
					targetPath: body.target_path != null ? String(body.target_path) : undefined,
					sourceFolders: Array.isArray(body.source_folders) ? body.source_folders.map(String) : undefined,
					includeEmptyFolders: body.include_empty_folders !== false,
					preservePaths: Boolean(body.preserve_paths),
					sourceStorage: body.source_storage ? String(body.source_storage) : undefined,
					sourcePath: body.source_path != null ? String(body.source_path) : undefined,
					concurrency: body.concurrency,
					database,
					logger,
					env,
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
					keep_source_file_on_disk?: boolean;
					target_path?: string;
					source_folders?: string[];
					include_empty_folders?: boolean;
					preserve_paths?: boolean;
					file_ids?: string[];
					source_storage?: string;
					source_path?: string;
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
						keepSourceFileOnDisk: Boolean(body.keep_source_file_on_disk),
						targetPath: body.target_path != null ? String(body.target_path) : undefined,
					sourceFolders: Array.isArray(body.source_folders) ? body.source_folders.map(String) : undefined,
					includeEmptyFolders: body.include_empty_folders !== false,
					preservePaths: Boolean(body.preserve_paths),
					sourceStorage: body.source_storage ? String(body.source_storage) : undefined,
					sourcePath: body.source_path != null ? String(body.source_path) : undefined,
						// Sequential gives clearer File N/M UX; still allow override
						concurrency: body.concurrency ?? 1,
						database,
						logger,
						env,
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

		router.post('/materialize/dry-run', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const body = (req.body || {}) as {
					folder_id?: string | null;
					mode?: 'preserve' | 'merge';
					target_storage?: string;
					structure_only?: boolean;
					recursive?: boolean;
				};
				const mode = body.mode === 'merge' ? 'merge' : 'preserve';
				const folderId = body.folder_id === undefined ? null : body.folder_id === null || body.folder_id === '' ? null : String(body.folder_id);
				const targetStorage = String(body.target_storage || '').trim();
				if (mode === 'merge' && !targetStorage) {
					res.status(400).json({ errors: [{ message: 'target_storage is required when mode is "merge"' }] });
					return;
				}
				if (mode === 'merge') {
					const locations = listConfiguredLocations(env);
					if (!locations.includes(targetStorage)) {
						res.status(400).json({ errors: [{ message: `Unknown target storage: ${targetStorage}` }] });
						return;
					}
				}
				const data = await materializeDryRun({
					database,
					folderId,
					mode,
					targetStorage: targetStorage || undefined,
					structureOnly: Boolean(body.structure_only),
					recursive: Boolean(body.recursive),
				});
				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		router.post('/materialize', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const body = (req.body || {}) as {
					folder_id?: string | null;
					mode?: 'preserve' | 'merge';
					target_storage?: string;
					structure_only?: boolean;
					keep_source_file_on_disk?: boolean;
					recursive?: boolean;
				};
				const mode = body.mode === 'merge' ? 'merge' : 'preserve';
				const folderId = body.folder_id === undefined ? null : body.folder_id === null || body.folder_id === '' ? null : String(body.folder_id);
				const targetStorage = String(body.target_storage || '').trim();
				if (mode === 'merge' && !targetStorage) {
					res.status(400).json({ errors: [{ message: 'target_storage is required when mode is "merge"' }] });
					return;
				}
				if (mode === 'merge') {
					const locations = listConfiguredLocations(env);
					if (!locations.includes(targetStorage)) {
						res.status(400).json({ errors: [{ message: `Unknown target storage: ${targetStorage}` }] });
						return;
					}
				}
				const data = await materializeRun({
					database,
					logger,
					folderId,
					mode,
					targetStorage: targetStorage || undefined,
					structureOnly: Boolean(body.structure_only),
					keepSourceFileOnDisk: Boolean(body.keep_source_file_on_disk),
					recursive: Boolean(body.recursive),
				});
				res.json({ data });
			} catch (error) {
				next(error);
			}
		});

		router.post('/materialize/stream', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const body = (req.body || {}) as {
					folder_id?: string | null;
					mode?: 'preserve' | 'merge';
					target_storage?: string;
					structure_only?: boolean;
					keep_source_file_on_disk?: boolean;
					recursive?: boolean;
				};
				const mode = body.mode === 'merge' ? 'merge' : 'preserve';
				const folderId =
					body.folder_id === undefined
						? null
						: body.folder_id === null || body.folder_id === ''
							? null
							: String(body.folder_id);
				const targetStorage = String(body.target_storage || '').trim();
				if (mode === 'merge' && !targetStorage) {
					res.status(400).json({ errors: [{ message: 'target_storage is required when mode is "merge"' }] });
					return;
				}
				if (mode === 'merge') {
					const locations = listConfiguredLocations(env);
					if (!locations.includes(targetStorage)) {
						res.status(400).json({ errors: [{ message: `Unknown target storage: ${targetStorage}` }] });
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

				try {
				await materializeRun({
					database,
					logger,
					folderId,
					mode,
					targetStorage: targetStorage || undefined,
					structureOnly: Boolean(body.structure_only),
					keepSourceFileOnDisk: Boolean(body.keep_source_file_on_disk),
					recursive: Boolean(body.recursive),
					isCancelled: () => closed,
					onProgress: (event) => send(event as unknown as Record<string, unknown>),
				});
				} catch (err) {
					send({
						type: 'error',
						message: err instanceof Error ? err.message : String(err),
					});
				}
				if (!closed) res.end();
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
		// ── Settings ────────────────────────────────────────────────────────
		/** GET /storage-manager/settings → returns full settings object. */
		router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const settings = await loadSettings(database);
				res.json({ data: { locations: settings.locations ?? {} } });
			} catch (error) {
				next(error);
			}
		});

		/** PATCH /storage-manager/settings → deep-merge and save. */
		router.patch('/settings', async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (!requireAdmin(req, res)) return;
				const body = req.body as { locations?: Record<string, Partial<StorageLocationSettings>> };
				if (!body || typeof body.locations !== 'object') {
					res.status(400).json({ errors: [{ message: 'Body must contain a "locations" object.' }] });
					return;
				}

				// Load existing
				const row = await database('directus_settings').select(STORAGE_MANAGER_FIELD).first();
				const raw = row?.[STORAGE_MANAGER_FIELD];
				const existing: StorageManagerSettings =
					typeof raw === 'string' ? JSON.parse(raw) : (raw ?? { locations: {} });

				// Merge: for each incoming location, deep-merge defaults → existing → incoming
				const merged: Record<string, StorageLocationSettings> = { ...(existing.locations ?? {}) };
				for (const [loc, partial] of Object.entries(body.locations)) {
					merged[loc] = {
						...STORAGE_MANAGER_LOCATION_DEFAULTS,
						...(existing.locations?.[loc] ?? {}),
						...partial,
					};
				}

				const next_settings: StorageManagerSettings = {
					locations: merged,
					...(existing.name_mirror_claims !== undefined
						? { name_mirror_claims: existing.name_mirror_claims }
						: {}),
				};
				await database('directus_settings').update({ [STORAGE_MANAGER_FIELD]: JSON.stringify(next_settings) });
				invalidateSettingsCache();

				res.json({ data: { locations: next_settings.locations } });
			} catch (error) {
				next(error);
			}
		});

		/** DELETE /storage-manager/settings/locations/:location → remove per-location settings. */
		router.delete(
			'/settings/locations/:location',
			async (req: Request, res: Response, next: NextFunction) => {
				try {
					if (!requireAdmin(req, res)) return;
					const loc = String(req.params.location);
					const row = await database('directus_settings').select(STORAGE_MANAGER_FIELD).first();
					const raw = row?.[STORAGE_MANAGER_FIELD];
					const existing: StorageManagerSettings =
						typeof raw === 'string' ? JSON.parse(raw) : (raw ?? { locations: {} });
					delete existing.locations[loc];
					await database('directus_settings').update({
						[STORAGE_MANAGER_FIELD]: JSON.stringify(existing),
					});
					invalidateSettingsCache();
					res.json({ data: existing });
				} catch (error) {
					next(error);
				}
			},
		);
	},
};
