export type MigrateMode = 'copy' | 'move';

export type StorageUsage = {
	location: string;
	driver: string;
	file_count: number;
	total_bytes: number;
	/** Filesystem capacity when available (local only). */
	disk_total_bytes: number | null;
	disk_free_bytes: number | null;
	disk_used_bytes: number | null;
	disk_used_percent: number | null;
	/** True when disk_* comes from the OS filesystem. */
	disk_available: boolean;
};

export type StorageLocationInfo = StorageUsage & {
	label: string;
	short: string;
	icon: string;
	root: string | null;
	bucket: string | null;
	/** Physical storage folders discovered under this adapter. */
	folder_count: number;
	/** When true, new uploads and folder rename/delete follow the Directus folder tree on this adapter. */
	mirror_directus_folders: boolean;
};

export type FileRow = {
	id: string;
	title: string | null;
	filename_download: string;
	filename_disk: string;
	storage: string;
	type: string | null;
	filesize: number | null;
	folder: string | null;
	uploaded_on: string | null;
	modified_on: string | null;
};

export type FolderNode = {
	id: string;
	name: string;
	parent: string | null;
	file_count: number;
	total_bytes: number;
	child_count: number;
};

export type MigrateRequest = {
	target_storage: string;
	mode: MigrateMode;
	/** Keep source file on disk as orphan after successful cross-storage transfer. */
	keep_source_file_on_disk?: boolean;
	/** Explicit file IDs. */
	file_ids?: string[];
	/** Migrate all files currently on this source storage. */
	source_storage?: string;
	/** With source_storage: limit to files under this physical path prefix. */
	source_path?: string;
	/** Migrate files in this folder (optionally recursive). */
	folder_id?: string | null;
	recursive?: boolean;
	/** Optional concurrency (1–8). Default 3. */
	concurrency?: number;
};

export type MigrateFileResult = {
	id: string;
	filename_disk: string;
	from: string;
	to: string;
	status: 'moved' | 'copied' | 'skipped' | 'failed';
	error?: string;
	bytes?: number;
};

export type MigrateResponse = {
	mode: MigrateMode;
	target_storage: string;
	total: number;
	succeeded: number;
	skipped: number;
	failed: number;
	results: MigrateFileResult[];
	/** Bytes successfully transferred (copied/moved), excluding skipped. */
	transferred_bytes?: number;
	/** Planned total bytes from source filesize metadata. */
	total_bytes?: number;
	elapsed_ms?: number;
	/** True when the user aborted the job (not a hard failure). */
	cancelled?: boolean;
};

export type MaterializeMode = 'preserve' | 'merge';

export type MaterializeDryRunRequest = {
	folder_id: string | null;
	mode: MaterializeMode;
	target_storage?: string;
	structure_only?: boolean;
};

export type MaterializeDryRunResponse = {
	folder_id: string | null;
	mode: MaterializeMode;
	target_storage?: string | null;
	structure_only: boolean;
	total_files: number;
	total_folders: number;
	total_bytes: number;
	conflicts: number;
	samples: Array<{ id: string; from: string; to_storage: string; to_path: string }>;
	by_storage: Array<{ storage: string; files: number; bytes: number }>;
};

// ── Storage Manager Settings (stored in directus_settings.storage_manager) ──

export type PrefixStrategy = 'none' | 'folder' | 'folder_id' | 'type' | 'date';

export type FolderSyncRenameStrategy = 'full_sync' | 'leave_old';
/** When Sync Folder Changes is on, deleted virtual folders relocate storage paths up to the parent (never delete files). */
export type FolderSyncDeleteStrategy = 'move_to_parent';

export type StorageLocationSettings = {
	prefix_strategy: PrefixStrategy;
	/** Meaningful when prefix_strategy is 'folder' or 'folder_id'. */
	folder_sync_enabled: boolean;
	/** Only meaningful for 'folder' (by name) — IDs do not change on rename. */
	folder_sync_rename: FolderSyncRenameStrategy;
	/** Always relocate-to-parent when sync is enabled; kept for settings shape / legacy coerce. */
	folder_sync_delete: FolderSyncDeleteStrategy;
	/** Mime-category → prefix path for 'type' strategy. */
	type_map: Record<string, string>;
	/** date-fns format string for 'date' strategy, e.g. "yyyy/MM" */
	date_format: string;
};

export type StorageManagerSettings = {
	locations: Record<string, StorageLocationSettings>;
	/**
	 * Sticky first-wins for Mirror by Name collisions.
	 * Key: `${parent ?? ''}::${name}` → folder id that owns the plain name segment.
	 * Absent (`undefined`) means claims have never been initialized (legacy bootstrap once).
	 */
	name_mirror_claims?: Record<string, string>;
	/** File lifecycle defaults (unreferenced scan + deselect / item-delete policies). */
	lifecycle?: import('./lifecycle').StorageManagerLifecycleSettings;
};

export const STORAGE_MANAGER_FIELD = 'storage_manager';

/** Marker object written on cloud adapters so empty storage folders survive. */
export const STORAGE_FOLDER_KEEP = '.keep';

export type StorageBrowseFolder = {
	name: string;
	path: string;
};

export type StorageBrowseResponse = {
	path: string;
	folders: StorageBrowseFolder[];
};

/** Nested physical folder node for left-nav tree (and similar UIs). */
export type StorageFolderNode = {
	name: string;
	path: string;
	children?: StorageFolderNode[];
	/** Set after the first expand attempt (even when children is []). */
	childrenLoaded?: boolean;
};

export const STORAGE_MANAGER_LOCATION_DEFAULTS: StorageLocationSettings = {
	prefix_strategy: 'none',
	folder_sync_enabled: false,
	folder_sync_rename: 'full_sync',
	folder_sync_delete: 'move_to_parent',
	type_map: { image: 'images', video: 'videos', audio: 'audio', text: 'documents' },
	date_format: 'yyyy/MM',
};

// ─────────────────────────────────────────────────────────────────────────────

/** Server → client progress events (SSE `/migrate/stream`). */
export type MigrateProgressEvent =
	| {
			type: 'start';
			mode: MigrateMode;
			from: string | null;
			to: string;
			total: number;
			total_bytes: number;
	  }
	| {
			type: 'file_start';
			index: number;
			total: number;
			id: string;
			name: string;
			filename_disk: string;
			from: string;
			to: string;
			bytes: number;
	  }
	| {
			type: 'file_bytes';
			index: number;
			id: string;
			/** Bytes transferred for the current file so far. */
			file_transferred: number;
			file_bytes: number;
			/** Aggregate bytes across the whole job so far. */
			transferred_bytes: number;
			total_bytes: number;
			elapsed_ms: number;
	  }
	| {
			type: 'file_done';
			index: number;
			total: number;
			result: MigrateFileResult;
			name: string;
			succeeded: number;
			skipped: number;
			failed: number;
			transferred_bytes: number;
			total_bytes: number;
			elapsed_ms: number;
	  }
	| {
			type: 'done';
			data: MigrateResponse;
	  }
	| {
			type: 'error';
			message: string;
	  };
