import { defineDisplay } from '@directus/extensions-sdk';
import StorageLocationBadge from './storage-location-badge.vue';

export default defineDisplay({
	id: 'storage-location-badge',
	name: 'Storage Location Badge',
	icon: 'storage',
	description: 'Compact badge for a storage adapter location name.',
	component: StorageLocationBadge,
	options: null,
	types: ['string'],
});
