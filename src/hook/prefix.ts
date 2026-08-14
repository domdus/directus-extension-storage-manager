import type { PrefixStrategy, StorageLocationSettings } from '../shared/types';
import {
	buildSiblingNameIndex,
	loadFolderRows,
	siblingGroupKey,
	type FolderRow,
} from './folder-tree';
import { ensureNameMirrorClaims } from './name-mirror-claims';

export type { FolderRow } from './folder-tree';
export {
	buildSiblingNameIndex,
	findSiblingIdsByName,
	loadFolderRows,
	siblingGroupKey,
} from './folder-tree';

export function isNameMirrorStrategy(strategy: PrefixStrategy): boolean {
	return strategy === 'folder';
}

export function isIdMirrorStrategy(strategy: PrefixStrategy): boolean {
	return strategy === 'folder_id';
}

export function isMirrorStrategy(strategy: PrefixStrategy): boolean {
	return isNameMirrorStrategy(strategy) || isIdMirrorStrategy(strategy);
}

/**
 * By-name mirror segment for one folder.
 * Alone among siblings → plain `name`.
 * With duplicates → claim holder keeps plain `name`; others → `name_<folderId>`.
 * No claim among multiples → all use `name_<folderId>` (no UUID reassignment).
 */
export function nameMirrorPathSegment(
	name: string,
	folderId: string,
	siblingIds: string[],
	claimHolderId: string | null | undefined,
): string {
	const ids = siblingIds.length ? siblingIds : [folderId];
	if (ids.length <= 1) return name;
	if (claimHolderId === folderId) return name;
	return `${name}_${folderId}`;
}

/**
 * Walk the directus_folders tree upward from `folderId` and return a
 * slash-joined path of folder **names**, with sticky first-wins collision handling.
 * e.g. "articles/drafts" or "articles/drafts_<uuid>".
 */
export async function buildFolderPath(database: any, folderId: string | null | undefined): Promise<string | null> {
	if (!folderId) return null;
	const folders = await loadFolderRows(database);
	const claims = await ensureNameMirrorClaims(database);
	return buildFolderPathFromRows(folders, folderId, 'name', claims);
}

/**
 * Walk the directus_folders tree upward from `folderId` and return a
 * slash-joined path of folder **ids**, e.g. "uuid-parent/uuid-child".
 */
export async function buildFolderPathById(database: any, folderId: string | null | undefined): Promise<string | null> {
	if (!folderId) return null;
	const folders = await loadFolderRows(database);
	return buildFolderPathFromRows(folders, folderId, 'id');
}

export function buildFolderPathFromRows(
	folders: FolderRow[],
	folderId: string | null | undefined,
	mode: 'name' | 'id',
	claims: Record<string, string> = {},
): string | null {
	if (!folderId) return null;

	const map = new Map<string, FolderRow>();
	for (const folder of folders) map.set(folder.id, folder);

	const siblingIndex = mode === 'name' ? buildSiblingNameIndex(folders) : null;

	const parts: string[] = [];
	let current: string | null = String(folderId);
	let depth = 0;
	while (current && depth < 50) {
		const node = map.get(current);
		if (!node) break;
		if (mode === 'id') {
			parts.unshift(current);
		} else {
			const key = siblingGroupKey(node.parent, node.name);
			const siblings = siblingIndex!.get(key) ?? [node.id];
			parts.unshift(nameMirrorPathSegment(node.name, node.id, siblings, claims[key] ?? null));
		}
		current = node.parent;
		depth++;
	}
	return parts.length ? parts.join('/') : null;
}

/** Format a date string/ISO according to a simple template: yyyy, MM, dd. */
function formatDate(dateStr: string | null | undefined, fmt: string): string {
	const d = dateStr ? new Date(dateStr) : new Date();
	return fmt
		.replace('yyyy', String(d.getUTCFullYear()))
		.replace('MM', String(d.getUTCMonth() + 1).padStart(2, '0'))
		.replace('dd', String(d.getUTCDate()).padStart(2, '0'));
}

/** Map a full mime type like "image/jpeg" to a broad category key. */
function mimeCategory(mime: string | null | undefined): string {
	if (!mime) return 'other';
	const main = mime.split('/')[0] ?? 'other';
	return main; // 'image', 'video', 'audio', 'text', 'application' ...
}

/**
 * Build the storage prefix for a file being created.
 *
 * @param settings  Per-location settings for the target storage.
 * @param input     The payload from the files.create filter (partial FileRow).
 * @param database  Knex database instance (needed for folder strategies).
 * @returns         A prefix string like "images" or nested folder path,
 *                  or null when no prefix should be applied.
 */
export async function buildPrefix(
	settings: StorageLocationSettings,
	input: Record<string, any>,
	database: any,
): Promise<string | null> {
	switch (settings.prefix_strategy) {
		case 'none':
			return null;

		case 'folder': {
			const path = await buildFolderPath(database, input.folder);
			return path || null;
		}

		case 'folder_id': {
			const path = await buildFolderPathById(database, input.folder);
			return path || null;
		}

		case 'type': {
			const cat = mimeCategory(input.type);
			const path = settings.type_map[cat] ?? settings.type_map['other'] ?? cat;
			return path || null;
		}

		case 'date': {
			const fmt = settings.date_format || 'yyyy/MM';
			return formatDate(input.uploaded_on, fmt);
		}

		default:
			return null;
	}
}
