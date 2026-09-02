import {
	RECYCLE_DEFAULT_FOLDER_NAME,
	RECYCLE_DEFAULTS,
	RECYCLE_PURGE_FLOW_CRON,
	RECYCLE_PURGE_FLOW_NAME,
	RECYCLE_TRASHED_AT_FIELD,
	normalizeRecycleSettings,
	recycleStorageFolderName,
	type RecycleSettings,
} from '../shared/recycle';
import {
	getCachedRecycleFolderId,
	invalidateSettingsCache,
	loadSettings,
	saveSettings,
	setCachedRecycleFolderId,
} from '../hook/settings';
import { LIFECYCLE_DEFAULTS, normalizeLifecycleSettings } from '../shared/lifecycle';
import { diskDeleteTransformsOnly, getStorageManager } from './storage';
import { randomUUID } from 'node:crypto';

export type RecycleContext = {
	database: any;
	env: Record<string, unknown>;
	services: Record<string, any>;
	getSchema: () => Promise<any>;
	accountability?: unknown;
	logger?: { info?: (m: string) => void; warn?: (m: string) => void };
};

async function hasFilesColumn(database: any, field: string): Promise<boolean> {
	try {
		return Boolean(await database.schema.hasColumn('directus_files', field));
	} catch {
		return false;
	}
}

export async function resolveRecycleFolderId(database: any): Promise<string | null> {
	const cached = getCachedRecycleFolderId();
	if (cached !== undefined) return cached;

	const settings = await loadSettings(database);
	const recycle = normalizeRecycleSettings(settings.recycle);
	const id = recycle.enabled ? recycle.folder_id : null;
	setCachedRecycleFolderId(id);
	return id;
}

export async function resolveRecycleFolderMeta(
	database: any,
): Promise<{ id: string; name: string } | null> {
	const id = await resolveRecycleFolderId(database);
	if (!id) return null;
	const row = await database('directus_folders').select('id', 'name').where({ id }).first();
	if (!row?.id) return null;
	return { id: String(row.id), name: recycleStorageFolderName(row.name) };
}

async function storageHasRecycleFiles(database: any, location: string, folderId: string): Promise<boolean> {
	const row = await database('directus_files')
		.where({ folder: folderId, storage: location })
		.count({ n: '*' })
		.first();
	return (Number(row?.n ?? row?.['count(*)'] ?? 0) || 0) > 0;
}

/** Virtual Recycle folder on a storage browse view, if this adapter has quarantined files. */
export async function getVirtualRecycleBrowseFolder(
	database: any,
	location: string,
): Promise<{ id: string; name: string } | null> {
	const meta = await resolveRecycleFolderMeta(database);
	if (!meta) return null;
	if (!(await storageHasRecycleFiles(database, location, meta.id))) return null;
	return meta;
}

/**
 * Drop Recycle Bin files from a `directus_files` query. Keeps unfiled rows (`folder` IS NULL).
 * Mutates `query` in place — do not return the builder from this async function (Knex is thenable).
 */
export async function excludeRecycleFolderFromFilesQuery(database: any, query: any): Promise<void> {
	const recycleId = await resolveRecycleFolderId(database);
	if (!recycleId) return;
	query.where(function (this: any) {
		this.whereNull('folder').orWhere('folder', '<>', recycleId);
	});
}

export async function ensureTrashedAtField(ctx: RecycleContext, field = RECYCLE_TRASHED_AT_FIELD): Promise<void> {
	if (await hasFilesColumn(ctx.database, field)) return;

	const schema = await ctx.getSchema();
	const fieldsService = new ctx.services.FieldsService({
		database: ctx.database,
		schema,
		accountability: { admin: true },
	});

	await fieldsService.createField('directus_files', {
		field,
		type: 'timestamp',
		meta: {
			collection: 'directus_files',
			field,
			interface: 'datetime',
			display: 'datetime',
			hidden: true,
			readonly: true,
			note: 'Storage Manager Recycle Bin — set when a file enters _Recycle (do not edit manually)',
		},
		schema: {
			is_nullable: true,
		},
	});
	ctx.logger?.info?.(`[storage-manager] Created directus_files.${field}`);
}

