import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';
import { getStorageFilesFieldOptions } from '../shared/field-options';

export default defineInterface({
	id: 'storage-manager-files-with-storage',
	name: 'Files with Storage',
	description: 'Upload or select multiple files to a configured storage adapter and folder',
	icon: 'note_add',
	component: InterfaceComponent,
	relational: true,
	types: ['alias'],
	localTypes: ['files'],
	group: 'relational',
	options: ({ relations }) => getStorageFilesFieldOptions(relations),
	recommendedDisplays: ['files'],
});
