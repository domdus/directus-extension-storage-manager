<template>
	<v-dialog v-model="dialogActive" @esc="dialogActive = false" @apply="addFolder">
		<template #activator="{ on }">
			<header-action-button
				v-tooltip.bottom="'Create Storage Folder'"
				icon="create_new_folder"
				secondary
				@click="on"
			/>
		</template>

		<v-card>
			<v-card-title>Create Storage Folder</v-card-title>
			<v-card-text>
				<v-input v-model="newFolderName" autofocus placeholder="Folder name" @keydown.enter="addFolder" />
			</v-card-text>
			<v-card-actions>
				<v-button secondary @click="dialogActive = false">Cancel</v-button>
				<v-button :disabled="!newFolderName?.trim()" :loading="saving" @click="addFolder">Save</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import HeaderActionButton from './header-action-button.vue';
import { storageManagerPath } from '../../shared/storage-path-url';

const props = defineProps<{
	location: string;
	parentPath?: string;
}>();

const emit = defineEmits<{
	(e: 'created', path: string): void;
}>();

const api = useApi();
const router = useRouter();

const dialogActive = ref(false);
const saving = ref(false);
const newFolderName = ref<string | null>(null);

async function addFolder() {
	if (!newFolderName.value?.trim() || saving.value) return;
	saving.value = true;
	try {
		const res = await api.post(`/storage-manager/storages/${encodeURIComponent(props.location)}/folders`, {
			name: newFolderName.value.trim(),
			parent_path: props.parentPath || '',
		});
		const path = String(res.data?.data?.path || '');
		dialogActive.value = false;
		newFolderName.value = null;
		emit('created', path);
		if (path) {
			router.push(storageManagerPath(props.location, path));
		}
	} catch (err: any) {
		const message = err?.response?.data?.errors?.[0]?.message || err?.message || 'Could not create folder';
		window.alert(message);
	} finally {
		saving.value = false;
	}
}
</script>