export async function ensureRecycleFolder(
	ctx: RecycleContext,
	opts?: { folderId?: string | null; name?: string },
): Promise<string> {
	if (opts?.folderId) {
		const row = await ctx.database('directus_folders').select('id').where({ id: opts.folderId }).first();
		if (!row?.id) throw new Error('Selected recycle folder was not found');
		return String(row.id);
	}

	const name = (opts?.name || RECYCLE_DEFAULT_FOLDER_NAME).trim() || RECYCLE_DEFAULT_FOLDER_NAME;
	const existing = await ctx.database('directus_folders')
		.select('id')
		.where({ name })
		.whereNull('parent')
		.first();
	if (existing?.id) return String(existing.id);

	const schema = await ctx.getSchema();
	const foldersService = new ctx.services.FoldersService({
		schema,
		accountability: ctx.accountability ?? { admin: true },
	});
	const id = await foldersService.createOne({ name, parent: null });
	ctx.logger?.info?.(`[storage-manager] Created recycle folder “${name}”`);
	return String(id);
}

export async function enableRecycle(
	ctx: RecycleContext,
	opts?: { folder_id?: string | null; retention_days?: number; folder_name?: string },
): Promise<RecycleSettings> {
	await ensureTrashedAtField(ctx, RECYCLE_TRASHED_AT_FIELD);
	const folderId = await ensureRecycleFolder(ctx, {
		folderId: opts?.folder_id,
		name: opts?.folder_name,
	});

	// Folder create may run name_mirror_claims bootstrap (folders.create action) and race
	// with this write — always re-read immediately before persisting enabled state.
	invalidateSettingsCache();
	const settings = await loadSettings(ctx.database);
	const next: RecycleSettings = {
		...RECYCLE_DEFAULTS,
		...normalizeRecycleSettings(settings.recycle),
		enabled: true,
		folder_id: folderId,
		field: RECYCLE_TRASHED_AT_FIELD,
		retention_days:
			opts?.retention_days != null
				? normalizeRecycleSettings({ retention_days: opts.retention_days }).retention_days
				: normalizeRecycleSettings(settings.recycle).retention_days,
	};

	await saveSettings(ctx.database, { ...settings, recycle: next });
	setCachedRecycleFolderId(folderId);

	// Stamp anything already sitting in the recycle folder (manual moves / re-enable).
	const now = new Date().toISOString();
	try {
		await ctx.database('directus_files')
			.where({ folder: folderId })
			.whereNull(RECYCLE_TRASHED_AT_FIELD)
			.update({ [RECYCLE_TRASHED_AT_FIELD]: now });
	} catch (err: any) {
		ctx.logger?.warn?.(`[storage-manager] Recycle backfill trashed_at failed: ${err?.message || err}`);
	}

	return next;
}

export async function disableRecycle(ctx: RecycleContext): Promise<RecycleSettings> {
	const settings = await loadSettings(ctx.database);
	const current = normalizeRecycleSettings(settings.recycle);
	// Pause linked schedule so it doesn't keep failing while recycle is off.
	if (current.purge_flow_id) {
		try {
			await setFlowStatus(ctx, current.purge_flow_id, 'inactive');
		} catch (err: any) {
			ctx.logger?.warn?.(`[storage-manager] Could not pause purge Flow: ${err?.message || err}`);
		}
	}
	const next: RecycleSettings = {
		...current,
		enabled: false,
	};
	await saveSettings(ctx.database, { ...settings, recycle: next });
	setCachedRecycleFolderId(null);
	return next;
}

export type RecyclePurgeFlowInfo = {
	id: string;
	name: string;
	status: string;
	cron: string | null;
	missing: boolean;
};

