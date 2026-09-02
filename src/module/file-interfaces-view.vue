<template>
	<private-view title="File Interfaces" icon="widgets">
		<template #headline>
			<v-breadcrumb
				:items="[
					{ name: 'Storage Manager', to: '/storage-manager' },
					{ name: 'File Interfaces', to: '/storage-manager/file-interfaces' },
				]"
			/>
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About" :close="false">
				<p class="sidebar-text">
					Separate lifecycle defaults for native Directus file fields and Storage Manager interfaces.
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
				<template #icon><v-icon name="policy" /></template>
				File Lifecycle Defaults
			</v-divider>

			<p class="page-intro">
				What happens to a file when a field is deselected/cleared or the collection item holding it is deleted.
				<strong>Move to Recycle Bin</strong> requires Recycle Bin to be On; otherwise the file is kept.
			</p>

			<section class="policy-block">
				<h2 class="policy-title">Native Directus Interfaces</h2>
				<p class="policy-subtitle">File, Image, and Files interfaces</p>

				<div class="side-field policy-select">
					<label>On deselect</label>
					<v-select
						v-model="lifecycle.native.on_deselect"
						:items="nativeDeselectChoices"
						:disabled="saving"
					/>
					<p class="field-hint">Runs on save when the field is cleared or replaced. No Studio prompt.</p>
				</div>

				<div class="side-field policy-select">
					<label>On item delete</label>
					<v-select
						v-model="lifecycle.native.on_item_delete"
						:items="itemDeleteChoices"
						:disabled="saving"
					/>
					<p class="field-hint">When the parent item is deleted.</p>
				</div>
			</section>

			<section class="policy-block">
				<h2 class="policy-title">Storage Manager Interfaces</h2>
				<p class="policy-subtitle">File / Image / Files with Storage</p>

				<div class="side-field policy-select">
					<label>On deselect</label>
					<v-select
						v-model="lifecycle.storage_manager.on_deselect"
						:items="smDeselectChoices"
						:disabled="saving"
					/>
					<p class="field-hint">Can run immediately in the form. Ask shows a Studio prompt.</p>
				</div>

				<div class="side-field policy-select">
					<label>On item delete</label>
					<v-select
						v-model="lifecycle.storage_manager.on_item_delete"
						:items="itemDeleteChoices"
						:disabled="saving"
					/>
					<p class="field-hint">When the parent item is deleted. Per-field options can override.</p>
				</div>
			</section>

			<div class="actions">
				<v-button :loading="saving" :disabled="saving" @click="save">Save</v-button>
			</div>

			<div v-if="message" class="result">
				<v-notice :type="message.type">{{ message.text }}</v-notice>
			</div>
		</div>
	</private-view>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import ModuleNavigation from './navigation.vue';
import { usePageClass } from './composables/use-page-class';
import { LIFECYCLE_DEFAULTS, normalizeLifecycleSettings } from '../shared/lifecycle';

const api = useApi();
const pageClass = usePageClass();

const lifecycle = reactive(normalizeLifecycleSettings(LIFECYCLE_DEFAULTS));
const saving = ref(false);
const message = ref<{ type: 'success' | 'danger'; text: string } | null>(null);

const nativeDeselectChoices = [
	{ text: 'Keep file in library', value: 'keep' },
	{ text: 'Move to Recycle Bin if unreferenced', value: 'move_to_recycle' },
	{ text: 'Delete file if unreferenced', value: 'delete_if_unreferenced' },
];

const smDeselectChoices = [
	{ text: 'Keep file in library', value: 'keep' },
	{ text: 'Move to Recycle Bin if unreferenced', value: 'move_to_recycle' },
	{ text: 'Ask (deselect vs delete if unused)', value: 'ask' },
	{ text: 'Delete file if unreferenced', value: 'delete_if_unreferenced' },
];

const itemDeleteChoices = [
	{ text: 'Keep file in library', value: 'keep' },
	{ text: 'Move to Recycle Bin if unreferenced', value: 'move_to_recycle' },
	{ text: 'Delete file if unreferenced', value: 'delete_if_unreferenced' },
];

async function load() {
	try {
		const res = await api.get('/storage-manager/settings');
		const lc = normalizeLifecycleSettings(res.data?.data?.lifecycle ?? LIFECYCLE_DEFAULTS);
		Object.assign(lifecycle, lc);
		Object.assign(lifecycle.native, lc.native);
		Object.assign(lifecycle.storage_manager, lc.storage_manager);
	} catch {
		/* defaults */
	}
}

async function save() {
	saving.value = true;
	message.value = null;
	try {
		await api.patch('/storage-manager/settings', {
			lifecycle: {
				native: {
					on_deselect: lifecycle.native.on_deselect,
					on_item_delete: lifecycle.native.on_item_delete,
				},
				storage_manager: {
					on_deselect: lifecycle.storage_manager.on_deselect,
					on_item_delete: lifecycle.storage_manager.on_item_delete,
				},
			},
		});
		message.value = { type: 'success', text: 'File lifecycle defaults saved.' };
	} catch (err: any) {
		message.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Save failed',
		};
	} finally {
		saving.value = false;
	}
}

onMounted(() => {
	load();
});
</script>

<style scoped>
.page-container {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding);
	max-inline-size: 67.5rem;
}

.section-divider {
	margin-block-end: 0.75rem;
}

.page-intro {
	margin: 0 0 1.25rem;
	color: var(--theme--foreground);
	line-height: 1.45;
}

.policy-block {
	margin: 0 0 1.25rem;
	padding: 1rem 1.1rem;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
}

.policy-title {
	margin: 0;
	font-size: 1rem;
	font-weight: 700;
	color: var(--theme--foreground);
}

.policy-subtitle {
	margin: 0.2rem 0 0.85rem;
	font-size: 0.8125rem;
	color: var(--theme--foreground-subdued);
}

.policy-select {
	max-inline-size: 28rem;
	margin-block-end: 0.85rem;
}

.policy-select:last-child {
	margin-block-end: 0;
}

.side-field {
	display: flex;
	flex-direction: column;
	gap: 0.3rem;
}

.side-field label {
	font-size: 0.75rem;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}

.field-hint {
	margin: 0;
	font-size: 0.75rem;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
	margin-block: 0.5rem 1rem;
}

.result {
	margin-block-end: 1rem;
}

.sidebar-text {
	margin: 0;
	font-size: 0.875rem;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}
</style>
