<template>
	<private-view title="Unreferenced Files" icon="link_off">
		<template #headline>
			<v-breadcrumb
				:items="[
					{ name: 'Storage Manager', to: '/storage-manager' },
					{ name: 'Unreferenced Files', to: '/storage-manager/unreferenced' },
				]"
			/>
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template v-if="scannedOnce" #actions:prepend>
			<component :is="`layout-actions-${layout}`" v-bind="layoutState" />
		</template>

		<template #actions>
			<search-input
				v-if="scannedOnce"
				v-model="search"
				v-model:filter="filter"
				collection="directus_files"
			/>

			<v-dialog
				v-if="selection.length"
				v-model="moveFolderDialogOpen"
				@esc="moveFolderDialogOpen = false"
				@apply="moveToDirectusFolder"
			>
				<template #activator="{ on }">
					<header-action-button
						v-tooltip.bottom="'Move to Directus Folder'"
						icon="folder"
						secondary
						:disabled="busy"
						@click="on"
					/>
				</template>
				<v-card>
					<v-card-title>Move to Directus Folder</v-card-title>
					<v-card-text>
						<p class="move-hint">
							Assigns {{ selection.length }} selected file(s) to a Directus File Library folder
							(virtual label only — storage path is unchanged).
						</p>
						<directus-folder-picker v-model="selectedDirectusFolder" />
					</v-card-text>
					<v-card-actions>
						<v-button secondary @click="moveFolderDialogOpen = false">Cancel</v-button>
						<v-button :loading="movingFolder" @click="moveToDirectusFolder">Move</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>

			<v-dialog
				v-if="selection.length"
				v-model="moveStorageDialogOpen"
				@esc="moveStorageDialogOpen = false"
				@apply="moveToStorageFolder"
			>
				<template #activator="{ on }">
					<header-action-button
						v-tooltip.bottom="'Move to Storage Folder'"
						icon="folder_move"
						secondary
						:disabled="busy"
						@click="on"
					/>
				</template>
				<v-card>
					<v-card-title>Move to Storage Folder</v-card-title>
					<v-card-text>
						<p class="move-hint">
							Moves {{ selection.length }} selected file(s) onto a physical storage path. Thumbnails
							move with the file when possible. Cross-storage moves use migrate.
						</p>
						<storage-target-picker v-model="selectedMoveTarget" />
						<p v-if="moveDestinationHint" class="move-destination-hint">
							{{ moveDestinationHint }}
						</p>
						<p class="move-destination-hint">
							If another registered file already owns the destination path, the incoming file is
							skipped and stays on the source.
						</p>
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
									<template v-if="moveDryRun.total_bytes">
										· {{ formatBytes(moveDryRun.total_bytes) }}
									</template>
								</p>
								<p v-if="moveDryRun.skipped" class="move-hint">
									{{ moveDryRun.skipped.toLocaleString() }} already at destination — skipped
								</p>
							</div>
						</div>
					</v-card-text>
					<v-card-actions>
						<v-button secondary @click="moveStorageDialogOpen = false">Cancel</v-button>
						<v-button
							:disabled="!selectedMoveTarget.location"
							:loading="movingStorage"
							@click="moveToStorageFolder"
						>
							Move
						</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>

			<header-action-button
				v-if="selection.length && recycleEnabled"
				v-tooltip.bottom="'Move to Recycle Bin'"
				icon="recycling"
				:loading="movingToRecycle"
				:disabled="busy"
				@click="askMoveToRecycle"
			/>
			<header-action-button
				v-if="selection.length"
				v-tooltip.bottom="recycleEnabled ? 'Delete Permanently' : 'Delete Selected Files'"
				icon="delete"
				secondary
				:loading="deleting"
				:disabled="busy"
				@click="askDelete"
			/>
		</template>

		<template #sidebar>
			<layout-sidebar-detail v-if="scannedOnce" v-model="layout">
				<component :is="`layout-options-${layout}`" v-bind="layoutState" />
			</layout-sidebar-detail>

			<sidebar-detail id="about" icon="info" title="About" :close="false">
				<p class="sidebar-text">
					Finds File Library entries that nothing still references. Prefer
					<button type="button" class="text-link" @click="goRecycle">Recycle Bin</button>
					for quarantine with retention; open
					<button type="button" class="text-link" @click="goFileInterfaces">File Interfaces</button>
					for automatic cleanup when fields are cleared or items are deleted.
				</p>
			</sidebar-detail>
		</template>

		<div :class="pageClass">
			<v-divider
				class="section-divider"
				large
				:inline-title="false"
				:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
			>
				<template #icon><v-icon name="link_off" /></template>
				Find Unreferenced Files
			</v-divider>

			<p class="page-intro">
				Dry-run scan of the File Library. Select files to move into a Directus folder, relocate on storage,
				or delete (delete always re-checks references first).
			</p>

			<div class="scan-bar" aria-label="Scan Options">
				<span class="scan-bar-title">Scan Options</span>

				<div class="scan-bar-fields">
					<div class="scan-bar-field scan-bar-field--age">
						<label for="scan-min-age" class="scan-bar-label-row">
							<span>Min Age (Minutes)</span>
							<v-icon
								v-tooltip.top="'Skip files uploaded within this many minutes. Avoids catching mid-upload or draft files that are not referenced yet.'"
								name="help_outline"
								small
								class="scan-bar-info"
							/>
						</label>
						<v-input
							id="scan-min-age"
							v-model="lifecycle.scan_min_age_minutes"
							type="number"
							:min="0"
							:disabled="scanning"
						/>
					</div>

					<div class="scan-bar-field scan-bar-field--storage">
						<label for="scan-storage">Storage Filter</label>
						<v-select
							id="scan-storage"
							v-model="storageFilter"
							:items="storageFilterChoices"
							:disabled="scanning"
							show-deselect
							placeholder="All Storages"
						/>
					</div>

					<div class="scan-bar-field scan-bar-field--check">
						<label class="scan-bar-label-row">
							<span>Scan Text Fields</span>
							<v-icon
								v-tooltip.top="'Optional: also searches rich text, Markdown, JSON, code, multiline, list, tags, and text columns for /assets/ links and file UUIDs. Adds significant extra scan time on large content tables — turn off for a faster relations-only pass.'"
								name="help_outline"
								small
								class="scan-bar-info"
							/>
						</label>
						<div class="scan-bar-radios" role="radiogroup" aria-label="Scan Text Fields">
							<v-radio
								:model-value="lifecycle.scan_text_fields"
								:value="true"
								label="Yes"
								:disabled="scanning"
								@update:model-value="lifecycle.scan_text_fields = true"
							/>
							<v-radio
								:model-value="lifecycle.scan_text_fields"
								:value="false"
								label="No"
								:disabled="scanning"
								@update:model-value="lifecycle.scan_text_fields = false"
							/>
						</div>
					</div>
				</div>

				<div class="scan-bar-actions">
					<v-button :loading="scanning" :disabled="busy" @click="runScan">
						<v-icon name="radar" left />
						Scan
					</v-button>
				</div>
			</div>

			<div v-if="meta" class="stats-grid">
				<div class="stat">
					<span class="stat-value">{{ meta.unreferenced_count.toLocaleString() }}</span>
					<span class="stat-label">
						Unreferenced
						<v-icon
							v-tooltip.top="'File Library entries with no remaining references in relations or (optional) text fields, after Min Age / Storage Filter.'"
							name="help_outline"
							small
							class="stat-info"
						/>
					</span>
				</div>
				<div class="stat">
					<span class="stat-value">{{ formatBytes(meta.unreferenced_bytes ?? 0) }}</span>
					<span class="stat-label">
						Total Size
						<v-icon
							v-tooltip.top="'Sum of File Library filesize for all unreferenced files found by this scan.'"
							name="help_outline"
							small
							class="stat-info"
						/>
					</span>
				</div>
				<div class="stat">
					<span class="stat-value">{{ (meta.collections_checked ?? 0).toLocaleString() }}</span>
					<span class="stat-label">
						Collections Checked
						<v-icon
							v-tooltip.top="'Unique collections that had at least one file relation or text field to inspect — not your total collection count. Includes system collections with file fields (e.g. avatar, logos).'"
							name="help_outline"
							small
							class="stat-info"
						/>
					</span>
				</div>
				<div class="stat">
					<span class="stat-value">{{ meta.relation_targets.toLocaleString() }}</span>
					<span class="stat-label">
						Relations Checked
						<v-icon
							v-tooltip.top="'Number of file/image fields that point at directus_files (one field = one). Includes system fields such as user avatars and project logos.'"
							name="help_outline"
							small
							class="stat-info"
						/>
					</span>
				</div>
				<div class="stat">
					<span class="stat-value">{{ meta.text_targets.toLocaleString() }}</span>
					<span class="stat-label">
						Text Fields Scanned
						<v-icon
							v-tooltip.top="'Rich text, Markdown, JSON, code, multiline, list, tags, and text columns checked for /assets/ links or file UUIDs. System Directus tables are excluded.'"
							name="help_outline"
							small
							class="stat-info"
						/>
					</span>
				</div>
			</div>

			<p v-if="error" class="error">{{ error }}</p>

			<v-notice v-if="restoredFromPrevious && scannedOnce && !sessionExpired" type="info" class="restored-notice">
				Restored your previous scan. This is a snapshot — run Scan again if you need a fresh check.
			</v-notice>
		</div>

		<div v-if="scanning && !scanDrawerOpen" class="loading-block">
			<v-progress-circular indeterminate />
			<span>Scan running in the background…</span>
		</div>

		<div v-else-if="sessionExpired" class="session-expired">
			<v-notice type="warning">
				This scan result is no longer available — it expired (JSON snapshots in
				<strong>Unreferenced File Scans</strong> are kept for 24 hours), or the file was removed. Run Scan
				again to refresh the list and continue browsing, filtering, or deleting.
			</v-notice>
			<div class="session-expired-actions">
				<v-button @click="runScan">
					<v-icon name="radar" left />
					Scan Again
				</v-button>
			</div>
		</div>

		<!-- In-flow empty state: layout empty slots use absolute centering and overlap the scan bar on short viewports. -->
		<div v-else-if="showEmptyNoItems" class="empty-state">
			<v-info title="No Unreferenced Files" icon="link_off">
				Nothing matched this scan (or leftovers are newer than the min age).
				<template #append>
					<v-button @click="runScan">Scan Again</v-button>
				</template>
			</v-info>
		</div>

		<component
			v-else-if="scannedOnce"
			ref="layoutRef"
			:is="`layout-${layout}`"
			v-bind="layoutState"
			v-model:selection="selection"
			@update:width="onLayoutWidth"
			@update:limit="onLimitUpdate"
			@update:fields="onFieldsUpdate"
			@update:table-spacing="onTableSpacingUpdate"
			@update:size="onSizeUpdate"
			@update:sort="onSortUpdate"
		>
			<template #no-results>
				<div class="empty-state empty-state--in-layout">
					<v-info title="No Results" icon="search">
						No unreferenced files match your search or filters.
						<template #append>
							<v-button @click="clearFilters">Clear Filters</v-button>
						</template>
					</v-info>
				</div>
			</template>

			<template #no-items>
				<div class="empty-state empty-state--in-layout">
					<v-info title="No Unreferenced Files" icon="link_off">
						Nothing matched this scan (or leftovers are newer than the min age).
						<template #append>
							<v-button @click="runScan">Scan Again</v-button>
						</template>
					</v-info>
				</div>
			</template>
		</component>

		<drawer-item
			v-if="activeFileId"
			collection="directus_files"
			:primary-key="activeFileId"
			:active="true"
			@update:active="onFileDrawerActive"
		/>

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card>
				<v-card-title>Delete {{ selection.length }} file(s) permanently?</v-card-title>
				<v-card-text>
					<p>
						About to permanently remove
						<strong>{{ selection.length.toLocaleString() }}</strong>
						file{{ selection.length === 1 ? '' : 's' }}
						<template v-if="deleteSizeLoading"> · measuring size…</template>
						<template v-else-if="deleteSelectionBytes != null">
							· <strong>{{ formatBytes(deleteSelectionBytes) }}</strong>
						</template>
						from the File Library.
					</p>
					<p>
						Each file is re-checked for references before delete. Still-referenced files are skipped.
						This cannot be undone.
						<template v-if="recycleEnabled"> Prefer Move to Recycle when you want a retention window.</template>
					</p>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmOpen = false">Cancel</v-button>
					<v-button kind="danger" :loading="deleting" @click="doDelete">Delete Permanently</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="recycleConfirmOpen" @esc="recycleConfirmOpen = false">
			<v-card>
				<v-card-title>Move {{ selection.length }} file(s) to Recycle?</v-card-title>
				<v-card-text>
					<p>
						Moves
						<strong>{{ selection.length.toLocaleString() }}</strong>
						file{{ selection.length === 1 ? '' : 's' }}
						into the Recycle Bin folder. Transforms are removed; originals stay until purge.
						Non-admins cannot load their assets while they remain in Recycle.
					</p>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="recycleConfirmOpen = false">Cancel</v-button>
					<v-button :loading="movingToRecycle" @click="doMoveToRecycle">Move to Recycle</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<migrate-drawer
			v-model="migrateDrawerOpen"
			:storages="storages"
			:source-storage="null"
			selection-kind="files"
			:file-ids="selection"
			:folder-id="null"
			:source-path="null"
			:estimated-count="selection.length || undefined"
			@done="onMigrated"
		/>

		<unreferenced-scan-drawer v-model="scanDrawerOpen" @done="onScanDone" />
	</private-view>
