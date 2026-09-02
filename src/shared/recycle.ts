/** Recycle Bin settings + constants (File Library folder + optional trashed_at field). */

export const RECYCLE_DEFAULT_FOLDER_NAME = '_Recycle';
export const RECYCLE_TRASHED_AT_FIELD = 'storage_manager_trashed_at';
export const RECYCLE_DEFAULT_RETENTION_DAYS = 30;

/** Opt-in daily Schedule Flow created from the Recycle Bin page. */
export const RECYCLE_PURGE_FLOW_NAME = 'Storage Manager · Purge Recycle Bin';
/** Daily at 03:00 (server timezone). */
export const RECYCLE_PURGE_FLOW_CRON = '0 3 * * *';

export type RecycleSettings = {
	/** Admin opted in — field + folder ready. */
	enabled: boolean;
	/** Source of truth for “is in recycle bin”. */
	folder_id: string | null;
	/** Purge files with trashed_at older than this many days. */
	retention_days: number;
	/** Timestamp field on directus_files (created on enable). */
	field: string;
	/** Linked Schedule Flow id for daily purge (opt-in). */
	purge_flow_id: string | null;
};

export const RECYCLE_DEFAULTS: RecycleSettings = {
	enabled: false,
	folder_id: null,
	retention_days: RECYCLE_DEFAULT_RETENTION_DAYS,
	field: RECYCLE_TRASHED_AT_FIELD,
	purge_flow_id: null,
};

/** Storage-browse path for the virtual Recycle folder (single path segment). */
export function recycleStorageFolderName(folderName: string | null | undefined): string {
	const raw = String(folderName || RECYCLE_DEFAULT_FOLDER_NAME)
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	const segment = raw.split('/').filter(Boolean).pop();
	return segment || RECYCLE_DEFAULT_FOLDER_NAME;
}

export function normalizeRecycleSettings(raw: unknown): RecycleSettings {
	const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const retention = Number(src.retention_days);
	return {
		enabled: Boolean(src.enabled),
		folder_id: typeof src.folder_id === 'string' && src.folder_id ? src.folder_id : null,
		retention_days:
			Number.isFinite(retention) && retention > 0 ? Math.min(3650, Math.floor(retention)) : RECYCLE_DEFAULT_RETENTION_DAYS,
		field:
			typeof src.field === 'string' && src.field.trim()
				? src.field.trim()
				: RECYCLE_TRASHED_AT_FIELD,
		purge_flow_id:
			typeof src.purge_flow_id === 'string' && src.purge_flow_id ? src.purge_flow_id : null,
	};
}
