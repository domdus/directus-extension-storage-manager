<template>
	<component
		:is="layoutWrapper"
		ref="layoutRef"
		v-slot="{ layoutState }"
		v-model:selection="selection"
		v-model:layout-options="layoutOptions"
		v-model:layout-query="effectiveLayoutQuery"
		:filter="layoutFilter"
		:filter-user="filter"
		:filter-system="systemFilter"
		:search="search"
		collection="directus_files"
		:reset-preset="resetPreset"
	>
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
					v-if="selection.length"
					v-tooltip.bottom="'Delete selected files'"
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

				<sidebar-detail id="lifecycle" icon="policy" title="File Lifecycle" :close="false">
					<p class="sidebar-text sidebar-text--spaced">
						Defaults for File / Image / Files with Storage Interfaces. Per-field options override these.
					</p>
					<div class="side-field">
						<label>Default on deselect</label>
						<v-select
							v-model="lifecycle.on_deselect"
							:items="deselectChoices"
							:disabled="lifecycleSaving || scanning"
						/>
					</div>
					<div class="side-field">
						<label>Default on item delete</label>
						<v-select
							v-model="lifecycle.on_item_delete"
							:items="itemDeleteChoices"
							:disabled="lifecycleSaving || scanning"
						/>
					</div>
					<v-button
						small
						block
						:loading="lifecycleSaving"
						:disabled="lifecycleSaving || scanning"
						@click="saveLifecyclePolicies"
					>
						Save defaults
					</v-button>
					<p v-if="lifecycleMessage" class="lifecycle-msg" :class="lifecycleMessage.type">
						{{ lifecycleMessage.text }}
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
								v-tooltip.top="meta?.ids_truncated
									? 'Total unreferenced files found. The list below may show fewer — only listed files can be moved or deleted; scan again after clearing a batch.'
									: 'File Library entries with no remaining references in relations or (optional) text fields, after Min Age / Storage Filter.'"
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
								v-tooltip.top="'Sum of File Library filesize for all unreferenced files found by this scan (full total, not just the listed batch).'"
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
					<div class="stat">
						<span class="stat-value">{{ formatMs(meta.elapsed_ms) }}</span>
						<span class="stat-label">Duration</span>
					</div>
				</div>

				<p v-if="meta?.ids_truncated" class="notice">
					Showing {{ listedUnreferencedCount.toLocaleString() }} of
					{{ meta.unreferenced_count.toLocaleString() }} unreferenced files. Only the files listed below can
					be selected to move or delete — finish this batch, then scan again for the rest. Tip: use
					<strong>Storage Filter</strong> to work through one storage at a time.
				</p>

				<p v-if="error" class="error">{{ error }}</p>
			</div>

			<div v-if="scanning && !scanDrawerOpen" class="loading-block">
				<v-progress-circular indeterminate />
				<span>Scan running in the background…</span>
			</div>

			<component
				v-else-if="scannedOnce"
				:is="`layout-${layout}`"
				v-bind="bindLayout(layoutState)"
			>
				<template #no-results>
					<v-info title="No results" icon="search" center>
						No unreferenced files match your search or filters.
						<template #append>
							<v-button @click="clearFilters">Clear filters</v-button>
						</template>
					</v-info>
				</template>

				<template #no-items>
					<v-info title="No unreferenced files" icon="link_off" center>
						Nothing matched this scan (or leftovers are newer than the min age).
						<template #append>
							<v-button @click="runScan">Scan again</v-button>
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

			<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
				<v-card>
					<v-card-title>Delete {{ selection.length }} file(s)?</v-card-title>
					<v-card-text>
						<p>
							About to remove
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
						</p>
					</v-card-text>
					<v-card-actions>
						<v-button secondary @click="confirmOpen = false">Cancel</v-button>
						<v-button kind="danger" :loading="deleting" @click="doDelete">Delete</v-button>
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
	</component>
