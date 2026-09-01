import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	diskDelete,
	diskDeleteWithAssets,
	diskExists,
	diskList,
	diskListColocatedAssets,
	diskRead,
	diskWrite,
	getStorageManager,
} from './storage';
import { getLocationDriver, getLocationRoot } from './usage';
import { STORAGE_FOLDER_KEEP, type StorageBrowseFolder, type StorageFolderNode } from '../shared/types';

export function normalizeStoragePath(raw: string | null | undefined): string {
	return String(raw || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\/+/g, '/');
}

export function joinStoragePath(...parts: Array<string | null | undefined>): string {
	return parts
		.map((p) => normalizeStoragePath(p))
		.filter(Boolean)
		.join('/');
}

/**
 * Place a file under `targetPath`. Selected storage folders keep their name
 * (and nested files) so moving `hello/` into a storage root merges into
 * existing `hello/`. Loose files still flatten to the basename unless
 * `preservePaths` is set (whole-adapter move).
 */
export function relocateUnderTargetPath(
	filenameDisk: string,
	targetPath: string,
	sourceFolders?: string[],
	preservePaths = false,
): string {
	const dest = normalizeStoragePath(targetPath);
	const from = normalizeStoragePath(filenameDisk);
	if (preservePaths) {
		if (!from) return dest;
		return dest ? `${dest}/${from}` : from;
	}
	const prefixes = (sourceFolders || [])
		.map((p) => normalizeStoragePath(p))
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);

	for (const prefix of prefixes) {
		if (from === prefix || from.startsWith(`${prefix}/`)) {
			const folderName = path.posix.basename(prefix);
			const rest = from === prefix ? '' : from.slice(prefix.length + 1);
			const relative = rest ? `${folderName}/${rest}` : folderName;
			return dest ? `${dest}/${relative}` : relative;
		}
	}

	const base = path.posix.basename(from);
	return dest ? `${dest}/${base}` : base;
}

export function isKeepMarker(filename: string): boolean {
	return path.basename(filename) === STORAGE_FOLDER_KEEP;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Immediate-child file filter for Directus items query (non-recursive). */
export function getStoragePathFileRegex(storagePath: string): string {
	const base = normalizeStoragePath(storagePath);
	if (!base) return `^[^/]+$`;
	return `^${escapeRegex(base)}/[^/]+$`;
}

function resolveLocalAbsolute(root: string, relPath: string): string {
	const cwd = process.env.PWD || process.cwd() || '/directus';
	const absoluteRoot = path.isAbsolute(root) ? root : path.join(cwd, root);
	const abs = path.resolve(absoluteRoot, relPath);
	if (!abs.startsWith(path.resolve(absoluteRoot))) {
		throw new Error('Invalid storage path');
	}
	return abs;
}

function validateFolderName(name: string): string {
	const trimmed = String(name || '').trim();
	if (!trimmed) throw new Error('Folder name is required');
	if (trimmed.includes('/') || trimmed.includes('\\')) {
		throw new Error('Folder name cannot contain slashes');
	}
	if (trimmed === '.' || trimmed === '..' || trimmed === STORAGE_FOLDER_KEEP) {
		throw new Error('Invalid folder name');
	}
	return trimmed;
}

async function collectImmediateFoldersFromDisk(
	location: string,
	parentPath: string,
	env: Record<string, unknown>,
): Promise<Set<string>> {
	const folders = new Set<string>();
	const driver = getLocationDriver(env, location);
	const root = getLocationRoot(env, location);
	const parent = normalizeStoragePath(parentPath);

	if (driver === 'local' && root) {
		const abs = resolveLocalAbsolute(root, parent || '.');
		try {
			const entries = await fs.readdir(abs, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name && !entry.name.startsWith('.')) {
					folders.add(entry.name);
				}
			}
		} catch {
			// missing dir is fine
		}
		return folders;
	}

	try {
		const storage = await getStorageManager();
		const disk = storage.location(location);
		const prefix = parent ? `${parent}/` : '';
		for await (const filepath of diskList(disk, prefix)) {
			const name = String(filepath || '').replace(/^[/\\]+/, '');
			if (!name.startsWith(prefix) && prefix) continue;
			const rest = prefix ? name.slice(prefix.length) : name;
			const segment = rest.split('/')[0];
			if (!segment || segment.startsWith('.')) continue;
			if (rest.includes('/')) folders.add(segment);
			else if (isKeepMarker(name)) {
				// `.keep` itself is a file under the folder — the parent of keep is the folder;
				// when listing with prefix = parent, keep appears as `${parent}/.keep` so segment is `.keep` (skipped).
			}
		}
	} catch {
		// list unsupported — rely on DB only
	}

	return folders;
}

