<script setup lang="ts">
/**
 * Port of Directus File Library collection.vue (v11.17.0), adapted for Storage Manager.
 * Uses host-registered layout-cards / layout-tabular via useLayout — same chrome as File Library.
 * Migration / Detect actions live in the right sidebar (and header shortcuts).
 *
 * https://github.com/directus/directus/blob/v11.17.0/app/src/modules/files/routes/collection.vue
 */
import { useLayout } from '@directus/composables';
import { useApi } from '@directus/extensions-sdk';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import ModuleNavigation from '../navigation.vue';
import SearchInput from './search-input.vue';
import HeaderActionButton from './header-action-button.vue';
import LayoutSidebarDetail from './layout-sidebar-detail.vue';
import MigrateDrawer from './migrate-drawer.vue';
import ImportOrphansDrawer from './import-orphans-drawer.vue';
import UsageBar from './usage-bar.vue';
import AddStorageFolder from './add-storage-folder.vue';
import StorageFolderSection from './storage-folder-section.vue';
import DirectusFolderSection from './directus-folder-section.vue';
import StorageTargetPicker from './storage-target-picker.vue';
import type { StorageTarget } from './storage-target-picker.vue';
import DeleteStorageFolderDialog from './delete-storage-folder-dialog.vue';
import UploadFilesDialog from './upload-files-dialog.vue';
import MaterializeDrawer from './materialize-drawer.vue';
import { useDropUpload } from '../composables/use-drop-upload';
import { useFilesBrowserPreset } from '../composables/use-files-browser-preset';
import { useFolders } from '../composables/use-folders';
import { useStorageManager } from '../composables/use-storage-manager';
import { useStorageFolderTrees } from '../composables/use-storage-folder-trees';
import { useMigrateJob } from '../composables/use-migrate-job';
import { usePageClass } from '../composables/use-page-class';
import { getFolderFilter, getStorageFilter, mergeFilters } from '../utils/filters';
import { DIRECTUS_FOLDERS_PAGE_INTRO, VIRTUAL_FOLDER_NOTE } from '../../shared/strategies';
import { formatBytes } from '../../shared/format';
import { storageManagerPath } from '../../shared/storage-path-url';
import type { StorageBrowseFolder } from '../../shared/types';

const props = defineProps<{
	mode: 'folders' | 'storage';
	folder?: string;
	storage?: string;
	/** Physical path within a storage adapter (storage mode only). */
	storagePath?: string;
}>();

const api = useApi();
const route = useRoute();
const router = useRouter();
const { folders } = useFolders();
const { storages, loadStorages } = useStorageManager();
const { refreshTree } = useStorageFolderTrees();
const { running: migrateRunning, reopenNonce, start: startMigrate } = useMigrateJob();
const pageClass = usePageClass();

const layoutRef = ref();
const selection = ref<string[]>([]);
const folderSelection = ref<string[]>([]);
const storageFolders = ref<StorageBrowseFolder[]>([]);
const foldersLoading = ref(false);

const moveToDialogActive = ref(false);
const materializeOpen = ref(false);
const selectedMoveTarget = ref<StorageTarget>({ location: '', path: '' });
const moving = ref(false);
const moveDryRunning = ref(false);
const moveIncludeEmptyFolders = ref(true);
const moveDryRun = ref<{
	total_files: number;
	total_folders: number;
	empty_folders: number;
	total_bytes: number;
	skipped: number | null;
	samples: Array<{ from: string; to: string; skipped: boolean }>;
} | null>(null);

const confirmDelete = ref(false);
const confirmDeleteFolders = ref(false);
const deletingFiles = ref(false);

/** Distinct storage adapters used by files in the current Directus folder view. */
const folderStorages = ref<string[]>([]);

const { layout, layoutOptions, layoutQuery, filter, search, resetPreset, resetPage } = useFilesBrowserPreset();
const { layoutWrapper } = useLayout(layout);

const normalizedStoragePath = computed(() =>
	String(props.storagePath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, ''),
);

const systemFilter = computed(() => {
	if (props.mode === 'storage' && props.storage) {
		return getStorageFilter(
			props.storage,
			normalizedStoragePath.value,
			storageFolders.value.map((f) => f.name),
		);
	}
	return getFolderFilter(props.folder ?? null);
});

const title = computed(() => {
	if (props.mode === 'storage') {
		if (normalizedStoragePath.value) {
			const parts = normalizedStoragePath.value.split('/');
			return parts[parts.length - 1] || props.storage || 'Storage';
		}
		return props.storage || 'Storage';
	}
	if (props.folder) {
		const folder = folders.value?.find((f) => f.id === props.folder);
		return folder?.name || 'Folder';
	}
	return 'Directus Folders';
});

const showFoldersPageIntro = computed(
	() => props.mode === 'folders' && !props.folder && !search.value && !filter.value,
);

/** Child Directus folders for the current virtual parent (root or folder). */
const childDirectusFolders = computed(() => {
	if (props.mode !== 'folders' || !folders.value) return [];
	const parent = props.folder ?? null;
	return folders.value
		.filter((folder) => (parent ? folder.parent === parent : folder.parent == null))
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));
});

