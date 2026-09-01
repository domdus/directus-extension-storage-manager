import { accountabilityIsAdmin } from '../shared/admin';
import { RECYCLE_TRASHED_AT_FIELD } from '../shared/recycle';
import { diskDeleteTransformsOnly, getStorageManager } from '../endpoint/storage';
import { resolveRecycleFolderId } from '../endpoint/recycle';
import { loadSettings } from './settings';
import { normalizeRecycleSettings } from '../shared/recycle';

type Logger = {
	warn: (msg: string, ...args: unknown[]) => void;
	info?: (msg: string, ...args: unknown[]) => void;
};

type HookContext = {
	database: any;
	logger: Logger;
};

const ASSET_ID_RE = /^\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Stamp/clear trashed_at, drop transforms on enter, hide recycle files from library
 * browse/search (unless viewing the recycle folder or loading by id), and block /assets
 * for recycle files (AssetsService uses sudo reads — files.read alone cannot stop them).
 */
export function registerRecycleHooks(
	{ filter, action, init }: { filter: any; action: any; init: any },
	{ database, logger }: HookContext,
) {
	filter('files.create', async (input: Record<string, any>) => {
		try {
			const recycleId = await resolveRecycleFolderId(database);
			if (!recycleId) return input;
			const settings = await loadSettings(database);
			const field = normalizeRecycleSettings(settings.recycle).field || RECYCLE_TRASHED_AT_FIELD;
			if (String(input.folder || '') === recycleId) {
				input[field] = new Date().toISOString();
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Recycle create stamp failed: ${err?.message || err}`);
		}
		return input;
	});

	filter('files.update', async (payload: Record<string, any>, meta: { keys?: string[] }) => {
		try {
			if (!payload || !('folder' in payload)) return payload;
			const recycleId = await resolveRecycleFolderId(database);
			if (!recycleId) return payload;

			const settings = await loadSettings(database);
			const field = normalizeRecycleSettings(settings.recycle).field || RECYCLE_TRASHED_AT_FIELD;
			const nextFolder = payload.folder == null || payload.folder === '' ? null : String(payload.folder);

			if (nextFolder === recycleId) {
				payload[field] = new Date().toISOString();
				return payload;
			}

			const keys = (meta.keys || []).map(String).filter(Boolean);
			if (!keys.length) {
				payload[field] = null;
				return payload;
			}

			const inRecycle = await database('directus_files')
				.select('id')
				.whereIn('id', keys)
				.andWhere({ folder: recycleId });
			if (inRecycle?.length) {
				payload[field] = null;
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Recycle update stamp failed: ${err?.message || err}`);
		}
		return payload;
	});

	action('files.update', async (meta: { keys?: string[]; payload?: Record<string, any> }) => {
		try {
			if (!meta.payload || !('folder' in meta.payload)) return;
			const recycleId = await resolveRecycleFolderId(database);
			if (!recycleId) return;
			const nextFolder =
				meta.payload.folder == null || meta.payload.folder === ''
					? null
					: String(meta.payload.folder);
			if (nextFolder !== recycleId) return;

			const keys = (meta.keys || []).map(String).filter(Boolean);
			if (!keys.length) return;

			const rows = await database('directus_files')
				.select('id', 'storage', 'filename_disk')
				.whereIn('id', keys)
				.andWhere({ folder: recycleId });
			if (!rows?.length) return;

			const storage = await getStorageManager();
			for (const row of rows) {
				try {
					const disk = storage.location(String(row.storage));
					await diskDeleteTransformsOnly(disk, String(row.filename_disk || ''));
				} catch (err: any) {
					logger.warn(
						`[storage-manager] Recycle transform cleanup failed for ${row.id}: ${err?.message || err}`,
					);
				}
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] Recycle post-update cleanup failed: ${err?.message || err}`);
		}
	});

	// Exclude recycle from browse/search/picker queries (admins included).
	// Keep: explicit recycle-folder browse, and id lookups (relations / open drawer).
	filter('files.query', async (query: Record<string, any>) => {
		try {
			const recycleId = await resolveRecycleFolderId(database);
			if (!recycleId || !query || typeof query !== 'object') return query;
			if (queryAllowsRecycleVisibility(query.filter, recycleId)) return query;

			const exclusion = {
				_or: [{ folder: { _neq: recycleId } }, { folder: { _null: true } }],
			};
			const existing = query.filter;
			query.filter =
				existing && typeof existing === 'object' && Object.keys(existing).length
					? { _and: [existing, exclusion] }
					: exclusion;
		} catch (err: any) {
			logger.warn(`[storage-manager] Recycle query filter failed: ${err?.message || err}`);
		}
		return query;
	});

	// Belt-and-suspenders for non-admins (strip any recycle rows that still slip through).
	filter('files.read', async (payload: any, meta: { query?: Record<string, any> }, context: { accountability?: unknown }) => {
		try {
			const recycleId = await resolveRecycleFolderId(database);
			if (!recycleId || payload == null) return payload;

			const admin = accountabilityIsAdmin(context?.accountability);
			if (admin && queryAllowsRecycleVisibility(meta?.query?.filter, recycleId)) {
				return payload;
			}
			if (admin) {
				// Admins: still hide recycle rows from list payloads that weren't folder-scoped
				// (query filter should already handle this; strip leftovers).
				return stripRecycleRows(payload, recycleId, context?.accountability, logger, false);
			}
			return stripRecycleRows(payload, recycleId, context?.accountability, logger, true);
		} catch (err: any) {
			logger.warn(`[storage-manager] Recycle read filter failed: ${err?.message || err}`);
		}
		return payload;
	});

	// AssetsService uses sudo FilesService — intercept /assets before the controller.
	init('routes.before', ({ app }: { app: any }) => {
		app.use(async (req: any, res: any, next: any) => {
			try {
				if (req.method !== 'GET' && req.method !== 'HEAD') return next();
				const path = String(req.path || '');
				const match = path.match(ASSET_ID_RE);
				if (!match) return next();

				const recycleId = await resolveRecycleFolderId(database);
				if (!recycleId) return next();

				const fileId = match[1];
				const row = await database('directus_files').select('id', 'folder').where({ id: fileId }).first();
				if (!row || String(row.folder || '') !== recycleId) return next();

				const actor = describeAccountability(req.accountability);
				logger.info?.(
					`[storage-manager] Recycle: blocked asset request (${actor}) file=${fileId}`,
				);
				return res.status(403).json({
					errors: [
						{
							message: "You don't have permission to access this file, or it is in the Recycle Bin.",
							extensions: { code: 'FORBIDDEN' },
						},
					],
				});
			} catch (err: any) {
				logger.warn(`[storage-manager] Recycle asset middleware failed: ${err?.message || err}`);
				return next();
			}
		});
	});
}

function stripRecycleRows(
	payload: any,
	recycleId: string,
	accountability: unknown,
	logger: Logger,
	logBlocks: boolean,
) {
	const actor = describeAccountability(accountability);
	const isRecycle = (row: any) => row && String(row.folder || '') === recycleId;

	if (Array.isArray(payload)) {
		const blocked = payload.filter(isRecycle);
		if (logBlocks && blocked.length) {
			const sample = blocked
				.slice(0, 5)
				.map((row: any) => String(row.id || '?'))
				.join(', ');
			logger.info?.(
				`[storage-manager] Recycle: blocked ${blocked.length} file read(s)` +
					` (${actor})` +
					(blocked.length <= 5 ? `: ${sample}` : `: ${sample}, …`),
			);
		}
		return payload.filter((row: any) => !isRecycle(row));
	}
	if (typeof payload === 'object' && payload && 'folder' in payload && isRecycle(payload)) {
		if (logBlocks) {
			logger.info?.(
				`[storage-manager] Recycle: blocked file read (${actor}) file=${payload.id || '?'}`,
			);
		}
		return null;
	}
	return payload;
}

/** Allow recycle visibility for id lookups or when browsing the recycle folder itself. */
export function queryAllowsRecycleVisibility(filter: unknown, recycleId: string): boolean {
	if (!filter || typeof filter !== 'object') return false;
	if (filterIncludesIdLookup(filter)) return true;
	if (filterTargetsRecycleFolder(filter, recycleId)) return true;
	return false;
}

function filterIncludesIdLookup(filter: unknown): boolean {
	if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
	const obj = filter as Record<string, unknown>;

	if (obj.id != null) return true;

	for (const key of ['_and', '_or'] as const) {
		const group = obj[key];
		if (Array.isArray(group) && group.some((part) => filterIncludesIdLookup(part))) return true;
	}
	return false;
}

function filterTargetsRecycleFolder(filter: unknown, recycleId: string): boolean {
	if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
	const obj = filter as Record<string, unknown>;

	const folder = obj.folder;
	if (folder && typeof folder === 'object' && !Array.isArray(folder)) {
		const f = folder as Record<string, unknown>;
		if (f._eq != null && String(f._eq) === recycleId) return true;
		if (Array.isArray(f._in) && f._in.map(String).includes(recycleId)) return true;
	}

	for (const key of ['_and', '_or'] as const) {
		const group = obj[key];
		if (Array.isArray(group) && group.some((part) => filterTargetsRecycleFolder(part, recycleId))) {
			return true;
		}
	}
	return false;
}

function describeAccountability(accountability: unknown): string {
	if (!accountability || typeof accountability !== 'object') return 'anonymous';
	const a = accountability as {
		user?: string | null;
		role?: string | null;
		app?: boolean;
		admin?: boolean;
	};
	if (a.user) return `user=${a.user}`;
	if (a.role) return `role=${a.role}`;
	if (a.app) return 'app';
	return 'anonymous';
}
