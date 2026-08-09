import { defineModule } from '@directus/extensions-sdk';
import { userHasAdminAccess } from '../shared/admin';
import OverviewView from './overview-view.vue';
import StorageView from './storage-view.vue';
import FoldersView from './folders-view.vue';

export default defineModule({
	id: 'storage-manager',
	name: 'Storage Manager',
	icon: 'swap_horiz',
	routes: [
		{
			path: '',
			component: OverviewView,
		},
		{
			path: 'storage/:location',
			component: StorageView,
		},
		{
			path: 'folders',
			component: FoldersView,
		},
		{
			path: 'folders/:folderId',
			component: FoldersView,
		},
	],
	preRegisterCheck(user) {
		return userHasAdminAccess(user);
	},
});