const breadcrumb = computed(() => {
	const items = [{ name: 'Storage Manager', to: '/storage-manager' }];
	if (props.mode === 'storage') {
		items.push({
			name: props.storage || 'Storage',
			to: `/storage-manager/storage/${props.storage}`,
		});
		if (normalizedStoragePath.value) {
			const segments = normalizedStoragePath.value.split('/').filter(Boolean);
			let acc = '';
			for (const segment of segments) {
				acc = acc ? `${acc}/${segment}` : segment;
				items.push({
					name: segment,
					to: storageManagerPath(props.storage!, acc),
				});
			}
		}
	} else {
		items.push({ name: 'Directus Folders', to: '/storage-manager/folders' });
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
const selectionKind = ref<'files' | 'storage' | 'folder' | 'storage_path'>('files');
/** Resolved file IDs for Migrate Selected (includes files under selected storage folders). */
const migrateSelectedIds = ref<string[]>([]);
const migrateSelectedLoading = ref(false);

const estimateCount = computed(() => {
	if (selectionKind.value === 'files') {
		return migrateSelectedIds.value.length || selection.value.length || undefined;
	}
	if (selectionKind.value === 'storage') return storageInfo.value?.file_count ?? undefined;
	if (selectionKind.value === 'folder') return folderMigrateCount.value ?? undefined;
	return undefined;
});

const estimateBytes = computed(() => {
	if (selectionKind.value === 'storage') return storageInfo.value?.total_bytes;
	return undefined;
});

/** Direct files in the current virtual folder view (root = unfiled). */
const folderMigrateCount = ref<number | null>(null);

const multiStorageFolder = computed(
	() => props.mode === 'folders' && folderStorages.value.length > 1,
);

/** Show per-file storage labels in Directus Folders (always — not only multi-storage). */
const showStorageLocationLabels = computed(() => props.mode === 'folders');

const defaultTabularFields = ['title', 'type', 'filesize', 'modified_on'];

const effectiveLayoutQuery = computed({
	get() {
		const query = { ...layoutQuery.value };
		if (!showStorageLocationLabels.value || layout.value !== 'tabular') {
			return query;
		}

		const fields = [...(query.fields?.length ? query.fields : defaultTabularFields)];
		if (!fields.includes('storage')) {
			fields.push('storage');
		}

		return { ...query, fields };
	},
	set(value) {
		layoutQuery.value = value;
	},
});

const multiStorageNotice = computed(() => {
	if (!multiStorageFolder.value) return '';
	const list = folderStorages.value.join(', ');
	const scope = props.folder ? 'folder' : 'root view';
	return `This ${scope} has files on ${folderStorages.value.length} storages (${list}).`;
});

const canMaterializeFolder = computed(
	() => props.mode === 'folders' && selection.value.length === 0 && folderSelection.value.length === 0,
);

/** Whole-adapter transfer in sidebar — storage root only, nothing selected. */
const canMigrateStorage = computed(
	() =>
		props.mode === 'storage' &&
		Boolean(props.storage) &&
		!normalizedStoragePath.value &&
		selection.value.length === 0 &&
		folderSelection.value.length === 0,
);

const detectLabel = computed(() =>
	normalizedStoragePath.value ? 'Detect Files in this Folder' : `Detect Files on ${props.storage}`,
);

/** Nothing selected — show browse-level actions (detect / migrate whole scope). */
const nothingSelected = computed(
	() => selection.value.length === 0 && folderSelection.value.length === 0,
);

/** Move selected files, selected physical folders, this Directus folder, or all files on a storage root. */
const canMoveToStorageFolder = computed(
	() =>
		selection.value.length > 0 ||
		(props.mode === 'storage' && folderSelection.value.length > 0) ||
		(props.mode === 'storage' &&
			Boolean(props.storage) &&
			!normalizedStoragePath.value &&
			selection.value.length === 0 &&
			folderSelection.value.length === 0) ||
		(props.mode === 'folders' &&
			selection.value.length === 0 &&
			folderSelection.value.length === 0 &&
			(folderMigrateCount.value ?? 0) > 0),
);

const moveIsWholeAdapter = computed(
	() =>
		props.mode === 'storage' &&
		Boolean(props.storage) &&
		!normalizedStoragePath.value &&
		selection.value.length === 0 &&
		folderSelection.value.length === 0,
);

const moveScopeHint = computed(() => {
	if (moveIsWholeAdapter.value) {
		return `Moves every file and folder on “${props.storage}” into the destination you pick. Existing folders with the same name are merged. Files that already exist at the destination stay there.`;
	}
	if (props.mode === 'storage' && folderSelection.value.length) {
		return folderSelection.value.length === 1
			? 'Moves the selected storage folder into the destination you pick. If that folder name already exists there, files are merged into it.'
			: 'Moves the selected storage folders into the destination you pick. Matching folder names are merged.';
	}
	if (selection.value.length === 1) return 'Moves the selected file into the storage folder you pick.';
	if (selection.value.length > 1) {
		return `Moves ${selection.value.length} selected files into the storage folder you pick.`;
	}
	if (props.mode === 'folders') {
		return props.folder
			? 'No files selected — moves all files in this Directus folder into the storage folder you pick.'
			: 'No files selected — moves all unfiled files into the storage folder you pick.';
	}
	return '';
});

const moveSourceFolders = computed(() =>
	props.mode === 'storage' && folderSelection.value.length ? folderSelection.value.map(String) : [],
);

const moveActionLabel = computed(() =>
	moveIsWholeAdapter.value ? `Move all on ${props.storage}` : 'Move to Storage Folder',
);

const moveDestinationHint = computed(() => {
	const loc = selectedMoveTarget.value.location;
	if (!loc) return '';
	const dest = selectedMoveTarget.value.path ? `${loc}/${selectedMoveTarget.value.path}/` : `${loc}/`;
	if (moveIsWholeAdapter.value) {
		return `Everything on “${props.storage}” will be merged into ${dest}`;
	}
	if (moveSourceFolders.value.length === 1) {
		const name = String(moveSourceFolders.value[0]).split('/').filter(Boolean).pop();
		return `Folder “${name}” will be merged into ${dest}${name}/`;
	}
	if (moveSourceFolders.value.length > 1) {
		return `Selected folders will be merged into ${dest}{folder-name}/`;
	}
	return `Files will be moved to ${dest}`;
});

/** Migrate Selected only when storage folders are selected (files use Move). */
const canMigrateSelected = computed(
	() => props.mode === 'storage' && folderSelection.value.length > 0,
);

/** Delete when files and/or storage folders are selected. */
const canDeleteSelection = computed(
	() => selection.value.length > 0 || (props.mode === 'storage' && folderSelection.value.length > 0),
);

const migrateSelectedLabel = computed(() => {
	if (folderSelection.value.length > 0 && selection.value.length === 0) {
		return folderSelection.value.length === 1 ? 'Migrate Selected Folder' : 'Migrate Selected Folders';
	}
	return 'Migrate Selected';
});

const deleteConfirmText = computed(() => {
	const n = selection.value.length;
	return n === 1
		? 'Are you sure you want to delete this item? This action cannot be undone.'
		: `Are you sure you want to delete ${n} items? This action cannot be undone.`;
});

function openDelete() {
	if (props.mode === 'storage' && folderSelection.value.length > 0) {
		confirmDeleteFolders.value = true;
	} else {
		confirmDelete.value = true;
	}
}

async function refreshFolderMigrateCount() {
	if (props.mode !== 'folders') {
		folderMigrateCount.value = null;
		return;
	}

	try {
		const res = await api.get('/files', {
			params: {
				limit: 0,
				meta: 'filter_count',
				filter: JSON.stringify(getFolderFilter(props.folder ?? null)),
			},
		});
		folderMigrateCount.value = Number(res.data?.meta?.filter_count ?? 0);
	} catch {
		folderMigrateCount.value = 0;
	}
}

async function refreshFolderStorages() {
	if (props.mode !== 'folders') {
		folderStorages.value = [];
		return;
	}

	try {
		const res = await api.get('/files', {
			params: {
				filter: JSON.stringify(getFolderFilter(props.folder ?? null)),
				fields: ['storage'],
				limit: -1,
			},
		});
		const set = new Set<string>();
		for (const row of res.data?.data || []) {
			const loc = String(row?.storage || '').trim();
			if (loc) set.add(loc);
		}
		folderStorages.value = Array.from(set).sort((a, b) => a.localeCompare(b));
	} catch {
		folderStorages.value = [];
	}
}

const STORAGE_BADGE_CLASS = 'storage-location-badge';

function createStorageBadge(text: string): HTMLSpanElement {
	const badge = document.createElement('span');
	badge.className = STORAGE_BADGE_CLASS;
	badge.textContent = text;
	return badge;
}

function clearStorageBadges() {
	document.querySelectorAll(`.layout-cards .header .${STORAGE_BADGE_CLASS}`).forEach((el) => {
		el.remove();
	});
	document.querySelectorAll(`.layout-tabular .${STORAGE_BADGE_CLASS}`).forEach((el) => {
		const parent = el.parentElement;
		const text = el.textContent || '';
		el.remove();
		if (parent && !parent.querySelector(`.${STORAGE_BADGE_CLASS}`)) {
			parent.append(text);
		}
	});
}

function applyTableStorageBadges() {
	const headerRow = document.querySelector('.layout-tabular thead tr');
	if (!headerRow) return;

	const headers = Array.from(headerRow.children);
	let storageIndex = headers.findIndex((th) => {
		const classes = String((th as HTMLElement).className || '').split(/\s+/);
		return classes.includes('storage') || th.getAttribute('data-field') === 'storage';
	});
	if (storageIndex < 0) {
		storageIndex = headers.findIndex((th) => th.textContent?.trim().toLowerCase() === 'storage');
	}
	if (storageIndex < 0) return;

	document.querySelectorAll('.layout-tabular tbody tr').forEach((row) => {
		const cell = row.children[storageIndex] as HTMLElement | undefined;
		if (!cell || cell.querySelector(`.${STORAGE_BADGE_CLASS}`)) return;
		const text = String(cell.textContent || '').trim();
		if (!text) return;
		cell.textContent = '';
		cell.appendChild(createStorageBadge(text));
	});
}

async function applyStorageBadges(items: Record<string, any>[] | undefined) {
	clearStorageBadges();

	if (!showStorageLocationLabels.value) return;

	await nextTick();

	if (layout.value === 'tabular') {
		applyTableStorageBadges();
		return;
	}

	if (layout.value !== 'cards' || !items?.length) return;

	const cards = document.querySelectorAll('.layout-cards .grid .card:not(.folder-card)');
	if (!cards.length) return;

	const pk = 'id';
	const missingStorage = items.some((item) => item[pk] != null && item.storage == null);
	let storageById: Record<string, string> = {};

	if (missingStorage) {
		const ids = items.map((item) => item[pk]).filter(Boolean);
		if (!ids.length) return;

		try {
			const res = await api.get('/files', {
				params: {
					filter: JSON.stringify({ id: { _in: ids } }),
					fields: ['id', 'storage'],
					limit: ids.length,
				},
			});

			for (const row of res.data?.data || []) {
				storageById[String(row.id)] = String(row.storage || '');
			}
		} catch {
			return;
		}
	}

	cards.forEach((cardEl, index) => {
		const item = items[index];
		if (!item) return;

		const storage = String(item.storage ?? storageById[String(item[pk])] ?? '').trim();
		if (!storage) return;

		const header = cardEl.querySelector('.header');
		if (!header) return;

		header.appendChild(createStorageBadge(storage));
	});
}

function scheduleStorageBadges(items: Record<string, any>[] | undefined) {
	void applyStorageBadges(items).catch(() => undefined);
}

onBeforeRouteLeave((to, from) => {
	if (to.path !== from.path) {
		selection.value = [];
		folderSelection.value = [];
		confirmDelete.value = false;
		confirmDeleteFolders.value = false;
		clearStorageBadges();
	}
});

onBeforeRouteUpdate((to, from) => {
	// Keep selection when only opening/closing the file drawer (?file=)
	if (to.path !== from.path) {
		selection.value = [];
		folderSelection.value = [];
		confirmDelete.value = false;
		confirmDeleteFolders.value = false;
	}
});

watch(
	() => [props.folder, props.storage, props.mode, normalizedStoragePath.value] as const,
	() => {
		selection.value = [];
		folderSelection.value = [];
		resetPage();
		refreshFolderMigrateCount();
		refreshFolderStorages();
		clearStorageBadges();
	},
);

watch(
	() => [
		showStorageLocationLabels.value,
		layout.value,
		layoutQuery.value.page,
		layoutQuery.value.limit,
		JSON.stringify(layoutQuery.value.sort ?? []),
		layoutRef.value?.state?.loading,
		layoutRef.value?.state?.items,
	] as const,
	() => {
		if (layoutRef.value?.state?.loading) return;
		scheduleStorageBadges(layoutRef.value?.state?.items);
	},
	{ deep: true, flush: 'post' },
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
	loadStorageFolders().catch(() => undefined);
	refreshFolderMigrateCount().catch(() => undefined);
	refreshFolderStorages().catch(() => undefined);
});

watch(
	() => [props.mode, props.storage, normalizedStoragePath.value] as const,
	() => {
		void loadStorageFolders();
	},
);

async function refresh() {
	await layoutRef.value?.state?.refresh?.();
	await loadStorages(true).catch(() => undefined);
	await loadStorageFolders();
	await refreshFolderMigrateCount().catch(() => undefined);
	await refreshFolderStorages().catch(() => undefined);
	if (props.mode === 'storage' && props.storage) {
		await refreshTree(props.storage).catch(() => undefined);
	}
}

async function loadStorageFolders() {
	if (props.mode !== 'storage' || !props.storage) {
		storageFolders.value = [];
		return;
	}
	foldersLoading.value = true;
	try {
		const res = await api.get(`/storage-manager/storages/${encodeURIComponent(props.storage)}/browse`, {
			params: { path: normalizedStoragePath.value || '' },
		});
		storageFolders.value = (res.data?.data?.folders || []) as StorageBrowseFolder[];
	} catch {
		storageFolders.value = [];
	} finally {
		foldersLoading.value = false;
	}
}

function clearFilters() {
	filter.value = null;
	search.value = null;
}

async function resolveSelectedFileIds(): Promise<string[]> {
	const ids = new Set(selection.value.map(String));

	if (props.mode === 'folders' && ids.size === 0) {
		try {
			const res = await api.get('/files', {
				params: {
					limit: -1,
					fields: ['id'],
					filter: JSON.stringify(getFolderFilter(props.folder ?? null)),
				},
			});
			for (const row of res.data?.data || []) {
				ids.add(String(row.id));
			}
		} catch {
			// empty set handled by caller
		}
		return Array.from(ids);
	}

	if (props.mode === 'storage' && props.storage && folderSelection.value.length) {
		for (const folderPath of folderSelection.value) {
			const prefix = String(folderPath || '')
				.replace(/\\/g, '/')
				.replace(/^\/+|\/+$/g, '');
			if (!prefix) continue;

			try {
				const res = await api.get('/files', {
					params: {
						limit: -1,
						fields: ['id'],
						filter: JSON.stringify({
							_and: [
								{ storage: { _eq: props.storage } },
								{ filename_disk: { _starts_with: `${prefix}/` } },
							],
						}),
					},
				});
				for (const row of res.data?.data || []) {
					ids.add(String(row.id));
				}
			} catch {
				// ignore per-folder failures; empty set handled by caller
			}
		}
	}

	return Array.from(ids);
}

async function openMigrateSelected() {
	if (migrateSelectedLoading.value) return;
	migrateSelectedLoading.value = true;
	try {
		const ids = await resolveSelectedFileIds();
		if (!ids.length) {
			window.alert(
				folderSelection.value.length
					? 'Selected folder(s) contain no registered files to migrate.'
					: 'No files selected.',
			);
			return;
		}
		migrateSelectedIds.value = ids;
		selectionKind.value = 'files';
		drawerOpen.value = true;
	} finally {
		migrateSelectedLoading.value = false;
	}
}

function openMigrate(kind: 'files' | 'storage' | 'folder' | 'storage_path') {
	if (kind === 'files') {
		void openMigrateSelected();
		return;
	}
	migrateSelectedIds.value = [];
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
	folderSelection.value = [];
	migrateSelectedIds.value = [];
	await refresh();
}

async function onImported() {
	selection.value = [];
	folderSelection.value = [];
	await refresh();
}

async function onMaterialized() {
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
		return { storage: props.storage, storagePath: normalizedStoragePath.value || null };
	}
	return { folder: props.folder ?? null };
});

