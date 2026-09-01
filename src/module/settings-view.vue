<template>
	<private-view title="Settings" icon="settings">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Storage Manager', to: '/storage-manager' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About">
				<p class="sidebar-text">
					Export or import this extension’s JSON config, or remove the dedicated settings field before
					uninstalling. Recycle Bin lives under its own nav item.
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
				<template #icon><v-icon name="system_update" /></template>
				Extension Updates
			</v-divider>
			<p class="explain">
				Check npm for the latest published version and compare it with the installed extension version.
			</p>
			<div class="actions">
				<v-button secondary :loading="checkingUpdates" @click="checkUpdates(true)">Check Now</v-button>
				<v-button
					v-if="updateInfo?.has_update && marketplaceUrl"
					secondary
					:to="marketplaceUrl"
				>
					Marketplace
				</v-button>
			</div>
			<div v-if="updateInfo" class="result">
				<v-notice :type="updateNoticeType">
					Current: <strong>{{ updateInfo.current_version }}</strong>
					<template v-if="updateInfo.latest_version">
						· Latest: <strong>{{ updateInfo.latest_version }}</strong>
					</template>
					<template v-if="updateInfo.error"> · {{ updateInfo.error }}</template>
					<template v-else-if="updateInfo.has_update"> · Update available</template>
					<template v-else> · Up to date</template>
				</v-notice>
			</div>

			<v-divider
				class="section-divider add-margin-top"
				large
				:inline-title="false"
				:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
			>
				<template #icon><v-icon name="import_export" /></template>
				Export / Import
			</v-divider>
			<p class="explain">
				Back up or restore Mirror Directus Folders settings as JSON, or remove the dedicated
				<code>storage_manager</code> settings field before uninstalling. Per-location rules are stored in
				<code>directus_settings.storage_manager</code> only — other project settings are left untouched.
			</p>

			<div class="actions">
				<v-button secondary :disabled="loading || cleaning" @click="exportConfig">Export JSON</v-button>
				<v-button secondary :disabled="loading || cleaning || importing" :loading="importing" @click="triggerImport">
					Import JSON
				</v-button>
				<input
					ref="fileInput"
					type="file"
					accept="application/json,.json"
					class="file-input"
					@change="onImportFile"
				/>
			</div>

			<div v-if="importMessage" class="result">
				<v-notice :type="importMessage.type">{{ importMessage.text }}</v-notice>
			</div>

			<v-divider
				class="section-divider add-margin-top"
				large
				:inline-title="false"
				:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
			>
				<template #icon><v-icon name="delete" /></template>
				Remove Extension Data
			</v-divider>
			<p class="explain">
				Use this before uninstalling. Cleanup removes:
			</p>
			<ul class="cleanup-list">
				<li>
					<code>directus_settings.storage_manager</code> (config JSON field)
				</li>
				<li>
					Scheduled purge Flow
					(<code>Storage Manager · Purge Recycle Bin</code>), if present
				</li>
				<li>
					<code>Unreferenced File Scans</code> folder and its snapshot files
				</li>
			</ul>
			<p class="explain">
				The Recycle Bin folder and its files are left alone unless you opt in below. The
				<code>storage_manager_trashed_at</code> field on <code>directus_files</code> is not removed. If the
				extension stays installed, the next Directus restart may recreate an empty
				<code>storage_manager</code> field.
			</p>

			<div class="side-field">
				<v-checkbox v-model="emptyRecycle" :disabled="cleaning" label="Also Empty Recycle Bin" />
				<p class="field-hint">
					Permanently deletes all files in the Recycle folder and removes the folder. Cannot be undone.
				</p>
			</div>

			<v-notice type="warning" class="notice">
				Deleting extension data cannot be undone. Export first if you might need the config again.
			</v-notice>

			<div v-if="result" class="result">
				<v-notice type="success">
					Cleanup finished.
					<template v-if="result.cleared_value"> Value cleared.</template>
					<template v-if="result.deleted_field"> Field removed.</template>
					<template v-if="result.deleted_purge_flow"> Purge Flow deleted.</template>
					<template v-if="result.deleted_scan_folder || result.deleted_scan_files">
						· Scan snapshots removed
						<template v-if="result.deleted_scan_files">
							({{ result.deleted_scan_files.toLocaleString() }} file(s))
						</template>.
					</template>
					<template v-if="result.emptied_recycle">
						· Recycle emptied
						<template v-if="result.deleted_recycle_files">
							({{ result.deleted_recycle_files.toLocaleString() }} file(s))
						</template>.
					</template>
				</v-notice>
				<v-notice v-if="result.warnings?.length" type="warning" class="notice">
					{{ result.warnings.join(' ') }}
				</v-notice>
			</div>

			<div v-if="errorMessage" class="result">
				<v-notice type="danger">{{ errorMessage }}</v-notice>
			</div>

			<v-button kind="danger" :loading="cleaning" :disabled="cleaning" @click="confirmOpen = true">
				Delete Storage Manager Data
			</v-button>
		</div>

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card>
				<v-card-title>Remove Extension Data?</v-card-title>
				<v-card-text>
					<p>
						This deletes the <code>storage_manager</code> settings field, the scheduled purge Flow (if any),
						and the <code>Unreferenced File Scans</code> folder with its snapshot files.
					</p>
					<p v-if="emptyRecycle" class="dialog-danger">
						Also permanently deletes every file in the Recycle Bin folder.
					</p>
					<p v-else class="dialog-note">Recycle Bin files are kept.</p>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmOpen = false">Cancel</v-button>
					<v-button kind="danger" :loading="cleaning" @click="runCleanup">Delete</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import {
	useStorageSettingsAdmin,
	type CleanupExtensionResult,
} from './composables/use-storage-settings-admin';
import { usePageClass } from './composables/use-page-class';
import ModuleNavigation from './navigation.vue';
import {
	EXTENSION_GITHUB_URL,
	EXTENSION_MARKETPLACE_UID,
	EXTENSION_NPM_URL,
} from '../shared/extension-meta';

