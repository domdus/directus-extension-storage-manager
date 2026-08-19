import path from 'node:path';
import { diskExists } from './storage';
import { getStorageManager } from './storage';
import { migrateOneFile } from './migrate';
import type {
	MaterializeDryRunResponse,
	MaterializeMode,
	MigrateProgressEvent,
	MigrateResponse,
} from '../shared/types';

type FileRow = {
	id: string;
	storage: string;
	filename_disk: string;
	type: string | null;
	filesize: number | null;
	folder: string | null;
};

type FolderRow = {
	id: string;
	name: string;
	parent: string | null;
};

function normalizeSegment(value: string): string {
	return String(value || '')
		.replace(/\\/g, '/')
		.replace(/\//g, '_')
		.trim();
}

function buildFolderPath(folderId: string | null, map: Map<string, FolderRow>): string {
	if (!folderId) return '';
	const parts: string[] = [];
	let current: string | null = folderId;
	let guard = 0;
	while (current && guard < 100) {
		const node = map.get(current);
		if (!node) break;
		parts.unshift(normalizeSegment(node.name));
		current = node.parent;
		guard += 1;
	}
	return parts.filter(Boolean).join('/');
}

async function collectFolderIds(database: any, rootId: string | null): Promise<string[]> {
	if (!rootId) return [];
	const all = (await database('directus_folders').select('id', 'parent')) as Array<{ id: string; parent: string | null }>;
	const children = new Map<string | null, string[]>();
	for (const row of all) {
		const parent = row.parent == null ? null : String(row.parent);
		const id = String(row.id);
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent)!.push(id);
	}
	const ids: string[] = [];
	const stack = [rootId];
	while (stack.length) {
		const id = stack.pop()!;
		ids.push(id);
		for (const kid of children.get(id) || []) stack.push(kid);
	}
	return ids;
}

export async function materializeDryRun(params: {
	database: any;
	folderId: string | null;
	mode: MaterializeMode;
	targetStorage?: string;
	structureOnly: boolean;
	recursive?: boolean;
}): Promise<MaterializeDryRunResponse> {
	const folderRows = (await params.database('directus_folders').select('id', 'name', 'parent')) as FolderRow[];
	const folderMap = new Map(folderRows.map((row) => [String(row.id), { ...row, id: String(row.id), parent: row.parent ? String(row.parent) : null }]));
	const folderIds = await collectFolderIds(params.database, params.folderId);

	let query = params.database('directus_files')
		.select('id', 'storage', 'filename_disk', 'filesize', 'folder')
		.whereNotNull('filename_disk');
	if (params.recursive) {
		if (params.folderId !== null) {
			// current folder + all descendants
			query = query.whereIn('folder', [params.folderId, ...folderIds]);
		}
		// folderId === null + recursive → all files (no folder filter)
	} else if (params.folderId === null) {
		query = query.whereNull('folder');
	} else {
		query = query.whereIn('folder', folderIds);
	}

	const files = (await query) as Array<{ id: string; storage: string; filename_disk: string; filesize: number | null; folder: string | null }>;
	const storage = await getStorageManager();
	const seen = new Set<string>();
	let conflicts = 0;
	const byStorage = new Map<string, { files: number; bytes: number }>();
	const samples: Array<{ id: string; from: string; to_storage: string; to_path: string }> = [];

	for (const row of files) {
		const targetStorage = params.mode === 'merge' ? String(params.targetStorage || '') : String(row.storage);
		const folderPath = buildFolderPath(row.folder ? String(row.folder) : null, folderMap);
		const base = path.posix.basename(String(row.filename_disk || ''));
		const targetPath = folderPath ? `${folderPath}/${base}` : base;
		const key = `${targetStorage}::${targetPath}`;
		if (seen.has(key)) conflicts += 1;
		seen.add(key);
		const currentPath = String(row.filename_disk || '').replace(/\\/g, '/').replace(/^\/+/, '');
		const alreadyInPlace = row.storage === targetStorage && currentPath === targetPath;
		if (!alreadyInPlace) {
			try {
				const disk = storage.location(targetStorage);
				if (await diskExists(disk, targetPath)) conflicts += 1;
			} catch {
				// ignore dry-run target existence errors
			}
		}
		if (samples.length < 25) {
			samples.push({
				id: String(row.id),
				from: `${row.storage}:${row.filename_disk}`,
				to_storage: targetStorage,
				to_path: targetPath,
			});
		}
		const bucket = byStorage.get(targetStorage) || { files: 0, bytes: 0 };
		bucket.files += 1;
		bucket.bytes += Number(row.filesize) || 0;
		byStorage.set(targetStorage, bucket);
	}

	const uniqueFolders = new Set(files.map((f) => f.folder).filter(Boolean));

	return {
		folder_id: params.folderId,
		mode: params.mode,
		target_storage: params.mode === 'merge' ? params.targetStorage || null : null,
		structure_only: Boolean(params.structureOnly),
		total_files: files.length,
		total_folders: uniqueFolders.size,
		total_bytes: files.reduce((sum, f) => sum + (Number(f.filesize) || 0), 0),
		conflicts,
		samples,
		by_storage: Array.from(byStorage.entries()).map(([storageName, value]) => ({
			storage: storageName,
			files: value.files,
			bytes: value.bytes,
		})),
	};
}

