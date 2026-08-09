<template>
	<v-drawer
		:model-value="modelValue"
		:title="`Detect files on ${location}`"
		icon="folder_off"
		@update:model-value="$emit('update:modelValue', $event)"
		@cancel="close"
	>
		<template #actions>
			<v-button
				v-tooltip.bottom="'Import all unknown files'"
				icon
				rounded
				:disabled="!orphans.length || importing || scanning"
				:loading="importing"
				@click="askConfirm"
			>
				<v-icon name="download" />
			</v-button>
		</template>

		<div class="body">
			<p class="intro">
				Scans storage <strong>{{ location }}</strong> for objects on disk that are not in
				<code>directus_files</code> (by <code>filename_disk</code>). Import keeps the exact
				<code>filename_disk</code> and sets <code>title</code> from the name with
				<code>_</code> → spaces. Files are not copied — only DB rows are created.
				Generated Directus image transforms/thumbnails are excluded automatically (filenames ending in
				<code>__{hash}</code> or <code>__{hash}.ext</code>, from
				<code>AssetsService</code> / <code>getAssetSuffix</code>).
			</p>

			<div class="toolbar">
				<v-button secondary :loading="scanning" @click="scan">
					<v-icon name="radar" left />
					Scan disk
				</v-button>
				<v-button
					:disabled="!orphans.length || importing || scanning"
					:loading="importing"
					@click="askConfirm"
				>
					Import {{ orphans.length || '' }} new file{{ orphans.length === 1 ? '' : 's' }}
				</v-button>
			</div>

			<p v-if="meta" class="meta">
				Scanned {{ meta.scanned.toLocaleString() }} disk objects ·
				{{ meta.known.toLocaleString() }} already in DB ·
				{{ meta.orphan_count.toLocaleString() }} unknown
			</p>

			<div v-if="scanning" class="loading">
				<v-progress-circular indeterminate />
				<span>Listing storage…</span>
			</div>

			<p v-else-if="error" class="error">{{ error }}</p>

			<p v-else-if="scannedOnce && !orphans.length" class="empty">
				No unknown files on this storage. Everything on disk is already in the database.
			</p>

			<div v-else-if="orphans.length" class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>filename_disk</th>
							<th>Title (will be)</th>
							<th>Type</th>
							<th>Size</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="row in orphans" :key="row.filename_disk">
							<td class="name" :title="row.filename_disk">{{ row.filename_disk }}</td>
							<td class="title-cell" :title="row.title">{{ row.title }}</td>
							<td>{{ row.type || '—' }}</td>
							<td>{{ formatBytes(row.filesize) }}</td>
						</tr>
					</tbody>
				</table>
			</div>

			<div v-if="lastResult" class="result" :class="lastResult.failed ? 'has-fail' : 'ok'">
				Imported {{ lastResult.imported }} · skipped {{ lastResult.skipped }} · failed {{ lastResult.failed }}
			</div>
		</div>
	</v-drawer>

	<v-dialog :model-value="confirmOpen" @update:model-value="confirmOpen = $event" @esc="confirmOpen = false">
		<v-card>
			<v-card-title>Import new files?</v-card-title>
			<v-card-text>
				Do you want to import
				<strong>{{ orphans.length.toLocaleString() }}</strong>
				new file{{ orphans.length === 1 ? '' : 's' }} into storage
				<strong>{{ location }}</strong>?
				<br /><br />
				Each file keeps its exact <code>filename_disk</code>. Titles are generated from the
				filename with underscores replaced by spaces (extension stripped).
			</v-card-text>
			<v-card-actions>
				<v-button secondary :disabled="importing" @click="confirmOpen = false">Cancel</v-button>
				<v-button :loading="importing" @click="confirmImport">
					Import {{ orphans.length.toLocaleString() }}
				</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { formatBytes } from '../../shared/format';

type OrphanRow = {
	filename_disk: string;
	filesize: number;
	type: string | null;
	suggested_id: string | null;
	filename_download: string;
	title: string;
};

const props = defineProps<{
	modelValue: boolean;
	location: string;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'imported'): void;
}>();

const api = useApi();

const scanning = ref(false);
const importing = ref(false);
const confirmOpen = ref(false);
const scannedOnce = ref(false);
const error = ref<string | null>(null);
const orphans = ref<OrphanRow[]>([]);
const meta = ref<{ scanned: number; known: number; orphan_count: number } | null>(null);
const lastResult = ref<{ imported: number; skipped: number; failed: number } | null>(null);

watch(
	() => props.modelValue,
	(open) => {
		if (open) {
			lastResult.value = null;
			error.value = null;
			confirmOpen.value = false;
			scan();
		}
	},
);

function close() {
	confirmOpen.value = false;
	emit('update:modelValue', false);
}

function askConfirm() {
	if (!orphans.value.length || importing.value) return;
	confirmOpen.value = true;
}

async function scan() {
	if (!props.location) return;
	scanning.value = true;
	error.value = null;
	try {
		const res = await api.get(`/storage-manager/storages/${encodeURIComponent(props.location)}/orphans`);
		orphans.value = (res.data?.data || []) as OrphanRow[];
		meta.value = res.data?.meta || null;
		scannedOnce.value = true;
	} catch (e: any) {
		error.value = e?.response?.data?.errors?.[0]?.message || e?.message || String(e);
		orphans.value = [];
		meta.value = null;
	} finally {
		scanning.value = false;
	}
}

async function confirmImport() {
	if (!orphans.value.length) return;
	importing.value = true;
	error.value = null;
	try {
		const res = await api.post(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/import-orphans`,
			{ filename_disks: orphans.value.map((o) => o.filename_disk) },
		);
		const data = res.data?.data;
		lastResult.value = {
			imported: Number(data?.imported || 0),
			skipped: Number(data?.skipped || 0),
			failed: Number(data?.failed || 0),
		};
		confirmOpen.value = false;
		emit('imported');
		await scan();
	} catch (e: any) {
		error.value = e?.response?.data?.errors?.[0]?.message || e?.message || String(e);
		confirmOpen.value = false;
	} finally {
		importing.value = false;
	}
}
</script>

<style scoped>
.body {
	padding: 0 24px 24px;
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.intro {
	margin: 0;
	line-height: 1.45;
	color: var(--theme--foreground);
	font-size: 13px;
}

.intro code,
.v-card-text code {
	font-size: 12px;
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.meta,
.empty {
	margin: 0;
	font-size: 13px;
	color: var(--theme--foreground-subdued);
}

.loading {
	display: flex;
	align-items: center;
	gap: 10px;
	color: var(--theme--foreground-subdued);
}

.error {
	margin: 0;
	color: var(--theme--danger);
	font-size: 13px;
}

.table-wrap {
	overflow: auto;
	max-height: 50vh;
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
}

table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
}

th,
td {
	padding: 8px 10px;
	text-align: left;
	border-bottom: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

th {
	font-weight: 700;
	background: var(--theme--background-subdued);
	position: sticky;
	top: 0;
}

.name {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	max-width: 280px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.title-cell {
	max-width: 240px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.result {
	padding: 10px 12px;
	border-radius: var(--theme--border-radius);
	font-size: 13px;
	font-weight: 600;
}

.result.ok {
	background: color-mix(in srgb, var(--theme--success) 16%, transparent);
	color: var(--theme--success);
}

.result.has-fail {
	background: color-mix(in srgb, var(--theme--warning) 16%, transparent);
	color: var(--theme--warning);
}
</style>
