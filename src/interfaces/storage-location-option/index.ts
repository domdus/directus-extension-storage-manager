import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';

export default defineInterface({
	id: 'storage-manager-storage-location',
	name: 'Storage Location',
	description: 'Select a configured storage adapter',
	icon: 'storage',
	component: InterfaceComponent,
	types: ['string'],
	group: 'other',
	system: true,
	options: null,
});
