/**
 * Uninstall / “Remove extension data” cleanup.
 * Clears storage_manager settings and extension-owned Flow / scan artifacts.
 * Recycle Bin files are left alone unless empty_recycle is requested.
 */
import { STORAGE_MANAGER_FIELD } from '../shared/types';
import { invalidateSettingsCache, loadSettings } from '../hook/settings';
import { RECYCLE_PURGE_FLOW_NAME, RECYCLE_DEFAULT_FOLDER_NAME, normalizeRecycleSettings } from '../shared/recycle';
import {
	UNREFERENCED_SCAN_FOLDER_NAME,
	getUnreferencedScanFolderId,
} from './unreferenced-scan-session';

export type CleanupContext = {
	database: any;
	services: Record<string, any>;
	getSchema: () => Promise<any>;
	accountability?: unknown;
	logger?: { info?: (m: string) => void; warn?: (m: string) => void };
};

export type CleanupOptions = {
	/** Permanently delete files in the configured Recycle folder (and the folder if empty). */
	empty_recycle?: boolean;
};

export type CleanupResult = {
	cleared_value: boolean;
	deleted_field: boolean;
	deleted_purge_flow: boolean;
	deleted_scan_files: number;
	deleted_scan_folder: boolean;
	emptied_recycle: boolean;
	deleted_recycle_files: number;
	deleted_recycle_folder: boolean;
	warnings: string[];
};

async function deleteFlowById(ctx: CleanupContext, flowId: string): Promise<boolean> {
	const schema = await ctx.getSchema();
	const FlowsService = ctx.services.FlowsService;
	try {
		if (FlowsService) {
			const flowsService = new FlowsService({
				schema,
				accountability: ctx.accountability ?? { admin: true },
			});
			await flowsService.deleteOne(flowId);
		} else {
			await ctx.database('directus_flows').where({ id: flowId }).del();
		}
		return true;
	} catch (err: any) {
		ctx.logger?.warn?.(`[storage-manager] Cleanup Flow ${flowId}: ${err?.message || err}`);
		return false;
	}
}

async function deletePurgeFlows(ctx: CleanupContext, warnings: string[]): Promise<boolean> {
	let deleted = false;
	const ids = new Set<string>();

	try {
		const settings = await loadSettings(ctx.database);
		const recycle = normalizeRecycleSettings(settings.recycle);
		if (recycle.purge_flow_id) ids.add(recycle.purge_flow_id);
	} catch (err: any) {
		warnings.push(`Could not read settings for purge Flow id: ${err?.message || err}`);
	}

	try {
		const rows = await ctx
			.database('directus_flows')
			.select('id')
			.where({ name: RECYCLE_PURGE_FLOW_NAME });
		for (const row of rows || []) {
			if (row?.id) ids.add(String(row.id));
		}
	} catch (err: any) {
		warnings.push(`Could not look up purge Flow by name: ${err?.message || err}`);
	}

	for (const id of ids) {
		if (await deleteFlowById(ctx, id)) deleted = true;
	}
	return deleted;
}

async function deleteFolderAndFiles(
	ctx: CleanupContext,
	folderId: string,
	warnings: string[],
): Promise<{ files: number; folder: boolean }> {
	const schema = await ctx.getSchema();
	const FilesService = ctx.services.FilesService;
	const FoldersService = ctx.services.FoldersService;
	let files = 0;
	let folder = false;

	const fileRows = await ctx.database('directus_files').select('id').where({ folder: folderId });
	const fileIds = (fileRows || []).map((r: any) => String(r.id)).filter(Boolean);

	if (fileIds.length) {
		try {
			if (FilesService) {
				const filesService = new FilesService({
					schema,
					accountability: ctx.accountability ?? { admin: true },
				});
				await filesService.deleteMany(fileIds);
			} else {
				await ctx.database('directus_files').whereIn('id', fileIds).del();
			}
			files = fileIds.length;
		} catch (err: any) {
			warnings.push(`Failed deleting files in folder ${folderId}: ${err?.message || err}`);
		}
	}

	try {
		if (FoldersService) {
			const foldersService = new FoldersService({
				schema,
				accountability: ctx.accountability ?? { admin: true },
			});
			await foldersService.deleteOne(folderId);
		} else {
			await ctx.database('directus_folders').where({ id: folderId }).del();
		}
		folder = true;
	} catch (err: any) {
		warnings.push(`Failed deleting folder ${folderId}: ${err?.message || err}`);
	}

	return { files, folder };
}

