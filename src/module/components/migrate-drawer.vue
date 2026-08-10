<template>
	<v-drawer
		:model-value="modelValue"
		title="Migrate Files"
		icon="swap_horiz"
		persistent
		@update:model-value="onDrawerToggle"
		@cancel="close"
	>
		<template #actions>
			<v-button
				v-if="!running && !result"
				v-tooltip.bottom="confirmLabel"
				:disabled="!canSubmit"
				icon
				rounded
				@click="submit"
			>
				<v-icon name="check" />
			</v-button>
			<v-button
				v-else-if="running"
				v-tooltip.bottom="'Cancel'"
				icon
				rounded
				secondary
				@click="cancel"
			>
				<v-icon name="close" />
			</v-button>
		</template>

		<div class="drawer-body">
			<p class="intro">
				{{ summaryText }}
			</p>

			<template v-if="!running && !result">
				<div class="field">
					<label>Target Storage</label>
					<v-select
						v-model="target"
						:items="targetChoices"
						item-text="text"
						item-value="value"
						placeholder="Select target…"
					/>
				</div>

				<div class="field">
					<label>Mode</label>
					<div class="mode-radios">
						<v-radio v-model="mode" value="move" label="Move — delete source after verify" block />
						<v-radio v-model="mode" value="copy" label="Copy — leave source object as orphan" block />
					</div>
					<p class="note">
						Files keep the same identity in Directus; only their storage location changes. Image thumbnails
						are moved or copied with them when possible. Move removes the originals from the old storage;
						Copy leaves them behind as unused files.
					</p>
				</div>

				<div v-if="selectionKind === 'folder'" class="field">
					<v-checkbox v-model="recursive" label="Include files in subfolders" />
				</div>
			</template>

			<migrate-progress
				v-if="running || result"
				:storages="storages"
				:mode="mode"
				:from="progress.from"
				:to="progress.to"
				:current-index="progress.currentIndex"
				:total-files="progress.totalFiles"
				:current-name="progress.currentName"
				:transferred-bytes="progress.transferredBytes"
				:total-bytes="progress.totalBytes"
				:elapsed-ms="progress.elapsedMs"
				:speed-bps="progress.speedBps"
				:succeeded="progress.succeeded"
				:skipped="progress.skipped"
				:failed="progress.failed"
				:is-done="Boolean(result) && !running"
			/>

			<div v-if="result" class="result">
				<v-notice :type="result.failed ? 'danger' : 'success'">
					{{ result.succeeded }} succeeded · {{ result.skipped }} skipped · {{ result.failed }} failed
					(of {{ result.total }})
				</v-notice>
				<div v-if="failedRows.length" class="failures">
					<div v-for="row in failedRows.slice(0, 20)" :key="row.id" class="fail-row">
						<strong>{{ row.filename_disk || row.id }}</strong>
						<span>{{ row.error }}</span>
					</div>
				</div>
			</div>
		</div>
	</v-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useStorageManager } from '../composables/use-storage-manager';
import MigrateProgress from './migrate-progress.vue';
import type { MigrateMode, MigrateProgressEvent, MigrateResponse, StorageLocationInfo } from '../../shared/types';
import { formatBytes } from '../../shared/format';

const props = defineProps<{
	modelValue: boolean;
	storages: StorageLocationInfo[];
	sourceStorage?: string | null;
	selectionKind: 'files' | 'storage' | 'folder';
	fileIds?: string[];
	folderId?: string | null;
	estimatedCount?: number;
	estimatedBytes?: number;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'done', result: MigrateResponse): void;
}>();

const { migrateWithProgress } = useStorageManager();

const target = ref<string | null>(null);
const mode = ref<MigrateMode>('move');
const recursive = ref(true);
const running = ref(false);
const result = ref<MigrateResponse | null>(null);
let abortController: AbortController | null = null;

const progress = reactive({
	from: null as string | null,
	to: '',
	currentIndex: 0,
	totalFiles: 0,
	currentName: '',
	transferredBytes: 0,
	totalBytes: 0,
	elapsedMs: 0,
	speedBps: 0,
	succeeded: 0,
	skipped: 0,
	failed: 0,
});