const uploadDialogOpen = ref(false);

const { dragging, showDropEffect, uploading, uploadFiles } = useDropUpload({
	preset: uploadPreset,
	onDone: refresh,
});

const uploadDialogTitle = computed(() => {
	if (props.mode === 'storage' && props.storage) return `Upload to ${props.storage}`;
	return 'Add File';
});

function openUploadDialog() {
	uploadDialogOpen.value = true;
}

async function onUploadDialogFiles(files: globalThis.File[]) {
	await uploadFiles(files);
}

watch(moveToDialogActive, (open) => {
	if (!open) return;
	moveDryRun.value = null;
	moveIncludeEmptyFolders.value = true;
	const others = storages.value.filter((s) => s.location !== props.storage);
	const fallback = (moveIsWholeAdapter.value ? others[0]?.location : null) || props.storage || storages.value[0]?.location || '';
	selectedMoveTarget.value = {
		location: fallback,
		path: moveIsWholeAdapter.value ? '' : props.mode === 'storage' ? normalizedStoragePath.value || '' : '',
	};
});

watch(
	() => [selectedMoveTarget.value.location, selectedMoveTarget.value.path, moveIncludeEmptyFolders.value] as const,
	() => {
		moveDryRun.value = null;
	},
);

async function batchDeleteFiles() {
	if (deletingFiles.value || !selection.value.length) return;
	deletingFiles.value = true;
	try {
		await api.delete('/files', { data: selection.value });
		selection.value = [];
		confirmDelete.value = false;
		await refresh();
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed');
	} finally {
		deletingFiles.value = false;
	}
}

