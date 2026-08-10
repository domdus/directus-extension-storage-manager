<script setup lang="ts">
/**
 * Port of Directus File Library collection.vue (v11.17.0), adapted for Storage Manager.
 * Uses host-registered layout-cards / layout-tabular via useLayout — same chrome as File Library.
 * Migration / Detect actions live in the right sidebar (and header shortcuts).
 *
 * https://github.com/directus/directus/blob/v11.17.0/app/src/modules/files/routes/collection.vue
 */
import { useLayout } from '@directus/composables';
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import ModuleNavigation from '../navigation.vue';
import SearchInput from './search-input.vue';
import HeaderActionButton from './header-action-button.vue';
import LayoutSidebarDetail from './layout-sidebar-detail.vue';
import MigrateDrawer from './migrate-drawer.vue';
import ImportOrphansDrawer from './import-orphans-drawer.vue';
import UsageBar from './usage-bar.vue';
import { useDropUpload } from '../composables/use-drop-upload';
import { useFilesBrowserPreset } from '../composables/use-files-browser-preset';
import { useFolders } from '../composables/use-folders';
import { useStorageManager } from '../composables/use-storage-manager';
import { useMigrateJob } from '../composables/use-migrate-job';
import { getFolderFilter, getStorageFilter, mergeFilters } from '../utils/filters';
import { formatBytes } from '../../shared/format';

const props = defineProps<{
	mode: 'folders' | 'storage';
	folder?: string;
	storage?: string;
}>();

const route = useRoute();
const router = useRouter();
const { folders } = useFolders();
const { storages, loadStorages } = useStorageManager();
const { running: migrateRunning, reopenNonce } = useMigrateJob();

const layoutRef = ref();
const selection = ref<string[]>([]);

const { layout, layoutOptions, layoutQuery, filter, search, resetPreset } = useFilesBrowserPreset();
const { layoutWrapper } = useLayout(layout);

const systemFilter = computed(() => {
	if (props.mode === 'storage' && props.storage) {
		return getStorageFilter(props.storage);
	}
	return getFolderFilter(props.folder ?? null);
});

const title = computed(() => {
	if (props.mode === 'storage') return props.storage || 'Storage';
	if (props.folder) {
		const folder = folders.value?.find((f) => f.id === props.folder);
		return folder?.name || 'Folder';
	}
	return 'Folders';
});

const breadcrumb = computed(() => {
	const items = [{ name: 'Storage Manager', to: '/storage-manager' }];
	if (props.mode === 'storage') {
		items.push({
			name: props.storage || 'Storage',
			to: `/storage-manager/storage/${props.storage}`,
		});
	} else {
		items.push({ name: 'Folders', to: '/storage-manager/folders' });
		if (props.folder) {
			items.push({
				name: title.value,
				to: `/storage-manager/folders/${props.folder}`,
			});
		}
	}
	return items;
});

const storageInfo = computed(() => {
	if (props.mode !== 'storage' || !props.storage) return null;
	return storages.value.find((s) => s.location === props.storage) || null;
});

const drawerOpen = ref(false);
const importOpen = ref(false);
const selectionKind = ref<'files' | 'storage' | 'folder'>('files');

const estimateCount = computed(() => {
	if (selectionKind.value === 'files') return selection.value.length;
	if (selectionKind.value === 'storage') return storageInfo.value?.file_count ?? undefined;
	return undefined;
});

const estimateBytes = computed(() => {
	if (selectionKind.value === 'storage') return storageInfo.value?.total_bytes;
	return undefined;
});

onBeforeRouteLeave((to, from) => {
	if (to.path !== from.path) selection.value = [];
});

onBeforeRouteUpdate((to, from) => {
	// Keep selection when only opening/closing the file drawer (?file=)
	if (to.path !== from.path) selection.value = [];
});

watch(
	() => [props.folder, props.storage, props.mode] as const,
	() => {
		selection.value = [];
	},
);

watch(
	() => [props.storage, String(route.query.detect || '')] as const,
	([location, detect]) => {
		if (props.mode === 'storage' && location && detect === '1') {
			importOpen.value = true;
		}
	},
	{ immediate: true },
);

