import type { StorageManagerSettings } from '../shared/types';
import {
	buildSiblingNameIndex,
	findSiblingIdsByName,
	loadFolderRows,
	siblingGroupKey,
	type FolderRow,
} from './folder-tree';
import { loadSettings, saveSettings, invalidateSettingsCache } from './settings';

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

/**
 * Legacy bootstrap: freeze previous "smallest id keeps plain name" owners as sticky claims.
 * Only used when `name_mirror_claims` has never been written.
 */
export function bootstrapClaimsFromFolders(folders: FolderRow[]): Record<string, string> {
	const claims: Record<string, string> = {};
	const index = buildSiblingNameIndex(folders);
	for (const [key, ids] of index) {
		if (ids[0]) claims[key] = ids[0];
	}
	return claims;
}

/**
 * Return sticky name-mirror claims, bootstrapping once from current folders if needed.
 */
export async function ensureNameMirrorClaims(
	database: any,
	logger?: Logger,
): Promise<Record<string, string>> {
	const settings = await loadSettings(database);
	if (settings.name_mirror_claims !== undefined) {
		return settings.name_mirror_claims;
	}

	const folders = await loadFolderRows(database);
	const claims = bootstrapClaimsFromFolders(folders);
	// Re-read immediately before write — folder create can race with recycle enable.
	invalidateSettingsCache();
	const latest = await loadSettings(database);
	if (latest.name_mirror_claims !== undefined) {
		return latest.name_mirror_claims;
	}
	await saveSettings(database, {
		...latest,
		name_mirror_claims: claims,
	});
	logger?.info(
		`[storage-manager] Initialized name_mirror_claims (${Object.keys(claims).length} sibling groups)`,
	);
	return claims;
}

async function persistClaims(database: any, claims: Record<string, string>): Promise<void> {
	invalidateSettingsCache();
	const settings = await loadSettings(database);
	await saveSettings(database, {
		...settings,
		name_mirror_claims: claims,
	});
}

/** First folder under a parent+name claims the plain segment; later creates do not. */
export async function onFolderCreatedForClaims(
	folderId: string,
	database: any,
	logger?: Logger,
): Promise<void> {
	const row = await database('directus_folders').select('id', 'name', 'parent').where('id', folderId).first();
	if (!row) return;

	const name = String(row.name);
	const parent = row.parent ? String(row.parent) : null;
	const key = siblingGroupKey(parent, name);
	const claims = { ...(await ensureNameMirrorClaims(database, logger)) };
	const siblings = await findSiblingIdsByName(database, parent, name);
	const others = siblings.filter((id) => id !== folderId);

	if (others.length === 0) {
		if (claims[key] !== folderId) {
			claims[key] = folderId;
			await persistClaims(database, claims);
		}
		return;
	}

	// Later sibling: do not take an existing claim; do not invent one for multi without claim.
	if (!claims[key]) {
		return;
	}
}

/**
 * After rename: release old claim if held; claim new name only when alone (or already holder).
 */
export async function onFolderRenamedForClaims(
	folderId: string,
	oldName: string,
	newName: string,
	parent: string | null,
	database: any,
	logger?: Logger,
): Promise<void> {
	if (oldName === newName) return;

	const claims = { ...(await ensureNameMirrorClaims(database, logger)) };
	const oldKey = siblingGroupKey(parent, oldName);
	const newKey = siblingGroupKey(parent, newName);
	let dirty = false;

	if (claims[oldKey] === folderId) {
		delete claims[oldKey];
		dirty = true;
	}

	const newSiblings = await findSiblingIdsByName(database, parent, newName);
	const others = newSiblings.filter((id) => id !== folderId);

	if (others.length === 0) {
		if (claims[newKey] !== folderId) {
			claims[newKey] = folderId;
			dirty = true;
		}
	} else if (claims[newKey] === folderId) {
		// still the holder among duplicates — fine
	} else if (!claims[newKey]) {
		// do not steal plain name among existing same-name siblings
	}

	if (dirty) await persistClaims(database, claims);
}

/** Clear claim when the owning folder is deleted; never reassign to another sibling. */
export async function onFolderDeletedForClaims(
	folderId: string,
	parent: string | null,
	name: string,
	database: any,
	logger?: Logger,
): Promise<void> {
	const claims = { ...(await ensureNameMirrorClaims(database, logger)) };
	const key = siblingGroupKey(parent, name);
	if (claims[key] !== folderId) return;
	delete claims[key];
	await persistClaims(database, claims);
}

/** Snapshot parent/name before delete for claim cleanup after the row is gone. */
export async function captureFolderClaimIdentity(
	folderId: string,
	database: any,
): Promise<{ parent: string | null; name: string } | null> {
	const row = await database('directus_folders').select('name', 'parent').where('id', folderId).first();
	if (!row) return null;
	return {
		name: String(row.name),
		parent: row.parent ? String(row.parent) : null,
	};
}
