<script setup lang="ts">
/**
 * File Library–parity delete dialog for physical storage folders:
 * move contents one level up, or delete all registered content.
 * Recycle Bin files that still use the path are never moved or deleted.
 */
import { ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';

export type StorageFolderDeleteMode = 'move' | 'delete';

const modelValue = defineModel<boolean>({ required: true });

const props = defineProps<{
	location: string;
	paths: string[];
	/** Optional label for a single folder (context menu). */
	folderName?: string;
}>();

const emit = defineEmits<{
	(e: 'done'): void;
}>();

const api = useApi();
const deleteMode = ref<StorageFolderDeleteMode>('move');
const saving = ref(false);
const notice = ref<{ type: 'info' | 'danger'; text: string } | null>(null);

const radioOptions: { value: StorageFolderDeleteMode; label: string }[] = [
	{ value: 'move', label: 'Move content one level up' },
	{ value: 'delete', label: 'Delete all content' },
];

watch(modelValue, (open) => {
	if (open) {
		deleteMode.value = 'move';
		notice.value = null;
	}
});

function close() {
	modelValue.value = false;
}

async function save() {
	if (saving.value || !props.location || !props.paths.length) return;
	saving.value = true;
	notice.value = null;
	try {
		const res = await api.delete(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/folders`,
			{ data: { paths: props.paths, mode: deleteMode.value } },
		);
		const skipped = (res.data?.data?.skipped || []) as Array<{ path?: string; error?: string }>;
		const recycleKept = (res.data?.data?.recycle_kept || []) as Array<{ path?: string; count?: number }>;
		const keptCount = recycleKept.reduce((sum, row) => sum + (Number(row.count) || 0), 0);

		if (skipped.length) {
			notice.value = {
				type: 'danger',
				text: skipped[0]?.error || 'Folder could not be deleted',
			};
			if (recycleKept.length || res.data?.data?.deleted?.length) {
				emit('done');
			}
			return;
		}

		if (recycleKept.length) {
			const folderLabel =
				recycleKept.length === 1
					? 'The folder was not removed'
					: `${recycleKept.length} folders were not removed`;
			notice.value = {
				type: 'info',
				text:
					`${folderLabel}: ${keptCount.toLocaleString()} Recycle Bin file` +
					`${keptCount === 1 ? '' : 's'} still use this path. Restore or purge them first.`,
			};
			emit('done');
			return;
		}

		close();
		emit('done');
	} catch (err: any) {
		notice.value = {
			type: 'danger',
			text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed',
		};
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" persistent @update:model-value="modelValue = $event" @esc="close" @apply="save">
		<v-card>
			<v-card-title>Delete Folder</v-card-title>
			<v-card-text>
				<p>
					<template v-if="folderName && paths.length === 1">
						What should happen to the contents of “{{ folderName }}”?
					</template>
					<template v-else-if="paths.length === 1">What should happen to the folder contents?</template>
					<template v-else>What should happen to the contents of {{ paths.length }} folders?</template>
				</p>
				<div class="radio-options">
					<v-radio
						v-for="option in radioOptions"
						:key="option.value"
						v-model="deleteMode"
						:value="option.value"
						:label="option.label"
					/>
				</div>
				<p class="field-hint">
					Recycle Bin files that still sit under this path are left alone. Empty cloud folders (GCS/S3
					placeholders and <code>.keep</code> markers) are removed. Leftover files that are not in the File
					Library must be imported or deleted with Detect first.
				</p>
				<v-notice v-if="notice" :type="notice.type" class="result-notice">{{ notice.text }}</v-notice>
			</v-card-text>
			<v-card-actions>
				<v-button secondary :disabled="saving" @click="close">{{ notice?.type === 'info' ? 'Close' : 'Cancel' }}</v-button>
				<v-button v-if="notice?.type !== 'info'" kind="danger" :loading="saving" @click="save">Delete</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.radio-options {
	margin-block-start: 0.675rem;
}

.radio-options .v-radio + .v-radio {
	margin-block-start: 0.45rem;
}

.field-hint {
	margin-block-start: 0.75rem;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}

.result-notice {
	margin-block-start: 0.75rem;
}
</style>
