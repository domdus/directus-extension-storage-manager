<script setup lang="ts">
/**
 * Storage adapter row in left-nav — expandable when physical folders exist
 * (parity with Directus Folders / nav-folder-item).
 */
import type { StorageLocationInfo, StorageFolderNode } from '../../shared/types';
import NavStorageFolderItem from './nav-storage-folder-item.vue';

defineOptions({ name: 'NavStorageItem' });

defineProps<{
	storage: StorageLocationInfo;
	folders: StorageFolderNode[];
	currentLocation?: string | null;
	currentPath?: string;
	clickHandler: (target: { location: string; path?: string }) => void;
}>();

function rootValue(location: string) {
	return `@${location}`;
}
</script>

<template>
	<template v-if="!folders.length">
		<v-list-item
			clickable
			:active="currentLocation === storage.location && !currentPath"
			@click="clickHandler({ location: storage.location })"
		>
			<v-list-item-icon>
				<v-icon :name="storage.icon" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="storage.location" />
			</v-list-item-content>
		</v-list-item>
	</template>

	<v-list-group
		v-else
		clickable
		scope="storage-navigation"
		:value="rootValue(storage.location)"
		:active="currentLocation === storage.location"
		arrow-placement="after"
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

		<nav-storage-folder-item
			v-for="folder in folders"
			:key="folder.path"
			:location="storage.location"
			:folder="folder"
			:current-location="currentLocation"
			:current-path="currentPath"
			:click-handler="clickHandler"
		/>
		<!-- context-menu actions refresh via useStorageFolderTrees -->
	</v-list-group>
</template>
