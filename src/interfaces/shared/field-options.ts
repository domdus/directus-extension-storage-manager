const MIME_CHOICES = [
	{ value: 'image/*', text: 'image/*' },
	{ value: 'video/*', text: 'video/*' },
	{ value: 'audio/*', text: 'audio/*' },
	{ value: 'text/*', text: 'text/*' },
	{ value: 'application/pdf', text: 'application/pdf' },
];

type RelationsContext = { m2o?: { related_collection?: string }; o2m?: { collection?: string } };

const storageLocationFieldOption = {
	field: 'storage',
	name: 'Storage Location',
	type: 'string',
	schema: { default_value: 'local' },
	meta: {
		width: 'half',
		interface: 'storage-manager-storage-location',
		note: 'Storage adapter for uploads from this field. Works with Mirror Directus Folders when enabled for that storage.',
	},
} as const;

export function getStorageFileFieldOptions(
	relations: RelationsContext,
	extra: Record<string, unknown>[] = [],
) {
	const collection = relations.m2o?.related_collection;

	return [
		{
			field: 'folder',
			name: '$t:interfaces.system-folder.folder',
			type: 'uuid',
			meta: {
				width: 'half',
				interface: 'system-folder',
				note: '$t:interfaces.system-folder.field_hint',
			},
		},
		storageLocationFieldOption,
		...extra,
		{
			field: 'filter',
			name: '$t:filter',
			type: 'json',
			meta: {
				interface: 'system-filter',
				options: { collectionName: collection },
			},
		},
		{
			field: 'enableCreate',
			name: '$t:creating_items',
			schema: { default_value: true },
			meta: {
				interface: 'boolean',
				options: { label: '$t:enable_create_button' },
				width: 'half',
			},
		},
		{
			field: 'enableSelect',
			name: '$t:selecting_items',
			schema: { default_value: true },
			meta: {
				interface: 'boolean',
				options: { label: '$t:enable_select_button' },
				width: 'half',
			},
		},
		{
			field: 'allowedMimeTypes',
			name: '$t:interfaces.file.allowed_mime_types',
			type: 'json',
			meta: {
				interface: 'select-multiple-dropdown',
				options: {
					placeholder: '$t:interfaces.file.mime_types_placeholder',
					choices: MIME_CHOICES,
				},
			},
		},
	];
}

export function getStorageFilesFieldOptions(relations: RelationsContext) {
	const collection = relations.m2o?.related_collection;

	return [
		{
			field: 'folder',
			name: '$t:interfaces.system-folder.folder',
			type: 'uuid',
			meta: {
				width: 'half',
				interface: 'system-folder',
				note: '$t:interfaces.system-folder.field_hint',
			},
		},
		storageLocationFieldOption,
		{
			field: 'template',
			name: '$t:display_template',
			meta: {
				interface: 'system-display-template',
				options: { collectionName: relations.o2m?.collection },
			},
		},
		{
			field: 'filter',
			name: '$t:filter',
			type: 'json',
			meta: {
				interface: 'system-filter',
				options: { collectionName: collection },
			},
		},
		{
			field: 'enableCreate',
			name: '$t:creating_items',
			schema: { default_value: true },
			meta: {
				interface: 'boolean',
				options: { label: '$t:enable_create_button' },
				width: 'half',
			},
		},
		{
			field: 'enableSelect',
			name: '$t:selecting_items',
			schema: { default_value: true },
			meta: {
				interface: 'boolean',
				options: { label: '$t:enable_select_button' },
				width: 'half',
			},
		},
		{
			field: 'limit',
			name: '$t:per_page',
			type: 'integer',
			meta: { interface: 'input', width: 'half' },
			schema: { default_value: 15 },
		},
		{
			field: 'allowedMimeTypes',
			name: '$t:interfaces.file.allowed_mime_types',
			type: 'json',
			meta: {
				interface: 'select-multiple-dropdown',
				options: {
					placeholder: '$t:interfaces.file.mime_types_placeholder',
					choices: MIME_CHOICES,
				},
			},
		},
	];
}

export const DEFAULT_IMAGE_MIME_TYPES = ['image/*'];
