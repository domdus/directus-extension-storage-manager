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
			<template v-if="!jobRunning && !localResult">
				<v-button
					v-tooltip.bottom="confirmLabel"
					:disabled="!canSubmit"
					icon
					rounded
					@click="submit"
				>
					<v-icon name="check" />
				</v-button>
			</template>
		</template>

		<div class="drawer-body">
			<p class="intro">
				{{ summaryText }}
			</p>

			<v-notice v-if="jobRunning && jobBackgrounded" type="info">
				Transfer continues in the background. You can close this drawer and navigate elsewhere in Studio.
			</v-notice>

			<v-notice v-else-if="otherJobRunning" type="warning">
				Another migration is already running in the background. Wait for it to finish or cancel it from the
				progress toast.
			</v-notice>

			<template v-if="!jobRunning && !localResult">
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
				v-if="(jobRunning && !jobBackgrounded) || localResult"
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
				:is-done="Boolean(localResult) && !jobRunning"
				:is-cancelled="Boolean(localResult?.cancelled)"
			/>

			<div v-if="jobRunning && !jobBackgrounded" class="background-actions">
				<v-button secondary class="background-btn" @click="detachToBackground">
					Run in Background
				</v-button>
				<v-button kind="danger" secondary class="background-btn" @click="cancelTransfer">
					Cancel Transfer
				</v-button>
				<p class="note">
					Closing this drawer also runs in the background. Click the progress toast anytime for details.
				</p>
			</div>

			<div v-if="localResult" class="result">
				<v-notice v-if="localResult.cancelled" type="warning" icon="cancel">
					Migration cancelled.
					{{ localResult.succeeded.toLocaleString() }} file(s) finished before stop
					<span v-if="localResult.total">
						(of {{ localResult.total.toLocaleString() }} planned)</span
					>.
				</v-notice>
				<v-notice v-else :type="localResult.failed ? 'danger' : 'success'">
					{{ localResult.succeeded }} succeeded · {{ localResult.skipped }} skipped ·
					{{ localResult.failed }} failed (of {{ localResult.total }})
				</v-notice>
				<div v-if="!localResult.cancelled && failedRows.length" class="failures">
					<div v-for="row in failedRows.slice(0, 20)" :key="row.id" class="fail-row">
						<strong>{{ row.filename_disk || row.id }}</strong>
						<span>{{ row.error }}</span>
					</div>
				</div>
				<v-button secondary class="background-btn" @click="dismissResult">Done</v-button>
			</div>
		</div>
	</v-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMigrateJob } from '../composables/use-migrate-job';
import MigrateProgress from './migrate-progress.vue';
import type { MigrateMode, MigrateResponse, StorageLocationInfo } from '../../shared/types';
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

const route = useRoute();
const router = useRouter();

const {
	running: jobRunning,
	backgrounded: jobBackgrounded,
	progress,
	result: jobResult,
	activeMode,
	activeTarget,
	start,
	runInBackground,
	attachForeground,
	cancel: cancelJob,
	clearListeners,
	clearLastResult,
} = useMigrateJob();

const target = ref<string | null>(null);
const mode = ref<MigrateMode>('move');
const recursive = ref(true);
const localResult = ref<MigrateResponse | null>(null);
/** True when this drawer instance owns the in-foreground job. */
const ownsForegroundJob = ref(false);

const otherJobRunning = computed(
	() => jobRunning.value && !ownsForegroundJob.value && !jobBackgrounded.value && !props.modelValue,
);
const canSubmit = computed(() => Boolean(target.value) && !jobRunning.value);

function bindForegroundListeners() {
	attachForeground({
		onDone: (r) => {
			localResult.value = r;
			ownsForegroundJob.value = false;
			emit('done', r);
		},
		onCancel: (r) => {
			localResult.value = r;
			ownsForegroundJob.value = false;
		},
		onError: (err) => {
			localResult.value = {
				mode: (activeMode.value || mode.value) as MigrateMode,
				target_storage: activeTarget.value || target.value || '',
				total: progress.totalFiles,
				succeeded: progress.succeeded,
				skipped: progress.skipped,
				failed: Math.max(1, progress.failed),
				results: [
					{
						id: '',
						filename_disk: '',
						from: progress.from || '',
						to: activeTarget.value || target.value || '',
						status: 'failed',
						error: err.message || 'Migration failed',
					},
				],
				transferred_bytes: progress.transferredBytes,
				total_bytes: progress.totalBytes,
				elapsed_ms: progress.elapsedMs,
			};
			ownsForegroundJob.value = false;
		},
	});
	ownsForegroundJob.value = true;
	if (activeMode.value) mode.value = activeMode.value;
	if (activeTarget.value) target.value = activeTarget.value;
	if (jobResult.value) localResult.value = jobResult.value;
}

