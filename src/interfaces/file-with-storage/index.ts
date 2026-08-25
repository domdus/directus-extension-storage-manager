import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';
import { getStorageFileFieldOptions } from '../shared/field-options';

export default defineInterface({
	id: 'storage-manager-file-with-storage',
	name: 'File with Storage',
	description: 'Upload or select a single file to a configured storage adapter and folder',
	icon: 'note_add',
	component: InterfaceComponent,
	types: ['uuid'],
	localTypes: ['file'],
	group: 'relational',
	relational: true,
	options: ({ relations }) => getStorageFileFieldOptions(relations),
	recommendedDisplays: ['file'],
});