onMounted(() => {
	loadStorages().catch(() => undefined);
});

async function refresh() {
	await layoutRef.value?.state?.refresh?.();
	await loadStorages(true).catch(() => undefined);
}

function clearFilters() {
	filter.value = null;
	search.value = null;
}

function openMigrate(kind: 'files' | 'storage' | 'folder') {
	selectionKind.value = kind;
	drawerOpen.value = true;
}

function openDetect() {
	importOpen.value = true;
	if (props.mode === 'storage' && props.storage && String(route.query.detect || '') !== '1') {
		router.replace({ path: route.path, query: { ...route.query, detect: '1' } });
	}
}

function onDetectOpenChange(open: boolean) {
	importOpen.value = open;
	if (!open && String(route.query.detect || '') === '1') {
		const next = { ...route.query };
		delete next.detect;
		router.replace({ path: route.path, query: next });
	}
}

async function onMigrated() {
	selection.value = [];
	await refresh();
}

async function onImported() {
	selection.value = [];
	await refresh();
}

// Refresh list when a background (or any) migrate job finishes while this view is mounted.
watch(migrateRunning, async (now, was) => {
	if (was && !now) {
		selection.value = [];
		await refresh();
	}
});

// Progress toast click → reopen migrate drawer with live details.
watch(reopenNonce, () => {
	if (migrateRunning.value) drawerOpen.value = true;
});

watch(
	() => String(route.query.migrateJob || ''),
	(value) => {
		if (value !== '1') return;
		drawerOpen.value = true;
		const next = { ...route.query };
		delete next.migrateJob;
		router.replace({ path: route.path, query: next });
	},
	{ immediate: true },
);

const uploadPreset = computed(() => {
	if (props.mode === 'storage') {
		return { storage: props.storage };
	}
	return { folder: props.folder ?? null };
});

const fileInput = ref<HTMLInputElement | null>(null);

const { dragging, showDropEffect, uploading, onFileInputChange } = useDropUpload({
	preset: uploadPreset,
	onDone: refresh,
});

function openFilePicker() {
	fileInput.value?.click();
}

/**
 * Native /files/:id hardcodes back-to File Library — so open files in-module via drawer.
 * Cards use getLinkForItem; tabular uses onRowClick.
 */
const activeFileId = computed(() => {
	const value = route.query.file;
	return typeof value === 'string' && value.length > 0 ? value : null;
});

function fileDetailPath(id: string | number) {
	const query: Record<string, string | string[]> = { ...route.query, file: String(id) };
	const params = new URLSearchParams();

	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value)) {
			for (const entry of value) params.append(key, String(entry));
		} else {
			params.set(key, String(value));
		}
	}

	const qs = params.toString();
	return qs ? `${route.path}?${qs}` : route.path;
}

function clearFileQuery() {
	if (!('file' in route.query)) return;
	const next = { ...route.query };
	delete next.file;
	router.replace({ path: route.path, query: next });
}

function onFileDrawerActive(open: boolean) {
	if (!open) {
		clearFileQuery();
		refresh().catch(() => undefined);
	}
}

function bindLayout(layoutState: Record<string, any>) {
	const pkField = layoutState.primaryKeyField?.field || 'id';

	return {
		...layoutState,
		getLinkForItem(item: Record<string, any>) {
			const id = item?.[pkField];
			if (id == null) return;
			return fileDetailPath(id);
		},
		onRowClick({ item, event }: { item: Record<string, any>; event: MouseEvent }) {
			const primaryKey = item?.[pkField];
			if (primaryKey == null) return;

			if (selection.value.length > 0) {
				if (!selection.value.includes(primaryKey)) {
					selection.value = selection.value.concat(primaryKey);
				} else {
					selection.value = selection.value.filter((key) => key !== primaryKey);
				}
				return;
			}

			const path = fileDetailPath(primaryKey);
			if (event.ctrlKey || event.metaKey) window.open(router.resolve(path).href, '_blank');
			else router.push(path);
		},
	};
}
</script>