function resetProgress(to = '') {
	progress.from = props.sourceStorage || null;
	progress.to = to;
	progress.currentIndex = 0;
	progress.totalFiles = props.estimatedCount || props.fileIds?.length || 0;
	progress.currentName = '';
	progress.transferredBytes = 0;
	progress.totalBytes = props.estimatedBytes || 0;
	progress.elapsedMs = 0;
	progress.speedBps = 0;
	progress.succeeded = 0;
	progress.skipped = 0;
	progress.failed = 0;
}

watch(
	() => props.modelValue,
	(open) => {
		if (open) {
			result.value = null;
			running.value = false;
			abortController?.abort();
			abortController = null;
			const first = props.storages.find((s) => s.location !== props.sourceStorage);
			target.value = first?.location || null;
			mode.value = 'move';
			recursive.value = true;
			resetProgress(first?.location || '');
		}
	},
);

const targetChoices = computed(() =>
	props.storages
		.filter((s) => s.location !== props.sourceStorage)
		.map((s) => ({
			text: `${s.location} (${s.short})`,
			value: s.location,
		})),
);

const confirmLabel = computed(() => (mode.value === 'move' ? 'Move' : 'Copy'));
const canSubmit = computed(() => Boolean(target.value) && !running.value);

const summaryText = computed(() => {
	// After migrate (or while running), prefer job totals — parent refresh can
	// zero out estimatedCount once files left the source storage.
	const count = result.value?.total
		?? (running.value && progress.totalFiles > 0 ? progress.totalFiles : null)
		?? props.estimatedCount
		?? props.fileIds?.length
		?? 0;
	const byteValue = result.value?.total_bytes
		?? (running.value && progress.totalBytes > 0 ? progress.totalBytes : null)
		?? props.estimatedBytes;
	const bytes = byteValue != null ? ` (${formatBytes(byteValue)})` : '';
	const done = Boolean(result.value);

	if (props.selectionKind === 'storage') {
		return done
			? `Migrated ${count.toLocaleString()} files${bytes} from “${props.sourceStorage}”.`
			: `Migrate all ${count.toLocaleString()} files${bytes} on “${props.sourceStorage}”.`;
	}
	if (props.selectionKind === 'folder') {
		return done
			? `Migrated ${count.toLocaleString()} files${bytes} from the selected folder.`
			: `Migrate ${count.toLocaleString()} files${bytes} in the selected folder.`;
	}
	return done
		? `Migrated ${count.toLocaleString()} selected file(s)${bytes}.`
		: `Migrate ${count.toLocaleString()} selected file(s)${bytes}.`;
});

const failedRows = computed(() => (result.value?.results || []).filter((r) => r.status === 'failed'));

function onDrawerToggle(value: boolean) {
	if (!value && running.value) return;
	emit('update:modelValue', value);
}

function close() {
	if (running.value) {
		cancel();
		return;
	}
	emit('update:modelValue', false);
}

function cancel() {
	abortController?.abort();
}

function applyProgressEvent(event: MigrateProgressEvent) {
	if (event.type === 'start') {
		progress.from = event.from || props.sourceStorage || null;
		progress.to = event.to;
		progress.totalFiles = event.total;
		progress.totalBytes = event.total_bytes;
		progress.currentIndex = 0;
		progress.currentName = '';
		progress.transferredBytes = 0;
		progress.elapsedMs = 0;
		progress.speedBps = 0;
		progress.succeeded = 0;
		progress.skipped = 0;
		progress.failed = 0;
		return;
	}

	if (event.type === 'file_start') {
		progress.currentIndex = event.index;
		progress.totalFiles = event.total;
		progress.currentName = event.name || event.filename_disk;
		if (!progress.from) progress.from = event.from;
		progress.to = event.to;
		return;
	}

	if (event.type === 'file_bytes') {
		progress.currentIndex = event.index;
		progress.transferredBytes = event.transferred_bytes;
		progress.totalBytes = event.total_bytes || progress.totalBytes;
		progress.elapsedMs = event.elapsed_ms;
		progress.speedBps = event.elapsed_ms > 0 ? (event.transferred_bytes * 1000) / event.elapsed_ms : 0;
		return;
	}

	if (event.type === 'file_done') {
		progress.currentIndex = event.index;
		progress.totalFiles = event.total;
		progress.currentName = event.name || event.result.filename_disk;
		progress.succeeded = event.succeeded;
		progress.skipped = event.skipped;
		progress.failed = event.failed;
		progress.transferredBytes = event.transferred_bytes;
		progress.totalBytes = event.total_bytes || progress.totalBytes;
		progress.elapsedMs = event.elapsed_ms;
		progress.speedBps = event.elapsed_ms > 0 ? (event.transferred_bytes * 1000) / event.elapsed_ms : 0;
		return;
	}

	if (event.type === 'done') {
		progress.succeeded = event.data.succeeded;
		progress.skipped = event.data.skipped;
		progress.failed = event.data.failed;
		progress.transferredBytes = event.data.transferred_bytes ?? progress.transferredBytes;
		progress.totalBytes = event.data.total_bytes ?? progress.totalBytes;
		progress.elapsedMs = event.data.elapsed_ms ?? progress.elapsedMs;
		progress.totalFiles = event.data.total;
		progress.currentIndex = event.data.total;
		progress.speedBps =
			progress.elapsedMs > 0 ? (progress.transferredBytes * 1000) / progress.elapsedMs : 0;
	}
}

