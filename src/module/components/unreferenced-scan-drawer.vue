<template>
	<v-drawer
		:model-value="modelValue"
		title="Unreferenced Scan"
		icon="radar"
		persistent
		@update:model-value="onDrawerToggle"
		@cancel="close"
	>
		<div class="drawer-body">
			<p class="intro">
				Scanning the File Library for entries with no remaining references.
			</p>

			<v-notice v-if="jobRunning && jobBackgrounded" type="info">
				Scan continues in the background. You can close this drawer and navigate elsewhere in Studio.
			</v-notice>

			<v-notice v-else-if="otherJobRunning" type="warning">
				Another scan is already running in the background. Wait for it to finish or cancel it from the
				progress toast.
			</v-notice>

			<div v-if="(jobRunning && !jobBackgrounded) || localResult || localError" class="progress-panel">
				<div class="phase-line">
					<span class="phase">{{ phaseLabel }}</span>
					<span class="elapsed">{{ formatDuration(displayElapsed) }}</span>
				</div>

				<p class="message" :title="displayMessage">{{ displayMessage || 'Preparing…' }}</p>

				<div class="bar-wrap">
					<div class="bar-track">
						<div
							class="bar-fill"
							:class="{ indeterminate: !hasDeterminateProgress }"
							:style="hasDeterminateProgress ? { width: `${percent}%` } : undefined"
						/>
					</div>
					<div class="bar-meta">
						<strong v-if="hasDeterminateProgress">{{ percentRounded }}%</strong>
						<strong v-else>…</strong>
						<span v-if="progress.total > 0">
							{{ progress.current.toLocaleString() }} / {{ progress.total.toLocaleString() }}
						</span>
					</div>
				</div>

				<div class="counts">
					<span>Used ≈ {{ progress.used_count.toLocaleString() }}</span>
					<span>Unreferenced {{ progress.unreferenced_count.toLocaleString() }}</span>
				</div>
			</div>

			<div v-if="jobRunning && !jobBackgrounded" class="background-actions">
				<v-button secondary class="background-btn" @click="detachToBackground">
					Run in Background
				</v-button>
				<v-button kind="danger" secondary class="background-btn" @click="cancelScan">
					Cancel Scan
				</v-button>
				<p class="note">
					Closing this drawer also runs in the background. Click the progress toast anytime for details.
				</p>
			</div>

			<div v-if="localResult" class="result">
				<v-notice type="success" icon="check_circle">
					Scan complete —
					<strong>{{ localResult.unreferenced_count.toLocaleString() }}</strong> unreferenced
					<span v-if="localResult.unreferenced_bytes != null">
						· {{ formatBytes(localResult.unreferenced_bytes) }}
					</span>
					of {{ localResult.total_files.toLocaleString() }} files
					({{ formatDuration(localResult.elapsed_ms) }}).
				</v-notice>
				<div class="result-actions">
					<v-button @click="applyAndClose">View Results</v-button>
				</div>
			</div>

			<div v-else-if="localError" class="result">
				<v-notice type="danger" icon="error">{{ localError }}</v-notice>
				<div class="result-actions">
					<v-button secondary @click="close">Close</v-button>
				</div>
			</div>
		</div>
	</v-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatBytes, formatDuration } from '../../shared/format';
import {
	useUnreferencedScanJob,
	type UnreferencedScanMeta,
} from '../composables/use-unreferenced-scan-job';

const props = defineProps<{
	modelValue: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'done', meta: UnreferencedScanMeta): void;
}>();

const route = useRoute();
const router = useRouter();

const {
	running: jobRunning,
	backgrounded: jobBackgrounded,
	progress,
	result: jobResult,
	errorMessage,
	reopenNonce,
	returnToPath,
	runInBackground,
	attachForeground,
	cancel,
	clearLastResult,
} = useUnreferencedScanJob();

const localResult = ref<UnreferencedScanMeta | null>(null);
const localError = ref<string | null>(null);
const ownsForeground = ref(false);

const otherJobRunning = computed(
	() => jobRunning.value && !ownsForeground.value && !jobBackgrounded.value && !props.modelValue,
);

const displayMessage = computed(() => {
	if (localError.value) return localError.value;
	if (localResult.value) return 'Scan complete';
	return progress.message;
});

const displayElapsed = computed(() => {
	if (localResult.value) return localResult.value.elapsed_ms;
	return progress.elapsed_ms;
});