function showCompletedResult(res: MigrateResponse) {
	localResult.value = res;
	ownsForegroundJob.value = false;
	if (res.mode) mode.value = res.mode;
	if (res.target_storage) target.value = res.target_storage;
}

function resetToForm() {
	localResult.value = null;
	ownsForegroundJob.value = false;
	const first = props.storages.find((s) => s.location !== props.sourceStorage);
	target.value = first?.location || null;
	mode.value = 'move';
	recursive.value = true;
}

watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;

		// Live job → attach and show progress.
		if (jobRunning.value) {
			bindForegroundListeners();
			return;
		}

		// Finished in background (or while this drawer was open) → show summary, not empty form.
		if (jobResult.value) {
			showCompletedResult(jobResult.value);
			return;
		}

		resetToForm();
	},
);

// If the job completes while the drawer is already open, surface the result immediately.
watch(jobResult, (res) => {
	if (!props.modelValue || !res || jobRunning.value) return;
	showCompletedResult(res);
});

watch(jobRunning, (now, was) => {
	if (!props.modelValue || !was || now) return;
	if (jobResult.value) showCompletedResult(jobResult.value);
});

const targetChoices = computed(() =>
	props.storages
		.filter((s) => s.location !== props.sourceStorage)
		.map((s) => ({
			text: `${s.location} (${s.short})`,
			value: s.location,
		})),
);

const confirmLabel = computed(() => (mode.value === 'move' ? 'Move' : 'Copy'));

const summaryText = computed(() => {
	const count =
		localResult.value?.total ??
		(jobRunning.value && progress.totalFiles > 0 ? progress.totalFiles : null) ??
		props.estimatedCount ??
		props.fileIds?.length ??
		0;
	const byteValue =
		localResult.value?.total_bytes ??
		(jobRunning.value && progress.totalBytes > 0 ? progress.totalBytes : null) ??
		props.estimatedBytes;
	const bytes = byteValue != null ? ` (${formatBytes(byteValue)})` : '';
	const done = Boolean(localResult.value);

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

const failedRows = computed(() => (localResult.value?.results || []).filter((r) => r.status === 'failed'));

function onDrawerToggle(value: boolean) {
	if (!value && jobRunning.value && ownsForegroundJob.value && !jobBackgrounded.value) {
		// Closing the drawer while transferring = minimize to background toast.
		detachToBackground();
		return;
	}
	emit('update:modelValue', value);
}

function close() {
	if (jobRunning.value && ownsForegroundJob.value && !jobBackgrounded.value) {
		detachToBackground();
		return;
	}
	emit('update:modelValue', false);
}

function cancelTransfer() {
	cancelJob();
}

function dismissResult() {
	clearLastResult();
	localResult.value = null;
	emit('update:modelValue', false);
}

function detachToBackground() {
	const path = route.path.startsWith('/storage-manager') ? route.path : '/storage-manager';
	if (
		!runInBackground({
			returnTo: path,
			navigate: () => {
				router.push({ path, query: { ...route.query, migrateJob: '1' } });
			},
		})
	) {
		return;
	}
	ownsForegroundJob.value = false;
	emit('update:modelValue', false);
}

async function submit() {
	if (!target.value || jobRunning.value) return;

	localResult.value = null;
	ownsForegroundJob.value = true;

	const payload = {
		target_storage: target.value,
		mode: mode.value,
		concurrency: 1 as number,
		file_ids: undefined as string[] | undefined,
		source_storage: undefined as string | undefined,
		folder_id: undefined as string | null | undefined,
		recursive: undefined as boolean | undefined,
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

	try {
		await start(payload, {
			estimatedCount: props.estimatedCount || props.fileIds?.length || 0,
			estimatedBytes: props.estimatedBytes,
			sourceStorage: props.sourceStorage,
			listener: {
				onDone: (r) => {
					if (!ownsForegroundJob.value) return;
					localResult.value = r;
					emit('done', r);
				},
				onCancel: (r) => {
					if (ownsForegroundJob.value) localResult.value = r;
				},
				onError: (err) => {
					if (!ownsForegroundJob.value) return;
					localResult.value = {
						mode: mode.value,
						target_storage: target.value!,
						total: progress.totalFiles,
						succeeded: progress.succeeded,
						skipped: progress.skipped,
						failed: Math.max(1, progress.failed),
						results: [
							{
								id: '',
								filename_disk: '',
								from: progress.from || '',
								to: target.value!,
								status: 'failed',
								error: err.message || 'Migration failed',
							},
						],
						transferred_bytes: progress.transferredBytes,
						total_bytes: progress.totalBytes,
						elapsed_ms: progress.elapsedMs,
					};
				},
			},
		});
	} catch {
		// onError listener handles drawer UI
	} finally {
		ownsForegroundJob.value = false;
		clearListeners();
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

.background-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.background-actions .note {
	flex: 1 1 100%;
}

.result .background-btn {
	align-self: flex-start;
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
