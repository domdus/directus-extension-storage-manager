import { relocateFilesWithPrefixChange } from '../endpoint/physical-folders';
import type { StorageLocationSettings } from '../shared/types';
import {
	buildFolderPath,
	buildFolderPathById,
	findSiblingIdsByName,
	isIdMirrorStrategy,
	isMirrorStrategy,
	isNameMirrorStrategy,
} from './prefix';

type Logger = {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
};

const LARGE_RELOCATE_WARN = 100;

/** Locations with folder sync + by-name mirror (rename / collision path moves). */
function renameSyncLocations(allSettings: Record<string, StorageLocationSettings>): string[] {
	return Object.entries(allSettings)
		.filter(
			([, s]) =>
				s.folder_sync_enabled &&
				isNameMirrorStrategy(s.prefix_strategy) &&
				s.folder_sync_rename === 'full_sync',
		)
		.map(([loc]) => loc);
}

/** Locations with Sync Folder Changes + any mirror strategy (delete → move to parent). */
function deleteSyncLocations(allSettings: Record<string, StorageLocationSettings>): string[] {
	return Object.entries(allSettings)
		.filter(([, s]) => s.folder_sync_enabled && isMirrorStrategy(s.prefix_strategy))
		.map(([loc]) => loc);
}

async function relocatePrefixOnLocations(
	database: any,
	locations: string[],
	oldPath: string,
	newPath: string,
	logger: Logger,
): Promise<void> {
	if (!oldPath || oldPath === newPath) return;
	for (const location of locations) {
		try {
			const countRows = await database('directus_files')
				.count({ c: '*' })
				.where('storage', location)
				.whereRaw('filename_disk LIKE ?', [`${oldPath}/%`])
				.first();
			const count = Number((countRows as any)?.c ?? 0);
			if (count >= LARGE_RELOCATE_WARN) {
				logger.warn(
					`[storage-manager] Folder path sync on ${location}: relocating ${count} files (“${oldPath}” → “${newPath || '(root)'}”) — this may take a while`,
				);
			}

			const { moved, failed } = await relocateFilesWithPrefixChange(
				database,
				location,
				oldPath,
				newPath,
				logger,
			);
			if (moved || failed) {
				logger.info(
					`[storage-manager] Folder path sync on ${location}: "${oldPath}" → "${newPath || '(root)'}" (moved=${moved}, failed=${failed})`,
				);
			}
		} catch (err: any) {
			logger.error(`[storage-manager] Folder path sync failed for ${location}: ${err?.message}`);
		}
	}
}

export type FolderDeletePathCapture = {
	/** location → physical path of the folder being deleted */
	folderPaths: Record<string, string>;
	/** location → physical path of the parent ('' = storage root) */
	parentPaths: Record<string, string>;
};

/**
 * Capture per-location physical prefixes for a folder about to be deleted,
 * plus its parent prefix (for move-to-parent relocate).
 */
export async function captureFolderDeletePaths(
	folderId: string,
	database: any,
	allLocationSettings: Record<string, StorageLocationSettings>,
): Promise<FolderDeletePathCapture> {
	const folderPaths: Record<string, string> = {};
	const parentPaths: Record<string, string> = {};

	const row = await database('directus_folders').select('id', 'parent').where('id', folderId).first();
	const parentId = row?.parent ? String(row.parent) : null;

	for (const location of deleteSyncLocations(allLocationSettings)) {
		const settings = allLocationSettings[location]!;
		let folderPath: string | null = null;
		let parentPath = '';

		if (isNameMirrorStrategy(settings.prefix_strategy)) {
			folderPath = await buildFolderPath(database, folderId);
			parentPath = parentId ? (await buildFolderPath(database, parentId)) || '' : '';
		} else if (isIdMirrorStrategy(settings.prefix_strategy)) {
			folderPath = await buildFolderPathById(database, folderId);
			parentPath = parentId ? (await buildFolderPathById(database, parentId)) || '' : '';
		}

		if (folderPath) {
			folderPaths[location] = folderPath;
			parentPaths[location] = parentPath;
		}
	}

	return { folderPaths, parentPaths };
}