async function readPurgeFlow(
	ctx: RecycleContext,
	flowId: string | null,
): Promise<RecyclePurgeFlowInfo | null> {
	if (!flowId) return null;
	const row = await ctx.database('directus_flows').select('id', 'name', 'status', 'options').where({ id: flowId }).first();
	if (!row?.id) {
		return { id: flowId, name: RECYCLE_PURGE_FLOW_NAME, status: 'missing', cron: null, missing: true };
	}
	let cron: string | null = null;
	try {
		const opts = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
		cron = opts?.cron ? String(opts.cron) : null;
	} catch {
		cron = null;
	}
	return {
		id: String(row.id),
		name: String(row.name || RECYCLE_PURGE_FLOW_NAME),
		status: String(row.status || 'inactive'),
		cron,
		missing: false,
	};
}

async function setFlowStatus(ctx: RecycleContext, flowId: string, status: 'active' | 'inactive'): Promise<void> {
	const schema = await ctx.getSchema();
	const FlowsService = ctx.services.FlowsService;
	if (!FlowsService) {
		await ctx.database('directus_flows').where({ id: flowId }).update({ status });
		return;
	}
	const flowsService = new FlowsService({
		schema,
		accountability: ctx.accountability ?? { admin: true },
	});
	await flowsService.updateOne(flowId, { status });
}

export async function getRecycleStatus(ctx: RecycleContext) {
	const settings = await loadSettings(ctx.database);
	let recycle = normalizeRecycleSettings(settings.recycle);
	const fieldReady = await hasFilesColumn(ctx.database, recycle.field);
	let folderName: string | null = null;
	let count = 0;

	if (recycle.folder_id) {
		const folder = await ctx.database('directus_folders').select('id', 'name').where({ id: recycle.folder_id }).first();
		folderName = folder?.name ? String(folder.name) : null;
		if (folder?.id) {
			const row = await ctx.database('directus_files').where({ folder: recycle.folder_id }).count({ n: '*' }).first();
			count = Number(row?.n ?? row?.['count(*)'] ?? 0) || 0;
		}
	}

	let purge_flow = await readPurgeFlow(ctx, recycle.purge_flow_id);
	// Heal stale flow id if the Flow was deleted outside Storage Manager.
	if (purge_flow?.missing) {
		recycle = { ...recycle, purge_flow_id: null };
		await saveSettings(ctx.database, { ...settings, recycle });
		purge_flow = null;
	}

	return {
		...recycle,
		field_ready: fieldReady,
		folder_name: folderName,
		file_count: count,
		purge_flow,
	};
}

/**
 * Opt-in: create (or relink) a daily Schedule Flow that runs Purge Recycle Bin.
 */