</template>

<script setup lang="ts">
import { useLayout } from '@directus/composables';
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
import { useUnreferencedScanJob } from './composables/use-unreferenced-scan-job';
import type { UnreferencedScanMeta } from './composables/use-unreferenced-scan-job';
import { usePageClass } from './composables/use-page-class';
import { useStorageLocationBadges } from './composables/use-storage-location-badges';
import { useStorageManager } from './composables/use-storage-manager';
import { mergeFilters } from './utils/filters';
import { formatBytes } from '../shared/format';
import { LIFECYCLE_DEFAULTS } from '../shared/lifecycle';

type ScanMeta = UnreferencedScanMeta;

/** Sentinel UUID so the layout filter matches nothing before the first scan. */
const EMPTY_ID = '00000000-0000-4000-8000-000000000000';

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

const layoutRef = ref();
const selection = ref<string[]>([]);
const scanDrawerOpen = ref(false);
const deleting = ref(false);
const scannedOnce = ref(false);
const error = ref('');
const confirmOpen = ref(false);
const deleteSelectionBytes = ref<number | null>(null);
const deleteSizeLoading = ref(false);
const meta = ref<ScanMeta | null>(null);
const unreferencedIds = ref<string[]>([]);

/** Same as folders browser: `?file=` drives the item drawer. */
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
		movingFolder.value ||
		movingStorage.value,
);

const listedUnreferencedCount = computed(() => unreferencedIds.value.length);

const moveDestinationHint = computed(() => {
	const loc = selectedMoveTarget.value.location;
	if (!loc) return '';
	const dest = selectedMoveTarget.value.path ? `${loc}/${selectedMoveTarget.value.path}/` : `${loc}/`;
	return `Files will be moved to ${dest}`;
});

const lifecycle = reactive({ ...LIFECYCLE_DEFAULTS });
const lifecycleSaving = ref(false);
const lifecycleMessage = ref<{ type: 'success' | 'danger'; text: string } | null>(null);
const storageFilter = ref<string | null>(null);

const storageFilterChoices = computed(() =>
	storages.value.map((s) => ({
		text: s.location,
		value: s.location,
	})),
);

const deselectChoices = [
	{ text: 'Keep file in library', value: 'keep' },
	{ text: 'Ask (deselect vs delete if unused)', value: 'ask' },
	{ text: 'Delete file if unreferenced', value: 'delete_if_unreferenced' },
];

const itemDeleteChoices = [
	{ text: 'Keep file in library', value: 'keep' },
	{ text: 'Delete file if unreferenced', value: 'delete_if_unreferenced' },
];

const { layout, layoutOptions, layoutQuery, filter, search, resetPreset, resetPage } = useFilesBrowserPreset();
const { layoutWrapper } = useLayout(layout);

const showStorageLocationLabels = computed(() => scannedOnce.value);

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

useStorageLocationBadges({
	enabled: showStorageLocationLabels,
	layout,
	layoutRef,
	layoutQuery,
});

