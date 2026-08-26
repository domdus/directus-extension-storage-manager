<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import type { RootFileView } from '../composables/use-root-file-view';

const props = defineProps<{
	modelValue: RootFileView;
	location: string;
	search?: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: RootFileView): void;
	(e: 'deleted'): void;
}>();

const api = useApi();

const view = computed({
	get: () => props.modelValue,
	set: (value: RootFileView) => emit('update:modelValue', value),
});

const viewOptions = [
	{ value: 'files' as const, label: 'Show Files' },
	{ value: 'transforms' as const, label: 'Show Thumbnails' },
];

const filtered = computed(() => view.value !== 'files');

const confirmOpen = ref(false);
const counting = ref(false);
const deleting = ref(false);
const dryRun = ref<{ deleted: number; skipped: number; scanned: number; capped?: boolean } | null>(null);
const countError = ref('');

async function loadDryRun() {
	counting.value = true;
	countError.value = '';
	dryRun.value = null;
	try {
		const res = await api.post(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/root-transforms/delete-all`,
			{ dry_run: true, search: props.search || null },
		);
		const data = res.data?.data;
		dryRun.value = {
			deleted: Number(data?.deleted) || 0,
			skipped: Number(data?.skipped) || 0,
			scanned: Number(data?.scanned) || 0,
		};
	} catch (err: any) {
		countError.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Could not scan transforms';
	} finally {
		counting.value = false;
	}
}

function openConfirm() {
	confirmOpen.value = true;
	void loadDryRun();
}

watch(confirmOpen, (open) => {
	if (!open) {
		dryRun.value = null;
		countError.value = '';
	}
});

async function confirmDelete() {
	if (deleting.value) return;
	deleting.value = true;
	try {
		await api.post(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/root-transforms/delete-all`,
			{ dry_run: false, search: props.search || null },
		);
		confirmOpen.value = false;
		emit('deleted');
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed');
	} finally {
		deleting.value = false;
	}
}

const confirmMessage = computed(() => {
	if (counting.value) return '';
	if (countError.value) return '';
	if (!dryRun.value) return '';

	const { deleted, skipped } = dryRun.value;
	const scope = props.search?.trim() ? 'matching your search' : 'at the storage root';

	if (deleted === 0) {
		return `No generated transform files ${scope} would be deleted.${skipped ? ` ${skipped.toLocaleString()} registered file(s) would be skipped.` : ''}`;
	}

	return `${deleted.toLocaleString()} generated transform file${deleted === 1 ? '' : 's'} ${scope} will be removed.${skipped ? ` ${skipped.toLocaleString()} registered match(es) will be skipped.` : ''}`;
});
</script>

<template>
	<sidebar-detail id="thumbnails" icon="photo_size_select_large" title="Thumbnails" :badge="filtered">
		<div class="fields">
			<div class="field full">
				<v-radio
					v-for="option in viewOptions"
					:key="option.value"
					:value="option.value"
					:label="option.label"
					:model-value="view"
					@update:model-value="view = $event"
				/>
			</div>

			<div class="field full delete-transforms">
				<v-button secondary full-width class="sidebar-btn" @click="openConfirm">
					Delete All Transforms
				</v-button>
			</div>
		</div>

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card>
				<v-card-title>Delete All Transforms</v-card-title>
				<v-card-text>
					<v-notice type="info" class="dialog-info">
						This deletes generated transform files (thumbnails and resized variants) at the storage root.
						<strong>Source files are not deleted</strong> — your originals in Directus stay untouched.
						Directus will recreate transforms automatically the next time those images are requested.
					</v-notice>

					<p v-if="counting" class="dialog-text">Scanning storage…</p>
					<p v-else-if="countError" class="dialog-error">{{ countError }}</p>
					<p v-else-if="confirmMessage" class="dialog-text">{{ confirmMessage }}</p>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmOpen = false">Cancel</v-button>
					<v-button
						kind="danger"
						:loading="deleting"
						:disabled="counting || Boolean(countError) || !dryRun?.deleted"
						@click="confirmDelete"
					>
						Delete Transforms
					</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</sidebar-detail>
</template>

<style scoped>
.fields {
	--theme--form--row-gap: 1.375rem;
	--theme--form--column-gap: 1.375rem;

	display: grid;
	grid-template-columns: [start] minmax(0, 1fr) [half] minmax(0, 1fr) [full];
	gap: var(--theme--form--row-gap) var(--theme--form--column-gap);
	container-type: inline-size;
}

.field {
	grid-column: start / full;
	min-inline-size: 0;
}

.field.full {
	grid-column: start / full;
}

.fields :deep(.v-radio + .v-radio) {
	margin-block-start: 0.4375rem;
}

/* Sidebar panel bg often matches --theme--background-normal, so default
   secondary buttons look like plain text. Force a visible chip fill. */
.delete-transforms :deep(.sidebar-btn) {
	display: flex;
	width: 100%;
}

.delete-transforms :deep(.sidebar-btn .button) {
	width: 100%;
	justify-content: center;
	color: var(--theme--foreground);
	background-color: var(--theme--background-accent);
	border-color: var(--theme--background-accent);
}

.delete-transforms :deep(.sidebar-btn .button:hover:not(:disabled)) {
	background-color: var(--theme--background-normal);
	border-color: var(--theme--background-normal);
}

.dialog-info {
	margin-bottom: 16px;
	line-height: 1.5;
}

.dialog-text {
	margin: 0;
	line-height: 1.5;
}

.dialog-error {
	margin: 0;
	color: var(--theme--danger);
}
</style>