async function deleteScanArtifacts(ctx: CleanupContext, warnings: string[]) {
	let deleted_scan_files = 0;
	let deleted_scan_folder = false;

	try {
		const folderId = await getUnreferencedScanFolderId(ctx.database);
		if (folderId) {
			const result = await deleteFolderAndFiles(ctx, folderId, warnings);
			deleted_scan_files = result.files;
			deleted_scan_folder = result.folder;
		} else {
			// Name match only (legacy / renamed parent)
			const row = await ctx
				.database('directus_folders')
				.select('id')
				.where({ name: UNREFERENCED_SCAN_FOLDER_NAME })
				.whereNull('parent')
				.first();
			if (row?.id) {
				const result = await deleteFolderAndFiles(ctx, String(row.id), warnings);
				deleted_scan_files = result.files;
				deleted_scan_folder = result.folder;
			}
		}
	} catch (err: any) {
		warnings.push(`Scan folder cleanup failed: ${err?.message || err}`);
	}

	return { deleted_scan_files, deleted_scan_folder };
}

async function emptyRecycleBin(ctx: CleanupContext, warnings: string[]) {
	let deleted_recycle_files = 0;
	let deleted_recycle_folder = false;
	let emptied_recycle = false;

	try {
		const settings = await loadSettings(ctx.database);
		const recycle = normalizeRecycleSettings(settings.recycle);
		let folderId = recycle.folder_id;
		if (!folderId) {
			const row = await ctx
				.database('directus_folders')
				.select('id')
				.where({ name: RECYCLE_DEFAULT_FOLDER_NAME })
				.whereNull('parent')
				.first();
			folderId = row?.id ? String(row.id) : null;
		}
		if (!folderId) return { emptied_recycle, deleted_recycle_files, deleted_recycle_folder };

		const result = await deleteFolderAndFiles(ctx, folderId, warnings);
		deleted_recycle_files = result.files;
		deleted_recycle_folder = result.folder;
		emptied_recycle = result.files > 0 || result.folder;
	} catch (err: any) {
		warnings.push(`Recycle Bin empty failed: ${err?.message || err}`);
	}

	return { emptied_recycle, deleted_recycle_files, deleted_recycle_folder };
}

async function clearSettingsField(ctx: CleanupContext, warnings: string[]) {
	let cleared_value = false;
	let deleted_field = false;

	try {
		const hasColumn = await ctx.database.schema.hasColumn('directus_settings', STORAGE_MANAGER_FIELD);
		if (hasColumn) {
			await ctx.database('directus_settings').update({ [STORAGE_MANAGER_FIELD]: null });
			cleared_value = true;
		}
	} catch (err: any) {
		warnings.push(`Could not clear settings value: ${err?.message || err}`);
	}

	try {
		const schema = await ctx.getSchema();
		const FieldsService = ctx.services.FieldsService;
		if (FieldsService) {
			const fieldsService = new FieldsService({
				database: ctx.database,
				schema,
				accountability: { admin: true },
			});
			await fieldsService.deleteField('directus_settings', STORAGE_MANAGER_FIELD);
			deleted_field = true;
		} else {
			warnings.push('FieldsService unavailable — settings field meta not deleted');
		}
	} catch (err: any) {
		const msg = String(err?.message || err);
		if (/not found|does not exist|unknown field/i.test(msg)) {
			deleted_field = true;
		} else {
			warnings.push(`Could not delete settings field: ${msg}`);
		}
	}

	invalidateSettingsCache();
	return { cleared_value, deleted_field };
}

export async function cleanupExtensionData(
	ctx: CleanupContext,
	opts: CleanupOptions = {},
): Promise<CleanupResult> {
	const warnings: string[] = [];

	// Flows / scan / optional recycle first — still need settings for recycle folder id.
	const deleted_purge_flow = await deletePurgeFlows(ctx, warnings);
	const scan = await deleteScanArtifacts(ctx, warnings);
	const recycle =
		opts.empty_recycle === true
			? await emptyRecycleBin(ctx, warnings)
			: { emptied_recycle: false, deleted_recycle_files: 0, deleted_recycle_folder: false };

	const settings = await clearSettingsField(ctx, warnings);

	ctx.logger?.info?.(
		`[storage-manager] Cleanup done` +
			` flow=${deleted_purge_flow}` +
			` scan_files=${scan.deleted_scan_files}` +
			` recycle_files=${recycle.deleted_recycle_files}`,
	);

	return {
		...settings,
		deleted_purge_flow,
		deleted_scan_files: scan.deleted_scan_files,
		deleted_scan_folder: scan.deleted_scan_folder,
		emptied_recycle: recycle.emptied_recycle,
		deleted_recycle_files: recycle.deleted_recycle_files,
		deleted_recycle_folder: recycle.deleted_recycle_folder,
		warnings,
	};
}
