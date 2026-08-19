import {
	STORAGE_MANAGER_FIELD,
	STORAGE_MANAGER_LOCATION_DEFAULTS,
	type StorageLocationSettings,
	type StorageManagerSettings,
} from '../shared/types';

/** In-process cache: invalidated whenever settings are saved. */
let settingsCache: StorageManagerSettings | null = null;

export function invalidateSettingsCache(): void {
	settingsCache = null;
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

function emptySettings(): StorageManagerSettings {
	return { locations: {} };
}

function isMissingColumnError(err: unknown): boolean {
	const message = String((err as { message?: string })?.message || err || '');
	return /does not exist|unknown column|no such column/i.test(message);
}

export async function loadSettings(database: any): Promise<StorageManagerSettings> {
	if (settingsCache) return settingsCache;
	try {
		const hasColumn = await database.schema.hasColumn('directus_settings', STORAGE_MANAGER_FIELD);
		if (!hasColumn) {
			settingsCache = emptySettings();
			return settingsCache;
		}
		const row = await database('directus_settings').select(STORAGE_MANAGER_FIELD).first();
		const raw = row?.[STORAGE_MANAGER_FIELD];
		const parsed: Partial<StorageManagerSettings> =
			typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
		const result: StorageManagerSettings = {
			locations: parsed.locations ?? {},
		};
		if (parsed && typeof parsed === 'object' && 'name_mirror_claims' in parsed) {
			result.name_mirror_claims = normalizeNameMirrorClaims(parsed.name_mirror_claims);
		}
		settingsCache = result;
		return settingsCache;
	} catch (err) {
		if (isMissingColumnError(err)) {
			settingsCache = emptySettings();
			return settingsCache;
		}
		throw err;
	}
}

export async function saveSettings(database: any, settings: StorageManagerSettings): Promise<void> {
	await database('directus_settings').update({
		[STORAGE_MANAGER_FIELD]: JSON.stringify(settings),
	});
	settingsCache = settings;
}

export function getLocationSettings(
	settings: StorageManagerSettings,
	location: string,
): StorageLocationSettings {
	return {
		...STORAGE_MANAGER_LOCATION_DEFAULTS,
		...(settings.locations[location] ?? {}),
	};
}

/**
 * Create `directus_settings.storage_manager` if missing.
 * Called on server start and on the first Storage Manager API request (Marketplace
 * install does not restart Directus, so server.start has already run).
 */
export async function ensureSettingsField(
	database: any,
	services: Record<string, any>,
	getSchema: () => Promise<any>,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
	try {
		const hasColumn = await database.schema.hasColumn('directus_settings', STORAGE_MANAGER_FIELD);
		if (hasColumn) return;

		const schema = await getSchema();
		const fieldsService = new services.FieldsService({
			database,
			schema,
			accountability: { admin: true },
		});
		const existingFields = await fieldsService.readAll('directus_settings');
		const alreadyRegistered = existingFields?.some((f: any) => f.field === STORAGE_MANAGER_FIELD);
		if (alreadyRegistered && hasColumn) return;

		await fieldsService.createField('directus_settings', {
			field: STORAGE_MANAGER_FIELD,
			type: 'json',
			meta: {
				collection: 'directus_settings',
				field: STORAGE_MANAGER_FIELD,
				special: ['cast-json'],
				interface: 'input-code',
				hidden: true,
				note: 'Storage Manager extension settings (do not edit manually)',
			},
			schema: null,
		});
		invalidateSettingsCache();
		logger.info(`[storage-manager] Created directus_settings.${STORAGE_MANAGER_FIELD}`);
	} catch (err: any) {
		logger.warn(`[storage-manager] Could not ensure settings field: ${err?.message}`);
	}
}
