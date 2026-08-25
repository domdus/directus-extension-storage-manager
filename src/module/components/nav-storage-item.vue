<script setup lang="ts">
/**
 * Storage adapter row in left-nav — expandable; root folders load on first expand.
 */
import type { StorageLocationInfo, StorageFolderNode } from '../../shared/types';
import NavStorageFolderItem from './nav-storage-folder-item.vue';

defineOptions({ name: 'NavStorageItem' });

defineProps<{
	storage: StorageLocationInfo;
	folders: StorageFolderNode[];
	treeLoaded: boolean;
	currentLocation?: string | null;
	currentPath?: string;
	clickHandler: (target: { location: string; path?: string }) => void;
}>();

function rootValue(location: string) {
	return `@${location}`;
}
</script>

<template>
	<v-list-group
		clickable
		scope="storage-navigation"
		:value="rootValue(storage.location)"
		:active="currentLocation === storage.location"
		:arrow-placement="treeLoaded && !folders.length ? false : 'after'"
		disable-groupable-parent
		@click="clickHandler({ location: storage.location })"
	>
		<template #activator>
			<v-list-item-icon>
				<v-icon :name="storage.icon" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="storage.location" />
			</v-list-item-content>
		</template>

		<v-list-item v-if="!treeLoaded">
			<v-skeleton-loader type="list-item-icon" />
		</v-list-item>

		<template v-else>
			<nav-storage-folder-item
				v-for="folder in folders"
				:key="folder.path"
				:location="storage.location"
				:folder="folder"
				:current-location="currentLocation"
				:current-path="currentPath"
				:click-handler="clickHandler"
			/>
		</template>
	</v-list-group>
</template>
