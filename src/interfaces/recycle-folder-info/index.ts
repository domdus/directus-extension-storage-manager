import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';

export default defineInterface({
	id: 'storage-manager-recycle-folder-info',
	name: 'Recycle Folder (read-only)',
	description: 'Shows the configured Storage Manager Recycle Bin folder',
	icon: 'recycling',
	component: InterfaceComponent,
	types: ['string'],
	group: 'other',
	system: true,
	options: null,
});
