import { defineModule } from '@directus/extensions-sdk';
import { userHasAdminAccess } from '../shared/admin';
import OverviewView from './overview-view.vue';
import StorageView from './storage-view.vue';
import FoldersView from './folders-view.vue';
import SettingsView from './settings-view.vue';
import UnreferencedView from './unreferenced-view.vue';

export default defineModule({
	id: 'storage-manager',
	name: 'Storage Manager',
	icon: 'storage',
	routes: [
		{
			path: '',
			component: OverviewView,
		},
		{
			path: 'unreferenced',
			component: UnreferencedView,
		},
		{
			path: 'storage/:location',
			component: StorageView,
		},
		{
			path: 'storage/:location/path/:storagePath(.*)',
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
		{
			path: 'settings',
			component: SettingsView,
		},
	],
	preRegisterCheck(user) {
		return userHasAdminAccess(user);
	},
});
