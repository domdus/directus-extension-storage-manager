<template>
	<private-view title="Storage Manager" icon="swap_horiz">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Storage Manager', to: '/storage-manager' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About">
				<p class="sidebar-text">
					Copy or move files between configured storage adapters. Physical objects are streamed via Directus
					storage drivers; database <code>id</code> and <code>filename_disk</code> stay the same.
				</p>
			</sidebar-detail>
			<sidebar-detail id="strategy-guide" icon="menu_book" title="Strategy Guide">
				<div class="glossary-sidebar">
					<p class="glossary-scope">{{ STRATEGY_SCOPE_NOTE }}</p>

					<div v-for="entry in STRATEGY_GLOSSARY" :key="entry.value" class="glossary-item">
						<strong>{{ entry.title }}</strong>
						<p>{{ entry.body }}</p>
					</div>

					<section class="glossary-section" aria-labelledby="sync-folder-changes-heading">
						<span id="sync-folder-changes-heading" class="glossary-section-label">
							Option: Sync Folder Changes
						</span>
						<p class="glossary-section-intro">{{ syncGuideIntro }}</p>
						<div
							v-for="entry in syncGuideDetails"
							:key="entry.value"
							class="glossary-item"
						>
							<strong>{{ entry.title }}</strong>
							<p>{{ entry.body }}</p>
						</div>
					</section>
				</div>
			</sidebar-detail>
		</template>

		<div :class="pageClass">
			<div v-if="loading && !storages.length" class="loading">
				<v-progress-circular indeterminate />
			</div>

			<v-notice v-else-if="storagesError" type="danger">{{ storagesError }}</v-notice>

			<template v-else>
				<v-divider
					class="section-divider"
					large
					:inline-title="false"
					:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
				>
					<template #icon><v-icon name="swap_horiz" /></template>
					Storage Manager
				</v-divider>

				<p class="page-intro">
					Browse, create, and migrate files and storage folders across your adapters. Build folder
					structure yourself, or pick a smart folder strategy per storage — see the
					<strong>Strategy Guide</strong> in the sidebar for further information.
				</p>

				<div class="storage-grid">
					<article v-for="storage in storages" :key="storage.location" class="storage-card">
						<div class="card-head">
							<v-icon :name="storage.icon" large />
							<div class="card-titles">
								<strong>{{ storage.location }}</strong>
								<span>{{ storage.label }}</span>
							</div>
							<v-button small secondary @click="goStorage(storage.location)">Browse</v-button>
						</div>

						<usage-bar :usage="storage" plain />

						<div class="meta">
							<span class="tag">{{ storage.file_count.toLocaleString() }} files</span>
							<span class="tag">{{ (storage.folder_count ?? 0).toLocaleString() }} folders</span>
							<span
								v-if="storage.root"
								class="tag tag-path"
								:title="storage.root"
							>{{ storage.root }}</span>
							<span v-else-if="storage.bucket" class="tag tag-path">{{ storage.bucket }}</span>
						</div>

						<div class="card-strategy">
							<span class="strategy-label" :title="strategyHeadline(storage.location)">
								<span class="strategy-prefix">Storage Folder Strategy:</span>
								{{ strategyLabel(storage.location) }}
							</span>
							<v-button small secondary @click="openStrategyDialog(storage.location)">
								<v-icon name="tune" left />
								Configure
							</v-button>
						</div>
					</article>
				</div>
			</template>
		</div>

		<v-dialog
			:model-value="strategyDialogLocation !== null"
			@update:model-value="(open: boolean) => !open && closeStrategyDialog()"
			@esc="closeStrategyDialog"
		>
			<v-card v-if="strategyDialogLocation" class="strategy-dialog-card">
				<v-card-title>Storage Folder Strategy — {{ strategyDialogLocation }}</v-card-title>
				<v-card-text>
					<storage-settings
						:key="strategyDialogLocation"
						:location="strategyDialogLocation"
						@saved="onStrategySaved"
					/>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="closeStrategyDialog">Close</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import ModuleNavigation from './navigation.vue';
import UsageBar from './components/usage-bar.vue';
import StorageSettings from './components/storage-settings.vue';
import { usePageClass } from './composables/use-page-class';
import { useStorageManager } from './composables/use-storage-manager';
import {
	STRATEGY_CARD_LABELS,
	STRATEGY_GLOSSARY,
	STRATEGY_SCOPE_NOTE,
	SYNC_GLOSSARY,
} from '../shared/strategies';
import type { PrefixStrategy, StorageLocationSettings } from '../shared/types';
import { STORAGE_MANAGER_LOCATION_DEFAULTS } from '../shared/types';
import { storageManagerPath } from '../shared/storage-path-url';