async function collectImmediateFoldersFromDb(
	database: any,
	location: string,
	parentPath: string,
): Promise<Set<string>> {
	const parent = normalizeStoragePath(parentPath);
	const prefix = parent ? `${parent}/` : '';
	const client = String(
		database?.client?.config?.client || database?.client?.driverName || database?.client?.dialect || '',
	).toLowerCase();
	const start = prefix.length + 1;

	try {
		let rows: Array<{ segment?: string }> = [];

		const scoped = database('directus_files').where('storage', location).whereNotNull('filename_disk');
		if (prefix) {
			scoped.where('filename_disk', 'like', `${prefix}%`);
		} else {
			scoped.where('filename_disk', 'like', '%/%');
		}

		if (client.includes('pg') || client.includes('cockroach')) {
			const rest = prefix ? `substring(filename_disk from ${start})` : 'filename_disk';
			rows = await scoped
				.whereRaw(`${rest} like ?`, ['%/%'])
				.select(database.raw(`DISTINCT split_part(${rest}, '/', 1) as segment`));
		} else if (client.includes('mysql') || client.includes('maria')) {
			const rest = prefix ? `SUBSTRING(filename_disk, ${start})` : 'filename_disk';
			rows = await scoped
				.whereRaw(`${rest} like ?`, ['%/%'])
				.select(database.raw(`DISTINCT SUBSTRING_INDEX(${rest}, '/', 1) as segment`));
		} else if (client.includes('sqlite')) {
			const rest = prefix ? `substr(filename_disk, ${start})` : 'filename_disk';
			rows = await scoped
				.whereRaw(`instr(${rest}, '/') > 0`)
				.select(database.raw(`DISTINCT substr(${rest}, 1, instr(${rest}, '/') - 1) as segment`));
		} else if (client.includes('mssql')) {
			const rest = prefix ? `SUBSTRING(filename_disk, ${start}, 4000)` : 'filename_disk';
			rows = await scoped
				.whereRaw(`CHARINDEX('/', ${rest}) > 0`)
				.select(database.raw(`DISTINCT LEFT(${rest}, CHARINDEX('/', ${rest}) - 1) as segment`));
		} else {
			return new Set();
		}

		const folders = new Set<string>();
		for (const row of rows) {
			const segment = String(row.segment || '').trim();
			if (!segment || segment.startsWith('.') || segment.includes('/') || segment.includes('\\')) continue;
			folders.add(segment);
		}
		return folders;
	} catch {
		return new Set();
	}
}

/** Also pick up empty cloud folders that only contain `.keep`. */
async function collectKeepFoldersFromDisk(
	location: string,
	parentPath: string,
	env: Record<string, unknown>,
): Promise<Set<string>> {
	const folders = new Set<string>();
	const driver = getLocationDriver(env, location);
	if (driver === 'local') return folders;

	const parent = normalizeStoragePath(parentPath);
	const prefix = parent ? `${parent}/` : '';

	try {
		const storage = await getStorageManager();
		const disk = storage.location(location);
		for await (const filepath of diskList(disk, prefix)) {
			const name = String(filepath || '').replace(/^[/\\]+/, '');
			if (!isKeepMarker(name)) continue;
			const dir = normalizeStoragePath(path.posix.dirname(name));
			if (parent) {
				if (dir === parent) {
					// keep is directly in parent — that marks `parent` itself, not a child
					continue;
				}
				if (!dir.startsWith(`${parent}/`)) continue;
				const rest = dir.slice(parent.length + 1);
				const segment = rest.split('/')[0];
				if (segment && !segment.startsWith('.')) folders.add(segment);
			} else {
				// root-level keep at `foo/.keep` → folder foo
				const parts = dir.split('/').filter(Boolean);
				if (parts.length === 1) folders.add(parts[0]!);
			}
		}
	} catch {
		// ignore
	}

	return folders;
}

export async function browseStorageFolders(
	database: any,
	location: string,
	parentPath: string,
	env: Record<string, unknown>,
): Promise<{ path: string; folders: StorageBrowseFolder[] }> {
	const parent = normalizeStoragePath(parentPath);
	const names = new Set<string>();

	for (const name of await collectImmediateFoldersFromDb(database, location, parent)) names.add(name);
	for (const name of await collectImmediateFoldersFromDisk(location, parent, env)) names.add(name);
	for (const name of await collectKeepFoldersFromDisk(location, parent, env)) names.add(name);

	const folders = Array.from(names)
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({
			name,
			path: joinStoragePath(parent, name),
		}));

	return { path: parent, folders };
}