</template>


<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ModuleNavigation from './navigation.vue';
import HeaderActionButton from './components/header-action-button.vue';
import SearchInput from './components/search-input.vue';
import LayoutSidebarDetail from './components/layout-sidebar-detail.vue';
import DirectusFolderPicker from './components/directus-folder-picker.vue';
import StorageTargetPicker from './components/storage-target-picker.vue';
import type { StorageTarget } from './components/storage-target-picker.vue';
import MigrateDrawer from './components/migrate-drawer.vue';
import UnreferencedScanDrawer from './components/unreferenced-scan-drawer.vue';
import { useFilesBrowserPreset } from './composables/use-files-browser-preset';
import { useMigrateJob } from './composables/use-migrate-job';
import { useUnreferencedFilesLayout } from './composables/use-unreferenced-files-layout';
import { useUnreferencedScanJob } from './composables/use-unreferenced-scan-job';
import type { UnreferencedScanMeta } from './composables/use-unreferenced-scan-job';
import { useUnreferencedScanPersist } from './composables/use-unreferenced-scan-persist';
import { usePageClass } from './composables/use-page-class';
import { useStorageLocationBadges } from './composables/use-storage-location-badges';
import { useStorageManager } from './composables/use-storage-manager';
import { formatBytes } from '../shared/format';
import { LIFECYCLE_DEFAULTS, normalizeLifecycleSettings } from '../shared/lifecycle';

