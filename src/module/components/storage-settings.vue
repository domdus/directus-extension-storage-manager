<template>
	<div class="storage-settings">
		<p class="intro">
			Choose how new uploads to <strong>{{ location }}</strong> are organised into storage folders.
		</p>

		<div class="field">
			<label>Storage Folder Strategy</label>
			<v-select v-model="form.prefix_strategy" :items="strategyChoices" />
			<p class="hint">{{ strategyHint }}</p>
		</div>

		<!-- folder mirror strategy sub-options -->
		<template v-if="isMirrorStrategy">
			<div class="field">
				<v-checkbox v-model="form.folder_sync_enabled" label="Sync Folder Changes" />
				<p class="hint">
					Only affects this adapter. When a Directus virtual folder is renamed or deleted, physical
					paths on <strong>{{ location }}</strong> are updated to match. Other storages are unchanged
					unless they also have Sync enabled. Can be expensive for large folders.
				</p>
			</div>
			<template v-if="form.folder_sync_enabled">
				<div v-if="form.prefix_strategy === 'folder'" class="field">
					<label>On Folder Rename</label>
					<v-select v-model="form.folder_sync_rename" :items="renameChoices" />
					<p class="hint">{{ renameHint }}</p>
				</div>
				<p v-else class="hint">
					Rename sync is not needed for by-UID paths — folder IDs stay the same when renamed.
				</p>
				<div class="field">
					<label>On Folder Delete</label>
					<p class="static-option">Move to Parent</p>
					<p class="hint">
						Relocates storage paths one level up (same idea as File Library moving content to the
						parent). Never deletes registered files via sync.
					</p>
				</div>
			</template>
		</template>

		<!-- type strategy sub-options -->
		<template v-if="form.prefix_strategy === 'type'">
			<div class="field">
				<label>File Type → Storage Folder</label>
				<div v-for="(val, key) in form.type_map" :key="key" class="type-row">
					<span class="type-key">{{ key }}</span>
					<v-input
						class="type-val"
						:model-value="val"
						:placeholder="key"
						@update:model-value="(v: string) => updateTypeMap(key, v)"
					/>
				</div>
				<div class="type-row add-row">
					<v-input v-model="newTypeKey" placeholder="type (e.g. application)" class="type-key" />
					<v-input v-model="newTypeVal" placeholder="folder name" class="type-val" />
					<v-button small secondary icon @click="addTypeEntry">
						<v-icon name="add" />
					</v-button>
				</div>
			</div>
		</template>

		<!-- date strategy sub-options -->
		<template v-if="form.prefix_strategy === 'date'">
			<div class="field">
				<label>Date Folders</label>
				<v-select v-model="form.date_format" :items="dateFormatChoices" />
				<p class="hint">Example: <code>{{ datePreview }}</code></p>
			</div>
		</template>

		<div class="sidebar-actions">
			<v-button
				class="sidebar-btn sidebar-btn-primary"
				full-width
				:loading="saving"
				:disabled="!dirty"
				@click="save"
			>
				Save
			</v-button>
			<v-button
				secondary
				class="sidebar-btn"
				full-width
				:disabled="!dirty"
				@click="reset"
			>
				Reset
			</v-button>
		</div>

		<v-notice v-if="saveError" type="danger">{{ saveError }}</v-notice>
		<v-notice v-if="saved" type="success">Settings saved.</v-notice>
	</div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import type { StorageLocationSettings } from '../../shared/types';
import { STORAGE_MANAGER_LOCATION_DEFAULTS } from '../../shared/types';
import { STRATEGY_CHOICES, strategyHint as getStrategyHint } from '../../shared/strategies';

const props = defineProps<{
	location: string;
}>();

const emit = defineEmits<{
	(e: 'saved'): void;
}>();

const api = useApi();

const strategyChoices = STRATEGY_CHOICES;

const renameChoices = [
	{ value: 'full_sync', text: 'Move Files' },
	{ value: 'leave_old', text: 'Leave Files' },
];

