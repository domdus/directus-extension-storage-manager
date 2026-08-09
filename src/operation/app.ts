export default {
	id: 'storage-manager-operation',
	name: 'Storage Manager',
	icon: 'swap_horiz',
	description: 'Copy or move Directus files between storage adapters (same file id)',
	overview: ({ mode, target_storage, source_storage, folder_id }: Record<string, unknown>) => [
		{ label: 'Mode', text: String(mode || 'move') },
		{ label: 'Target', text: String(target_storage || '') },
		{ label: 'Source', text: String(source_storage || folder_id || 'file_ids') },
	],
	options: [
		{
			field: 'mode',
			name: 'Mode',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-dropdown',
				options: {
					choices: [
						{ text: 'Move (delete source after verify)', value: 'move' },
						{ text: 'Copy (keep source)', value: 'copy' },
					],
				},
				note: 'Move only deletes the source object after the target is verified and the DB row is updated.',
			},
			schema: { default_value: 'move' },
		},
		{
			field: 'target_storage',
			name: 'Target Storage',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: { placeholder: 's3' },
				note: 'Must match a configured STORAGE_LOCATIONS name.',
			},
			schema: { required: true },
		},
		{
			field: 'file_ids',
			name: 'File IDs',
			type: 'json',
			meta: {
				width: 'full',
				interface: 'input-code',
				options: { language: 'json', placeholder: '["uuid-1", "uuid-2"]' },
				note: 'Optional JSON array of file UUIDs. Leave empty when using source storage or folder.',
			},
		},
		{
			field: 'source_storage',
			name: 'Source Storage',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: { placeholder: 'local' },
				note: 'Migrate all files currently on this storage location.',
			},
		},
		{
			field: 'folder_id',
			name: 'Folder ID',
			type: 'uuid',
			meta: {
				width: 'half',
				interface: 'system-folder',
				note: 'Migrate files in this folder (optional).',
			},
		},
		{
			field: 'recursive',
			name: 'Include Subfolders',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'When a folder is selected, also migrate files in nested folders.',
			},
			schema: { default_value: true },
		},
	],
};