const syncGuideIntro = SYNC_GLOSSARY.find((e) => e.value === 'sync')?.body || '';
const syncGuideDetails = SYNC_GLOSSARY.filter((e) => e.value !== 'sync');

const router = useRouter();
const api = useApi();
const pageClass = usePageClass();
const { storages, storagesError, loadStorages } = useStorageManager();
const loading = ref(true);
/** Strategy per location — for card labels only; editing happens in the dialog. */
const locationStrategies = reactive<Record<string, PrefixStrategy>>({});
const strategyDialogLocation = ref<string | null>(null);

function strategyLabel(location: string): string {
	const value = locationStrategies[location] || STORAGE_MANAGER_LOCATION_DEFAULTS.prefix_strategy;
	return STRATEGY_CARD_LABELS[value] || 'None';
}

function strategyHeadline(location: string): string {
	return `Storage Folder Strategy: ${strategyLabel(location)}`;
}

function openStrategyDialog(location: string) {
	strategyDialogLocation.value = location;
}

async function closeStrategyDialog() {
	strategyDialogLocation.value = null;
	await loadStrategyLabels();
}

async function onStrategySaved() {
	await loadStrategyLabels();
}

async function loadStrategyLabels() {
	try {
		const res = await api.get('/storage-manager/settings');
		const locations = (res.data?.data?.locations || {}) as Record<string, StorageLocationSettings>;
		for (const key of Object.keys(locationStrategies)) delete locationStrategies[key];
		for (const [loc, partial] of Object.entries(locations)) {
			locationStrategies[loc] = (partial?.prefix_strategy ||
				STORAGE_MANAGER_LOCATION_DEFAULTS.prefix_strategy) as PrefixStrategy;
		}
		for (const storage of storages.value) {
			if (!locationStrategies[storage.location]) {
				locationStrategies[storage.location] = STORAGE_MANAGER_LOCATION_DEFAULTS.prefix_strategy;
			}
		}
	} catch {
		for (const storage of storages.value) {
			locationStrategies[storage.location] = STORAGE_MANAGER_LOCATION_DEFAULTS.prefix_strategy;
		}
	}
}

async function refresh() {
	loading.value = true;
	try {
		await loadStorages(true);
		await loadStrategyLabels();
	} finally {
		loading.value = false;
	}
}

function goStorage(location: string) {
	router.push(storageManagerPath(location));
}

onMounted(refresh);
</script>

<style scoped>
.page {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom);
	max-width: 1100px;
}

.page--flush-top {
	padding-block-start: 0;
}

.section-divider {
	margin-bottom: 12px;
}

.page-intro,
.sidebar-text {
	margin: 0 0 24px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.sidebar-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.loading {
	display: flex;
	justify-content: center;
	padding: 48px 0;
}

.glossary-sidebar {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.glossary-scope {
	margin: 0;
	padding: 10px 12px;
	font-size: 12px;
	line-height: 1.45;
	color: var(--theme--foreground);
	background: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.glossary-section {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin-block-start: 8px;
	padding: 14px 12px;
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color);
	border-block-start-width: 2px;
	background: var(--theme--background-subdued);
}

.glossary-section-label {
	display: block;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--theme--foreground);
}

.glossary-section-intro {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.glossary-section .glossary-item {
	padding-block-start: 10px;
	border-block-start: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.glossary-sidebar .glossary-item strong {
	display: block;
	margin-block-end: 4px;
	font-size: 13px;
}

.glossary-sidebar .glossary-item p {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.storage-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 16px;
}

@media (max-width: 900px) {
	.storage-grid {
		grid-template-columns: 1fr;
	}
}

.storage-card {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
	padding: 16px 18px;
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color);
	background: var(--theme--background);
}

.card-head {
	display: flex;
	align-items: center;
	gap: 12px;
}

.card-titles {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
	flex: 1;
}

.card-titles strong {
	font-size: 15px;
	letter-spacing: 0.01em;
}

.card-titles span {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}

.meta {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
}

.meta .tag {
	display: inline-flex;
	align-items: center;
	max-width: 100%;
	padding: 3px 9px;
	border-radius: 4px;
	font-size: 12px;
	line-height: 1.35;
	color: var(--theme--foreground);
	background: var(--theme--background-normal);
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.meta .tag-path {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	color: var(--theme--foreground-subdued);
}

.card-strategy {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding-block-start: 12px;
	border-block-start: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.strategy-label {
	min-width: 0;
	flex: 1;
	overflow: hidden;
	font-size: 13px;
	font-weight: 600;
	color: var(--theme--foreground);
	white-space: nowrap;
	text-overflow: ellipsis;
}

.strategy-prefix {
	font-weight: 500;
	color: var(--theme--foreground-subdued);
}

.strategy-dialog-card {
	width: min(480px, 92vw);
	max-block-size: min(85vh, 720px);
	overflow: auto;
}
</style>
