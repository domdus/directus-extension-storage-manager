import { defineHook } from '@directus/extensions-sdk';
import {
	ensureSettingsField,
	getLocationSettings,
	invalidateSettingsCache,
	loadSettings,
} from './settings';
import { buildPrefix, isMirrorStrategy, isNameMirrorStrategy } from './prefix';
import {
	captureFolderDeletePaths,
	captureFolderRenamePathSnapshot,
	captureSiblingPathsBeforeDelete,
	onFolderDeleteSiblingResync,
	onFolderDeleted,
	onFolderRenamed,
} from './folder-sync';
import {
	captureFolderClaimIdentity,
	onFolderCreatedForClaims,
	onFolderDeletedForClaims,
	onFolderRenamedForClaims,
} from './name-mirror-claims';
import { STORAGE_MANAGER_FIELD } from '../shared/types';

export default defineHook(({ filter, action }, { database, env, services, getSchema, logger }) => {
	// ── Auto-create settings field on server start ─────────────────────────
	action('server.start', async () => {
		await ensureSettingsField(database, services, getSchema, logger);
	});

	// ── Invalidate settings cache whenever settings are saved ──────────────
	filter('settings.update', (payload: Record<string, any>) => {
		if (STORAGE_MANAGER_FIELD in payload) {
			invalidateSettingsCache();
		}
		return payload;
	});

	// ── Prefix injection on file upload ────────────────────────────────────
	filter('files.create', async (input: Record<string, any>) => {
		try {
			const envLocations = String(env['STORAGE_LOCATIONS'] ?? 'local')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const location: string = String(input.storage ?? envLocations[0] ?? 'local');

			const settings = await loadSettings(database);
			const locSettings = getLocationSettings(settings, location);

			if (locSettings.prefix_strategy === 'none') return input;

			const prefix = await buildPrefix(locSettings, input, database);
			if (!prefix) return input;

			const current: string = String(input.filename_disk ?? '');
			if (!current.startsWith(prefix + '/')) {
				input.filename_disk = `${prefix}/${current}`;
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Prefix injection failed: ${err?.message}`);
		}
		return input;
	});

	// ── Sticky name claims: first folder under parent+name keeps plain path ──
	action('folders.create', async (meta: { key?: string; keys?: string[] }) => {
		try {
			const keys = meta.keys ?? (meta.key ? [meta.key] : []);
			for (const key of keys) {
				await onFolderCreatedForClaims(key, database, logger);
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Folder create claim update failed: ${err?.message}`);
		}
	});

	// ── Folder sync: rename (by-name mirror only, includes collision reshuffles) ──
	const pendingRenames = new Map<string, Record<string, string>>(); // folderId → id→oldPath
	const pendingRenameClaims = new Map<
		string,
		{ oldName: string; newName: string; parent: string | null }
	>();

	filter('folders.update', async (payload: Record<string, any>, meta: { keys?: string[]; key?: string }) => {
		if (!payload.name) return payload;
		try {
			const settings = await loadSettings(database);
			const hasSyncLocation = Object.values(settings.locations).some(
				(s) =>
					s.folder_sync_enabled &&
					isNameMirrorStrategy(s.prefix_strategy) &&
					s.folder_sync_rename === 'full_sync',
			);

			const keys = meta.keys ?? (meta.key ? [meta.key] : []);
			const newName = String(payload.name);
			for (const key of keys) {
				const row = await database('directus_folders')
					.select('name', 'parent')
					.where('id', key)
					.first();
				if (row) {
					pendingRenameClaims.set(key, {
						oldName: String(row.name),
						newName,
						parent: row.parent ? String(row.parent) : null,
					});
				}

				if (!hasSyncLocation) continue;
				const snapshot = await captureFolderRenamePathSnapshot(key, newName, database);
				if (snapshot && Object.keys(snapshot).length) {
					pendingRenames.set(key, snapshot);
				}
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Folder rename pre-capture failed: ${err?.message}`);
		}
		return payload;
	});

	action('folders.update', async (meta: { keys?: string[]; key?: string; payload?: Record<string, any> }) => {
		if (!meta.payload?.name) return;
		try {
			const settings = await loadSettings(database);
			const keys = meta.keys ?? (meta.key ? [meta.key] : []);
			for (const key of keys) {
				const claimInfo = pendingRenameClaims.get(key);
				pendingRenameClaims.delete(key);
				if (claimInfo) {
					await onFolderRenamedForClaims(
						key,
						claimInfo.oldName,
						claimInfo.newName,
						claimInfo.parent,
						database,
						logger,
					);
				}

				const oldPaths = pendingRenames.get(key);
				pendingRenames.delete(key);
				if (!oldPaths) continue;
				await onFolderRenamed(key, oldPaths, database, settings.locations, logger);
			}
		} catch (err: any) {
			logger.error(`[storage-manager] Folder rename sync error: ${err?.message}`);
		}
	});

	// ── Folder sync: delete ────────────────────────────────────────────────
	const pendingDeletePaths = new Map<
		string,
		{ folderPaths: Record<string, string>; parentPaths: Record<string, string> }
	>();
	const pendingDeleteSiblings = new Map<string, Record<string, string>>(); // folderId → siblingId → oldPath
	const pendingDeleteClaims = new Map<string, { parent: string | null; name: string }>();

	filter('folders.delete', async (keys: string[]) => {
		try {
			const settings = await loadSettings(database);
			const hasSyncLocation = Object.values(settings.locations).some(
				(s) => s.folder_sync_enabled && isMirrorStrategy(s.prefix_strategy),
			);

			const hasRenameSync = Object.values(settings.locations).some(
				(s) =>
					s.folder_sync_enabled &&
					isNameMirrorStrategy(s.prefix_strategy) &&
					s.folder_sync_rename === 'full_sync',
			);

			for (const key of keys) {
				const identity = await captureFolderClaimIdentity(key, database);
				if (identity) pendingDeleteClaims.set(key, identity);

				if (!hasSyncLocation) continue;

				const captured = await captureFolderDeletePaths(key, database, settings.locations);
				if (Object.keys(captured.folderPaths).length) {
					pendingDeletePaths.set(key, captured);
				}

				if (hasRenameSync) {
					const siblingSnap = await captureSiblingPathsBeforeDelete(key, database);
					if (siblingSnap && Object.keys(siblingSnap.siblingOldPaths).length) {
						pendingDeleteSiblings.set(key, siblingSnap.siblingOldPaths);
					}
				}
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Folder delete pre-capture failed: ${err?.message}`);
		}
		return keys;
	});

	action('folders.delete', async (meta: { keys?: string[] }) => {
		const keys = meta.keys ?? [];
		try {
			const settings = await loadSettings(database);
			for (const key of keys) {
				const identity = pendingDeleteClaims.get(key);
				pendingDeleteClaims.delete(key);
				if (identity) {
					await onFolderDeletedForClaims(key, identity.parent, identity.name, database, logger);
				}

				const captured = pendingDeletePaths.get(key);
				pendingDeletePaths.delete(key);
				if (captured) {
					await onFolderDeleted(
						key,
						captured.folderPaths,
						captured.parentPaths,
						database,
						settings.locations,
						logger,
					);
				}

				const siblingOldPaths = pendingDeleteSiblings.get(key);
				pendingDeleteSiblings.delete(key);
				if (siblingOldPaths) {
					await onFolderDeleteSiblingResync(siblingOldPaths, database, settings.locations, logger);
				}
			}
		} catch (err: any) {
			logger.error(`[storage-manager] Folder delete sync error: ${err?.message}`);
		}
	});
});
