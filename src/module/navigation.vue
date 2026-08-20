<script setup lang="ts">
/**
 * Port of Directus files-navigation.vue (v11.17.0), adapted for Storage Manager:
 * - Folders tree → /storage-manager/folders/...
 * - Storage adapters with expandable physical folder trees
 */
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFolders } from './composables/use-folders';
import { useStorageManager } from './composables/use-storage-manager';
import { useStorageFolderTrees } from './composables/use-storage-folder-trees';
import NavFolderItem from './components/nav-folder-item.vue';
import NavStorageItem from './components/nav-storage-item.vue';
import { decodeStoragePathFromUrl, storageManagerPath } from '../shared/storage-path-url';

const route = useRoute();
const router = useRouter();
const { nestedFolders, folders, loading, openFolders } = useFolders();
const { storages, loadStorages } = useStorageManager();
const { trees, openFolders: openStorageFolders } = useStorageFolderTrees();

const currentFolder = computed(() => {
	if (!route.path.startsWith('/storage-manager/folders')) return undefined;
	const id = route.params.folderId;
	return id ? String(id) : undefined;
});

const currentStorage = computed(() => {
	if (!route.path.startsWith('/storage-manager/storage/')) return undefined;
	return String(route.params.location || '') || undefined;
});

const currentStoragePath = computed(() => {
	if (!currentStorage.value) return '';
	const raw = route.params.storagePath;
	const joined = Array.isArray(raw) ? raw.filter(Boolean).join('/') : raw ? String(raw) : '';
	return decodeStoragePathFromUrl(joined);
});

const isFoldersRoot = computed(
	() => route.path === '/storage-manager/folders' || route.path === '/storage-manager/folders/',
);

const isOverview = computed(() => route.path === '/storage-manager' || route.path === '/storage-manager/');

const isSettings = computed(() => route.path.startsWith('/storage-manager/settings'));

watch([currentFolder, loading, folders], setOpenFolders, { immediate: true });
watch([currentStorage, currentStoragePath, trees], setOpenStorageFolders, { immediate: true, deep: true });

onMounted(() => {
	loadStorages().catch(() => undefined);
});

function onFolderClick(target: { folder?: string }) {
	if (target.folder) {
		router.push(`/storage-manager/folders/${target.folder}`);
	} else {
		router.push('/storage-manager/folders');
	}
}

function onStorageClick(target: { location: string; path?: string }) {
	router.push(storageManagerPath(target.location, target.path));
}

function goOverview() {
	router.push('/storage-manager');
}

function goSettings() {
	router.push('/storage-manager/settings');
}

function setOpenFolders() {
	if (!folders.value || loading.value) return;
	if (!openFolders?.value) return;
	// Only auto-expand when a nested folder is active — keep Directus Folders collapsed by default.
	if (!currentFolder.value) return;

	const shouldBeOpen: string[] = ['root'];
	const folder = folders.value.find((f) => f.id === currentFolder.value);

	if (folder?.parent) parseFolder(folder.parent);

	const next = [...openFolders.value];
	let changed = false;

	for (const folderID of shouldBeOpen) {
		if (!next.includes(folderID)) {
			next.push(folderID);
			changed = true;
		}
	}

	if (changed) {
		openFolders.value = next;
	}

	function parseFolder(id: string) {
		if (!folders.value) return;
		shouldBeOpen.push(id);
		const node = folders.value.find((f) => f.id === id);
		if (node?.parent) parseFolder(node.parent);
	}
}

function setOpenStorageFolders() {
	const location = currentStorage.value;
	if (!location) return;

	const shouldBeOpen: string[] = [`@${location}`];
	const path = currentStoragePath.value;
	if (path) {
		const parts = path.split('/').filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			shouldBeOpen.push(`${location}:${parts.slice(0, i).join('/')}`);
		}
	}

	// Always merge into a new array so late-mounted tree groups pick up open state after refresh.
	openStorageFolders.value = Array.from(new Set([...openStorageFolders.value, ...shouldBeOpen]));
}
</script>

<template>
	<v-list nav>
		<v-list-item clickable :active="isOverview" @click="goOverview">
			<v-list-item-icon>
				<v-icon name="dashboard" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow text="Storage Manager" />
			</v-list-item-content>
		</v-list-item>

		<v-divider />

		<template v-if="loading && (!nestedFolders || nestedFolders.length === 0)">
			<v-list-item v-for="n in 4" :key="n">
				<v-skeleton-loader type="list-item-icon" />
			</v-list-item>
		</template>

		<div class="section-label">Storage adapters</div>

		<div class="storages">
			<v-item-group v-model="openStorageFolders" scope="storage-navigation" multiple>
				<nav-storage-item
					v-for="storage in storages"
					:key="storage.location"
					:storage="storage"
					:folders="trees[storage.location] || []"
					:current-location="currentStorage"
					:current-path="currentStoragePath"
					:click-handler="onStorageClick"
				/>
			</v-item-group>
		</div>

		<v-divider />

		<div class="folders">
			<v-item-group v-model="openFolders" scope="files-navigation" multiple>
				<v-list-group
					clickable
					:active="isFoldersRoot || Boolean(currentFolder)"
					value="root"
					scope="files-navigation"
					exact
					disable-groupable-parent
					:arrow-placement="nestedFolders && nestedFolders.length > 0 ? 'after' : false"
					@click="onFolderClick({})"
				>
					<template #activator>
						<v-list-item-icon>
							<v-icon name="folder_special" outline />
						</v-list-item-icon>
						<v-list-item-content>
							<v-text-overflow text="Directus Folders" />
						</v-list-item-content>
					</template>

					<nav-folder-item
						v-for="folder in nestedFolders || []"
						:key="folder.id"
						:folder="folder"
						:current-folder="currentFolder"
						:click-handler="onFolderClick"
					/>
				</v-list-group>
			</v-item-group>
		</div>

		<v-list-item clickable :active="isSettings" @click="goSettings">
			<v-list-item-icon>
				<v-icon name="settings" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow text="Settings" />
			</v-list-item-content>
		</v-list-item>
	</v-list>
</template>

<style scoped>
.v-skeleton-loader {
	--v-skeleton-loader-background-color: var(--theme--background-accent);
}

.folders,
.storages {
	width: 100%;
	overflow-x: hidden;
}

.folders :deep(.v-list-item-content),
.storages :deep(.v-list-item-content) {
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.section-label {
	padding: 4px 12px 4px;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--theme--foreground-subdued);
}
</style>