async function submit() {
	if (!target.value || running.value) return;
	running.value = true;
	result.value = null;
	resetProgress(target.value);
	abortController = new AbortController();

	try {
		const payload: Parameters<typeof migrateWithProgress>[0] = {
			target_storage: target.value,
			mode: mode.value,
			concurrency: 1,
		};

		if (props.selectionKind === 'files') {
			payload.file_ids = props.fileIds || [];
		} else if (props.selectionKind === 'storage') {
			payload.source_storage = props.sourceStorage || undefined;
		} else if (props.selectionKind === 'folder') {
			payload.folder_id = props.folderId ?? null;
			payload.recursive = recursive.value;
			if (props.sourceStorage) payload.source_storage = props.sourceStorage;
		}

		const res = await migrateWithProgress(payload, applyProgressEvent, abortController.signal);
		result.value = res;
		emit('done', res);
	} catch (err: any) {
		if (err?.name === 'AbortError') {
			result.value = {
				mode: mode.value,
				target_storage: target.value,
				total: progress.totalFiles,
				succeeded: progress.succeeded,
				skipped: progress.skipped,
				failed: progress.failed + 1,
				results: [
					{
						id: '',
						filename_disk: '',
						from: progress.from || '',
						to: target.value,
						status: 'failed',
						error: 'Cancelled by user',
					},
				],
				transferred_bytes: progress.transferredBytes,
				total_bytes: progress.totalBytes,
				elapsed_ms: progress.elapsedMs,
			};
		} else {
			result.value = {
				mode: mode.value,
				target_storage: target.value,
				total: progress.totalFiles,
				succeeded: progress.succeeded,
				skipped: progress.skipped,
				failed: Math.max(1, progress.failed),
				results: [
					{
						id: '',
						filename_disk: '',
						from: progress.from || '',
						to: target.value,
						status: 'failed',
						error: err?.response?.data?.errors?.[0]?.message || err?.message || 'Migration failed',
					},
				],
				transferred_bytes: progress.transferredBytes,
				total_bytes: progress.totalBytes,
				elapsed_ms: progress.elapsedMs,
			};
		}
	} finally {
		running.value = false;
		abortController = null;
	}
}
</script>

<style scoped>
.drawer-body {
	padding: 20px 24px 32px;
	display: flex;
	flex-direction: column;
	gap: 18px;
}

.intro {
	margin: 0;
	color: var(--theme--foreground);
}

.field {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.field label {
	font-weight: 600;
}

.mode-radios {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px;
}

.mode-radios :deep(.v-radio.block) {
	width: 100%;
	margin: 0;
}

.note {
	margin: 0;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}

.result {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.failures {
	display: flex;
	flex-direction: column;
	gap: 6px;
	max-height: 240px;
	overflow: auto;
	padding: 8px 0;
}

.fail-row {
	display: flex;
	flex-direction: column;
	gap: 2px;
	font-size: 12px;
	padding: 8px 10px;
	background: var(--theme--background-subdued);
	border-radius: var(--theme--border-radius);
}

.fail-row span {
	color: var(--theme--danger);
}
</style>
