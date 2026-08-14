<script setup lang="ts">
/**
 * Recursive item for storage-folder-picker — mirrors Directus FolderPickerListItem.
 */
import { computed } from 'vue';
import type { StorageFolderNode } from '../../shared/types';

defineOptions({ name: 'StorageFolderPickerItem' });

const props = withDefaults(
	defineProps<{
		folder: StorageFolderNode;
		currentPath: string;
		clickHandler: (path: string) => void;
		disabled?: boolean;
		disabledPaths?: string[];
		/** v-item-group scope (multi-adapter picker uses a different scope). */
		scope?: string;
		/** Prefix for open-state group values when paths are not globally unique. */
		valuePrefix?: string;
	}>(),
	{
		scope: 'storage-folder-picker',
		valuePrefix: '',
	},
);

function pathBlocked(path: string): boolean {
	return (props.disabledPaths || []).some((d) => path === d || path.startsWith(`${d}/`));
}

const itemDisabled = computed(() => Boolean(props.disabled) || pathBlocked(props.folder.path));
const groupValue = computed(() => `${props.valuePrefix}${props.folder.path}`);
</script>

<template>
	<div class="folder-picker-list-item">
		<v-list-item
			v-if="!folder.children?.length"
			clickable
			:active="currentPath === folder.path"
			:disabled="itemDisabled"
			@click="clickHandler(folder.path)"
		>
			<v-list-item-icon>
				<v-icon :name="currentPath === folder.path ? 'folder_open' : 'folder'" />
			</v-list-item-icon>
			<v-list-item-content>{{ folder.name }}</v-list-item-content>
		</v-list-item>

		<v-list-group
			v-else
			clickable
			:scope="scope"
			:value="groupValue"
			:active="currentPath === folder.path"
			:disabled="itemDisabled"
			disable-groupable-parent
			arrow-placement="after"
			@click="clickHandler(folder.path)"
		>
			<template #activator>
				<v-list-item-icon>
					<v-icon :name="currentPath === folder.path ? 'folder_open' : 'folder'" />
				</v-list-item-icon>
				<v-list-item-content>{{ folder.name }}</v-list-item-content>
			</template>

			<storage-folder-picker-item
				v-for="child in folder.children"
				:key="child.path"
				:folder="child"
				:current-path="currentPath"
				:click-handler="clickHandler"
				:disabled="pathBlocked(child.path)"
				:disabled-paths="disabledPaths"
				:scope="scope"
				:value-prefix="valuePrefix"
			/>
		</v-list-group>
	</div>
</template>