type ScanMeta = UnreferencedScanMeta & { scan_id?: string };

/** Safe chunk size for ad-hoc `/files?filter=…` GETs. */
const FILES_QUERY_IDS_CHUNK = 50;

const api = useApi();
const route = useRoute();
const router = useRouter();
const pageClass = usePageClass();
const { storages, loadStorages } = useStorageManager();
const { start: startMigrate } = useMigrateJob();
const {
	running: scanning,
	result: scanJobResult,
	reopenNonce: scanReopenNonce,
	start: startScanJob,
	clearLastResult: clearScanJobResult,
} = useUnreferencedScanJob();

const { save: savePersistedScan, clear: clearPersistedScan, load: loadPersistedScan } =
	useUnreferencedScanPersist();

const layoutRef = ref();
const selection = ref<(string | number)[]>([]);
const scanDrawerOpen = ref(false);
const deleting = ref(false);
const movingToRecycle = ref(false);
const recycleEnabled = ref(false);
const recycleConfirmOpen = ref(false);
const scannedOnce = ref(false);
const error = ref('');
const confirmOpen = ref(false);
const deleteSelectionBytes = ref<number | null>(null);
const deleteSizeLoading = ref(false);
const meta = ref<ScanMeta | null>(null);
const scanId = ref<string | null>(null);
const restoredFromPrevious = ref(false);

