import { migrateFiles } from '../endpoint/migrate';
import { listConfiguredLocations } from '../endpoint/usage';
import type { MigrateMode } from '../shared/types';

type OperationContext = {
	env: Record<string, unknown>;
	database: any;
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
};

type OperationInput = {
	mode?: MigrateMode;
	target_storage?: string;
	file_ids?: string[] | string;
	/** Optional File Library folder to assign after a successful migrate. */
	folder_id?: string | null;
	concurrency?: number | string;
};

function parseFileIds(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return [];
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
		} catch {
			// single uuid
			return [trimmed];
		}
	}
	return [];
}

export default {
	id: 'storage-manager-operation',
	handler: async (input: OperationInput, { env, database, logger }: OperationContext) => {
		const mode: MigrateMode = input.mode === 'copy' ? 'copy' : 'move';
		const target = String(input.target_storage || '').trim();

		if (!target) {
			throw new Error('target_storage is required');
		}

		const locations = listConfiguredLocations(env);
		if (!locations.includes(target)) {
			throw new Error(`Unknown target storage "${target}". Available: ${locations.join(', ')}`);
		}

		const fileIds = parseFileIds(input.file_ids);
		if (!fileIds.length) {
			throw new Error('file_ids is required (JSON array of file UUIDs)');
		}

		const folderId =
			input.folder_id != null && String(input.folder_id).trim()
				? String(input.folder_id).trim()
				: null;

		if (folderId) {
			const folder = await database('directus_folders').select('id').where({ id: folderId }).first();
			if (!folder) {
				throw new Error(`Unknown Directus folder "${folderId}"`);
			}
		}

		const concurrency = input.concurrency != null ? parseInt(String(input.concurrency), 10) : 1;

		logger.info(
			`[storage-manager-operation] ${mode} ${fileIds.length} file(s) → ${target}` +
				(folderId ? ` (folder ${folderId})` : ''),
		);

		const response = await migrateFiles({
			fileIds,
			targetStorage: target,
			mode,
			concurrency,
			database,
			logger,
		});

		if (folderId) {
			const okIds = (response.results || [])
				.filter((r) => r.status === 'moved' || r.status === 'copied')
				.map((r) => String(r.id));
			if (okIds.length) {
				await database('directus_files').whereIn('id', okIds).update({ folder: folderId });
				logger.info(
					`[storage-manager-operation] Assigned ${okIds.length} file(s) to Directus folder ${folderId}`,
				);
			}
		}

		return response;
	},
};