/** After folder delete dialog: also remove any separately selected files (File Library parity). */
async function onStorageFolderDeleteDone() {
	try {
		if (selection.value.length > 0) {
			await api.delete('/files', { data: selection.value });
		}
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed');
	}

	selection.value = [];
	folderSelection.value = [];
	confirmDeleteFolders.value = false;
	await refresh();
	if (props.storage) {
		await refreshTree(props.storage).catch(() => undefined);
	}
}

async function buildMoveDryRunPayload() {
	const targetLoc = selectedMoveTarget.value.location;
	const targetPath = selectedMoveTarget.value.path || '';
	const sourceFolders = [...moveSourceFolders.value];
	const preservePaths = moveIsWholeAdapter.value;
	const payload: Record<string, unknown> = {
		target_storage: targetLoc,
		target_path: targetPath,
		preserve_paths: preservePaths,
		include_empty_folders: moveIncludeEmptyFolders.value,
		source_folders: sourceFolders,
	};
	if (moveIsWholeAdapter.value) {
		payload.source_storage = props.storage || undefined;
	} else if (props.mode === 'storage' && folderSelection.value.length) {
		payload.source_storage = props.storage || undefined;
		if (selection.value.length) payload.file_ids = selection.value.map(String);
	} else if (props.mode === 'folders' && selection.value.length === 0) {
		payload.folder_id = props.folder ?? null;
		payload.recursive = true;
	} else {
		payload.file_ids = selection.value.map(String);
		if (props.storage) payload.source_storage = props.storage;
	}
	return payload;
}