const activeFileId = computed(() => {
	const value = route.query.file;
	return typeof value === 'string' && value.length > 0 ? value : null;
});

const moveFolderDialogOpen = ref(false);
const selectedDirectusFolder = ref<string | null>(null);
const movingFolder = ref(false);

const moveStorageDialogOpen = ref(false);
const selectedMoveTarget = ref<StorageTarget>({ location: '', path: '' });
const movingStorage = ref(false);
const moveDryRunning = ref(false);
const moveDryRun = ref<{
	total_files: number;
	total_bytes?: number;
	skipped?: number;
} | null>(null);
const migrateDrawerOpen = ref(false);

const busy = computed(
	() =>
		scanning.value ||
		deleting.value ||
		movingToRecycle.value ||
		movingFolder.value ||
		movingStorage.value,
);

const moveDestinationHint = computed(() => {
	const loc = selectedMoveTarget.value.location;
	if (!loc) return '';
	const dest = selectedMoveTarget.value.path ? `${loc}/${selectedMoveTarget.value.path}/` : `${loc}/`;
	return `Files will be moved to ${dest}`;
});

const lifecycle = reactive(normalizeLifecycleSettings(LIFECYCLE_DEFAULTS));
const storageFilter = ref<string | null>(null);

const storageFilterChoices = computed(() =>
	storages.value.map((s) => ({
		text: s.location,
		value: s.location,
	})),
);

