<script setup lang="ts">
/**
 * File Library–parity delete dialog for physical storage folders:
 * move contents one level up, or delete all registered content.
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

const radioOptions: { value: StorageFolderDeleteMode; label: string }[] = [
	{ value: 'move', label: 'Move content one level up' },
	{ value: 'delete', label: 'Delete all content' },
];

watch(modelValue, (open) => {
	if (open) deleteMode.value = 'move';
});

async function save() {
	if (saving.value || !props.location || !props.paths.length) return;
	saving.value = true;
	try {
		const res = await api.delete(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/folders`,
			{ data: { paths: props.paths, mode: deleteMode.value } },
		);
		const skipped = res.data?.data?.skipped || [];
		if (skipped.length) {
			window.alert(skipped[0]?.error || 'Folder could not be deleted');
			return;
		}
		modelValue.value = false;
		emit('done');
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Delete failed');
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" persistent @update:model-value="modelValue = $event" @esc="modelValue = false" @apply="save">
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
			</v-card-text>
			<v-card-actions>
				<v-button secondary :disabled="saving" @click="modelValue = false">Cancel</v-button>
				<v-button kind="danger" :loading="saving" @click="save">Delete</v-button>
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
</style>
