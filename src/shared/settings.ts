import {
	STORAGE_MANAGER_LOCATION_DEFAULTS,
	type PrefixStrategy,
	type StorageLocationSettings,
	type StorageManagerSettings,
} from './types';
import { normalizeLifecycleSettings } from './lifecycle';

const VALID_STRATEGIES: PrefixStrategy[] = ['none', 'folder', 'folder_id', 'type', 'date'];
const VALID_RENAME = ['full_sync', 'leave_old'] as const;

function normalizeLocationSettings(raw: unknown): StorageLocationSettings {
	const partial = (raw && typeof raw === 'object' ? raw : {}) as Partial<StorageLocationSettings> & {
		collection_template?: unknown;
	};
	const prefix_strategy = VALID_STRATEGIES.includes(partial.prefix_strategy as PrefixStrategy)
		? (partial.prefix_strategy as PrefixStrategy)
		: STORAGE_MANAGER_LOCATION_DEFAULTS.prefix_strategy;

	return {
		prefix_strategy,
		folder_sync_enabled: Boolean(partial.folder_sync_enabled),
		folder_sync_rename: VALID_RENAME.includes(partial.folder_sync_rename as any)
			? partial.folder_sync_rename!
			: STORAGE_MANAGER_LOCATION_DEFAULTS.folder_sync_rename,
		// Legacy delete_empty / retain → always move_to_parent (never delete files via sync).
		folder_sync_delete: 'move_to_parent',
		date_format:
			typeof partial.date_format === 'string' && partial.date_format.trim()
				? partial.date_format.trim()
				: STORAGE_MANAGER_LOCATION_DEFAULTS.date_format,
		type_map: {
			...STORAGE_MANAGER_LOCATION_DEFAULTS.type_map,
			...(partial.type_map && typeof partial.type_map === 'object' && !Array.isArray(partial.type_map)
				? partial.type_map
				: {}),
		},
	};
}

export function normalizeStorageManagerSettings(raw: unknown): StorageManagerSettings {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Invalid JSON: expected an object');
	}

	const candidate = raw as Record<string, unknown>;
	const source =
		candidate.storage_manager && typeof candidate.storage_manager === 'object'
			? candidate.storage_manager
			: candidate;

	if (!source || typeof source !== 'object') {
		throw new Error('Invalid config: expected storage_manager object');
	}

	const locationsRaw = (source as Record<string, unknown>).locations;
	if (!locationsRaw || typeof locationsRaw !== 'object' || Array.isArray(locationsRaw)) {
		throw new Error('Invalid config: missing locations object');
	}

	const locations: Record<string, StorageLocationSettings> = {};
	for (const [loc, partial] of Object.entries(locationsRaw as Record<string, unknown>)) {
		if (!loc.trim()) continue;
		locations[loc] = normalizeLocationSettings(partial);
	}

	const result: StorageManagerSettings = { locations };
	if ('name_mirror_claims' in source) {
		result.name_mirror_claims = normalizeNameMirrorClaims(
			(source as Record<string, unknown>).name_mirror_claims,
		);
	}
	if ('lifecycle' in source) {
		result.lifecycle = normalizeLifecycleSettings((source as Record<string, unknown>).lifecycle);
	}
	return result;
}

function normalizeNameMirrorClaims(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof key === 'string' && key && typeof value === 'string' && value) {
			out[key] = value;
		}
	}
	return out;
}

export function serializeStorageManagerSettings(raw: unknown): StorageManagerSettings {
	return normalizeStorageManagerSettings({ locations: {}, ...(raw as object) });
}

/** PATCH payload for the overview Mirror Directus Folders toggle. */
export function directusFolderMirrorPatch(enabled: boolean): Partial<StorageLocationSettings> {
	return enabled
		? { prefix_strategy: 'folder', folder_sync_enabled: true, folder_sync_rename: 'full_sync' }
		: { prefix_strategy: 'none', folder_sync_enabled: false };
}