const { layout, layoutOptions, layoutQuery, filter, search, resetPreset, resetPage } = useFilesBrowserPreset();

const showStorageLocationLabels = computed(() => scannedOnce.value);

/** Zero-result scan: keep empty state in document flow (not layout absolute center). */
const showEmptyNoItems = computed(() => {
	if (!scannedOnce.value || sessionExpired.value || scanning.value) return false;
	return Number(meta.value?.unreferenced_count ?? 0) === 0;
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

const {
	layoutState,
	refresh: refreshUnreferencedLayout,
	sessionExpired,
	totalCount: layoutTotalCount,
	onLayoutWidth,
	onLimitUpdate,
	onFieldsUpdate,
	onTableSpacingUpdate,
	onSizeUpdate,
	onSortUpdate,
} = useUnreferencedFilesLayout({
	scanId,
	search,
	filter,
	layout,
	layoutOptions,
	layoutQuery,
	selection,
	resetPreset,
	fileDetailPath,
	routerPush: (path) => {
		void router.push(path);
	},
	openInNewTab: (href) => {
		window.open(href, '_blank');
	},
	resolveHref: (path) => router.resolve(path).href,
});

watch(sessionExpired, (expired) => {
	if (!expired) return;
	selection.value = [];
	clearPersistedScan();
});

useStorageLocationBadges({
	enabled: showStorageLocationLabels,
	layout,
	layoutRef,
	layoutQuery,
});

watch([filter, search], () => {
	resetPage();
});

function clearFilters() {
	filter.value = null;
	search.value = null;
	resetPage();
}

function goFileInterfaces() {
	router.push('/storage-manager/file-interfaces');
}

function goRecycle() {
	router.push('/storage-manager/recycle');
}

function clearFileQuery() {
	if (!('file' in route.query)) return;
	const next = { ...route.query };
	delete next.file;
	router.replace({ path: route.path, query: next });
}

function onFileDrawerActive(active: boolean) {
	if (!active) {
		clearFileQuery();
		refreshUnreferencedLayout().catch(() => undefined);
	}
}

async function refreshLayout() {
	await nextTick();
	await refreshUnreferencedLayout();
	if (meta.value && layoutTotalCount.value != null) {
		meta.value = {
			...meta.value,
			unreferenced_count: layoutTotalCount.value,
		};
		if (scanId.value) {
			savePersistedScan({
				...(meta.value as ScanMeta),
				scan_id: scanId.value,
			});
		}
	}
}

async function patchLifecycle(partial: Record<string, unknown>) {
	await api.patch('/storage-manager/settings', {
		lifecycle: partial,
	});
}

async function persistScanOptions() {
	await patchLifecycle({
		scan_min_age_minutes: Number(lifecycle.scan_min_age_minutes) || 0,
		scan_text_fields: Boolean(lifecycle.scan_text_fields),
	});
}

async function applyScanMeta(next: ScanMeta) {
	const nextScanId = typeof next.scan_id === 'string' && next.scan_id ? next.scan_id : null;
	if (!nextScanId) {
		error.value = 'Scan finished without a session id — update Storage Manager and try again.';
		return;
	}

	meta.value = {
		...next,
		scan_id: nextScanId,
		ids_truncated: false,
		truncated: false,
	};
	scanId.value = nextScanId;
	sessionExpired.value = false;
	restoredFromPrevious.value = false;
	scannedOnce.value = true;
	error.value = '';
	selection.value = [];
	savePersistedScan({
		...(meta.value as ScanMeta),
		scan_id: nextScanId,
	});
	resetPage();
	await refreshLayout();
}

async function onScanDone(next: ScanMeta) {
	await applyScanMeta(next);
	clearScanJobResult();
}

async function runScan() {
	if (scanning.value) {
		scanDrawerOpen.value = true;
		return;
	}
	error.value = '';
	selection.value = [];
	restoredFromPrevious.value = false;
	try {
		await persistScanOptions().catch(() => undefined);
		scanDrawerOpen.value = true;
		await startScanJob({
			min_age_minutes: Number(lifecycle.scan_min_age_minutes) || 0,
			scan_text_fields: Boolean(lifecycle.scan_text_fields),
			storage: storageFilter.value?.trim() || null,
			limit: 1,
			offset: 0,
		});
	} catch (err: any) {
		error.value = err?.message || 'Scan failed';
	}
}

watch(scanReopenNonce, () => {
	scanDrawerOpen.value = true;
});

watch(scanJobResult, async (next) => {
	if (!next || scanning.value) return;
	if (!scanDrawerOpen.value) {
		await applyScanMeta(next as ScanMeta);
		clearScanJobResult();
	}
});

async function sumSelectionFilesize(ids: string[]): Promise<number> {
	let total = 0;
	for (let i = 0; i < ids.length; i += FILES_QUERY_IDS_CHUNK) {
		const chunk = ids.slice(i, i + FILES_QUERY_IDS_CHUNK);
		const res = await api.get('/files', {
			params: {
				limit: chunk.length,
				fields: ['id', 'filesize'],
				filter: JSON.stringify({ id: { _in: chunk } }),
			},
		});
		for (const row of (res.data?.data || []) as Array<{ filesize?: number | null }>) {
			total += Number(row.filesize) || 0;
		}
	}
	return total;
}

async function askDelete() {
	if (!selection.value.length) return;
	confirmOpen.value = true;
	deleteSelectionBytes.value = null;
	deleteSizeLoading.value = true;
	try {
		deleteSelectionBytes.value = await sumSelectionFilesize(selection.value.map(String));
	} catch {
		deleteSelectionBytes.value = null;
	} finally {
		deleteSizeLoading.value = false;
	}
}

function askMoveToRecycle() {
	if (!selection.value.length || !recycleEnabled.value) return;
	recycleConfirmOpen.value = true;
}

async function doMoveToRecycle() {
	if (!selection.value.length || movingToRecycle.value) return;
	movingToRecycle.value = true;
	try {
		const res = await api.post('/storage-manager/recycle/move', {
			file_ids: selection.value,
			scan_id: scanId.value,
		});
		const moved = Number(res.data?.data?.moved) || 0;
		selection.value = [];
		recycleConfirmOpen.value = false;
		await refreshLayout();
		if (meta.value) {
			meta.value = {
				...meta.value,
				unreferenced_count: Math.max(0, Number(meta.value.unreferenced_count) - moved),
			};
		}
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Move to Recycle failed');
	} finally {
		movingToRecycle.value = false;
	}
}

async function doDelete() {
	if (!selection.value.length || deleting.value) return;
	deleting.value = true;
	try {
		const res = await api.post('/storage-manager/unreferenced/delete', {
			file_ids: selection.value,
			scan_text_fields: Boolean(lifecycle.scan_text_fields),
			scan_id: scanId.value,
		});
		selection.value = [];
		confirmOpen.value = false;
		await refreshLayout();
		const deleted = Number(res.data?.data?.deleted) || 0;
		if (meta.value) {
			meta.value = {
				...meta.value,
				unreferenced_count: Math.max(0, Number(meta.value.unreferenced_count) - deleted),
			};
		}
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed');
	} finally {
		deleting.value = false;
	}
}

async function moveToDirectusFolder() {
	if (!selection.value.length || movingFolder.value) return;
	movingFolder.value = true;
	try {
		await api.patch('/files', {
			keys: selection.value,
			data: { folder: selectedDirectusFolder.value },
		});
		moveFolderDialogOpen.value = false;
		selection.value = [];
		await refreshLayout();
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Move failed');
	} finally {
		movingFolder.value = false;
	}
}

async function runMoveDryRun() {
	if (!selectedMoveTarget.value.location || moveDryRunning.value || !selection.value.length) return;
	moveDryRunning.value = true;
	moveDryRun.value = null;
	try {
		const resp = await api.post('/storage-manager/migrate/dry-run', {
			file_ids: selection.value.map(String),
			target_storage: selectedMoveTarget.value.location,
			target_path: selectedMoveTarget.value.path || '',
			preserve_paths: false,
		});
		moveDryRun.value = resp.data?.data ?? null;
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Dry run failed');
	} finally {
		moveDryRunning.value = false;
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

async function moveToStorageFolder() {
	const targetLoc = selectedMoveTarget.value.location;
	const targetPath = selectedMoveTarget.value.path || '';
	if (!targetLoc || !selection.value.length) return;

	movingStorage.value = true;
	try {
		const fileIds = selection.value.map(String);
		const rows: Array<{ id: string; storage: string }> = [];
		for (let i = 0; i < fileIds.length; i += FILES_QUERY_IDS_CHUNK) {
			const chunk = fileIds.slice(i, i + FILES_QUERY_IDS_CHUNK);
			const res = await api.get('/files', {
				params: {
					limit: chunk.length,
					fields: ['id', 'storage'],
					filter: JSON.stringify({ id: { _in: chunk } }),
				},
			});
			rows.push(...((res.data?.data || []) as Array<{ id: string; storage: string }>));
		}
		const needCross = rows.filter((r) => String(r.storage) !== targetLoc).map((r) => String(r.id));

		if (!needCross.length) {
			const resp = await api.post(`/storage-manager/storages/${encodeURIComponent(targetLoc)}/move-files`, {
				file_ids: fileIds,
				target_path: targetPath,
			});
			alertMoveSkipped(resp.data?.data?.skipped);
			moveStorageDialogOpen.value = false;
			selection.value = [];
			await refreshLayout();
			return;
		}

		moveStorageDialogOpen.value = false;
		movingStorage.value = false;

		const migratePromise = startMigrate(
			{
				file_ids: needCross,
				target_storage: targetLoc,
				mode: 'move',
				target_path: targetPath,
			},
			{ estimatedCount: needCross.length },
		);
		migrateDrawerOpen.value = true;
		await migratePromise;

		const alreadyOnTarget = rows.filter((r) => String(r.storage) === targetLoc).map((r) => String(r.id));
		if (alreadyOnTarget.length) {
			const resp = await api.post(`/storage-manager/storages/${encodeURIComponent(targetLoc)}/move-files`, {
				file_ids: alreadyOnTarget,
				target_path: targetPath,
			});
			alertMoveSkipped(resp.data?.data?.skipped);
		}

		selection.value = [];
		await refreshLayout();
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Move failed');
	} finally {
		movingStorage.value = false;
	}
}

async function onMigrated() {
	selection.value = [];
	await refreshLayout();
}

onMounted(async () => {
	try {
		await loadStorages().catch(() => undefined);
		const res = await api.get('/storage-manager/settings');
		const lc = res.data?.data?.lifecycle;
		if (lc) {
			const normalized = normalizeLifecycleSettings(lc);
			Object.assign(lifecycle, normalized);
			Object.assign(lifecycle.native, normalized.native);
			Object.assign(lifecycle.storage_manager, normalized.storage_manager);
		}
		recycleEnabled.value = Boolean(res.data?.data?.recycle?.enabled);
	} catch {
		/* defaults */
	}

	// Reopen last scan if the DB-backed server session is still alive.
	if (!scanId.value && !scanning.value) {
		const persisted = loadPersistedScan();
		if (persisted?.scan_id) {
			try {
				const probe = await api.get(
					`/storage-manager/unreferenced/sessions/${encodeURIComponent(persisted.scan_id)}`,
				);
				const data = probe.data?.data;
				const serverMeta = data?.meta || {};
				meta.value = {
					...persisted,
					...serverMeta,
					scan_id: persisted.scan_id,
					unreferenced_count:
						Number(data?.id_count) ||
						Number(serverMeta.unreferenced_count) ||
						Number(persisted.unreferenced_count) ||
						0,
					ids_truncated: false,
					truncated: false,
				};
				scanId.value = persisted.scan_id;
				scannedOnce.value = true;
				sessionExpired.value = false;
				restoredFromPrevious.value = true;
				await refreshLayout();
			} catch {
				clearPersistedScan();
			}
		}
	}
});
</script>

<style scoped>
.page-container {
	padding: var(--content-padding);
	padding-block-end: 0;
	max-inline-size: 67.5rem;
}

.page-intro {
	margin: 0 0 1.25rem;
	color: var(--theme--foreground);
	line-height: 1.45;
}

.page-intro code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.section-divider {
	margin-block-end: 0.75rem;
}

.scan-bar {
	position: relative;
	z-index: 1;
	display: flex;
	flex-wrap: wrap;
	align-items: end;
	gap: 0.85rem 1rem;
	margin-block-end: 0.75rem;
	padding: 0.75rem 1rem;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
}

.scan-bar-title {
	flex: 0 0 auto;
	align-self: center;
	margin-inline-end: 0.25rem;
	font-size: 0.75rem;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--theme--foreground-subdued);
	white-space: nowrap;
}

.scan-bar-fields {
	display: flex;
	flex-wrap: wrap;
	align-items: end;
	gap: 0.85rem 1.5rem;
	min-inline-size: 0;
	flex: 1 1 auto;
}

.scan-bar-field {
	display: flex;
	flex-direction: column;
	justify-content: end;
	gap: 0.3rem;
	inline-size: auto;
	min-inline-size: 7.5rem;
}

.scan-bar-field--age {
	min-inline-size: 11.5rem;
}

.scan-bar-field--storage {
	min-inline-size: 10rem;
}

.scan-bar-field--check {
	inline-size: auto;
	min-inline-size: 12rem;
}

.scan-bar-radios {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.75rem 1rem;
	min-block-size: 2.25rem;
}

.scan-bar-radios :deep(.v-radio) {
	margin: 0;
}

.scan-bar-field label,
.scan-bar-spacer {
	display: block;
	min-block-size: 1.125rem;
	font-size: 0.8125rem;
	font-weight: 600;
	line-height: 1.125rem;
	color: var(--theme--foreground-subdued);
	white-space: nowrap;
}

.scan-bar-label-row {
	display: inline-flex !important;
	align-items: center;
	gap: 6px;
}

.scan-bar-info {
	--v-icon-color: var(--theme--foreground-subdued);
	cursor: pointer;
}

.scan-bar-field :deep(.v-input),
.scan-bar-field :deep(.v-select) {
	margin: 0;
}

.scan-bar-field :deep(.v-input .input),
.scan-bar-field :deep(.v-input input),
.scan-bar-field :deep(.v-select .input) {
	min-block-size: 2.25rem;
}

.scan-bar-actions {
	display: flex;
	align-items: center;
	margin-inline-start: auto;
}

.scan-bar-actions :deep(.v-button) {
	margin: 0;
}

.notice {
	margin: 0 0 1rem;
	font-size: 0.85rem;
	line-height: 1.4;
	color: var(--theme--warning);
}

.stats-grid {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin: 0 0 0.75rem;
	inline-size: 100%;
}

.stat {
	display: inline-flex;
	flex: 1 1 auto;
	align-items: baseline;
	gap: 0.4rem;
	min-inline-size: max-content;
	padding: 0.4rem 0.7rem;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
	white-space: nowrap;
}

.stat-value {
	font-size: 0.9rem;
	font-weight: 700;
	line-height: 1.3;
	color: var(--theme--foreground);
	font-variant-numeric: tabular-nums;
}

.stat-label {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 0.8rem;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}

.stat-info {
	--v-icon-color: var(--theme--foreground-subdued);
	cursor: pointer;
	flex-shrink: 0;
}

.error {
	margin: 0 0 1rem;
	color: var(--theme--danger);
}

.loading-block {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.75rem;
	padding: 3rem var(--content-padding);
	color: var(--theme--foreground-subdued);
}

.session-expired {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 1rem;
	padding: 1.5rem var(--content-padding) 3rem;
	max-inline-size: 40rem;
}

.session-expired-actions {
	display: flex;
	align-items: center;
}

.empty-state {
	margin: 1.25rem var(--content-padding) 3rem;
	max-inline-size: 36rem;
}

.empty-state--in-layout {
	margin-block-start: 2rem;
}

.empty-state :deep(.v-info),
.empty-state :deep(.v-info.center) {
	position: static;
	inset: auto;
	transform: none;
	text-align: start;
}

.restored-notice {
	margin: 0 0 0.75rem;
}

.sidebar-text {
	margin: 0;
	font-size: 0.875rem;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.text-link {
	display: inline;
	padding: 0;
	border: 0;
	background: none;
	color: var(--theme--primary);
	font: inherit;
	cursor: pointer;
	text-decoration: none;
}

.text-link:hover {
	text-decoration: underline;
}

.sidebar-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.move-hint {
	margin: 0 0 12px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.move-destination-hint {
	margin: 12px 0 0;
	font-size: 13px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.move-dry-run {
	margin-top: 14px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	align-items: flex-start;
}

.move-dry-result {
	width: 100%;
	font-size: 13px;
	line-height: 1.45;
}

.move-dry-result p {
	margin: 0 0 6px;
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