async function runMoveDryRun() {
	if (!selectedMoveTarget.value.location || moveDryRunning.value) return;
	moveDryRunning.value = true;
	moveDryRun.value = null;
	try {
		const payload = await buildMoveDryRunPayload();
		const resp = await api.post('/storage-manager/migrate/dry-run', payload);
		moveDryRun.value = resp.data?.data ?? null;
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Dry run failed');
	} finally {
		moveDryRunning.value = false;
	}
}

async function moveToStorageFolder() {
	const targetLoc = selectedMoveTarget.value.location;
	const targetPath = selectedMoveTarget.value.path || '';
	if (!targetLoc) return;

	moving.value = true;
	const sourceFolders = [...moveSourceFolders.value];
	const preservePaths = moveIsWholeAdapter.value;

	try {
		const fileIds = moveIsWholeAdapter.value
			? ((
					await api.get('/files', {
						params: {
							limit: -1,
							fields: ['id'],
							filter: JSON.stringify({ storage: { _eq: props.storage } }),
						},
					})
				).data?.data || []
			).map((r: { id: string }) => String(r.id))
			: await resolveSelectedFileIds();

		if (!fileIds.length && !sourceFolders.length && !moveIsWholeAdapter.value) {
			window.alert(
				props.mode === 'folders' && selection.value.length === 0
					? 'This Directus folder has no files to move.'
					: 'No files selected.',
			);
			return;
		}

		if (!fileIds.length && (sourceFolders.length || moveIsWholeAdapter.value)) {
			const resp = await api.post(`/storage-manager/storages/${encodeURIComponent(targetLoc)}/move-files`, {
				file_ids: [],
				target_path: targetPath,
				source_folders: sourceFolders,
				include_empty_folders: moveIncludeEmptyFolders.value,
				source_storage: props.storage || undefined,
				preserve_paths: preservePaths,
			});
			alertMoveSkipped(resp.data?.data?.skipped);
			moveToDialogActive.value = false;
			selection.value = [];
			folderSelection.value = [];
			await refresh();
			return;
		}

		const res = await api.get('/files', {
			params: {
				limit: -1,
				fields: ['id', 'storage'],
				filter: JSON.stringify({ id: { _in: fileIds } }),
			},
		});
		const rows = (res.data?.data || []) as Array<{ id: string; storage: string }>;
		const needCross = rows.filter((r) => String(r.storage) !== targetLoc).map((r) => String(r.id));

		if (!needCross.length) {
			const resp = await api.post(`/storage-manager/storages/${encodeURIComponent(targetLoc)}/move-files`, {
				file_ids: fileIds,
				target_path: targetPath,
				source_folders: sourceFolders,
				include_empty_folders: moveIncludeEmptyFolders.value,
				source_storage: props.storage || undefined,
				preserve_paths: preservePaths,
			});
			alertMoveSkipped(resp.data?.data?.skipped);
			moveToDialogActive.value = false;
			selection.value = [];
			folderSelection.value = [];
			await refresh();
			return;
		}

		moveToDialogActive.value = false;
		moving.value = false;

		const migratePromise = startMigrate(
			{
				file_ids: needCross,
				target_storage: targetLoc,
				mode: 'move',
				target_path: targetPath,
				source_folders: sourceFolders,
				include_empty_folders: moveIncludeEmptyFolders.value,
				source_storage: props.storage || undefined,
				preserve_paths: preservePaths,
			},
			{ estimatedCount: needCross.length },
		);
		drawerOpen.value = true;
		await migratePromise;

		const alreadyOnTarget = rows.filter((r) => String(r.storage) === targetLoc).map((r) => String(r.id));
		if (alreadyOnTarget.length) {
			const resp = await api.post(`/storage-manager/storages/${encodeURIComponent(targetLoc)}/move-files`, {
				file_ids: alreadyOnTarget,
				target_path: targetPath,
				source_folders: sourceFolders,
				include_empty_folders: moveIncludeEmptyFolders.value,
				preserve_paths: preservePaths,
			});
			alertMoveSkipped(resp.data?.data?.skipped);
		}

		selection.value = [];
		folderSelection.value = [];
		await refresh();
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Move failed');
	} finally {
		moving.value = false;
	}
}

