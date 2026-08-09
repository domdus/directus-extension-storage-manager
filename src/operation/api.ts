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
	source_storage?: string;
	folder_id?: string | null;
	recursive?: boolean;
	concurrency?: number | string;
};

async function collectFolderIds(database: any, rootId: string, recursive: boolean): Promise<string[]> {
	if (!recursive) return [rootId];

	const all = await database('directus_folders').select('id', 'parent');
	const childrenMap = new Map<string | null, string[]>();
	for (const row of all) {
		const parent = row.parent == null ? null : String(row.parent);
		const id = String(row.id);
		if (!childrenMap.has(parent)) childrenMap.set(parent, []);
		childrenMap.get(parent)!.push(id);
	}

	const result: string[] = [];
	const stack = [String(rootId)];
	while (stack.length) {
		const current = stack.pop()!;
		result.push(current);
		for (const kid of childrenMap.get(current) || []) stack.push(kid);
	}
	return result;
}

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

		let fileIds = parseFileIds(input.file_ids);

		if (fileIds.length === 0) {
			const query = database('directus_files').select('id');

			if (input.source_storage) {
				const source = String(input.source_storage).trim();
				if (!locations.includes(source)) {
					throw new Error(`Unknown source storage "${source}"`);
				}
				query.where('storage', source);
			}

			if (input.folder_id) {
				const folderIds = await collectFolderIds(database, String(input.folder_id), input.recursive !== false);
				query.whereIn('folder', folderIds);
			}

			if (!input.source_storage && !input.folder_id) {
				throw new Error('Provide file_ids, source_storage, and/or folder_id');
			}

			const rows = await query;
			fileIds = rows.map((r: { id: string }) => String(r.id));
		}

		const concurrency = input.concurrency != null ? parseInt(String(input.concurrency), 10) : 1;

		logger.info(`[storage-manager-operation] ${mode} ${fileIds.length} file(s) → ${target}`);

		return await migrateFiles({
			fileIds,
			targetStorage: target,
			mode,
			concurrency,
			database,
			logger,
		});
	},
};
