<script setup lang="ts">
/**
 * Port of Directus FolderPicker (v11.17.4) for physical storage folders.
 * Expandable nested list (v-list-group) — not a flat indented dump.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import type { StorageFolderNode } from '../../shared/types';
import StorageFolderPickerItem from './storage-folder-picker-item.vue';

const props = defineProps<{
	location: string;
	modelValue: string;
	/** Paths that cannot be selected (e.g. folders being moved). */
	disabledPaths?: string[];
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
}>();

const api = useApi();
const loading = ref(false);
const tree = ref<StorageFolderNode[]>([]);

const openFolders = ref<string[]>(['root']);

const selectedAncestors = computed(() => {
	const path = String(props.modelValue || '').replace(/^\/+|\/+$/g, '');
	if (!path) return [] as string[];
	const parts = path.split('/').filter(Boolean);
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		out.push(parts.slice(0, i).join('/'));
	}
	return out;
});

watch(
	selectedAncestors,
	(ancestors) => {
		const next = new Set(openFolders.value);
		next.add('root');
		for (const p of ancestors) next.add(p);
		openFolders.value = Array.from(next);
	},
	{ immediate: true },
);

async function loadTree() {
	loading.value = true;
	try {
		const res = await api.get(`/storage-manager/storages/${encodeURIComponent(props.location)}/folder-tree`);
		tree.value = (res.data?.data || []) as StorageFolderNode[];
	} catch {
		tree.value = [];
	} finally {
		loading.value = false;
	}
}

function select(path: string) {
	emit('update:modelValue', path);
}

watch(
	() => props.location,
	() => {
		void loadTree();
	},
);

onMounted(() => {
	void loadTree();
});
</script>

<template>
	<v-skeleton-loader v-if="loading" />
	<div v-else class="folder-picker">
		<v-list>
			<v-item-group v-model="openFolders" scope="storage-folder-picker" multiple>
				<v-list-group
					disable-groupable-parent
					clickable
					:active="modelValue === ''"
					scope="storage-folder-picker"
					value="root"
					:arrow-placement="tree.length > 0 ? 'after' : false"
					@click="select('')"
				>
					<template #activator>
						<v-list-item-icon>
							<v-icon name="storage" />
						</v-list-item-icon>
						<v-list-item-content>Root ({{ location }})</v-list-item-content>
					</template>

					<storage-folder-picker-item
						v-for="folder in tree"
						:key="folder.path"
						:folder="folder"
						:current-path="modelValue"
						:click-handler="select"
						:disabled="disabledPaths?.includes(folder.path)"
						:disabled-paths="disabledPaths"
					/>
				</v-list-group>
			</v-item-group>
		</v-list>

		<p v-if="!tree.length" class="empty">No storage folders yet.</p>
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