function addPathPrefixes(paths: Set<string>, fullPath: string) {
	const parts = normalizeStoragePath(fullPath).split('/').filter(Boolean);
	for (let i = 1; i <= parts.length; i++) {
		paths.add(parts.slice(0, i).join('/'));
	}
}

async function collectAllFolderPathsFromDb(database: any, location: string): Promise<Set<string>> {
	const paths = new Set<string>();
	const rows = await database('directus_files').select('filename_disk').where('storage', location);

	for (const row of rows) {
		const name = String(row.filename_disk || '').replace(/^[/\\]+/, '');
		if (!name || isKeepMarker(name)) continue;
		const dir = normalizeStoragePath(path.posix.dirname(name));
		if (!dir || dir === '.') continue;
		addPathPrefixes(paths, dir);
	}

	return paths;
}

async function collectAllFolderPathsFromLocalDisk(
	location: string,
	env: Record<string, unknown>,
): Promise<Set<string>> {
	const paths = new Set<string>();
	const driver = getLocationDriver(env, location);
	const root = getLocationRoot(env, location);
	if (driver !== 'local' || !root) return paths;

	async function walk(rel: string) {
		const abs = resolveLocalAbsolute(root!, rel || '.');
		let entries;
		try {
			entries = await fs.readdir(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name || entry.name.startsWith('.')) continue;
			const childRel = joinStoragePath(rel, entry.name);
			paths.add(childRel);
			await walk(childRel);
		}
	}

	await walk('');
	return paths;
}

async function collectAllKeepFolderPaths(
	location: string,
	env: Record<string, unknown>,
): Promise<Set<string>> {
	const paths = new Set<string>();
	const driver = getLocationDriver(env, location);
	if (driver === 'local') return paths;

	try {
		const storage = await getStorageManager();
		const disk = storage.location(location);
		for await (const filepath of diskList(disk, '')) {
			const name = String(filepath || '').replace(/^[/\\]+/, '');
			if (!isKeepMarker(name)) continue;
			const dir = normalizeStoragePath(path.posix.dirname(name));
			if (!dir || dir === '.') continue;
			addPathPrefixes(paths, dir);
		}
	} catch {
		// ignore
	}

	return paths;
}

