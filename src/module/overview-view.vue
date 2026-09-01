<template>
	<private-view title="Storage Manager" icon="storage">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Storage Manager', to: '/storage-manager' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About">
				<p class="sidebar-text">
					Move files between configured storage adapters and manage physical storage folders. Use Directus
					Folders view to materialize virtual folders into real storage paths.
				</p>
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
					Browse, create, and move files and storage folders across your adapters. Use Materialize in
					Directus Folders view to convert virtual folder hierarchy into physical storage paths. Use
					<strong>Unreferenced Files</strong> to find leftover File Library entries, and
					<strong>File Interfaces</strong> to set automatic cleanup when fields are cleared or items are
					deleted (including native Directus File / Image / Files fields).
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

						<usage-bar :usage="storage" />

						<div class="meta">
							<span class="tag"
								>{{ storage.file_count.toLocaleString() }}
								{{ storage.file_count === 1 ? 'file' : 'files' }}</span
							>
							<span v-if="storage.folder_count == null" class="tag tag-muted">… folders</span>
							<span v-else class="tag"
								>{{ storage.folder_count.toLocaleString() }}
								{{ storage.folder_count === 1 ? 'folder' : 'folders' }}</span
							>
							<span
								v-if="storage.root"
								class="tag tag-path"
								:title="storage.root"
							>{{ storage.root }}</span>
							<span v-else-if="storage.bucket" class="tag tag-path">{{ storage.bucket }}</span>
						</div>

						<div class="card-strategy">
							<div class="mirror-copy">
								<strong>Mirror Directus Folders</strong>
								<v-icon
									v-tooltip.bottom="'New uploads and folder rename/delete follow the Directus folder tree on this adapter.'"
									name="help_outline"
									small
								/>
							</div>
							<v-checkbox
								:model-value="storage.mirror_directus_folders"
								:disabled="Boolean(savingMirror[storage.location])"
								@update:model-value="(value: boolean) => setMirror(storage.location, value)"
							/>
						</div>

					</article>
				</div>
			</template>
		</div>
	</private-view>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useApi } from '@directus/extensions-sdk';
import ModuleNavigation from './navigation.vue';
import UsageBar from './components/usage-bar.vue';
import { usePageClass } from './composables/use-page-class';
import { useStorageManager } from './composables/use-storage-manager';
import { storageManagerPath } from '../shared/storage-path-url';
import { directusFolderMirrorPatch } from '../shared/settings';

const router = useRouter();
const api = useApi();
const pageClass = usePageClass();
const { storages, storagesError, loadStorages } = useStorageManager();
const loading = ref(true);
const savingMirror = reactive<Record<string, boolean>>({});

async function refresh() {
	loading.value = true;
	try {
		await loadStorages(true);
	} finally {
		loading.value = false;
	}
}

async function setMirror(location: string, enabled: boolean) {
	const card = storages.value.find((s) => s.location === location);
	if (!card || savingMirror[location]) return;

	const previous = Boolean(card.mirror_directus_folders);
	card.mirror_directus_folders = enabled;
	savingMirror[location] = true;
	try {
		await api.patch('/storage-manager/settings', {
			locations: { [location]: directusFolderMirrorPatch(enabled) },
		});
	} catch {
		card.mirror_directus_folders = previous;
		window.alert('Could not save Mirror Directus Folders.');
	} finally {
		savingMirror[location] = false;
	}
}

function goStorage(location: string) {
	router.push(storageManagerPath(location));
}

onMounted(refresh);
</script>

<style scoped>
.page-container {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom);
	max-inline-size: 67.5rem;
}

.page-container--flush-top {
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

.meta .tag-muted {
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

.mirror-copy {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	flex: 1;
}

.mirror-copy strong {
	font-size: 13px;
}

.mirror-copy .v-icon {
	--v-icon-color: var(--theme--foreground-subdued);
	cursor: pointer;
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