/**
 * Before a by-name folder rename: snapshot storage paths for every folder whose
 * path segment may change (the folder itself + old-name siblings + new-name siblings).
 */
export async function captureFolderRenamePathSnapshot(
	folderId: string,
	newName: string,
	database: any,
): Promise<Record<string, string> | null> {
	const row = await database('directus_folders').select('id', 'name', 'parent').where('id', folderId).first();
	if (!row) return null;
	const oldName = String(row.name);
	if (oldName === newName) return null;

	const parent = row.parent ? String(row.parent) : null;
	const affected = new Set<string>([
		folderId,
		...(await findSiblingIdsByName(database, parent, oldName)),
		...(await findSiblingIdsByName(database, parent, newName)),
	]);

	const snapshot: Record<string, string> = {};
	for (const id of affected) {
		const path = await buildFolderPath(database, id);
		if (path) snapshot[id] = path;
	}
	return snapshot;
}

/**
 * Before a by-name folder delete: snapshot sibling paths that may lose collision suffixes.
 */
export async function captureSiblingPathsBeforeDelete(
	folderId: string,
	database: any,
): Promise<{ parent: string | null; name: string; siblingOldPaths: Record<string, string> } | null> {
	const row = await database('directus_folders').select('id', 'name', 'parent').where('id', folderId).first();
	if (!row) return null;
	const name = String(row.name);
	const parent = row.parent ? String(row.parent) : null;
	const siblingIds = (await findSiblingIdsByName(database, parent, name)).filter((id) => id !== folderId);
	const siblingOldPaths: Record<string, string> = {};
	for (const id of siblingIds) {
		const path = await buildFolderPath(database, id);
		if (path) siblingOldPaths[id] = path;
	}
	return { parent, name, siblingOldPaths };
}

/**
 * Apply by-name path changes after a rename (folder + any siblings affected by collisions).
 */
export async function onFolderRenamed(
	folderId: string,
	oldPaths: Record<string, string>,
	database: any,
	allLocationSettings: Record<string, StorageLocationSettings>,
	logger: Logger,
): Promise<void> {
	const locations = renameSyncLocations(allLocationSettings);
	if (!locations.length) return;

	for (const [id, oldPath] of Object.entries(oldPaths)) {
		const newPath = await buildFolderPath(database, id);
		if (!newPath || !oldPath || newPath === oldPath) continue;
		await relocatePrefixOnLocations(database, locations, oldPath, newPath, logger);
	}
}

/**
 * After a folder delete: relocate remaining same-name siblings when their path
 * changes (e.g. sole survivor promotes from `name_<uid>` to plain `name`).
 * Does not reassign the sticky plain-name claim to another sibling.
 */
export async function onFolderDeleteSiblingResync(
	siblingOldPaths: Record<string, string>,
	database: any,
	allLocationSettings: Record<string, StorageLocationSettings>,
	logger: Logger,
): Promise<void> {
	const locations = renameSyncLocations(allLocationSettings);
	if (!locations.length) return;

	for (const [id, oldPath] of Object.entries(siblingOldPaths)) {
		const newPath = await buildFolderPath(database, id);
		if (!newPath || !oldPath || newPath === oldPath) continue;
		await relocatePrefixOnLocations(database, locations, oldPath, newPath, logger);
	}
}

/**
 * After a virtual folder is deleted (File Library move-to-parent or empty delete):
 * relocate remaining registered files from the deleted folder’s storage prefix up to the parent.
 * Never deletes files — matches File Library’s “move content to parent” behaviour on disk.
 * If files were recursively deleted in Directus first, the prefix is already empty (no-op).
 */
export async function onFolderDeleted(
	_folderId: string,
	folderPaths: Record<string, string>,
	parentPaths: Record<string, string>,
	database: any,
	allLocationSettings: Record<string, StorageLocationSettings>,
	logger: Logger,
): Promise<void> {
	for (const [location, folderPath] of Object.entries(folderPaths)) {
		const settings = allLocationSettings[location];
		if (!settings?.folder_sync_enabled || !isMirrorStrategy(settings.prefix_strategy)) continue;

		const parentPath = parentPaths[location] ?? '';
		await relocatePrefixOnLocations(database, [location], folderPath, parentPath, logger);
	}
}