const pageClass = usePageClass();
const api = useApi();
const marketplaceUrl = computed(() =>
	EXTENSION_MARKETPLACE_UID
		? `/admin/settings/marketplace/extension/${EXTENSION_MARKETPLACE_UID}`
		: null,
);

const {
	loading,
	cleaning,
	ensureLoaded,
	cleanupExtensionData,
	exportStorageManagerConfig,
	importStorageManagerConfig,
} = useStorageSettingsAdmin();

const confirmOpen = ref(false);
const emptyRecycle = ref(false);
const errorMessage = ref<string | null>(null);
const result = ref<CleanupExtensionResult | null>(null);
const importing = ref(false);
const importMessage = ref<{ type: 'success' | 'danger'; text: string } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const checkingUpdates = ref(false);
const updateInfo = ref<{
	current_version: string;
	latest_version: string | null;
	has_update: boolean;
	checked_at: string;
	error?: string;
	links: { npm: string; github: string; marketplace: string | null };
} | null>(null);
const updateNoticeType = computed(() => {
	if (!updateInfo.value) return 'info';
	if (updateInfo.value.error) return 'warning';
	return updateInfo.value.has_update ? 'warning' : 'success';
});

onMounted(() => {
	ensureLoaded();
});

async function checkUpdates(force: boolean) {
	checkingUpdates.value = true;
	try {
		const res = await api.get('/storage-manager/update-check', {
			params: { force: force ? '1' : undefined },
		});
		updateInfo.value = res.data?.data || null;
	} catch (error: any) {
		updateInfo.value = {
			current_version: 'unknown',
			latest_version: null,
			has_update: false,
			checked_at: new Date().toISOString(),
			error: error?.response?.data?.errors?.[0]?.message || error?.message || 'Update check failed',
			links: {
				npm: EXTENSION_NPM_URL,
				github: EXTENSION_GITHUB_URL,
				marketplace: marketplaceUrl.value,
			},
		};
	} finally {
		checkingUpdates.value = false;
	}
}

function exportConfig() {
	importMessage.value = null;
	exportStorageManagerConfig();
}

function triggerImport() {
	importMessage.value = null;
	fileInput.value?.click();
}

async function onImportFile(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file) return;

	importing.value = true;
	importMessage.value = null;

	try {
		const text = await file.text();
		const parsed = JSON.parse(text);
		await importStorageManagerConfig(parsed);
		importMessage.value = {
			type: 'success',
			text: 'Config imported and saved to settings.',
		};
	} catch (error: any) {
		importMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Import failed',
		};
	} finally {
		importing.value = false;
	}
}

async function runCleanup() {
	errorMessage.value = null;
	result.value = null;
	importMessage.value = null;

	try {
		result.value = await cleanupExtensionData({ empty_recycle: emptyRecycle.value });
		confirmOpen.value = false;
	} catch (error: any) {
		errorMessage.value =
			error?.response?.data?.errors?.[0]?.message || error?.message || 'Cleanup failed';
	}
}
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

.section-divider.add-margin-top {
	margin-top: 40px;
}

.explain,
.sidebar-text {
	margin: 0 0 16px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.explain code,
.sidebar-text code,
.v-card-text code,
.cleanup-list code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.cleanup-list {
	margin: 0 0 1rem;
	padding-inline-start: 1.25rem;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.cleanup-list li {
	margin-block-end: 0.35rem;
}

.side-field {
	margin: 0 0 1rem;
	max-inline-size: 36rem;
}

.field-hint {
	margin: 0.35rem 0 0;
	font-size: 0.9rem;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.dialog-danger {
	margin: 0.75rem 0 0;
	color: var(--theme--danger);
	font-weight: 600;
}

.dialog-note {
	margin: 0.75rem 0 0;
	color: var(--theme--foreground-subdued);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 16px;
}

.file-input {
	display: none;
}

.notice,
.result {
	margin-bottom: 16px;
}
</style>
