<script setup lang="ts">
/**
 * Pick a Directus File Library (virtual) folder — updates `directus_files.folder` only.
 */
import { computed, onMounted, watch } from 'vue';
import { useFolders } from '../composables/use-folders';
import DirectusFolderPickerItem from './directus-folder-picker-item.vue';

const props = withDefaults(
	defineProps<{
		/** Selected folder id, or `null` for File Library root (unfiled). */
		modelValue: string | null;
		/** When false, hide “Root (no folder)” — e.g. Recycle Bin must be a real folder. */
		allowRoot?: boolean;
	}>(),
	{ allowRoot: true },
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string | null): void;
}>();

const { nestedFolders, folders, loading, fetchFolders, openFolders } = useFolders();

const selectedAncestors = computed(() => {
	const id = props.modelValue;
	if (!id || !folders.value?.length) return [] as string[];

	const byId = new Map(folders.value.map((f) => [f.id, f]));
	const out: string[] = [];
	let cur = byId.get(id);
	while (cur?.parent) {
		out.unshift(cur.parent);
		cur = byId.get(cur.parent);
	}
	return out;
});

watch(
	selectedAncestors,
	(ancestors) => {
		const next = new Set(openFolders.value);
		for (const id of ancestors) next.add(id);
		openFolders.value = Array.from(next);
	},
	{ immediate: true },
);

function select(folderId: string | null) {
	emit('update:modelValue', folderId);
}

onMounted(() => {
	void fetchFolders();
});
</script>

<template>
	<v-skeleton-loader v-if="loading && !nestedFolders?.length" />
	<div v-else class="folder-picker">
		<v-list>
			<v-item-group v-model="openFolders" scope="directus-folder-picker" multiple>
				<v-list-item
					v-if="allowRoot"
					clickable
					:active="modelValue === null"
					@click="select(null)"
				>
					<v-list-item-icon>
						<v-icon name="folder_open" />
					</v-list-item-icon>
					<v-list-item-content>Root (no folder)</v-list-item-content>
				</v-list-item>

				<directus-folder-picker-item
					v-for="folder in nestedFolders || []"
					:key="folder.id"
					:folder="folder"
					:current-folder="modelValue"
					:click-handler="select"
				/>
			</v-item-group>
		</v-list>

		<p v-if="!(nestedFolders || []).length" class="empty">No Directus folders yet.</p>
	</div>
</template>

<style scoped>
.folder-picker {
	--v-list-item-background-color-hover: var(--theme--background-accent);
	--v-list-item-background-color-active: var(--theme--background-accent);

	padding: 0.6875rem;
	background-color: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
	max-block-size: 17.5rem;
	overflow: auto;
}

.empty {
	margin: 8px 12px 4px;
	font-size: 13px;
	color: var(--theme--foreground-subdued);
}
</style>
