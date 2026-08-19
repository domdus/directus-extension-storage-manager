<template>
	<v-drawer
		:model-value="modelValue"
		:title="drawerTitle"
		icon="folder_off"
		@update:model-value="$emit('update:modelValue', $event)"
		@cancel="close"
	>
		<template #actions>
			<v-button
				v-if="selected.length"
				v-tooltip.bottom="'Delete Selected from Storage'"
				icon
				rounded
				secondary
				:disabled="deleting || scanning"
				:loading="deleting"
				@click="askDeleteConfirm"
			>
				<v-icon name="delete" />
			</v-button>
			<v-button
				v-tooltip.bottom="'Import All Unknown Files'"
				icon
				rounded
				:disabled="!orphans.length || importing || scanning || deleting"
				:loading="importing"
				@click="askConfirm"
			>
				<v-icon name="download" />
			</v-button>
		</template>

		<div class="body">
			<p class="intro">
				<template v-if="scopedPath">
					Finds files under <strong>{{ scopedPath }}</strong> on
					<strong>{{ location }}</strong> that aren’t registered in Directus yet.
				</template>
				<template v-else>
					Finds files on <strong>{{ location }}</strong> that aren’t registered in Directus yet.
				</template>
			Import only creates database rows — nothing is copied. Titles come from the filename
			(underscores become spaces). You can delete selected unknown files from storage.
			Generated thumbnails are excluded.
			</p>

			<div class="toolbar">
				<v-button secondary :loading="scanning" :disabled="deleting" @click="scan">
					<v-icon name="radar" left />
					{{ scopedPath ? 'Scan Folder' : 'Scan Storage' }}
				</v-button>
				<v-button
					:disabled="!orphans.length || importing || scanning || deleting"
					:loading="importing"
					@click="askConfirm"
				>
					Import {{ orphans.length || '' }} New File{{ orphans.length === 1 ? '' : 's' }}
				</v-button>
				<v-button
					secondary
					:disabled="!selected.length || importing || scanning || deleting"
					:loading="deleting"
					@click="askDeleteConfirm"
				>
					<v-icon name="delete" left />
					Delete Selected ({{ selected.length }})
				</v-button>
			</div>

			<p v-if="meta" class="meta">
				Scanned {{ meta.scanned.toLocaleString() }} objects ·
				{{ meta.known.toLocaleString() }} already in DB ·
				{{ meta.orphan_count.toLocaleString() }} unknown
			</p>

			<div v-if="scanning" class="loading">
				<v-progress-circular indeterminate />
				<span>Listing storage…</span>
			</div>

			<p v-else-if="error" class="error">{{ error }}</p>

			<p v-else-if="scannedOnce && !orphans.length" class="empty">
				<template v-if="scopedPath">
					No unknown files in this folder. Everything here is already in the database.
				</template>
				<template v-else>
					No unknown files on this storage. Everything here is already in the database.
				</template>
			</p>

			<div v-else-if="orphans.length" class="table-wrap">
				<table>
					<thead>
						<tr>
							<th class="check-col">
								<v-checkbox :model-value="allSelected" @update:model-value="toggleSelectAll" />
							</th>
							<th>filename_disk</th>
							<th>Type</th>
							<th>Size</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="row in orphans" :key="row.filename_disk">
							<td class="check-col">
								<v-checkbox
									:model-value="selected.includes(row.filename_disk)"
									@update:model-value="(checked) => toggleRow(row.filename_disk, checked)"
								/>
							</td>
							<td class="name" :title="row.filename_disk">{{ row.filename_disk }}</td>
							<td>{{ row.type || '—' }}</td>
							<td>{{ formatBytes(row.filesize) }}</td>
						</tr>
					</tbody>
				</table>
			</div>

			<div v-if="lastDeleteResult" class="result" :class="lastDeleteResult.failed ? 'has-fail' : 'ok'">
				Deleted {{ lastDeleteResult.deleted }} · skipped {{ lastDeleteResult.skipped }} · failed
				{{ lastDeleteResult.failed }}
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
				filename with underscores replaced by spaces (extension stripped). Image width and
				height are read from the file so thumbnails can be generated.
			</v-card-text>
			<v-card-actions>
				<v-button secondary :disabled="importing" @click="confirmOpen = false">Cancel</v-button>
				<v-button :loading="importing" @click="confirmImport">
					Import {{ orphans.length.toLocaleString() }}
				</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>

	<v-dialog
		:model-value="deleteConfirmOpen"
		@update:model-value="deleteConfirmOpen = $event"
		@esc="deleteConfirmOpen = false"
	>
		<v-card>
			<v-card-title>Delete from Storage?</v-card-title>
			<v-card-text>
				Permanently delete
				<strong>{{ selected.length.toLocaleString() }}</strong>
				file{{ selected.length === 1 ? '' : 's' }} from storage
				<strong>{{ location }}</strong>?
				<br /><br />
				Only unregistered files are removed. Generated thumbnails are not deleted.
			</v-card-text>
			<v-card-actions>
				<v-button secondary :disabled="deleting" @click="deleteConfirmOpen = false">Cancel</v-button>
				<v-button kind="danger" :loading="deleting" @click="confirmDelete">
					Delete {{ selected.length.toLocaleString() }}
				</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
	/** When set, scan only under this physical storage path (and its subfolders). */
	storagePath?: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
	(e: 'imported'): void;
}>();

