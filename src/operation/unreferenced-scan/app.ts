export default {
	id: 'storage-manager-unreferenced-scan',
	name: 'Scan Unreferenced Files',
	icon: 'link_off',
	description: 'Dry-run scan for File Library entries that nothing still references',
	overview: ({ storage, min_age_minutes, scan_text_fields }: Record<string, unknown>) => [
		{
			label: 'Storage',
			text: storage ? String(storage) : 'All',
		},
		{
			label: 'Min age',
			text: `${Number(min_age_minutes) || 0} min`,
		},
		{
			label: 'Text fields',
			text: scan_text_fields === false ? 'No' : 'Yes',
		},
	],
	options: [
		{
			field: 'storage',
			name: 'Storage Filter',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'storage-manager-storage-location',
				options: { includeAll: true },
				note: 'Limit the scan to one storage, or All Storages.',
			},
		},
		{
			field: 'min_age_minutes',
			name: 'Min Age (Minutes)',
			type: 'integer',
			meta: {
				width: 'half',
				interface: 'input',
				options: { min: 0 },
				note: 'Skip files uploaded within this many minutes. Default is 60.',
			},
			schema: { default_value: 60 },
		},
		{
			field: 'scan_text_fields',
			name: 'Scan Text Fields',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'Also search rich text, Markdown, JSON, code, and text columns for /assets/ links and file UUIDs. Leave unset to use the Storage Manager default.',
			},
		},
	],
};