function formatMs(ms: number) {
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

const systemFilter = computed(() => {
	const ids = unreferencedIds.value.length ? unreferencedIds.value : [EMPTY_ID];
	return { id: { _in: ids } };
});

const layoutFilter = computed(() => mergeFilters(filter.value, systemFilter.value));

watch([filter, search], () => {
	resetPage();
});

function clearFilters() {
	filter.value = null;
	search.value = null;
	resetPage();
}

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

function bindLayout(layoutState: Record<string, any>) {
	const pkField = layoutState.primaryKeyField?.field || 'id';

	return {
		...layoutState,
		hasPrependContent: false,
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

function onFileDrawerActive(active: boolean) {
	if (!active) {
		clearFileQuery();
		refreshLayout().catch(() => undefined);
	}
}

async function refreshLayout() {
	await nextTick();
	await layoutRef.value?.state?.refresh?.();
}

async function patchLifecycle(partial: Record<string, unknown>) {
	await api.patch('/storage-manager/settings', {
		lifecycle: {
			on_deselect: lifecycle.on_deselect,
			on_item_delete: lifecycle.on_item_delete,
			scan_min_age_minutes: Number(lifecycle.scan_min_age_minutes) || 0,
			scan_text_fields: Boolean(lifecycle.scan_text_fields),
			...partial,
		},
	});
}

async function saveLifecyclePolicies() {
	lifecycleSaving.value = true;
	lifecycleMessage.value = null;
	try {
		await patchLifecycle({
			on_deselect: lifecycle.on_deselect,
			on_item_delete: lifecycle.on_item_delete,
		});
		lifecycleMessage.value = { type: 'success', text: 'Lifecycle defaults saved.' };
	} catch (err: any) {
		lifecycleMessage.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Save failed',
		};
	} finally {
		lifecycleSaving.value = false;
	}
}

/** Persist current scan options when Scan runs (no separate Save control). */
async function persistScanOptions() {
	await patchLifecycle({
		scan_min_age_minutes: Number(lifecycle.scan_min_age_minutes) || 0,
		scan_text_fields: Boolean(lifecycle.scan_text_fields),
	});
}

async function applyScanMeta(next: ScanMeta) {
	meta.value = next;
	const ids = Array.isArray(next.ids) ? next.ids.map(String) : [];
	unreferencedIds.value = ids;
	scannedOnce.value = true;
	error.value = '';
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
	// Apply background-completed results when returning to this page.
	if (!scanDrawerOpen.value) {
		await applyScanMeta(next);
		clearScanJobResult();
	}
});

async function sumSelectionFilesize(ids: string[]): Promise<number> {
	const CHUNK = 500;
	let total = 0;
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
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

async function doDelete() {
	if (!selection.value.length || deleting.value) return;
	deleting.value = true;
	try {
		const res = await api.post('/storage-manager/unreferenced/delete', {
			file_ids: selection.value,
			scan_text_fields: Boolean(lifecycle.scan_text_fields),
		});
		const deleted = new Set(
			((res.data?.data?.results || []) as Array<{ id: string; status: string }>)
				.filter((r) => r.status === 'deleted')
				.map((r) => String(r.id)),
		);
		unreferencedIds.value = unreferencedIds.value.filter((id) => !deleted.has(id));
		if (meta.value) {
			meta.value = {
				...meta.value,
				unreferenced_count: unreferencedIds.value.length,
				ids: unreferencedIds.value,
			};
		}
		selection.value = [];
		confirmOpen.value = false;
		await refreshLayout();
	} catch (err: any) {
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed';
		confirmOpen.value = false;
	} finally {
		deleting.value = false;
	}
}

watch(moveFolderDialogOpen, (open) => {
	if (open) selectedDirectusFolder.value = null;
});

watch(moveStorageDialogOpen, (open) => {
	if (!open) return;
	moveDryRun.value = null;
	selectedMoveTarget.value = {
		location: storages.value[0]?.location || '',
		path: '',
	};
});

watch(
	() => [selectedMoveTarget.value.location, selectedMoveTarget.value.path] as const,
	() => {
		moveDryRun.value = null;
	},
);

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
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Move to folder failed');
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
		if (lc) Object.assign(lifecycle, lc);
	} catch {
		/* defaults */
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

.sidebar-text {
	margin: 0;
	font-size: 0.875rem;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.sidebar-text--spaced {
	margin-bottom: 0.85rem;
}

.sidebar-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.side-field {
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
	margin-bottom: 0.85rem;
}

.side-field label {
	font-size: 0.75rem;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}

.lifecycle-msg {
	margin: 0.65rem 0 0;
	font-size: 0.8rem;
}

.lifecycle-msg.success {
	color: var(--theme--success);
}

.lifecycle-msg.danger {
	color: var(--theme--danger);
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
