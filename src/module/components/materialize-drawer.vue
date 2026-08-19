<template>
	<v-drawer
		:model-value="modelValue"
		title="Materialize Folder"
		icon="account_tree"
		:persistent="running"
		@update:model-value="(value:boolean) => emit('update:modelValue', value)"
		@cancel="emit('update:modelValue', false)"
	>
		<div class="drawer-body">
			<p class="intro">
				Materialize virtual Directus folders into real storage paths.
			</p>

			<div class="field">
				<label>Storage Mode</label>
				<div class="mode-cards">
					<div
						class="mode-card"
						:class="{ active: mode === 'preserve' }"
						@click="mode = 'preserve'"
					>
						<div class="mode-card-header">
							<v-icon name="devices" small />
							<strong>Keep</strong>
						</div>
						<p class="mode-card-desc">Each file stays on its current storage. Only the folder path is created there.</p>
						<p class="mode-card-example">
							<em>Example:</em> photo.jpg on <code>s3</code> → moved to <code>s3/travel/paris/photo.jpg</code>. A file on <code>local</code> stays on <code>local</code>.
						</p>
					</div>
					<div
						class="mode-card"
						:class="{ active: mode === 'merge' }"
						@click="mode = 'merge'"
					>
						<div class="mode-card-header">
							<v-icon name="merge" small />
							<strong>Merge</strong>
						</div>
						<p class="mode-card-desc">All files are moved into one target storage, placed at their virtual folder path.</p>
						<p class="mode-card-example">
							<em>Example:</em> Files from both <code>s3</code> and <code>local</code> end up on <code>local2/travel/paris/</code>.
						</p>
					</div>
				</div>
			</div>

			<div v-if="mode === 'merge'" class="field">
				<label>Target Storage</label>
				<v-select v-model="target" :items="targetChoices" item-text="text" item-value="value" />
			</div>

			<div v-if="mode === 'preserve'" class="field">
				<v-checkbox v-model="structureOnly" label="Build Storage Folder Structure only (don't move files)" />
			</div>

			<div class="field">
				<v-checkbox v-model="recursive" label="Include subfolders" />
			</div>

			<div class="actions">
				<v-button secondary :loading="dryRunning" :disabled="running" @click="runDryRun">Dry Run</v-button>
				<v-button v-if="!running" :disabled="!canRun" :loading="running" @click="runMaterialize">Run</v-button>
				<v-button v-else kind="danger" secondary @click="cancelRun">Cancel</v-button>
			</div>

			<v-notice v-if="error" type="danger">{{ error }}</v-notice>

			<div v-if="dryRun" class="result">
				<p><strong>Files:</strong> {{ dryRun.total_files.toLocaleString() }}</p>
				<p v-if="dryRun.total_folders > 0"><strong>Folders:</strong> {{ dryRun.total_folders.toLocaleString() }}</p>
				<p><strong>Total Size:</strong> {{ formatBytes(dryRun.total_bytes || 0) }}</p>
				<p v-if="dryRun.conflicts > 0">
					<strong>Path conflicts:</strong> {{ dryRun.conflicts.toLocaleString() }}
				</p>
				<p v-if="dryRun.conflicts > 0" class="note">
					A destination path already exists on disk, or two files would use the same path.
				</p>
				<p>
					<strong>{{ dryRun.mode === 'merge' ? 'Will be written to' : 'Stay on current storage' }}:</strong>
				</p>
				<ul v-if="dryRun.by_storage.length" class="by-storage">
					<li v-for="row in dryRun.by_storage" :key="row.storage">{{ row.storage }}</li>
				</ul>
				<p v-else class="empty-storage">No files in this folder.</p>
			</div>

			<div v-if="result" class="result">
				<v-notice :type="result.failed ? 'danger' : 'success'">
					{{ result.succeeded }} succeeded · {{ result.skipped }} skipped · {{ result.failed }} failed (of
					{{ result.total }})
				</v-notice>
			</div>

			<migrate-progress
				v-if="running || result"
				:storages="storages"
				mode="move"
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
				:is-cancelled="cancelled"
			/>
		</div>
	</v-drawer>
</template>

<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { computed, ref } from 'vue';
import { formatBytes } from '../../shared/format';
import type { MaterializeDryRunResponse, MigrateProgressEvent, StorageLocationInfo } from '../../shared/types';
import MigrateProgress from './migrate-progress.vue';

const props = defineProps<{
	modelValue: boolean;
	storages: StorageLocationInfo[];
	folderId: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'done'): void;
}>();

