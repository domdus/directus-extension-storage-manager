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
	/** Explicit file IDs. */
	file_ids?: string[];
	/** Migrate all files currently on this source storage. */
	source_storage?: string;
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