function alertMoveSkipped(skipped: unknown) {
	const count = Number(skipped) || 0;
	if (count > 0) {
		window.alert(
			`${count.toLocaleString()} file${count === 1 ? '' : 's'} already exist at the destination and were left in place.`,
		);
	}
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

function onSelectAllFolders() {
	if (props.mode === 'folders') {
		folderSelection.value = childDirectusFolders.value.map((folder) => folder.id);
		return;
	}
	if (props.mode !== 'storage') return;
	folderSelection.value = storageFolders.value.map((f) => f.path);
}

function bindLayout(layoutState: Record<string, any>) {
	const pkField = layoutState.primaryKeyField?.field || 'id';
	const hasFolders =
		props.mode === 'storage' && storageFolders.value.length > 0 && !search.value && !filter.value;

	const bound: Record<string, any> = {
		...layoutState,
		hasPrependContent: hasFolders,
		selectMode: layoutState.selectMode || folderSelection.value.length > 0,
		getLinkForItem(item: Record<string, any>) {
			const id = item?.[pkField];
			if (id == null) return;
			return fileDetailPath(id);
		},
		onRowClick({ item, event }: { item: Record<string, any>; event: MouseEvent }) {
			const primaryKey = item?.[pkField];
			if (primaryKey == null) return;

			if (selection.value.length > 0 || folderSelection.value.length > 0) {
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

	return bound;
}
</script>

<template>
	<component
		:is="layoutWrapper"
		ref="layoutRef"
		v-slot="{ layoutState }"
		v-model:selection="selection"
		v-model:layout-options="layoutOptions"
		v-model:layout-query="effectiveLayoutQuery"
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
				<search-input v-model="search" v-model:filter="filter" collection="directus_files" />

				<add-storage-folder
					v-if="mode === 'storage' && storage"
					:location="storage"
					:parent-path="normalizedStoragePath"
					@created="refresh"
				/>

				<v-dialog
					v-if="canMoveToStorageFolder"
					v-model="moveToDialogActive"
					@esc="moveToDialogActive = false"
					@apply="moveToStorageFolder"
				>
					<template #activator="{ on }">
						<header-action-button
							v-tooltip.bottom="moveActionLabel"
							icon="folder_move"
							secondary
							@click="on"
						/>
					</template>
					<v-card>
						<v-card-title>{{ moveActionLabel }}</v-card-title>
						<v-card-text>
							<p v-if="moveScopeHint" class="move-hint">{{ moveScopeHint }}</p>
							<storage-target-picker v-model="selectedMoveTarget" />
							<p v-if="moveDestinationHint" class="move-destination-hint">
								{{ moveDestinationHint }}
							</p>
							<p class="move-destination-hint">
								Existing folders are merged. If another registered file already owns the destination
								path, the incoming file is skipped and stays on the source.
							</p>
							<v-checkbox
								v-if="moveIsWholeAdapter || moveSourceFolders.length"
								v-model="moveIncludeEmptyFolders"
								label="Include empty folders"
							/>
							<div class="move-dry-run">
								<v-button
									secondary
									:loading="moveDryRunning"
									:disabled="!selectedMoveTarget.location"
									@click="runMoveDryRun"
								>
									Dry Run
								</v-button>
								<div v-if="moveDryRun" class="move-dry-result">
									<p>
										<strong>{{ moveDryRun.total_files.toLocaleString() }}</strong> files
										<template v-if="moveDryRun.total_folders">
											· <strong>{{ moveDryRun.total_folders.toLocaleString() }}</strong>
											{{ moveDryRun.total_folders === 1 ? 'folder' : 'folders' }}
										</template>
										<template v-if="moveDryRun.empty_folders">
											<span class="move-hint">
												({{ moveDryRun.empty_folders.toLocaleString() }} empty{{
													moveIncludeEmptyFolders ? '' : ', skipped'
												}})
											</span>
										</template>
										<template v-if="moveDryRun.total_bytes">
											· {{ formatBytes(moveDryRun.total_bytes) }}
										</template>
									</p>
									<p v-if="moveDryRun.skipped" class="move-hint">
										{{ moveDryRun.skipped.toLocaleString() }} already at destination — skipped
									</p>
									<ul v-if="moveDryRun.samples?.length" class="move-samples">
										<li v-for="(row, i) in moveDryRun.samples" :key="i">
											{{ row.from }} → {{ row.to }}
											<span v-if="row.skipped"> (skipped)</span>
										</li>
									</ul>
									<p
										v-if="
											moveDryRun.samples?.length &&
											moveDryRun.total_files > moveDryRun.samples.length
										"
										class="move-hint"
									>
										Showing {{ moveDryRun.samples.length }} of
										{{ moveDryRun.total_files.toLocaleString() }} files
									</p>
								</div>
							</div>
						</v-card-text>
						<v-card-actions>
							<v-button secondary @click="moveToDialogActive = false">Cancel</v-button>
							<v-button
								:disabled="!selectedMoveTarget.location"
								:loading="moving"
								@click="moveToStorageFolder"
							>
								Move
							</v-button>
						</v-card-actions>
					</v-card>
				</v-dialog>

				<header-action-button
					v-if="canDeleteSelection"
					v-tooltip.bottom="'Delete'"
					class="action-delete"
					icon="delete"
					secondary
					:disabled="deletingFiles"
					@click="openDelete"
				/>

				<v-dialog v-model="confirmDelete" @esc="confirmDelete = false" @apply="batchDeleteFiles">
					<v-card>
						<v-card-title>Delete {{ selection.length === 1 ? 'Item' : 'Items' }}</v-card-title>
						<v-card-text>{{ deleteConfirmText }}</v-card-text>
						<v-card-actions>
							<v-button secondary @click="confirmDelete = false">Cancel</v-button>
							<v-button kind="danger" :loading="deletingFiles" @click="batchDeleteFiles">Delete</v-button>
						</v-card-actions>
					</v-card>
				</v-dialog>

				<delete-storage-folder-dialog
					v-if="mode === 'storage' && storage"
					v-model="confirmDeleteFolders"
					:location="storage"
					:paths="folderSelection"
					@done="onStorageFolderDeleteDone"
				/>


				<header-action-button
					v-if="canMaterializeFolder"
					v-tooltip.bottom="folder ? 'Materialize This Folder' : 'Materialize Root Folders'"
					icon="account_tree"
					secondary
					@click="materializeOpen = true"
				/>

				<header-action-button
					v-tooltip.bottom="'Upload File'"
					icon="add"
					:loading="uploading"
					@click="openUploadDialog"
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

			<div v-if="showFoldersPageIntro" :class="pageClass">
				<v-divider
					class="section-divider"
					large
					:inline-title="false"
					:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
				>
					<template #icon><v-icon name="folder_special" /></template>
					Directus Folders
				</v-divider>

				<p class="page-intro">{{ DIRECTUS_FOLDERS_PAGE_INTRO }}</p>
			</div>

			<v-notice v-if="multiStorageFolder" type="info" class="multi-storage-notice">
				{{ multiStorageNotice }}
			</v-notice>

			<component
				:is="`layout-${layout}`"
				v-bind="bindLayout(layoutState)"
				v-model:extra-selection="folderSelection"
				@select-all="onSelectAllFolders"
			>
				<template
					v-if="mode === 'storage' && storageFolders.length && !search && !filter"
					#prepend
				>
					<storage-folder-section
						v-model:selection="folderSelection"
						:location="storage!"
						:folders="storageFolders"
						:any-file-selection="selection.length > 0"
						@changed="refresh"
					/>
				</template>

				<template
					v-else-if="mode === 'folders' && childDirectusFolders.length && !search && !filter"
					#prepend
				>
					<directus-folder-section
						v-model:selection="folderSelection"
						:folders="childDirectusFolders"
						:any-file-selection="selection.length > 0"
					/>
				</template>

				<template #no-results>
					<v-info v-if="!filter && !search" title="No files" icon="folder" center>
						Drop files here to upload, or use the + button.
						<template #append>
							<v-button @click="openUploadDialog">Add File</v-button>
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
						<template v-if="foldersLoading">Loading storage folders…</template>
						<template v-else>
							Drop files here to upload, or use the + button.
							<template v-if="mode === 'storage'"> Create a storage folder with the folder icon. </template>
						</template>
						<template #append>
							<v-button @click="openUploadDialog">Add File</v-button>
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
							v-if="mode === 'storage' && nothingSelected"
							secondary
							full-width
							class="sidebar-btn"
							@click="openDetect"
						>
							{{ detectLabel }}
						</v-button>
						<v-button
							v-if="canMigrateStorage"
							full-width
							class="sidebar-btn sidebar-btn-primary"
							@click="moveToDialogActive = true"
						>
							Move all on {{ storage }}
						</v-button>
						<v-button
							v-if="canMaterializeFolder"
							full-width
							class="sidebar-btn"
							@click="materializeOpen = true"
						>
							{{ folder ? 'Materialize This Folder' : 'Materialize Root Folders' }}
						</v-button>
					</div>
				</sidebar-detail>

				<sidebar-detail
					v-if="mode === 'storage' && storageInfo"
					id="storage-info"
					icon="info"
					title="Storage Info"
				>
					<p class="sidebar-text storage-label">{{ storageInfo.label }}</p>
					<usage-bar :usage="storageInfo" compact plain />
				</sidebar-detail>

				<sidebar-detail v-else id="directus-folders-info" icon="info" title="Directus Folders">
					<p class="sidebar-text sidebar-note">{{ VIRTUAL_FOLDER_NOTE }}</p>
					<p class="sidebar-text">
						Use Move to Storage Folder to relocate files onto a physical path. Materialize builds storage
						folders from this virtual tree. At a storage root, Move all uses the same dialog.
					</p>
					<v-notice v-if="multiStorageFolder" type="info" class="sidebar-multi-notice">
						Files on {{ folderStorages.length }} storages:
						<strong>{{ folderStorages.join(', ') }}</strong>
					</v-notice>
				</sidebar-detail>

			</template>

			<upload-files-dialog
				v-model="uploadDialogOpen"
				:title="uploadDialogTitle"
				:uploading="uploading"
				@files="onUploadDialogFiles"
			/>

			<migrate-drawer
				v-model="drawerOpen"
				:storages="storages"
				:source-storage="mode === 'storage' ? storage || null : null"
				:selection-kind="selectionKind"
				:file-ids="migrateSelectedIds.length ? migrateSelectedIds : selection"
				:folder-id="mode === 'folders' ? folder ?? null : null"
				:source-path="mode === 'storage' ? normalizedStoragePath || null : null"
				:estimated-count="estimateCount"
				:estimated-bytes="estimateBytes"
				@done="onMigrated"
			/>

			<import-orphans-drawer
				v-if="mode === 'storage' && storage"
				:model-value="importOpen"
				:location="storage"
				:storage-path="normalizedStoragePath || null"
				@update:model-value="onDetectOpenChange"
				@imported="onImported"
			/>
				<materialize-drawer
					v-if="mode === 'folders'"
					v-model="materializeOpen"
					:storages="storages"
					:folder-id="folder ?? null"
					@done="onMaterialized"
				/>
		</private-view>
	</component>
</template>

<style scoped>
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

.sidebar-note {
	margin-block-end: 12px;
	padding: 10px 12px;
	font-size: 12px;
	line-height: 1.45;
	color: var(--theme--foreground);
	background: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.page {
	padding: var(--content-padding);
	padding-block-end: 0;
	max-width: 1100px;
}

.page--flush-top {
	padding-block-start: 0;
}

.section-divider {
	margin-bottom: 12px;
}

.page-intro {
	margin: 0 0 24px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.move-hint {
	margin: 0 0 12px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.move-destination-hint {
	margin: 10px 0 0;
	font-size: 13px;
	color: var(--theme--foreground-subdued);
}

.move-dry-run {
	margin-top: 16px;
}

.move-dry-result {
	margin-top: 12px;
	line-height: 1.5;
}

.move-samples {
	margin: 8px 0 0;
	padding-inline-start: 18px;
	max-height: 180px;
	overflow: auto;
	font-size: 12px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.multi-storage-notice {
	margin: 12px var(--content-padding, 16px) 0;
}

.sidebar-multi-notice {
	margin-block-start: 12px;
}

.action-delete {
	--v-button-background-color-hover: var(--theme--danger) !important;
	--v-button-color-hover: var(--white, #fff) !important;
}

.storage-label {
	margin-bottom: 10px;
	font-weight: 600;
}
</style>

<style>
.storage-location-badge {
	display: inline-flex;
	align-items: center;
	max-inline-size: 100%;
	padding: 2px 8px;
	overflow: hidden;
	font-size: 11px;
	font-weight: 600;
	line-height: 1.35;
	color: var(--theme--primary-foreground, var(--white, #fff));
	white-space: nowrap;
	text-overflow: ellipsis;
	pointer-events: none;
	background: var(--theme--primary);
	border: none;
	border-radius: var(--theme--border-radius);
}

.layout-cards .header .storage-location-badge {
	position: absolute;
	inset-block-end: 8px;
	inset-inline-start: 8px;
	z-index: 2;
	max-inline-size: calc(100% - 16px);
	box-shadow: 0 1px 3px rgb(38 50 56 / 0.2);
}
</style>