const dateFormatChoices = [
	{ value: 'yyyy/MM', text: 'YYYY/MM' },
	{ value: 'yyyy/MM/dd', text: 'YYYY/MM/DD' },
	{ value: 'yyyy', text: 'YYYY' },
];

function makeForm(s: StorageLocationSettings): StorageLocationSettings {
	return {
		...STORAGE_MANAGER_LOCATION_DEFAULTS,
		...s,
		folder_sync_delete: 'move_to_parent',
		type_map: { ...STORAGE_MANAGER_LOCATION_DEFAULTS.type_map, ...(s.type_map ?? {}) },
	};
}

const serverForm = ref<StorageLocationSettings>({ ...STORAGE_MANAGER_LOCATION_DEFAULTS });
const form = reactive<StorageLocationSettings>(makeForm(serverForm.value));

const saving = ref(false);
const saved = ref(false);
const saveError = ref<string | null>(null);
const newTypeKey = ref('');
const newTypeVal = ref('');

const dirty = computed(() => JSON.stringify(form) !== JSON.stringify(serverForm.value));

const strategyHint = computed(() => getStrategyHint(form.prefix_strategy));

const isMirrorStrategy = computed(
	() => form.prefix_strategy === 'folder' || form.prefix_strategy === 'folder_id',
);

const renameHint = computed(() =>
	form.folder_sync_rename === 'full_sync'
		? 'Rewrites filename_disk and moves objects to match the new name. Can be slow for thousands of files.'
		: 'Leaves existing objects where they are. New uploads use the new folder name; old paths stay until you migrate them.',
);

const datePreview = computed(() => {
	const now = new Date();
	return (form.date_format || 'yyyy/MM')
		.replace('yyyy', String(now.getFullYear()))
		.replace('MM', String(now.getMonth() + 1).padStart(2, '0'))
		.replace('dd', String(now.getDate()).padStart(2, '0'));
});

async function loadSettings() {
	try {
		const res = await api.get('/storage-manager/settings');
		const data = res.data?.data ?? {};
		const loc = data.locations?.[props.location] ?? {};
		const loaded = makeForm(loc);
		serverForm.value = loaded;
		Object.assign(form, makeForm(loaded));
	} catch {
		// leave defaults
	}
}

function reset() {
	Object.assign(form, makeForm(serverForm.value));
}

async function save() {
	saving.value = true;
	saved.value = false;
	saveError.value = null;
	try {
		const payload = { ...form, folder_sync_delete: 'move_to_parent' as const };
		const res = await api.patch('/storage-manager/settings', {
			locations: { [props.location]: payload },
		});
		const updated = res.data?.data?.locations?.[props.location] ?? {};
		const synced = makeForm(updated);
		serverForm.value = synced;
		Object.assign(form, makeForm(synced));
		saved.value = true;
		emit('saved');
		setTimeout(() => (saved.value = false), 3000);
	} catch (err: any) {
		saveError.value = err?.response?.data?.errors?.[0]?.message ?? err?.message ?? 'Save failed';
	} finally {
		saving.value = false;
	}
}

function updateTypeMap(key: string, value: string) {
	form.type_map = { ...form.type_map, [key]: value };
}

function addTypeEntry() {
	if (!newTypeKey.value.trim()) return;
	form.type_map = { ...form.type_map, [newTypeKey.value.trim()]: newTypeVal.value.trim() };
	newTypeKey.value = '';
	newTypeVal.value = '';
}

watch(() => props.location, loadSettings, { immediate: true });
</script>

<style scoped>
.storage-settings {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 8px 0;
}

.intro {
	margin: 0;
	font-size: 13px;
	color: var(--theme--foreground-subdued);
}

.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.field label {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	color: var(--theme--foreground-subdued);
}

.hint {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.static-option {
	margin: 0;
	font-size: 14px;
	color: var(--theme--foreground);
}

.type-row {
	display: flex;
	align-items: center;
	gap: 8px;
}

.type-key {
	flex: 0 0 120px;
	font-size: 12px;
	font-family: var(--theme--fonts--monospace--font-family, monospace);
}

.type-val {
	flex: 1;
}

.add-row {
	margin-top: 4px;
}

.sidebar-actions {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

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
}
</style>
