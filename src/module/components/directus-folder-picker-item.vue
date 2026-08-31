<script setup lang="ts">
/**
 * Recursive Directus (virtual) folder row for folder picker dialogs.
 */
import type { Folder } from '../composables/use-folders';

defineOptions({ name: 'DirectusFolderPickerItem' });

defineProps<{
	folder: Folder;
	currentFolder: string | null;
	clickHandler: (folderId: string | null) => void;
}>();
</script>

<template>
	<template v-if="!folder.children || folder.children.length === 0">
		<v-list-item
			clickable
			:active="currentFolder === folder.id"
			@click="clickHandler(folder.id)"
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
		scope="directus-folder-picker"
		:value="folder.id"
		:active="currentFolder === folder.id"
		arrow-placement="after"
		disable-groupable-parent
		@click="clickHandler(folder.id)"
	>
		<template #activator>
			<v-list-item-icon>
				<v-icon name="folder" outline />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="folder.name" />
			</v-list-item-content>
		</template>

		<directus-folder-picker-item
			v-for="child in folder.children"
			:key="child.id"
			:folder="child"
			:current-folder="currentFolder"
			:click-handler="clickHandler"
		/>
	</v-list-group>
</template>
