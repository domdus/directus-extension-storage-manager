<script setup lang="ts">
/**
 * Recursive physical storage folder item for left-nav (mirrors nav-folder-item)
 * with File Library-style context menu (Rename / Move / Delete).
 *
 * Subfolders load on expand via useStorageFolderTrees (browse API per path).
 */
import { computed, ref } from 'vue';
import type { StorageFolderNode } from '../../shared/types';
import StorageFolderContextMenu from './storage-folder-context-menu.vue';

defineOptions({ name: 'NavStorageFolderItem' });

const props = defineProps<{
	location: string;
	folder: StorageFolderNode;
	currentLocation?: string | null;
	currentPath?: string;
	clickHandler: (target: { location: string; path?: string }) => void;
}>();

const emit = defineEmits<{
	(e: 'changed'): void;
}>();

const menu = ref<{ open: (event: MouseEvent) => void } | null>(null);

function groupValue(location: string, path: string) {
	return `${location}:${path}`;
}

function isActive(location: string, path: string, currentLocation?: string | null, currentPath?: string) {
	return currentLocation === location && (currentPath || '') === path;
}

/** Chevron until first expand; hide when loaded empty. */
const isExpandable = computed(() => {
	if (props.folder.childrenLoaded) {
		return (props.folder.children?.length ?? 0) > 0;
	}
	return true;
});

function onContextMenu(event: MouseEvent) {
	menu.value?.open(event);
}

function onChanged() {
	emit('changed');
}
</script>

<template>
	<template v-if="!isExpandable">
		<v-list-item
			clickable
			:active="isActive(location, folder.path, currentLocation, currentPath)"
			@click="clickHandler({ location, path: folder.path })"
			@contextmenu.prevent="onContextMenu"
		>
			<v-list-item-icon>
				<v-icon name="folder" outline />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="folder.name" />
			</v-list-item-content>
		</v-list-item>
	</template>

	<v-list-group
		v-else
		clickable
		scope="storage-navigation"
		:value="groupValue(location, folder.path)"
		:active="isActive(location, folder.path, currentLocation, currentPath)"
		arrow-placement="after"
		disable-groupable-parent
		@click="clickHandler({ location, path: folder.path })"
		@contextmenu.prevent="onContextMenu"
	>
		<template #activator>
			<v-list-item-icon>
				<v-icon name="folder" outline />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="folder.name" />
			</v-list-item-content>
		</template>

		<v-list-item v-if="folder.childrenLoaded && !folder.children?.length" disabled>
			<v-list-item-content>
				<span class="empty-children">Empty</span>
			</v-list-item-content>
		</v-list-item>

		<nav-storage-folder-item
			v-for="child in folder.children || []"
			:key="child.path"
			:location="location"
			:folder="child"
			:current-location="currentLocation"
			:current-path="currentPath"
			:click-handler="clickHandler"
			@changed="onChanged"
		/>
	</v-list-group>

	<storage-folder-context-menu
		ref="menu"
		:location="location"
		:path="folder.path"
		:name="folder.name"
		@changed="onChanged"
	/>
</template>

<style scoped>
.empty-children {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}
</style>
