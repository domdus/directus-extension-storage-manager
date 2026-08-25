import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from '../file-with-storage/interface.vue';
import { DEFAULT_IMAGE_MIME_TYPES, getStorageFileFieldOptions } from '../shared/field-options';

export default defineInterface({
	id: 'storage-manager-image-with-storage',
	name: 'Image with Storage',
	description: 'Upload or select an image to a configured storage adapter and folder',
	icon: 'insert_photo',
	component: InterfaceComponent,
	types: ['uuid'],
	localTypes: ['file'],
	group: 'relational',
	relational: true,
	options: ({ relations }) => {
		const base = getStorageFileFieldOptions(relations);
		return base.map((option) => {
			if (option.field !== 'allowedMimeTypes') return option;
			return {
				...option,
				schema: { default_value: DEFAULT_IMAGE_MIME_TYPES },
			};
		});
	},
	recommendedDisplays: ['image'],
});
