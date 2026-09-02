<template>
	<v-drawer
		:model-value="modelValue"
		:title="drawerTitle"
		icon="undo"
		persistent
		@update:model-value="onDrawerToggle"
		@cancel="close"
	>
		<template #actions>
			<template v-if="!jobRunning && !localResult && !localError">
				<v-button v-tooltip.bottom="confirmLabel" icon rounded :loading="starting || jobRunning" @click="submit">
					<v-icon name="check" />
				</v-button>
			</template>
		</template>

		<div class="drawer-body">
			<p class="intro">{{ introText }}</p>
			<p v-if="!jobRunning && !localResult && !localError" class="description">{{ descriptionText }}</p>

			<v-notice v-if="jobRunning && jobBackgrounded" type="info">
				Restore continues in the background. You can close this drawer and navigate elsewhere in Studio.
			</v-notice>

			<v-notice v-else-if="otherJobRunning" type="warning">
				Another restore is already running in the background. Wait for it to finish or cancel it from the
				progress toast.
			</v-notice>

			<div v-if="showProgress" class="progress-panel">
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
					<span>Restored {{ progress.restored.toLocaleString() }}</span>
					<span v-if="progress.failed">Failed {{ progress.failed.toLocaleString() }}</span>
				</div>
			</div>

			<div v-if="jobRunning && !jobBackgrounded" class="background-actions">
				<v-button secondary class="background-btn" @click="detachToBackground">
					Run in Background
				</v-button>
				<v-button kind="danger" secondary class="background-btn" @click="cancelRestore">
					Cancel Restore
				</v-button>
				<p class="note">
					Closing this drawer also runs in the background. Click the progress toast anytime for details.
				</p>
			</div>

			<div v-else-if="!jobRunning && !localResult && !localError && !otherJobRunning" class="background-actions">
				<v-button :loading="starting || jobRunning" @click="submit">{{ confirmLabel }}</v-button>
			</div>

			<div v-if="localResult" class="result">
				<v-notice :type="localResult.cancelled ? 'warning' : 'success'" :icon="localResult.cancelled ? 'cancel' : 'check_circle'">
					<template v-if="localResult.cancelled">
						Cancelled —
						<strong>{{ localResult.restored.toLocaleString() }}</strong>
						of {{ localResult.total.toLocaleString() }} restored
					</template>
					<template v-else>
						Restored
						<strong>{{ localResult.restored.toLocaleString() }}</strong>
						file{{ localResult.restored === 1 ? '' : 's' }}
						to the File Library root
						<template v-if="localResult.failed">
							· {{ localResult.failed.toLocaleString() }} failed
						</template>
						({{ formatDuration(progress.elapsed_ms) }}).
					</template>
				</v-notice>
				<div class="result-actions">
					<v-button @click="applyAndClose">Done</v-button>
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
import { formatDuration } from '../../shared/format';
import {
	useRecycleRestoreJob,
	type RecycleRestoreResult,
} from '../composables/use-recycle-restore-job';

const props = defineProps<{
	modelValue: boolean;
	/** Limit restore to one storage adapter. Omit / null = entire Recycle Bin. */
	storage?: string | null;
	estimatedCount?: number;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'done', result: RecycleRestoreResult): void;
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
	start,
	runInBackground,
	attachForeground,
	cancel,
	clearLastResult,
} = useRecycleRestoreJob();

const localResult = ref<RecycleRestoreResult | null>(null);
const localError = ref<string | null>(null);
const ownsForeground = ref(false);
const starting = ref(false);

const otherJobRunning = computed(
	() => jobRunning.value && !ownsForeground.value && !jobBackgrounded.value && !props.modelValue,
);

const drawerTitle = computed(() =>
	props.storage ? `Restore All on ${props.storage}` : 'Restore All from Recycle',
);

const confirmLabel = computed(() => {
	const n = Number(props.estimatedCount) || 0;
	if (n > 0) return `Restore ${n.toLocaleString()}`;
	return 'Restore All';
});

const introText = computed(() => {
	const n = Number(props.estimatedCount) || 0;
	const count = n > 0 ? ` — ${n.toLocaleString()} file${n === 1 ? '' : 's'}` : '';
	if (props.storage) {
		return `Restore every Recycle file on ${props.storage}${count} to the File Library root.`;
	}
	return `Restore every file in Recycle Bin${count} to the File Library root.`;
});

const descriptionText = computed(() => {
	const scope = props.storage
		? `All Recycle files on ${props.storage} — not only the current page or filters.`
		: 'The entire Recycle Bin — not only the current page.';
	return `${scope} Objects stay at their original storage keys. Folder and trash stamp are cleared. Thumbnails were removed when files went into Recycle and regenerate on the next request.`;
});

const displayMessage = computed(() => {
	if (localError.value) return localError.value;
	if (localResult.value) {
		return localResult.value.cancelled ? 'Restore cancelled' : 'Restore complete';
	}
	return progress.message;
});

const displayElapsed = computed(() => progress.elapsed_ms);

const phaseLabel = computed(() => {
	switch (progress.phase) {
		case 'prepare':
			return 'Preparing';
		case 'restore':
			return 'Restoring';
		case 'done':
			return 'Done';
		case 'error':
			return 'Error';
		default:
			return 'Restore';
	}
});

const restoreFinished = computed(
	() => Boolean(localResult.value) || progress.phase === 'done' || progress.phase === 'error',
);

const showProgress = computed(
	() => (jobRunning.value && !jobBackgrounded.value) || Boolean(localResult.value) || Boolean(localError.value),
);

const hasDeterminateProgress = computed(
	() => restoreFinished.value || (progress.total > 0 && progress.phase !== 'idle'),
);

const percent = computed(() => {
	if (restoreFinished.value) return 100;
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
		returnTo: String(route.fullPath || '/storage-manager/recycle'),
		navigate: () => {
			const path = returnToPath.value || '/storage-manager/recycle';
			if (route.fullPath !== path) router.push(path);
			emit('update:modelValue', true);
		},
	});
	ownsForeground.value = false;
	emit('update:modelValue', false);
}

function cancelRestore() {
	cancel();
}

async function submit() {
	if (jobRunning.value || starting.value) return;
	starting.value = true;
	localResult.value = null;
	localError.value = null;
	try {
		const data = await start(
			{ storage: props.storage ?? null },
			{
				listener: {
					onDone: (meta) => {
						localResult.value = meta;
						localError.value = null;
					},
					onError: (err) => {
						localError.value = err.message;
						localResult.value = null;
					},
					onCancel: (partial) => {
						localResult.value = partial;
						localError.value = partial ? null : 'Restore cancelled';
					},
				},
			},
		);
		if (data) localResult.value = data;
	} catch (err: any) {
		if (err?.name !== 'AbortError') {
			localError.value = err?.message || 'Restore failed';
		}
	} finally {
		starting.value = false;
	}
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
			onCancel: (partial) => {
				localResult.value = partial;
				localError.value = partial ? null : 'Restore cancelled';
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
	margin: 0 0 0.75rem;
	line-height: 1.45;
	color: var(--theme--foreground);
}

.description {
	margin: 0 0 1rem;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
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
	animation: restore-indeterminate 1.2s ease-in-out infinite;
}

@keyframes restore-indeterminate {
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
