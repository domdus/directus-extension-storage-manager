import { loadSettings } from '../../hook/settings';
import { LIFECYCLE_DEFAULTS, normalizeLifecycleSettings } from '../../shared/lifecycle';
import { listConfiguredLocations } from '../../endpoint/usage';
import { scanUnreferencedFiles } from '../../endpoint/unreferenced';

type OperationContext = {
	env: Record<string, unknown>;
	database: any;
	getSchema: () => Promise<any>;
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
};

type OperationInput = {
	storage?: string | null;
	min_age_minutes?: number | string | null;
	scan_text_fields?: boolean | null;
};

export default {
	id: 'storage-manager-unreferenced-scan',
	handler: async (input: OperationInput, { env, database, getSchema, logger }: OperationContext) => {
		const settings = await loadSettings(database);
		const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);

		const storageRaw = input.storage == null ? '' : String(input.storage).trim();
		const storage = storageRaw || null;
		if (storage) {
			const locations = listConfiguredLocations(env);
			if (!locations.includes(storage)) {
				throw new Error(`Unknown storage "${storage}". Available: ${locations.join(', ')}`);
			}
		}

		const minAgeMinutes =
			input.min_age_minutes === undefined || input.min_age_minutes === null || input.min_age_minutes === ''
				? lifecycle.scan_min_age_minutes
				: Math.max(0, Number(input.min_age_minutes) || 0);

		const scanTextFields =
			input.scan_text_fields === undefined || input.scan_text_fields === null
				? lifecycle.scan_text_fields
				: Boolean(input.scan_text_fields);

		const schema = await getSchema();
		logger.info(
			`[storage-manager-unreferenced-scan] starting` +
				` storage=${storage || 'all'} min_age=${minAgeMinutes} text=${scanTextFields}`,
		);

		const result = await scanUnreferencedFiles(database, schema, {
			minAgeMinutes,
			scanTextFields,
			storage,
			logger,
		});

		logger.info(
			`[storage-manager-unreferenced-scan] done` +
				` unreferenced=${result.meta.unreferenced_count}` +
				` listed=${result.meta.ids.length}` +
				` bytes=${result.meta.unreferenced_bytes}` +
				` ${result.meta.elapsed_ms}ms`,
		);

		return {
			meta: result.meta,
			/** Listed unreferenced ids (capped) — ready to pass into migrate / delete steps. */
			file_ids: result.meta.ids,
			unreferenced_count: result.meta.unreferenced_count,
			unreferenced_bytes: result.meta.unreferenced_bytes,
			ids_truncated: result.meta.ids_truncated,
			elapsed_ms: result.meta.elapsed_ms,
		};
	},
};