export async function createRecyclePurgeFlow(ctx: RecycleContext): Promise<RecyclePurgeFlowInfo> {
	const settings = await loadSettings(ctx.database);
	const recycle = normalizeRecycleSettings(settings.recycle);
	if (!recycle.enabled || !recycle.folder_id) {
		throw new Error('Enable Recycle Bin before creating the daily purge Flow');
	}

	const existing = await readPurgeFlow(ctx, recycle.purge_flow_id);
	if (existing && !existing.missing) {
		if (existing.status !== 'active') {
			await setFlowStatus(ctx, existing.id, 'active');
			existing.status = 'active';
		}
		return existing;
	}

	const schema = await ctx.getSchema();
	const FlowsService = ctx.services.FlowsService;
	const OperationsService = ctx.services.OperationsService;
	if (!FlowsService || !OperationsService) {
		throw new Error('FlowsService / OperationsService unavailable');
	}

	const accountability = ctx.accountability ?? { admin: true };
	const flowsService = new FlowsService({ schema, accountability });
	const operationsService = new OperationsService({ schema, accountability });

	const flowId = randomUUID();
	const operationId = randomUUID();

	await flowsService.createOne({
		id: flowId,
		name: RECYCLE_PURGE_FLOW_NAME,
		icon: 'recycling',
		status: 'active',
		trigger: 'schedule',
		accountability: 'all',
		options: { cron: RECYCLE_PURGE_FLOW_CRON },
		description:
			'Created by Storage Manager. Runs daily and permanently deletes expired Recycle Bin files that are still unreferenced. Retention comes from Recycle Bin settings.',
	});

	await operationsService.createOne({
		id: operationId,
		name: 'Purge Recycle Bin',
		key: 'purge_recycle',
		type: 'storage-manager-recycle-purge',
		position_x: 19,
		position_y: 1,
		options: { dry_run: false },
		flow: flowId,
	});

	await flowsService.updateOne(flowId, { operation: operationId });

	const next: RecycleSettings = { ...recycle, purge_flow_id: flowId };
	await saveSettings(ctx.database, { ...settings, recycle: next });
	ctx.logger?.info?.(`[storage-manager] Created purge Flow ${flowId}`);

	return {
		id: flowId,
		name: RECYCLE_PURGE_FLOW_NAME,
		status: 'active',
		cron: RECYCLE_PURGE_FLOW_CRON,
		missing: false,
	};
}

/** Delete the linked Schedule Flow and clear purge_flow_id. */
export async function removeRecyclePurgeFlow(ctx: RecycleContext): Promise<void> {
	const settings = await loadSettings(ctx.database);
	const recycle = normalizeRecycleSettings(settings.recycle);
	const flowId = recycle.purge_flow_id;
	if (!flowId) return;

	const schema = await ctx.getSchema();
	const FlowsService = ctx.services.FlowsService;
	if (FlowsService) {
		const flowsService = new FlowsService({
			schema,
			accountability: ctx.accountability ?? { admin: true },
		});
		try {
			await flowsService.deleteOne(flowId);
		} catch (err: any) {
			// Flow may already be gone
			ctx.logger?.warn?.(`[storage-manager] Purge Flow delete: ${err?.message || err}`);
		}
	} else {
		await ctx.database('directus_flows').where({ id: flowId }).del();
	}

	await saveSettings(ctx.database, {
		...settings,
		recycle: { ...recycle, purge_flow_id: null },
	});
}

const TRANSFORM_DELETE_CONCURRENCY = 8;

type TransformFileRow = { id: string; storage: string; filename_disk: string };

