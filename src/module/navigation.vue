<script setup lang="ts">
/**
 * Port of Directus files-navigation.vue (v11.17.0), adapted for Storage Manager:
 * - Folders tree → /storage-manager/folders/...
 * - Storage adapters as flat links
 */
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFolders } from './composables/use-folders';
import { useStorageManager } from './composables/use-storage-manager';
import NavFolderItem from './components/nav-folder-item.vue';

const route = useRoute();
const router = useRouter();
const { nestedFolders, folders, loading, openFolders } = useFolders();
const { storages, loadStorages } = useStorageManager();

const currentFolder = computed(() => {
	if (!route.path.startsWith('/storage-manager/folders')) return undefined;
	const id = route.params.folderId;
	return id ? String(id) : undefined;
});

const currentStorage = computed(() => {
	if (!route.path.startsWith('/storage-manager/storage/')) return undefined;
	return String(route.params.location || '') || undefined;
});

const isFoldersRoot = computed(
	() => route.path === '/storage-manager/folders' || route.path === '/storage-manager/folders/',
);

const isOverview = computed(() => route.path === '/storage-manager' || route.path === '/storage-manager/');

watch([currentFolder, loading], setOpenFolders, { immediate: true });

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

function goOverview() {
	router.push('/storage-manager');
}

function goStorage(location: string) {
	router.push(`/storage-manager/storage/${location}`);
}

function setOpenFolders() {
	if (!folders.value) return;
	if (!openFolders?.value) return;

	const shouldBeOpen: string[] = [];
	const folder = folders.value.find((f) => f.id === currentFolder.value);

	if (folder?.parent) parseFolder(folder.parent);

	const newOpenFolders = [...openFolders.value];

	for (const folderID of shouldBeOpen) {
		if (newOpenFolders.includes(folderID) === false) {
			newOpenFolders.push(folderID);
		}
	}

	if (
		newOpenFolders.length !== 1 &&
		JSON.stringify(newOpenFolders) !== JSON.stringify(openFolders.value)
	) {
		openFolders.value = newOpenFolders;
	}

	function parseFolder(id: string) {
		if (!folders.value) return;
		shouldBeOpen.push(id);
		const node = folders.value.find((f) => f.id === id);
		if (node?.parent) parseFolder(node.parent);
	}
}
</script>

<template>
	<v-list nav>
		<v-list-item clickable :active="isOverview" @click="goOverview">
			<v-list-item-icon>
				<v-icon name="dashboard" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow text="Storage" />
			</v-list-item-content>
		</v-list-item>

		<template v-if="loading && (!nestedFolders || nestedFolders.length === 0)">
			<v-list-item v-for="n in 4" :key="n">
				<v-skeleton-loader type="list-item-icon" />
			</v-list-item>
		</template>

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
							<v-text-overflow text="Folders" />
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

		<v-divider />

		<div class="section-label">Storage adapters</div>

		<div class="storages">
			<v-list-item
				v-for="storage in storages"
				:key="storage.location"
				clickable
				:active="currentStorage === storage.location"
				@click="goStorage(storage.location)"
			>
				<v-list-item-icon>
					<v-icon :name="storage.icon" />
				</v-list-item-icon>
				<v-list-item-content>
					<v-text-overflow :text="storage.location" />
				</v-list-item-content>
			</v-list-item>
		</div>
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
	padding: 12px 12px 4px;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--theme--foreground-subdued);
}
</style>