<template>
	<component
		:is="layoutWrapper"
		ref="layoutRef"
		v-slot="{ layoutState }"
		v-model:selection="selection"
		v-model:layout-options="layoutOptions"
		v-model:layout-query="layoutQuery"
		:filter="mergeFilters(filter, systemFilter)"
		:filter-user="filter"
		:filter-system="systemFilter"
		:search="search"
		collection="directus_files"
		:reset-preset="resetPreset"
	>
		<private-view
			:title="title"
			:icon="mode === 'storage' ? storageInfo?.icon || 'storage' : 'folder'"
			:class="{ dragging }"
		>
			<template #headline>
				<v-breadcrumb :items="breadcrumb" />
			</template>

			<template #actions:prepend>
				<component :is="`layout-actions-${layout}`" v-bind="layoutState" />
			</template>

			<template #actions>
				<input
					ref="fileInput"
					class="upload-input"
					type="file"
					multiple
					@change="onFileInputChange"
				/>

				<search-input v-model="search" v-model:filter="filter" collection="directus_files" />

				<header-action-button
					v-if="mode === 'storage'"
					v-tooltip.bottom="`Detect Files on ${storage}`"
					icon="radar"
					secondary
					@click="openDetect"
				/>

				<header-action-button
					v-if="selection.length"
					v-tooltip.bottom="'Migrate Selected'"
					icon="drive_file_move"
					secondary
					@click="openMigrate('files')"
				/>

				<header-action-button
					v-if="mode === 'storage'"
					v-tooltip.bottom="'Migrate All'"
					icon="swap_horiz"
					@click="openMigrate('storage')"
				/>

				<header-action-button
					v-else
					v-tooltip.bottom="folder ? 'Migrate This Folder' : 'Migrate Root Files'"
					icon="swap_horiz"
					@click="openMigrate('folder')"
				/>
			</template>

			<template #navigation>
				<module-navigation />
			</template>

			<template v-if="showDropEffect">
				<div class="drop-border top" />
				<div class="drop-border right" />
				<div class="drop-border bottom" />
				<div class="drop-border left" />
			</template>

			<component :is="`layout-${layout}`" v-bind="bindLayout(layoutState)">
				<template #no-results>
					<v-info v-if="!filter && !search" title="No files" icon="folder" center>
						Drop files here to upload, or use the + button.
						<template #append>
							<v-button @click="openFilePicker">Add file</v-button>
						</template>
					</v-info>
					<v-info v-else title="No results" icon="search" center>
						No files match your search or filters.
						<template #append>
							<v-button @click="clearFilters">Clear filters</v-button>
						</template>
					</v-info>
				</template>

				<template #no-items>
					<v-info title="No files" icon="folder" center>
						Drop files here to upload, or use the + button.
						<template #append>
							<v-button @click="openFilePicker">Add file</v-button>
						</template>
					</v-info>
				</template>
			</component>

			<drawer-item
				v-if="activeFileId"
				collection="directus_files"
				:primary-key="activeFileId"
				:active="true"
				@update:active="onFileDrawerActive"
			/>

			<template #sidebar>
				<layout-sidebar-detail v-model="layout">
					<component :is="`layout-options-${layout}`" v-bind="layoutState" />
				</layout-sidebar-detail>
				<component :is="`layout-sidebar-${layout}`" v-bind="layoutState" />

				<sidebar-detail id="actions" icon="swap_horiz" title="Actions">
					<div class="sidebar-actions">
						<v-button
							secondary
							full-width
							class="sidebar-btn"
							:loading="uploading"
							@click="openFilePicker"
						>
							{{ mode === 'storage' ? `Upload to ${storage}` : 'Upload files' }}
						</v-button>
						<v-button
							v-if="mode === 'storage'"
							secondary
							full-width
							class="sidebar-btn"
							@click="openDetect"
						>
							Detect files on {{ storage }}
						</v-button>
						<v-button
							v-if="selection.length"
							secondary
							full-width
							class="sidebar-btn"
							@click="openMigrate('files')"
						>
							Migrate selected ({{ selection.length }})
						</v-button>
						<v-button
							v-if="mode === 'storage'"
							full-width
							class="sidebar-btn sidebar-btn-primary"
							@click="openMigrate('storage')"
						>
							Migrate all on {{ storage }}
						</v-button>
						<v-button
							v-else
							full-width
							class="sidebar-btn sidebar-btn-primary"
							@click="openMigrate('folder')"
						>
							{{ folder ? 'Migrate this folder' : 'Migrate root files' }}
						</v-button>
					</div>
				</sidebar-detail>

				<sidebar-detail
					v-if="mode === 'storage' && storageInfo"
					id="storage-info"
					icon="info"
					title="Storage"
				>
					<p class="sidebar-text storage-label">{{ storageInfo.label }}</p>
					<usage-bar :usage="storageInfo" compact plain />
				</sidebar-detail>

				<sidebar-detail v-else id="folders-info" icon="info" title="Folders">
					<p class="sidebar-text">
						Browse virtual folders like the File Library. Migrate selected files or an entire folder between
						storage adapters.
					</p>
				</sidebar-detail>
			</template>

			<migrate-drawer
				v-model="drawerOpen"
				:storages="storages"
				:source-storage="mode === 'storage' ? storage || null : null"
				:selection-kind="selectionKind"
				:file-ids="selection"
				:folder-id="mode === 'folders' ? folder ?? null : null"
				:estimated-count="estimateCount"
				:estimated-bytes="estimateBytes"
				@done="onMigrated"
			/>

			<import-orphans-drawer
				v-if="mode === 'storage' && storage"
				:model-value="importOpen"
				:location="storage"
				@update:model-value="onDetectOpenChange"
				@imported="onImported"
			/>
		</private-view>
	</component>