export function nestStorageFolderPaths(paths: string[]): StorageFolderNode[] {
	const unique = Array.from(new Set(paths.map((p) => normalizeStoragePath(p)).filter(Boolean))).sort((a, b) =>
		a.localeCompare(b),
	);

	const byPath = new Map<string, StorageFolderNode>();
	for (const p of unique) {
		const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
		byPath.set(p, { name, path: p });
	}

	const roots: StorageFolderNode[] = [];
	for (const p of unique) {
		const node = byPath.get(p)!;
		const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
		if (parentPath && byPath.has(parentPath)) {
			const parent = byPath.get(parentPath)!;
			if (!parent.children) parent.children = [];
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const sortChildren = (nodes: StorageFolderNode[]) => {
		nodes.sort((a, b) => a.name.localeCompare(b.name));
		for (const n of nodes) {
			if (n.children?.length) sortChildren(n.children);
		}
	};
	sortChildren(roots);
	return roots;
}

/** Immediate-child tree for pickers/nav — never walks the full disk or loads every filename_disk. */
export async function browseStorageFolderTree(
	database: any,
	location: string,
	env: Record<string, unknown>,
): Promise<StorageFolderNode[]> {
	const { folders } = await browseStorageFolders(database, location, '', env);
	return folders.map((folder) => ({ name: folder.name, path: folder.path }));
}

export function countFolderNodes(nodes: StorageFolderNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1;
		if (node.children?.length) total += countFolderNodes(node.children);
	}
	return total;
}

export async function countStorageFolders(
	database: any,
	location: string,
	env: Record<string, unknown>,
): Promise<number> {
	try {
		const paths = await listStorageFolderPaths(database, location, env);
		return paths.length;
	} catch {
		return 0;
	}
}

export async function listStorageFolderPaths(
	database: any,
	location: string,
	env: Record<string, unknown>,
): Promise<string[]> {
	const paths = new Set<string>();
	for (const p of await collectAllFolderPathsFromDb(database, location)) paths.add(p);
	for (const p of await collectAllFolderPathsFromLocalDisk(location, env)) paths.add(p);
	for (const p of await collectAllKeepFolderPaths(location, env)) paths.add(p);
	return Array.from(paths);
}

export async function listEmptyStorageFolders(
	database: any,
	location: string,
	env: Record<string, unknown>,
): Promise<string[]> {
	const all = await listStorageFolderPaths(database, location, env);
	const withFiles = new Set<string>();
	const rows = await database('directus_files').select('filename_disk').where('storage', location);
	for (const row of rows) {
		const name = String(row.filename_disk || '').replace(/^[/\\]+/, '');
		if (!name || isKeepMarker(name)) continue;
		const dir = normalizeStoragePath(path.posix.dirname(name));
		if (!dir || dir === '.') continue;
		addPathPrefixes(withFiles, dir);
	}
	return all.filter((p) => !withFiles.has(p));
}

export function relocateFolderPath(
	folderPath: string,
	targetPath: string | undefined,
	sourceFolders?: string[],
): string {
	const from = normalizeStoragePath(folderPath);
	if (!from) return '';
	if (targetPath == null) return from;
	if (sourceFolders?.length) {
		return relocateUnderTargetPath(`${from}/__folder__`, targetPath, sourceFolders).replace(/\/__folder__$/, '');
	}
	const dest = normalizeStoragePath(targetPath);
	return dest ? `${dest}/${from}` : from;
}

export async function ensureStorageFolderPath(
	location: string,
	folderPath: string,
	env: Record<string, unknown>,
): Promise<void> {
	const normalized = normalizeStoragePath(folderPath);
	if (!normalized) return;
	let parent = '';
	for (const segment of normalized.split('/').filter(Boolean)) {
		await createStorageFolder(location, segment, parent, env);
		parent = joinStoragePath(parent, segment);
	}
}

async function removeEmptyStorageFolder(
	location: string,
	folderPath: string,
	env: Record<string, unknown>,
): Promise<void> {
	const folder = normalizeStoragePath(folderPath);
	if (!folder) return;
	const driver = getLocationDriver(env, location);
	if (driver === 'local') {
		const root = getLocationRoot(env, location);
		if (!root) return;
		const abs = resolveLocalAbsolute(root, folder);
		try {
			await fs.rm(abs, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		return;
	}
	try {
		const storage = await getStorageManager();
		const disk = storage.location(location);
		const keepKey = `${folder}/${STORAGE_FOLDER_KEEP}`;
		if (await diskExists(disk, keepKey)) await diskDelete(disk, keepKey);
	} catch {
		// best-effort
	}
}

function filterFoldersByScope(folders: string[], sourceFolders?: string[], sourcePath?: string): string[] {
	if (sourceFolders?.length) {
		const prefixes = sourceFolders.map((p) => normalizeStoragePath(p)).filter(Boolean);
		return folders.filter((p) => prefixes.some((f) => p === f || p.startsWith(`${f}/`)));
	}
	if (sourcePath) {
		const prefix = normalizeStoragePath(sourcePath);
		if (!prefix) return folders;
		return folders.filter((p) => p === prefix || p.startsWith(`${prefix}/`));
	}
	return folders;
}

export async function copyEmptyStorageFolders(params: {
	database: any;
	sourceLocation: string;
	targetLocation: string;
	env: Record<string, unknown>;
	targetPath?: string;
	sourceFolders?: string[];
	sourcePath?: string;
	removeSource?: boolean;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<number> {
	let empty = await listEmptyStorageFolders(params.database, params.sourceLocation, params.env);
	empty = filterFoldersByScope(empty, params.sourceFolders, params.sourcePath);
	empty.sort((a, b) => a.length - b.length);
	let copied = 0;
	for (const folder of empty) {
		const dest = relocateFolderPath(folder, params.targetPath, params.sourceFolders);
		if (!dest) continue;
		try {
			await ensureStorageFolderPath(params.targetLocation, dest, params.env);
			copied += 1;
		} catch (err: any) {
			params.logger?.warn(`[storage-manager] Failed copying empty folder ${folder}: ${err?.message || err}`);
		}
	}
	if (params.removeSource && copied) {
		for (const folder of [...empty].sort((a, b) => b.length - a.length)) {
			try {
				await removeEmptyStorageFolder(params.sourceLocation, folder, params.env);
				await pruneEmptyLocalAncestors(params.sourceLocation, `${folder}/.keep`, params.env);
			} catch {
				// best-effort
			}
		}
	}
	return copied;
}

export async function createStorageFolder(
	location: string,
	name: string,
	parentPath: string,
	env: Record<string, unknown>,
): Promise<{ path: string }> {
	const folderName = validateFolderName(name);
	const fullPath = joinStoragePath(parentPath, folderName);
	const driver = getLocationDriver(env, location);

	if (driver === 'local') {
		const root = getLocationRoot(env, location);
		if (!root) throw new Error(`Local storage “${location}” has no STORAGE_${location.toUpperCase()}_ROOT`);
		const abs = resolveLocalAbsolute(root, fullPath);
		await fs.mkdir(abs, { recursive: true });
		return { path: fullPath };
	}

	const storage = await getStorageManager();
	const disk = storage.location(location);
	const keepKey = `${fullPath}/${STORAGE_FOLDER_KEEP}`;
	if (!(await diskExists(disk, keepKey))) {
		const empty = Readable.from([Buffer.alloc(0)]);
		await diskWrite(disk, keepKey, empty, 'application/octet-stream');
	}
	return { path: fullPath };
}

/**
 * Delete storage folders (File Library–style).
 * - mode `move` (default): relocate registered files under the prefix up to the parent, then remove the folder.
 * - mode `delete`: permanently delete registered files under the prefix (DB + storage), then remove the folder.
 * Unregistered disk objects are not relocated — local dirs are force-removed; cloud leftovers are left alone
 * (only `.keep` markers under the prefix are cleaned up).
 */
export async function deleteStorageFolders(
	database: any,
	location: string,
	paths: string[],
	env: Record<string, unknown>,
	logger?: { info: (m: string) => void; warn: (m: string) => void },
	options?: {
		mode?: 'move' | 'delete';
		/** Prefer FilesService.deleteMany when available (handles transforms). */
		filesService?: { deleteMany: (keys: string[]) => Promise<unknown> };
	},
): Promise<{
	deleted: string[];
	skipped: Array<{ path: string; error: string }>;
	relocated: number;
	files_deleted: number;
}> {
	const mode = options?.mode === 'delete' ? 'delete' : 'move';
	const deleted: string[] = [];
	const skipped: Array<{ path: string; error: string }> = [];
	let relocated = 0;
	let filesDeleted = 0;
	const driver = getLocationDriver(env, location);
	const storage = await getStorageManager();
	const disk = storage.location(location);

	for (const raw of paths) {
		const folderPath = normalizeStoragePath(raw);
		if (!folderPath) {
			skipped.push({ path: String(raw), error: 'Invalid path' });
			continue;
		}

		const parent = parentStoragePath(folderPath);

		try {
			let deletedInFolder = 0;
			if (mode === 'delete') {
				const rows = await database('directus_files')
					.select('id', 'filename_disk')
					.where('storage', location)
					.whereRaw('filename_disk LIKE ?', [`${folderPath}/%`]);

				const realRows = rows.filter((r: any) => !isKeepMarker(String(r.filename_disk || '')));
				const ids = realRows.map((r: any) => String(r.id));

				if (ids.length) {
					if (options?.filesService) {
						await options.filesService.deleteMany(ids);
					} else {
						for (const row of realRows) {
							const id = String(row.id);
							const from = String(row.filename_disk || '');
							try {
								if (from) await diskDeleteWithAssets(disk, from);
							} catch {
								// best-effort disk cleanup
							}
							await database('directus_files').where('id', id).delete();
						}
					}
					deletedInFolder = ids.length;
					filesDeleted += ids.length;
				}
			} else {
				const { moved, failed } = await relocateFilesWithPrefixChange(
					database,
					location,
					folderPath,
					parent,
					logger,
				);
				relocated += moved;
				if (failed > 0) {
					skipped.push({
						path: folderPath,
						error: `Could not move ${failed} registered file(s) to parent`,
					});
					continue;
				}
			}

			if (driver === 'local') {
				const root = getLocationRoot(env, location);
				if (!root) throw new Error('Missing local root');
				const abs = resolveLocalAbsolute(root, folderPath);
				await fs.rm(abs, { recursive: true, force: true });
			} else {
				// Drop keep markers that held the folder in the tree; leave unknown objects.
				try {
					for await (const filepath of diskList(disk, `${folderPath}/`)) {
						const name = String(filepath || '').replace(/^[/\\]+/, '');
						if (!name.startsWith(`${folderPath}/`)) continue;
						if (!isKeepMarker(name)) continue;
						try {
							await diskDelete(disk, name);
						} catch {
							// best-effort
						}
					}
				} catch {
					const keepKey = `${folderPath}/${STORAGE_FOLDER_KEEP}`;
					if (await diskExists(disk, keepKey)) {
						await diskDelete(disk, keepKey);
					}
				}
			}

			deleted.push(folderPath);
			logger?.info(
				mode === 'delete'
					? `[storage-manager] Deleted storage folder “${folderPath}” on ${location} (deleted ${deletedInFolder} registered file(s))`
					: `[storage-manager] Deleted storage folder “${folderPath}” on ${location} (relocated files to parent)`,
			);
		} catch (err: any) {
			skipped.push({ path: folderPath, error: err?.message || String(err) });
		}
	}

	return { deleted, skipped, relocated, files_deleted: filesDeleted };
}

/**
 * Move registered files into a storage folder path (same adapter).
 * Updates filename_disk and moves the object (+ transforms).
 */
export async function moveFilesToStoragePath(
	database: any,
	location: string,
	fileIds: string[],
	targetPath: string,
	logger?: { info: (m: string) => void; warn: (m: string) => void },
	env?: Record<string, unknown>,
	sourceFolders?: string[],
	preservePaths = false,
): Promise<{
	moved: number;
	failed: number;
	skipped: number;
	results: Array<{ id: string; from: string; to: string; status: 'moved' | 'failed' | 'skipped'; error?: string }>;
}> {
	const storage = await getStorageManager();
	const disk = storage.location(location);
	const results: Array<{ id: string; from: string; to: string; status: 'moved' | 'failed' | 'skipped'; error?: string }> = [];

	const rows = await database('directus_files')
		.select('id', 'storage', 'filename_disk', 'type')
		.where('storage', location)
		.whereIn('id', fileIds.map(String));

	for (const row of rows) {
		const id = String(row.id);
		const from = String(row.filename_disk || '');
		const to = relocateUnderTargetPath(from, targetPath, sourceFolders, preservePaths);

		if (!from || from === to) {
			results.push({ id, from, to, status: 'moved' });
			continue;
		}

		try {
			if (!(await diskExists(disk, from))) {
				throw new Error('Source object missing on storage');
			}
			const occupant = await database('directus_files')
				.select('id')
				.where({ storage: location, filename_disk: to })
				.whereNot({ id })
				.first();
			if (occupant) {
				results.push({
					id,
					from,
					to,
					status: 'skipped',
					error: 'Destination already has a file at this path — left in place',
				});
				continue;
			}
			if (!(await diskExists(disk, to))) {
				const stream = await diskRead(disk, from);
				await diskWrite(disk, to, stream, row.type);
				if (!(await diskExists(disk, to))) {
					throw new Error('Write verification failed');
				}
			}

			// AssetsService keeps transforms at storage root by basename — leave those alone.
			// Only remove orphaned copies that sat beside the old nested path.
			try {
				const colocated = await diskListColocatedAssets(disk, from);
				for (const rel of colocated) {
					try {
						await diskDelete(disk, rel);
					} catch {
						// best-effort
					}
				}
			} catch {
				// ignore
			}

			await diskDelete(disk, from);
			await database('directus_files').where('id', id).update({ filename_disk: to });
			await pruneEmptyLocalAncestors(location, from, env);
			results.push({ id, from, to, status: 'moved' });
			logger?.info(`[storage-manager] Moved ${from} → ${to} on ${location}`);
		} catch (err: any) {
			results.push({ id, from, to, status: 'failed', error: err?.message || String(err) });
			logger?.warn(`[storage-manager] Move failed for ${id}: ${err?.message}`);
		}
	}

	return {
		moved: results.filter((r) => r.status === 'moved').length,
		failed: results.filter((r) => r.status === 'failed').length,
		skipped: results.filter((r) => r.status === 'skipped').length,
		results,
	};
}

/**
 * After a flat upload, move the object under the current storage path if needed.
 */
export async function ensureFileUnderPath(
	database: any,
	fileId: string,
	location: string,
	targetPath: string,
): Promise<string | null> {
	const target = normalizeStoragePath(targetPath);
	if (!target) return null;

	const row = await database('directus_files')
		.select('id', 'storage', 'filename_disk', 'type')
		.where('id', fileId)
		.first();
	if (!row || String(row.storage) !== location) return null;

	const from = String(row.filename_disk || '');
	const base = path.posix.basename(from);
	const to = `${target}/${base}`;
	if (!from || from === to) return from;

	const result = await moveFilesToStoragePath(database, location, [fileId], target);
	const entry = result.results[0];
	if (entry?.status === 'moved') return entry.to;
	throw new Error(entry?.error || 'Failed to place file under storage path');
}

function parentStoragePath(folderPath: string): string {
	const normalized = normalizeStoragePath(folderPath);
	const idx = normalized.lastIndexOf('/');
	return idx === -1 ? '' : normalized.slice(0, idx);
}

/** Remove empty local directories left after a file is moved out of a nested path. */
export async function pruneEmptyLocalAncestors(
	location: string,
	filePath: string,
	env?: Record<string, unknown>,
): Promise<void> {
	if (!env || getLocationDriver(env, location) !== 'local') return;
	const root = getLocationRoot(env, location);
	if (!root) return;

	let current = parentStoragePath(filePath);
	while (current) {
		const abs = resolveLocalAbsolute(root, current);
		try {
			const entries = await fs.readdir(abs);
			if (entries.length > 0) return;
			await fs.rmdir(abs);
		} catch {
			return;
		}
		current = parentStoragePath(current);
	}
}

async function storageFolderExists(
	database: any,
	location: string,
	folderPath: string,
	env: Record<string, unknown>,
): Promise<boolean> {
	const target = normalizeStoragePath(folderPath);
	if (!target) return false;

	const row = await database('directus_files')
		.select('id')
		.where('storage', location)
		.whereRaw('filename_disk LIKE ?', [`${target}/%`])
		.first();
	if (row) return true;

	const parent = parentStoragePath(target);
	const name = path.posix.basename(target);
	const names = new Set<string>();
	for (const n of await collectImmediateFoldersFromDb(database, location, parent)) names.add(n);
	for (const n of await collectImmediateFoldersFromDisk(location, parent, env)) names.add(n);
	for (const n of await collectKeepFoldersFromDisk(location, parent, env)) names.add(n);
	return names.has(name);
}

/**
 * Rename or move a physical storage folder (registered files + disk leftovers / `.keep`).
 */
export async function relocateStorageFolder(
	database: any,
	location: string,
	fromPath: string,
	toPath: string,
	env: Record<string, unknown>,
	logger?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ path: string; moved: number; failed: number }> {
	const from = normalizeStoragePath(fromPath);
	const to = normalizeStoragePath(toPath);
	if (!from) throw new Error('Source folder path is required');
	if (!to) throw new Error('Destination folder path is required');
	if (from === to) return { path: to, moved: 0, failed: 0 };
	if (to.startsWith(`${from}/`)) {
		throw new Error('Cannot move a folder into itself');
	}

	const destName = path.posix.basename(to);
	validateFolderName(destName);

	if (await storageFolderExists(database, location, to, env)) {
		throw new Error(`Folder already exists: ${to}`);
	}

	const { moved, failed } = await relocateFilesWithPrefixChange(database, location, from, to, logger);
	if (failed > 0) {
		throw new Error(`Failed to relocate ${failed} file(s) under ${from}`);
	}

	const driver = getLocationDriver(env, location);
	if (driver === 'local') {
		const root = getLocationRoot(env, location);
		if (!root) throw new Error(`Local storage “${location}” has no STORAGE_${location.toUpperCase()}_ROOT`);
		const absFrom = resolveLocalAbsolute(root, from);
		const absTo = resolveLocalAbsolute(root, to);
		await fs.mkdir(path.dirname(absTo), { recursive: true });
		try {
			await fs.access(absFrom);
			try {
				await fs.access(absTo);
				// Destination already has moved files — merge leftovers then remove source.
				const entries = await fs.readdir(absFrom, { withFileTypes: true });
				for (const entry of entries) {
					const src = path.join(absFrom, entry.name);
					const dest = path.join(absTo, entry.name);
					try {
						await fs.rename(src, dest);
					} catch {
						// best-effort when dest already exists
					}
				}
				await fs.rm(absFrom, { recursive: true, force: true });
			} catch {
				await fs.rename(absFrom, absTo);
			}
		} catch {
			await fs.mkdir(absTo, { recursive: true });
		}
	} else {
		const storage = await getStorageManager();
		const disk = storage.location(location);
		const prefix = `${from}/`;
		try {
			for await (const filepath of diskList(disk, prefix)) {
				const name = String(filepath || '').replace(/^[/\\]+/, '');
				if (!name.startsWith(prefix)) continue;
				const dest = to + name.slice(from.length);
				try {
					if (await diskExists(disk, dest)) {
						await diskDelete(disk, name);
						continue;
					}
					const stream = await diskRead(disk, name);
					await diskWrite(disk, dest, stream, 'application/octet-stream');
					await diskDelete(disk, name);
				} catch (err: any) {
					logger?.warn(`[storage-manager] Folder leftover move failed ${name}: ${err?.message}`);
				}
			}
		} catch {
			// list unsupported — ensure destination keep
		}

		const keepKey = `${to}/${STORAGE_FOLDER_KEEP}`;
		if (!(await diskExists(disk, keepKey))) {
			const empty = Readable.from([Buffer.alloc(0)]);
			await diskWrite(disk, keepKey, empty, 'application/octet-stream');
		}
		const oldKeep = `${from}/${STORAGE_FOLDER_KEEP}`;
		if (await diskExists(disk, oldKeep)) {
			try {
				await diskDelete(disk, oldKeep);
			} catch {
				// best-effort
			}
		}
	}

	logger?.info(`[storage-manager] Relocated folder ${from} → ${to} on ${location} (${moved} file(s))`);
	return { path: to, moved, failed };
}

/**
 * Rename a storage folder in place (same parent).
 */
export async function renameStorageFolder(
	database: any,
	location: string,
	folderPath: string,
	newName: string,
	env: Record<string, unknown>,
	logger?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ path: string; moved: number; failed: number }> {
	const from = normalizeStoragePath(folderPath);
	if (!from) throw new Error('Folder path is required');
	const name = validateFolderName(newName);
	const to = joinStoragePath(parentStoragePath(from), name);
	return relocateStorageFolder(database, location, from, to, env, logger);
}

/**
 * Move a storage folder under a new parent path (name unchanged).
 */
export async function moveStorageFolder(
	database: any,
	location: string,
	folderPath: string,
	parentPath: string,
	env: Record<string, unknown>,
	logger?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ path: string; moved: number; failed: number }> {
	const from = normalizeStoragePath(folderPath);
	if (!from) throw new Error('Folder path is required');
	const parent = normalizeStoragePath(parentPath);
	const name = path.posix.basename(from);
	const to = joinStoragePath(parent, name);
	return relocateStorageFolder(database, location, from, to, env, logger);
}

/**
 * Rewrite every filename_disk under `oldPrefix/` to `newPrefix/` on the same adapter
 * (physical object + transform siblings + DB). Used by by-name folder mirror sync.
 */
export async function relocateFilesWithPrefixChange(
	database: any,
	location: string,
	oldPrefix: string,
	newPrefix: string,
	logger?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ moved: number; failed: number }> {
	const fromPrefix = normalizeStoragePath(oldPrefix);
	const toPrefix = normalizeStoragePath(newPrefix);
	if (!fromPrefix || fromPrefix === toPrefix) return { moved: 0, failed: 0 };

	const rows = await database('directus_files')
		.select('id', 'filename_disk', 'type')
		.where('storage', location)
		.whereRaw('filename_disk LIKE ?', [`${fromPrefix}/%`]);

	if (!rows.length) return { moved: 0, failed: 0 };

	const storage = await getStorageManager();
	const disk = storage.location(location);
	let moved = 0;
	let failed = 0;

	for (const row of rows) {
		const id = String(row.id);
		const from = String(row.filename_disk || '');
		if (!from.startsWith(`${fromPrefix}/`)) continue;
		if (isKeepMarker(from)) continue;
		const rest = from.slice(fromPrefix.length).replace(/^\//, '');
		const to = toPrefix ? `${toPrefix}/${rest}` : rest;

		try {
			if (from === to) {
				moved++;
				continue;
			}
			if (!(await diskExists(disk, from))) {
				// DB-only repair when object already missing / already moved
				await database('directus_files').where('id', id).update({ filename_disk: to });
				moved++;
				logger?.warn(`[storage-manager] Prefix relocate DB-only (missing source): ${from} → ${to}`);
				continue;
			}
			if (await diskExists(disk, to)) {
				throw new Error(`Target already exists: ${to}`);
			}

			const stream = await diskRead(disk, from);
			await diskWrite(disk, to, stream, row.type);
			if (!(await diskExists(disk, to))) {
				throw new Error('Write verification failed');
			}

			// Same-adapter path rewrite: keep root transforms; drop colocated orphans only.
			try {
				const colocated = await diskListColocatedAssets(disk, from);
				for (const rel of colocated) {
					try {
						await diskDelete(disk, rel);
					} catch {
						// best-effort
					}
				}
			} catch {
				// ignore
			}

			await diskDelete(disk, from);
			await database('directus_files').where('id', id).update({ filename_disk: to });
			moved++;
			logger?.info(`[storage-manager] Prefix relocate ${from} → ${to} on ${location}`);
		} catch (err: any) {
			failed++;
			logger?.warn(`[storage-manager] Prefix relocate failed for ${id}: ${err?.message}`);
		}
	}

	return { moved, failed };
}