const phaseLabel = computed(() => {
	switch (progress.phase) {
		case 'relations':
			return 'Relations';
		case 'text':
			return 'Text fields';
		case 'files':
			return 'File Library';
		case 'finalize':
			return 'Finalizing';
		case 'done':
			return 'Done';
		case 'error':
			return 'Error';
		default:
			return 'Scan';
	}
});

const hasDeterminateProgress = computed(() => progress.total > 0 && progress.phase !== 'idle');

const percent = computed(() => {
	if (progress.total <= 0) return 0;
	return Math.max(0, Math.min(100, (progress.current / progress.total) * 100));
});

const percentRounded = computed(() => Math.round(percent.value));

function onDrawerToggle(open: boolean) {
	if (!open) {
		close();
		return;
	}
	emit('update:modelValue', true);
}

function detachToBackground() {
	runInBackground({
		returnTo: String(route.fullPath || '/storage-manager/unreferenced'),
		navigate: () => {
			const path = returnToPath.value || '/storage-manager/unreferenced';
			if (route.fullPath !== path) router.push(path);
			emit('update:modelValue', true);
		},
	});
	ownsForeground.value = false;
	emit('update:modelValue', false);
}

function cancelScan() {
	cancel();
}

function applyAndClose() {
	if (localResult.value) emit('done', localResult.value);
	clearLastResult();
	localResult.value = null;
	localError.value = null;
	emit('update:modelValue', false);
}

function close() {
	if (jobRunning.value && !jobBackgrounded.value && ownsForeground.value) {
		detachToBackground();
		return;
	}
	emit('update:modelValue', false);
}

watch(
	() => props.modelValue,
	(open) => {
		if (!open) {
			ownsForeground.value = false;
			return;
		}
		ownsForeground.value = true;
		attachForeground({
			onDone: (meta) => {
				localResult.value = meta;
				localError.value = null;
			},
			onError: (err) => {
				localError.value = err.message;
				localResult.value = null;
			},
			onCancel: () => {
				localError.value = 'Scan cancelled';
				localResult.value = null;
			},
		});
		if (jobResult.value && !jobRunning.value) {
			localResult.value = jobResult.value;
		}
		if (errorMessage.value && !jobRunning.value) {
			localError.value = errorMessage.value;
		}
	},
);

watch(reopenNonce, () => {
	emit('update:modelValue', true);
});

watch(jobResult, (meta) => {
	if (!meta || !props.modelValue || jobBackgrounded.value) return;
	localResult.value = meta;
});
</script>

<style scoped>
.drawer-body {
	padding: var(--content-padding);
	padding-block-end: 2rem;
}

.intro {
	margin: 0 0 1rem;
	line-height: 1.45;
	color: var(--theme--foreground);
}

.progress-panel {
	margin-block-start: 1rem;
	padding: 1rem;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
}

.phase-line {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 0.75rem;
	margin-block-end: 0.5rem;
}

.phase {
	font-size: 0.75rem;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--theme--foreground-subdued);
}

.elapsed {
	font-variant-numeric: tabular-nums;
	font-size: 0.85rem;
	color: var(--theme--foreground-subdued);
}

.message {
	margin: 0 0 0.85rem;
	font-size: 0.95rem;
	line-height: 1.4;
	color: var(--theme--foreground);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.bar-wrap {
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
}

.bar-track {
	height: 0.5rem;
	overflow: hidden;
	border-radius: 999px;
	background: var(--theme--background-normal);
}

.bar-fill {
	height: 100%;
	border-radius: 999px;
	background: var(--theme--primary);
	transition: width 0.2s ease;
}

.bar-fill.indeterminate {
	width: 35%;
	animation: scan-indeterminate 1.2s ease-in-out infinite;
}

@keyframes scan-indeterminate {
	0% {
		transform: translateX(-120%);
	}
	100% {
		transform: translateX(320%);
	}
}

.bar-meta {
	display: flex;
	justify-content: space-between;
	gap: 0.75rem;
	font-size: 0.8rem;
	color: var(--theme--foreground-subdued);
	font-variant-numeric: tabular-nums;
}

.counts {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem 1.25rem;
	margin-block-start: 0.85rem;
	font-size: 0.8rem;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}

.background-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin-block-start: 1.25rem;
}

.background-btn {
	flex: 0 0 auto;
}

.note {
	flex: 1 1 100%;
	margin: 0.35rem 0 0;
	font-size: 0.8rem;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}

.result {
	margin-block-start: 1.25rem;
}

.result-actions {
	display: flex;
	gap: 0.5rem;
	margin-block-start: 1rem;
}
</style>
