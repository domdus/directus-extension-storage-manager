export default {
	id: 'storage-manager-recycle-purge',
	name: 'Purge Recycle Bin',
	icon: 'delete_forever',
	description: 'Permanently delete expired files from the Storage Manager Recycle Bin',
	overview: ({ older_than_days, dry_run }: Record<string, unknown>) => [
		{
			label: 'Older than',
			text:
				older_than_days === undefined || older_than_days === null || older_than_days === ''
					? 'Settings default'
					: `${Number(older_than_days) || 1} days`,
		},
		{
			label: 'Dry run',
			text: dry_run ? 'Yes' : 'No',
		},
	],
	options: [
		{
			field: 'recycle_folder',
			name: 'Recycle Folder',
			type: 'string',
			meta: {
				width: 'full',
				interface: 'storage-manager-recycle-folder-info',
				readonly: true,
				note: 'From Storage Manager → Recycle Bin. Purge always targets this folder.',
			},
		},
		{
			field: 'older_than_days',
			name: 'Older Than (Days)',
			type: 'integer',
			meta: {
				width: 'half',
				interface: 'input',
				options: { min: 1 },
				note: 'Purge files whose trashed_at is older than this. Leave empty to use the Recycle Bin retention setting (default 30).',
			},
		},
		{
			field: 'dry_run',
			name: 'Dry Run',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'Count candidates only — do not delete.',
			},
			schema: { default_value: false },
		},
	],
};
