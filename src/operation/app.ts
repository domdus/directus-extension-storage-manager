export default {
	id: 'storage-manager-operation',
	name: 'Storage Manager',
	icon: 'swap_horiz',
	description: 'Copy or move selected Directus files between storage adapters (same file id)',
	overview: ({ mode, target_storage, folder_id }: Record<string, unknown>) => [
		{ label: 'Mode', text: String(mode || 'move') },
		{ label: 'Target', text: String(target_storage || '') },
		...(folder_id ? [{ label: 'Folder', text: String(folder_id) }] : []),
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
				interface: 'storage-manager-storage-location',
				note: 'Configured storage adapter to copy or move files onto.',
			},
			schema: { required: true },
		},
		{
			field: 'folder_id',
			name: 'Directus Folder',
			type: 'uuid',
			meta: {
				width: 'half',
				interface: 'system-folder',
				note: 'Optional. After a successful migrate, assign those files to this File Library folder. Leave empty to keep each file’s current folder.',
			},
		},
		{
			field: 'file_ids',
			name: 'File IDs',
			type: 'json',
			meta: {
				width: 'full',
				interface: 'input-code',
				options: { language: 'json', placeholder: '["uuid-1", "uuid-2"]' },
				note: 'JSON array of file UUIDs to copy or move. Required — use Flow data to pass selected or triggered file ids.',
			},
			schema: { required: true },
		},
	],
};