export async function materializeRun(params: {
	database: any;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void };
	folderId: string | null;
	mode: MaterializeMode;
	targetStorage?: string;
	structureOnly: boolean;
	keepSourceFileOnDisk: boolean;
	recursive?: boolean;
	onProgress?: (event: MigrateProgressEvent) => void;
	isCancelled?: () => boolean;
}): Promise<MigrateResponse> {
	const folderRows = (await params.database('directus_folders').select('id', 'name', 'parent')) as FolderRow[];
	const folderMap = new Map(folderRows.map((row) => [String(row.id), { ...row, id: String(row.id), parent: row.parent ? String(row.parent) : null }]));
	const folderIds = await collectFolderIds(params.database, params.folderId);

	let query = params.database('directus_files')
		.select('id', 'storage', 'filename_disk', 'filesize', 'type', 'folder')
		.whereNotNull('filename_disk');
	if (params.recursive) {
		if (params.folderId !== null) {
			query = query.whereIn('folder', [params.folderId, ...folderIds]);
		}
	} else if (params.folderId === null) {
		query = query.whereNull('folder');
	} else {
		query = query.whereIn('folder', folderIds);
	}
	const files = (await query) as FileRow[];

	const results: any[] = [];
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;
	let totalBytes = 0;
	const startedAt = Date.now();

	for (const file of files) totalBytes += Number(file.filesize) || 0;
	let transferredBytes = 0;

	params.onProgress?.({
		type: 'start',
		mode: 'move',
		from: params.mode === 'merge' ? null : 'mixed',
		to: params.mode === 'merge' ? String(params.targetStorage || '') : 'preserve',
		total: files.length,
		total_bytes: totalBytes,
	});

	for (let index = 0; index < files.length; index++) {
		const file = files[index]!;
		if (params.isCancelled?.()) {
			break;
		}
		const targetStorage = params.mode === 'merge' ? String(params.targetStorage || '') : String(file.storage);
		const folderPath = buildFolderPath(file.folder ? String(file.folder) : null, folderMap);
		const base = path.posix.basename(String(file.filename_disk || ''));
		const targetPath = folderPath ? `${folderPath}/${base}` : base;
		const displayName = String(file.filename_disk || file.id);
		params.onProgress?.({
			type: 'file_start',
			index: index + 1,
			total: files.length,
			id: String(file.id),
			name: displayName,
			filename_disk: String(file.filename_disk || ''),
			from: String(file.storage),
			to: targetStorage,
			bytes: Number(file.filesize) || 0,
		});
		if (params.structureOnly) {
			const result = {
				id: file.id,
				status: 'skipped',
				filename_disk: targetPath,
				from: String(file.storage),
				to: targetStorage,
				error: 'Structure-only mode',
			};
			results.push(result);
			skipped += 1;
			params.onProgress?.({
				type: 'file_done',
				index: index + 1,
				total: files.length,
				result,
				name: displayName,
				succeeded,
				skipped,
				failed,
				transferred_bytes: transferredBytes,
				total_bytes: totalBytes,
				elapsed_ms: Date.now() - startedAt,
			});
			continue;
		}
		try {
			const result = await migrateOneFile(
				file,
				targetStorage,
				'move',
				params.database,
				params.logger,
				undefined,
				targetPath,
				Boolean(params.keepSourceFileOnDisk),
			);
			results.push(result);
			if (result.status === 'failed') failed += 1;
			else if (result.status === 'skipped') skipped += 1;
			else {
				succeeded += 1;
				transferredBytes += Number(result.bytes) || Number(file.filesize) || 0;
			}
			params.onProgress?.({
				type: 'file_done',
				index: index + 1,
				total: files.length,
				result,
				name: displayName,
				succeeded,
				skipped,
				failed,
				transferred_bytes: transferredBytes,
				total_bytes: totalBytes,
				elapsed_ms: Date.now() - startedAt,
			});
		} catch (error: any) {
			const result = {
				id: file.id,
				status: 'failed',
				filename_disk: targetPath,
				from: String(file.storage),
				to: targetStorage,
				error: error?.message || 'Materialize failed',
			};
			results.push(result);
			failed += 1;
			params.onProgress?.({
				type: 'file_done',
				index: index + 1,
				total: files.length,
				result,
				name: displayName,
				succeeded,
				skipped,
				failed,
				transferred_bytes: transferredBytes,
				total_bytes: totalBytes,
				elapsed_ms: Date.now() - startedAt,
			});
		}
	}

	const response: MigrateResponse = {
		mode: 'move',
		target_storage: params.mode === 'merge' ? String(params.targetStorage || '') : 'preserve',
		total: files.length,
		succeeded,
		failed,
		skipped,
		results,
		transferred_bytes: transferredBytes,
		total_bytes: totalBytes,
		elapsed_ms: Date.now() - startedAt,
	};
	params.onProgress?.({ type: 'done', data: response });
	return response;
}