const api = useApi();
const mode = ref<'preserve' | 'merge'>('preserve');
const target = ref<string | null>(null);
const structureOnly = ref(false);
const recursive = ref(true);
const dryRunning = ref(false);
const running = ref(false);
const cancelled = ref(false);
const error = ref<string | null>(null);
const dryRun = ref<MaterializeDryRunResponse | null>(null);
const result = ref<{ total: number; succeeded: number; skipped: number; failed: number } | null>(null);
const controller = ref<AbortController | null>(null);
const startedAt = ref(0);
const progress = ref({
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

const targetChoices = computed(() =>
	props.storages.map((s) => ({
		text: `${s.location} (${s.short})`,
		value: s.location,
	})),
);

const canRun = computed(() => mode.value !== 'merge' || Boolean(target.value));

async function runDryRun() {
	error.value = null;
	dryRunning.value = true;
	try {
		const res = await api.post('/storage-manager/materialize/dry-run', {
			folder_id: props.folderId ?? null,
			mode: mode.value,
			target_storage: mode.value === 'merge' ? target.value : undefined,
			structure_only: structureOnly.value,
			recursive: recursive.value,
		});
		dryRun.value = res.data?.data || null;
	} catch (err: any) {
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Dry run failed';
	} finally {
		dryRunning.value = false;
	}
}

async function runMaterialize() {
	if (!canRun.value) return;
	error.value = null;
	running.value = true;
	cancelled.value = false;
	startedAt.value = Date.now();
	progress.value = {
		from: null,
		to: mode.value === 'merge' ? String(target.value || '') : 'preserve',
		currentIndex: 0,
		totalFiles: dryRun.value?.total_files || 0,
		currentName: '',
		transferredBytes: 0,
		totalBytes: dryRun.value?.total_bytes || 0,
		elapsedMs: 0,
		speedBps: 0,
		succeeded: 0,
		skipped: 0,
		failed: 0,
	};
	try {
		controller.value = new AbortController();
		const response = await fetch('/storage-manager/materialize/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
			credentials: 'same-origin',
			signal: controller.value.signal,
			body: JSON.stringify({
				folder_id: props.folderId ?? null,
				mode: mode.value,
				target_storage: mode.value === 'merge' ? target.value : undefined,
				structure_only: structureOnly.value,
				keep_source_file_on_disk: false,
				recursive: recursive.value,
			}),
		});
		await parseStream(response, applyProgress);
		emit('done');
	} catch (err: any) {
		if (err?.name === 'AbortError') {
			cancelled.value = true;
		} else {
			error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Materialize failed';
		}
	} finally {
		running.value = false;
		controller.value = null;
	}
}

function cancelRun() {
	controller.value?.abort();
}

function applyProgress(event: MigrateProgressEvent) {
	const elapsedMs = Date.now() - startedAt.value;
	if (event.type === 'start') {
		progress.value.from = event.from || null;
		progress.value.to = event.to;
		progress.value.totalFiles = event.total;
		progress.value.totalBytes = event.total_bytes;
		return;
	}
	if (event.type === 'file_start') {
		progress.value.currentIndex = event.index;
		progress.value.currentName = event.name;
		return;
	}
	if (event.type === 'file_done') {
		progress.value.currentIndex = event.index;
		progress.value.currentName = event.name;
		progress.value.succeeded = event.succeeded;
		progress.value.skipped = event.skipped;
		progress.value.failed = event.failed;
		progress.value.transferredBytes = event.transferred_bytes;
		progress.value.totalBytes = event.total_bytes;
		progress.value.elapsedMs = event.elapsed_ms;
		progress.value.speedBps = event.elapsed_ms > 0 ? (event.transferred_bytes * 1000) / event.elapsed_ms : 0;
		return;
	}
	if (event.type === 'done') {
		result.value = {
			total: event.data.total,
			succeeded: event.data.succeeded,
			skipped: event.data.skipped,
			failed: event.data.failed,
		};
		progress.value.currentIndex = event.data.total;
		progress.value.succeeded = event.data.succeeded;
		progress.value.skipped = event.data.skipped;
		progress.value.failed = event.data.failed;
		progress.value.transferredBytes = event.data.transferred_bytes || progress.value.transferredBytes;
		progress.value.totalBytes = event.data.total_bytes || progress.value.totalBytes;
		progress.value.elapsedMs = event.data.elapsed_ms || elapsedMs;
		progress.value.speedBps =
			progress.value.elapsedMs > 0
				? (progress.value.transferredBytes * 1000) / progress.value.elapsedMs
				: 0;
	}
}

async function parseStream(response: Response, onEvent: (event: MigrateProgressEvent) => void): Promise<void> {
	if (!response.ok) {
		let message = `Materialize failed (${response.status})`;
		try {
			const json = await response.json();
			message = json?.errors?.[0]?.message || message;
		} catch {
			// ignore
		}
		throw new Error(message);
	}
	if (!response.body) throw new Error('No response body for materialize stream');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const chunks = buffer.split('\n\n');
		buffer = chunks.pop() || '';
		for (const chunk of chunks) {
			for (const line of chunk.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) continue;
				const payload = trimmed.slice(5).trim();
				if (!payload) continue;
				let event: MigrateProgressEvent;
				try {
					event = JSON.parse(payload) as MigrateProgressEvent;
				} catch {
					continue;
				}
				onEvent(event);
				if (event.type === 'error') throw new Error(event.message || 'Materialize failed');
			}
		}
	}
}
</script>

<style scoped>
.drawer-body { padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.note { margin: 0; font-size: 12px; color: var(--theme--foreground-subdued); }
.actions { display: flex; gap: 8px; }
.result { padding: 10px; border-radius: var(--theme--border-radius); background: var(--theme--background-subdued); }
.by-storage { margin: 4px 0 0; padding-left: 18px; }
.empty-storage { margin: 4px 0 0; color: var(--theme--foreground-subdued); }

.mode-cards {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px;
}

.mode-card {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 12px 14px;
	border-radius: var(--theme--border-radius);
	border: 2px solid var(--theme--border-color);
	cursor: pointer;
	transition: border-color 0.15s, background 0.15s;
}

.mode-card:hover {
	border-color: var(--theme--primary);
}

.mode-card.active {
	border-color: var(--theme--primary);
	background: var(--theme--primary-background);
}

.mode-card-header {
	display: flex;
	align-items: center;
	gap: 6px;
}

.mode-card-desc {
	margin: 0;
	font-size: 13px;
	color: var(--theme--foreground);
}

.mode-card-example {
	margin: 0;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
	line-height: 1.4;
}

.mode-card-example code {
	font-family: var(--theme--fonts--mono--font-family, monospace);
	font-size: 11px;
	background: var(--theme--background-subdued);
	padding: 1px 4px;
	border-radius: 3px;
}
</style>