async function dropTransformsForRows(
	rows: TransformFileRow[],
	logger?: RecycleContext['logger'],
	opts?: { concurrency?: number; isCancelled?: () => boolean },
): Promise<number> {
	if (!rows.length) return 0;
	const storage = await getStorageManager();
	const concurrency = Math.max(1, opts?.concurrency ?? TRANSFORM_DELETE_CONCURRENCY);
	let deleted = 0;
	let next = 0;

	async function worker() {
		while (next < rows.length) {
			if (opts?.isCancelled?.()) return;
			const index = next++;
			const row = rows[index];
			if (!row) continue;
			try {
				const disk = storage.location(String(row.storage));
				deleted += await diskDeleteTransformsOnly(disk, String(row.filename_disk || ''));
			} catch (err: any) {
				logger?.warn?.(
					`[storage-manager] Recycle transform cleanup failed for ${row.id}: ${err?.message || err}`,
				);
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
	await Promise.all(workers);
	return deleted;
}

async function dropTransformsForFiles(
	database: any,
	fileIds: string[],
	logger?: RecycleContext['logger'],
): Promise<number> {
	if (!fileIds.length) return 0;
	const rows = (await database('directus_files')
		.select('id', 'storage', 'filename_disk')
		.whereIn('id', fileIds)) as TransformFileRow[];
	return dropTransformsForRows(rows || [], logger);
}

/**
 * Move files into the recycle folder, stamp trashed_at, drop transforms.
 */
export async function moveFilesToRecycle(
	ctx: RecycleContext,
	fileIds: string[],
): Promise<{ moved: number; transforms_deleted: number }> {
	const status = await getRecycleStatus(ctx);
	if (!status.enabled || !status.folder_id) {
		throw new Error('Recycle Bin is not enabled — enable it in Storage Manager settings first.');
	}
	if (!status.field_ready) {
		await ensureTrashedAtField(ctx, status.field);
	}

	const ids = [...new Set(fileIds.map(String).filter(Boolean))];
	if (!ids.length) return { moved: 0, transforms_deleted: 0 };
	if (ids.length > 1000) throw new Error('Move at most 1000 files per request');

	const now = new Date().toISOString();
	const patch: Record<string, unknown> = {
		folder: status.folder_id,
		[status.field]: now,
	};

	await ctx.database('directus_files').whereIn('id', ids).update(patch);
	const transforms_deleted = await dropTransformsForFiles(ctx.database, ids, ctx.logger);
	return { moved: ids.length, transforms_deleted };
}

export const RECYCLE_MOVE_CHUNK = 1000;

export type RecycleBulkProgress = {
	phase: 'prepare' | 'move' | 'done';
	message: string;
	current: number;
	total: number;
	moved: number;
	skipped: number;
	failed: number;
	transforms_deleted: number;
};

export type RecycleRestoreProgress = {
	phase: 'prepare' | 'restore' | 'done';
	message: string;
	current: number;
	total: number;
	restored: number;
	failed: number;
};

/**
 * Chunked Recycle move for huge ID lists (scan sessions). No per-request cap.
 * Does not re-check references — caller already scanned.
 */
export async function moveFilesToRecycleBulk(
	ctx: RecycleContext,
	fileIds: string[],
	opts?: {
		isCancelled?: () => boolean;
		onProgress?: (progress: RecycleBulkProgress) => void;
	},
): Promise<{
	moved: number;
	skipped: number;
	failed: number;
	transforms_deleted: number;
	cancelled: boolean;
	moved_ids: string[];
}> {
	const status = await getRecycleStatus(ctx);
	if (!status.enabled || !status.folder_id) {
		throw new Error('Recycle Bin is not enabled — enable it in Storage Manager settings first.');
	}
	if (!status.field_ready) {
		await ensureTrashedAtField(ctx, status.field);
	}

	const ids = [...new Set(fileIds.map(String).filter(Boolean))];
	const empty = {
		moved: 0,
		skipped: 0,
		failed: 0,
		transforms_deleted: 0,
		cancelled: false,
		moved_ids: [] as string[],
	};
	if (!ids.length) return empty;

	const recycleFolderId = String(status.folder_id);
	const now = new Date().toISOString();
	const patch: Record<string, unknown> = {
		folder: recycleFolderId,
		[status.field]: now,
	};

	const report = (partial: Omit<RecycleBulkProgress, 'phase'> & { phase?: RecycleBulkProgress['phase'] }) => {
		opts?.onProgress?.({
			phase: partial.phase ?? 'move',
			message: partial.message,
			current: partial.current,
			total: partial.total,
			moved: partial.moved,
			skipped: partial.skipped,
			failed: partial.failed,
			transforms_deleted: partial.transforms_deleted,
		});
	};

	report({
		phase: 'prepare',
		message: `Preparing ${ids.length.toLocaleString()} file(s)…`,
		current: 0,
		total: ids.length,
		moved: 0,
		skipped: 0,
		failed: 0,
		transforms_deleted: 0,
	});

	let moved = 0;
	let skipped = 0;
	let failed = 0;
	let transforms_deleted = 0;
	const moved_ids: string[] = [];

	for (let i = 0; i < ids.length; i += RECYCLE_MOVE_CHUNK) {
		if (opts?.isCancelled?.()) {
			return { moved, skipped, failed, transforms_deleted, cancelled: true, moved_ids };
		}

		const chunk = ids.slice(i, i + RECYCLE_MOVE_CHUNK);
		try {
			const rows = (await ctx.database('directus_files')
				.select('id', 'storage', 'filename_disk', 'folder')
				.whereIn('id', chunk)) as Array<TransformFileRow & { folder?: string | null }>;

			const existing = new Map(rows.map((row) => [String(row.id), row]));
			const toMove: TransformFileRow[] = [];
			for (const id of chunk) {
				const row = existing.get(id);
				if (!row) {
					skipped++;
					continue;
				}
				if (row.folder != null && String(row.folder) === recycleFolderId) {
					skipped++;
					continue;
				}
				toMove.push(row);
			}

			if (toMove.length) {
				const moveIds = toMove.map((row) => String(row.id));
				await ctx.database('directus_files').whereIn('id', moveIds).update(patch);
				moved += toMove.length;
				moved_ids.push(...moveIds);
				transforms_deleted += await dropTransformsForRows(toMove, ctx.logger, {
					isCancelled: opts?.isCancelled,
				});
			}
		} catch (err: any) {
			failed += chunk.length;
			ctx.logger?.warn?.(
				`[storage-manager] Recycle bulk chunk failed at ${i}: ${err?.message || err}`,
			);
		}

		report({
			phase: 'move',
			message: `Moved ${moved.toLocaleString()} of ${ids.length.toLocaleString()}`,
			current: Math.min(i + chunk.length, ids.length),
			total: ids.length,
			moved,
			skipped,
			failed,
			transforms_deleted,
		});
	}

	report({
		phase: 'done',
		message: opts?.isCancelled?.()
			? 'Cancelled'
			: `Moved ${moved.toLocaleString()} file(s) to Recycle`,
		current: ids.length,
		total: ids.length,
		moved,
		skipped,
		failed,
		transforms_deleted,
	});

	return {
		moved,
		skipped,
		failed,
		transforms_deleted,
		cancelled: Boolean(opts?.isCancelled?.()),
		moved_ids,
	};
}

/**
 * Move files into Recycle when still unreferenced.
 * If Recycle Bin is off: skip (keep files), do not fail the caller.
 */
export async function moveFilesToRecycleIfUnreferenced(
	ctx: RecycleContext,
	fileIds: string[],
	opts?: { scanTextFields?: boolean },
): Promise<{
	moved: number;
	skipped: number;
	failed: number;
	transforms_deleted: number;
	recycle_disabled: boolean;
	results: Array<{ id: string; status: 'moved' | 'skipped' | 'failed'; reason?: string }>;
}> {
	const status = await getRecycleStatus(ctx);
	const ids = [...new Set(fileIds.map(String).filter(Boolean))];
	const empty = {
		moved: 0,
		skipped: ids.length,
		failed: 0,
		transforms_deleted: 0,
		recycle_disabled: !status.enabled || !status.folder_id,
		results: ids.map((id) => ({
			id,
			status: 'skipped' as const,
			reason: !status.enabled || !status.folder_id ? 'recycle disabled' : 'empty',
		})),
	};
	if (!ids.length) {
		return { ...empty, skipped: 0, results: [] };
	}
	if (!status.enabled || !status.folder_id) {
		ctx.logger?.warn?.(
			'[storage-manager] move_to_recycle skipped — Recycle Bin is not enabled',
		);
		return empty;
	}

	const settings = await loadSettings(ctx.database);
	const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
	const scanTextFields = opts?.scanTextFields ?? lifecycle.scan_text_fields;
	const schema = await ctx.getSchema();
	const { isFileReferenced } = await import('./unreferenced');

	const toMove: string[] = [];
	const results: Array<{ id: string; status: 'moved' | 'skipped' | 'failed'; reason?: string }> = [];

	for (const rawId of ids) {
		try {
			const exists = await ctx.database('directus_files').select('id').where('id', rawId).first();
			if (!exists) {
				results.push({ id: rawId, status: 'skipped', reason: 'not found' });
				continue;
			}
			const referenced = await isFileReferenced(ctx.database, schema, rawId, {
				scanTextFields,
				logger: ctx.logger as any,
			});
			if (referenced) {
				results.push({ id: rawId, status: 'skipped', reason: 'still referenced' });
				continue;
			}
			toMove.push(rawId);
		} catch (err: any) {
			results.push({ id: rawId, status: 'failed', reason: err?.message || String(err) });
		}
	}

	let transforms_deleted = 0;
	if (toMove.length) {
		try {
			const moved = await moveFilesToRecycle(ctx, toMove);
			transforms_deleted = moved.transforms_deleted;
			for (const id of toMove) results.push({ id, status: 'moved' });
		} catch (err: any) {
			for (const id of toMove) {
				results.push({ id, status: 'failed', reason: err?.message || String(err) });
			}
		}
	}

	return {
		moved: results.filter((r) => r.status === 'moved').length,
		skipped: results.filter((r) => r.status === 'skipped').length,
		failed: results.filter((r) => r.status === 'failed').length,
		transforms_deleted,
		recycle_disabled: false,
		results,
	};
}

/**
 * Restore files from recycle: clear folder + trashed_at (leave at library root).
 */
export async function restoreFilesFromRecycle(
	ctx: RecycleContext,
	fileIds: string[],
): Promise<{ restored: number }> {
	const status = await getRecycleStatus(ctx);
	if (!status.folder_id) throw new Error('Recycle Bin folder is not configured');

	const ids = [...new Set(fileIds.map(String).filter(Boolean))];
	if (!ids.length) return { restored: 0 };
	if (ids.length > 1000) throw new Error('Restore at most 1000 files per request');

	const patch: Record<string, unknown> = {
		folder: null,
		[status.field]: null,
	};

	const updated = await ctx.database('directus_files')
		.whereIn('id', ids)
		.andWhere({ folder: status.folder_id })
		.update(patch);

	return { restored: Number(updated) || ids.length };
}

/**
 * Restore every Recycle file (optional storage filter) in chunks.
 * Does not load the full ID list into memory — re-queries remaining rows each batch.
 */
export async function restoreRecycleFilesBulk(
	ctx: RecycleContext,
	opts?: {
		storage?: string | null;
		isCancelled?: () => boolean;
		onProgress?: (progress: RecycleRestoreProgress) => void;
	},
): Promise<{
	restored: number;
	failed: number;
	total: number;
	cancelled: boolean;
	storage: string | null;
}> {
	const status = await getRecycleStatus(ctx);
	if (!status.folder_id) throw new Error('Recycle Bin folder is not configured');

	const folderId = String(status.folder_id);
	const storage = opts?.storage ? String(opts.storage) : null;
	const patch: Record<string, unknown> = {
		folder: null,
		[status.field]: null,
	};

	const scoped = () => {
		const query = ctx.database('directus_files').where({ folder: folderId });
		if (storage) query.andWhere({ storage });
		return query;
	};

	const countRow = await scoped().count({ n: '*' }).first();
	const total = Number(countRow?.n ?? countRow?.['count(*)'] ?? 0) || 0;

	const report = (partial: RecycleRestoreProgress) => {
		opts?.onProgress?.(partial);
	};

	report({
		phase: 'prepare',
		message:
			total === 0
				? 'Nothing to restore'
				: storage
					? `Preparing ${total.toLocaleString()} file(s) on ${storage}…`
					: `Preparing ${total.toLocaleString()} file(s)…`,
		current: 0,
		total,
		restored: 0,
		failed: 0,
	});

	if (!total) {
		return { restored: 0, failed: 0, total: 0, cancelled: false, storage };
	}

	let restored = 0;
	let failed = 0;

	while (true) {
		if (opts?.isCancelled?.()) {
			return { restored, failed, total, cancelled: true, storage };
		}

		const rows = await scoped().select('id').limit(RECYCLE_MOVE_CHUNK);
		const ids = (rows || []).map((row: { id: string }) => String(row.id)).filter(Boolean);
		if (!ids.length) break;

		try {
			const updated = await ctx.database('directus_files')
				.whereIn('id', ids)
				.andWhere({ folder: folderId })
				.update(patch);
			const n = Number(updated) || ids.length;
			restored += n;
		} catch (err: any) {
			failed += ids.length;
			ctx.logger?.warn?.(`[storage-manager] Recycle restore chunk failed: ${err?.message || err}`);
			break;
		}

		report({
			phase: 'restore',
			message: `Restored ${restored.toLocaleString()} of ${total.toLocaleString()}`,
			current: Math.min(restored + failed, total),
			total,
			restored,
			failed,
		});
	}

	const cancelled = Boolean(opts?.isCancelled?.());
	report({
		phase: 'done',
		message: cancelled
			? `Cancelled after ${restored.toLocaleString()} restored`
			: `Restored ${restored.toLocaleString()} file(s)`,
		current: total,
		total,
		restored,
		failed,
	});

	return { restored, failed, total, cancelled, storage };
}

export async function purgeExpiredRecycle(
	ctx: RecycleContext,
	opts?: { older_than_days?: number; dry_run?: boolean },
): Promise<{
	dry_run: boolean;
	candidate_count: number;
	deleted: number;
	skipped: number;
	failed: number;
	older_than_days: number;
}> {
	const status = await getRecycleStatus(ctx);
	if (!status.enabled || !status.folder_id) {
		throw new Error('Recycle Bin is not enabled');
	}
	if (!(await hasFilesColumn(ctx.database, status.field))) {
		throw new Error(`Missing field directus_files.${status.field} — re-enable Recycle Bin`);
	}

	const olderThan = Math.max(
		1,
		Number(opts?.older_than_days) || status.retention_days || RECYCLE_DEFAULTS.retention_days,
	);
	const cutoff = new Date(Date.now() - olderThan * 24 * 60 * 60 * 1000).toISOString();
	const dryRun = Boolean(opts?.dry_run);

	const settings = await loadSettings(ctx.database);
	const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
	const scanTextFields = lifecycle.scan_text_fields;

	const rows = await ctx.database('directus_files')
		.select('id')
		.where({ folder: status.folder_id })
		.andWhere(status.field, '<=', cutoff);

	const ids = (rows || []).map((r: any) => String(r.id));
	if (!ids.length || dryRun) {
		return {
			dry_run: dryRun,
			candidate_count: ids.length,
			deleted: 0,
			skipped: 0,
			failed: 0,
			older_than_days: olderThan,
		};
	}

	const schema = await ctx.getSchema();
	let deleted = 0;
	let skipped = 0;
	let failed = 0;

	const { deleteUnreferencedFiles } = await import('./unreferenced');

	// Chunk to keep delete-if-unreferenced bounded.
	const CHUNK = 100;
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const results = await deleteUnreferencedFiles(
			ctx.database,
			schema,
			ctx.services,
			ctx.accountability ?? { admin: true },
			chunk,
			{ scanTextFields, logger: ctx.logger as any },
		);
		deleted += results.filter((r) => r.status === 'deleted').length;
		skipped += results.filter((r) => r.status === 'skipped').length;
		failed += results.filter((r) => r.status === 'failed').length;
	}

	return {
		dry_run: false,
		candidate_count: ids.length,
		deleted,
		skipped,
		failed,
		older_than_days: olderThan,
	};
}

/** Keep recycle folder out of unreferenced scan results. */
export async function getRecycleExcludeFolderIds(database: any): Promise<string[]> {
	const id = await resolveRecycleFolderId(database);
	return id ? [id] : [];
}

export { invalidateSettingsCache, normalizeRecycleSettings };
