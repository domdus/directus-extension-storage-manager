<script setup lang="ts">
/**
 * Multi-adapter storage folder picker for “Move to Storage Folder”.
 * Lists every configured location with its physical folder tree.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useStorageManager } from '../composables/use-storage-manager';
import { useStorageFolderTrees } from '../composables/use-storage-folder-trees';
import StorageFolderPickerItem from './storage-folder-picker-item.vue';

export type StorageTarget = {
	location: string;
	path: string;
};

const props = defineProps<{
	modelValue: StorageTarget;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: StorageTarget): void;
}>();

const { storages, loadStorages } = useStorageManager();
const { trees, loading, loadTrees } = useStorageFolderTrees();

const openFolders = ref<string[]>([]);

const locations = computed(() => storages.value.map((s) => s.location));

const selectedAncestors = computed(() => {
	const loc = props.modelValue?.location || '';
	const path = String(props.modelValue?.path || '').replace(/^\/+|\/+$/g, '');
	if (!loc) return [] as string[];
	const out: string[] = [`@${loc}`];
	if (!path) return out;
	const parts = path.split('/').filter(Boolean);
	for (let i = 1; i <= parts.length; i++) {
		out.push(`${loc}::${parts.slice(0, i).join('/')}`);
	}
	return out;
});

watch(
	selectedAncestors,
	(ancestors) => {
		const next = new Set(openFolders.value);
		for (const key of ancestors) next.add(key);
		openFolders.value = Array.from(next);
	},
	{ immediate: true },
);

function select(location: string, path: string) {
	emit('update:modelValue', { location, path });
}

function isActive(location: string, path: string) {
	return props.modelValue?.location === location && (props.modelValue?.path || '') === path;
}

async function ensureTrees() {
	await loadStorages().catch(() => undefined);
	const locs = storages.value.map((s) => s.location);
	if (locs.length) await loadTrees(locs);
}

watch(
	locations,
	(locs) => {
		if (locs.length) void loadTrees(locs);
	},
	{ deep: true },
);

onMounted(() => {
	void ensureTrees();
});
</script>

<template>
	<v-skeleton-loader v-if="loading && !locations.length" />
	<div v-else class="folder-picker">
		<v-list>
			<v-item-group v-model="openFolders" scope="storage-target-picker" multiple>
				<v-list-group
					v-for="loc in locations"
					:key="loc"
					disable-groupable-parent
					clickable
					:active="isActive(loc, '')"
					scope="storage-target-picker"
					:value="`@${loc}`"
					:arrow-placement="(trees[loc] || []).length > 0 ? 'after' : false"
					@click="select(loc, '')"
				>
					<template #activator>
						<v-list-item-icon>
							<v-icon name="storage" />
						</v-list-item-icon>
						<v-list-item-content>Root ({{ loc }})</v-list-item-content>
					</template>

					<storage-folder-picker-item
						v-for="folder in trees[loc] || []"
						:key="`${loc}:${folder.path}`"
						:folder="folder"
						:current-path="modelValue.location === loc ? modelValue.path : '__none__'"
						:click-handler="(p) => select(loc, p)"
						scope="storage-target-picker"
						:value-prefix="`${loc}::`"
					/>
				</v-list-group>
			</v-item-group>
		</v-list>

		<p v-if="!locations.length" class="empty">No storage adapters configured.</p>
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
