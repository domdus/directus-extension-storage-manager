import {
	RECYCLE_DEFAULT_FOLDER_NAME,
	RECYCLE_DEFAULTS,
	RECYCLE_PURGE_FLOW_CRON,
	RECYCLE_PURGE_FLOW_NAME,
	RECYCLE_TRASHED_AT_FIELD,
	normalizeRecycleSettings,
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

async function dropTransformsForFiles(
	database: any,
	fileIds: string[],
	logger?: RecycleContext['logger'],
): Promise<number> {
	if (!fileIds.length) return 0;
	const rows = await database('directus_files')
		.select('id', 'storage', 'filename_disk')
		.whereIn('id', fileIds);
	const storage = await getStorageManager();
	let deleted = 0;
	for (const row of rows || []) {
		try {
			const disk = storage.location(String(row.storage));
			deleted += await diskDeleteTransformsOnly(disk, String(row.filename_disk || ''));
		} catch (err: any) {
			logger?.warn?.(
				`[storage-manager] Recycle transform cleanup failed for ${row.id}: ${err?.message || err}`,
			);
		}
	}
	return deleted;
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