</template>

<style scoped>
.upload-input {
	display: none;
}

.drop-border {
	position: fixed;
	z-index: 500;
	background-color: var(--theme--primary);
}

.drop-border.top,
.drop-border.bottom {
	inline-size: 100%;
	block-size: 0.25rem;
}

.drop-border.left,
.drop-border.right {
	inline-size: 0.25rem;
	block-size: 100%;
}

.drop-border.top {
	inset-block-start: 0;
	inset-inline-start: 0;
}

.drop-border.right {
	inset-block-start: 0;
	inset-inline-end: 0;
}

.drop-border.bottom {
	inset-block-end: 0;
	inset-inline-start: 0;
}

.drop-border.left {
	inset-block-start: 0;
	inset-inline-start: 0;
}

.dragging :deep(*) {
	pointer-events: none;
}

.dragging :deep([data-dropzone]) {
	pointer-events: all;
}

.sidebar-actions {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* Sidebar panel bg often matches --theme--background-normal, so default
   secondary buttons look like plain text. Force a visible chip fill. */
.sidebar-actions :deep(.sidebar-btn) {
	display: flex;
	width: 100%;
}

.sidebar-actions :deep(.sidebar-btn .button) {
	width: 100%;
	justify-content: center;
	color: var(--theme--foreground);
	background-color: var(--theme--background-accent);
	border-color: var(--theme--background-accent);
}

.sidebar-actions :deep(.sidebar-btn .button:hover:not(:disabled)) {
	background-color: var(--theme--background-normal);
	border-color: var(--theme--background-normal);
}

/* Theme fill only when enabled — disabled stays gray like secondary */
.sidebar-actions :deep(.sidebar-btn-primary .button:not(:disabled)) {
	color: var(--foreground-inverted, var(--theme--primary-foreground, #fff));
	background-color: var(--theme--primary);
	border-color: var(--theme--primary);
}

.sidebar-actions :deep(.sidebar-btn-primary .button:hover:not(:disabled)) {
	background-color: var(--theme--primary-accent);
	border-color: var(--theme--primary-accent);
}

.sidebar-actions :deep(.sidebar-btn .button:disabled) {
	color: var(--theme--foreground-subdued);
	background-color: var(--theme--background-accent);
	border-color: var(--theme--background-accent);
	opacity: 0.65;
	cursor: not-allowed;
}

.sidebar-text {
	margin: 0;
	line-height: 1.45;
}

.storage-label {
	margin-bottom: 10px;
	font-weight: 600;
}
</style>
