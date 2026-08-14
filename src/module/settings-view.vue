<template>
	<private-view title="Settings" icon="settings">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Storage Manager', to: '/storage-manager' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail icon="info" title="About" close>
				<p class="sidebar-text">
					Export or import this extension’s JSON config, or remove the dedicated settings field before
					uninstalling.
				</p>
			</sidebar-detail>
		</template>

		<div :class="pageClass">
			<p class="page-intro">
				Back up or restore storage folder strategies and sync settings as JSON, or remove the dedicated
				<code>storage_manager</code> settings field before uninstalling. Per-location storage folder rules are
				stored in <code>directus_settings.storage_manager</code> only — other project settings are left
				untouched.
			</p>

			<v-divider
				class="section-divider"
				large
				:inline-title="false"
				:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
			>
				<template #icon><v-icon name="import_export" /></template>
				Export / Import
			</v-divider>
			<p class="explain">
				Download or restore <code>directus_settings.storage_manager</code> only (storage folder strategies and
				folder sync options per storage location).
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
				Remove extension data
			</v-divider>
			<p class="explain">
				Storage folder and sync settings live in a dedicated JSON field
				<code>directus_settings.storage_manager</code>. Cleanup removes only that field and its value. If the
				extension stays installed, the next Directus restart may recreate an empty
				<code>storage_manager</code> field.
			</p>

			<v-notice type="warning" class="notice">
				Deleting extension data cannot be undone. Export first if you might need the config again.
			</v-notice>

			<div v-if="result" class="result">
				<v-notice type="success">
					Cleanup finished.
					<template v-if="result.clearedValue"> Value cleared.</template>
					<template v-if="result.deletedField"> Field removed.</template>
				</v-notice>
			</div>

			<div v-if="errorMessage" class="result">
				<v-notice type="danger">{{ errorMessage }}</v-notice>
			</div>

			<v-button kind="danger" :loading="cleaning" :disabled="cleaning" @click="confirmOpen = true">
				Delete storage_manager data
			</v-button>
		</div>

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card>
				<v-card-title>Delete storage_manager?</v-card-title>
				<v-card-text>
					This removes only <code>directus_settings.storage_manager</code> (the extension’s own JSON field).
					All other project settings stay as they are.
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
import { onMounted, ref } from 'vue';
import { useStorageSettingsAdmin } from './composables/use-storage-settings-admin';
import { usePageClass } from './composables/use-page-class';
import ModuleNavigation from './navigation.vue';

const pageClass = usePageClass();

const {
	loading,
	cleaning,
	ensureLoaded,
	cleanupExtensionData,
	exportStorageManagerConfig,
	importStorageManagerConfig,
} = useStorageSettingsAdmin();

const confirmOpen = ref(false);
const errorMessage = ref<string | null>(null);
const result = ref<{ clearedValue: boolean; deletedField: boolean } | null>(null);
const importing = ref(false);
const importMessage = ref<{ type: 'success' | 'danger'; text: string } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
	ensureLoaded();
});

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
		result.value = await cleanupExtensionData();
		confirmOpen.value = false;
	} catch (error: any) {
		errorMessage.value =
			error?.response?.data?.errors?.[0]?.message || error?.message || 'Cleanup failed';
	}
}
</script>

<style scoped>
.page {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom);
	max-width: 720px;
}

.page--flush-top {
	padding-block-start: 0;
}

.section-divider {
	margin-bottom: 12px;
}

.section-divider.add-margin-top {
	margin-top: 40px;
}

.page-intro {
	margin: 0 0 24px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.page-intro code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.explain,
.sidebar-text {
	margin: 0 0 16px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.explain code,
.sidebar-text code,
.v-card-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
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