const api = useApi();

const scanning = ref(false);
const importing = ref(false);
const deleting = ref(false);
const confirmOpen = ref(false);
const deleteConfirmOpen = ref(false);
const scannedOnce = ref(false);
const error = ref<string | null>(null);
const orphans = ref<OrphanRow[]>([]);
const selected = ref<string[]>([]);
const meta = ref<{ scanned: number; known: number; orphan_count: number; path?: string | null } | null>(null);
const lastResult = ref<{ imported: number; skipped: number; failed: number } | null>(null);
const lastDeleteResult = ref<{ deleted: number; skipped: number; failed: number } | null>(null);

const scopedPath = computed(() => {
	const path = String(props.storagePath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\/+/g, '/');
	return path || '';
});

const drawerTitle = computed(() =>
	scopedPath.value ? 'Detect Files in this Folder' : `Detect Files on ${props.location}`,
);

const allSelected = computed(
	() => orphans.value.length > 0 && selected.value.length === orphans.value.length,
);

watch(
	() => props.modelValue,
	(open) => {
		if (open) {
			lastResult.value = null;
			lastDeleteResult.value = null;
			error.value = null;
			confirmOpen.value = false;
			deleteConfirmOpen.value = false;
			scan();
		}
	},
);

function close() {
	confirmOpen.value = false;
	deleteConfirmOpen.value = false;
	emit('update:modelValue', false);
}

function toggleSelectAll(checked: boolean) {
	selected.value = checked ? orphans.value.map((o) => o.filename_disk) : [];
}

function toggleRow(filename_disk: string, checked: boolean) {
	if (checked) {
		if (!selected.value.includes(filename_disk)) {
			selected.value = [...selected.value, filename_disk];
		}
	} else {
		selected.value = selected.value.filter((name) => name !== filename_disk);
	}
}

function askConfirm() {
	if (!orphans.value.length || importing.value || deleting.value) return;
	confirmOpen.value = true;
}

function askDeleteConfirm() {
	if (!selected.value.length || importing.value || deleting.value) return;
	deleteConfirmOpen.value = true;
}

async function scan() {
	if (!props.location) return;
	scanning.value = true;
	error.value = null;
	try {
		const res = await api.get(`/storage-manager/storages/${encodeURIComponent(props.location)}/orphans`, {
			params: scopedPath.value ? { path: scopedPath.value } : undefined,
		});
		orphans.value = (res.data?.data || []) as OrphanRow[];
		meta.value = res.data?.meta || null;
		scannedOnce.value = true;
		selected.value = [];
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

async function confirmDelete() {
	if (!selected.value.length) return;
	deleting.value = true;
	error.value = null;
	const toDelete = [...selected.value];
	try {
		const res = await api.post(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/delete-orphans`,
			{ filename_disks: toDelete },
		);
		const data = res.data?.data;
		lastDeleteResult.value = {
			deleted: Number(data?.deleted || 0),
			skipped: Number(data?.skipped || 0),
			failed: Number(data?.failed || 0),
		};
		lastResult.value = null;
		deleteConfirmOpen.value = false;
		emit('imported');
		await scan();
	} catch (e: any) {
		error.value = e?.response?.data?.errors?.[0]?.message || e?.message || String(e);
		deleteConfirmOpen.value = false;
	} finally {
		deleting.value = false;
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

.check-col {
	width: 36px;
	padding-left: 8px;
	padding-right: 4px;
	vertical-align: middle;
}

.check-col :deep(.v-checkbox) {
	margin: 0;
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
