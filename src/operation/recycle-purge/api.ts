import { purgeExpiredRecycle } from '../../endpoint/recycle';

type OperationContext = {
	env: Record<string, unknown>;
	database: any;
	services: Record<string, any>;
	getSchema: () => Promise<any>;
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
};

type OperationInput = {
	older_than_days?: number | string | null;
	dry_run?: boolean | null;
};

export default {
	id: 'storage-manager-recycle-purge',
	handler: async (
		input: OperationInput,
		{ env, database, services, getSchema, logger }: OperationContext,
	) => {
		const olderThan =
			input.older_than_days === undefined || input.older_than_days === null || input.older_than_days === ''
				? undefined
				: Math.max(1, Number(input.older_than_days) || 1);
		const dryRun = Boolean(input.dry_run);

		logger.info(
			`[storage-manager-recycle-purge] starting` +
				` older_than=${olderThan ?? 'settings'} dry_run=${dryRun}`,
		);

		const result = await purgeExpiredRecycle(
			{
				database,
				env,
				services,
				getSchema,
				accountability: { admin: true },
				logger,
			},
			{
				older_than_days: olderThan,
				dry_run: dryRun,
			},
		);

		logger.info(
			`[storage-manager-recycle-purge] done` +
				` candidates=${result.candidate_count}` +
				` deleted=${result.deleted}` +
				` skipped=${result.skipped}` +
				` failed=${result.failed}`,
		);

		return result;
	},
};
