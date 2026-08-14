<script setup lang="ts">
/**
 * Context menu + dialogs for physical storage folders.
 * File Library parity: Rename, Move, Delete (Download omitted).
 *
 * Parent: `@contextmenu.prevent="(e) => menu.open(e)"` with `ref="menu"`.
 */
import { computed, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import StorageFolderPicker from './storage-folder-picker.vue';
import DeleteStorageFolderDialog from './delete-storage-folder-dialog.vue';
import { useStorageFolderTrees } from '../composables/use-storage-folder-trees';
import { decodeStoragePathFromUrl, storageManagerPath } from '../../shared/storage-path-url';

const props = defineProps<{
	location: string;
	path: string;
	name: string;
}>();

const emit = defineEmits<{
	(e: 'changed', nextPath?: string): void;
}>();

const api = useApi();
const router = useRouter();
const { refreshTree } = useStorageFolderTrees();

const contextMenu = ref<{ activate?: (event: MouseEvent) => void } | null>(null);

const renameActive = ref(false);
const renameValue = ref(props.name);
const renameSaving = ref(false);

const moveActive = ref(false);
const moveValue = ref('');
const moveSaving = ref(false);

const deleteActive = ref(false);

const parentPath = computed(() => {
	const p = String(props.path || '');
	const idx = p.lastIndexOf('/');
	return idx === -1 ? '' : p.slice(0, idx);
});

const disabledMovePaths = computed(() => [props.path]);
const deletePaths = computed(() => [props.path]);

watch(
	() => props.name,
	(n) => {
		if (!renameActive.value) renameValue.value = n;
	},
);

watch(renameActive, (open) => {
	if (open) renameValue.value = props.name;
});

watch(moveActive, (open) => {
	if (open) moveValue.value = parentPath.value;
});

function open(event: MouseEvent) {
	contextMenu.value?.activate?.(event);
}

defineExpose({ open });

function currentBrowsingPath(): string {
	if (!router.currentRoute.value.path.includes('/storage/')) return '';
	const raw = Array.isArray(router.currentRoute.value.params.storagePath)
		? router.currentRoute.value.params.storagePath.filter(Boolean).join('/')
		: String(router.currentRoute.value.params.storagePath || '');
	return decodeStoragePathFromUrl(raw);
}

function followPathChange(nextPath: string) {
	const browsing = currentBrowsingPath();
	if (!browsing) return;
	if (browsing === props.path || browsing.startsWith(`${props.path}/`)) {
		const rest = browsing === props.path ? '' : browsing.slice(props.path.length + 1);
		router.replace(storageManagerPath(props.location, rest ? `${nextPath}/${rest}` : nextPath));
	}
}

async function afterChange(nextPath?: string) {
	await refreshTree(props.location).catch(() => undefined);
	emit('changed', nextPath);
}

async function renameSave() {
	if (!renameValue.value?.trim() || renameSaving.value) return;
	renameSaving.value = true;
	try {
		const res = await api.patch(`/storage-manager/storages/${encodeURIComponent(props.location)}/folders`, {
			path: props.path,
			name: renameValue.value.trim(),
		});
		const next = String(res.data?.data?.path || '');
		renameActive.value = false;
		if (next) followPathChange(next);
		await afterChange(next || undefined);
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Rename failed');
	} finally {
		renameSaving.value = false;
	}
}

async function moveSave() {
	if (moveSaving.value) return;
	moveSaving.value = true;
	try {
		const res = await api.patch(`/storage-manager/storages/${encodeURIComponent(props.location)}/folders`, {
			path: props.path,
			parent_path: moveValue.value || '',
		});
		const next = String(res.data?.data?.path || '');
		moveActive.value = false;
		if (next) followPathChange(next);
		await afterChange(next || undefined);
	} catch (err: any) {
		window.alert(err?.response?.data?.errors?.[0]?.message || err?.message || 'Move failed');
	} finally {
		moveSaving.value = false;
	}
}

async function onDeleteDone() {
	const browsing = currentBrowsingPath();
	if (browsing === props.path || browsing.startsWith(`${props.path}/`)) {
		router.replace(storageManagerPath(props.location, parentPath.value || undefined));
	}
	await afterChange(parentPath.value || undefined);
}
</script>

<template>
	<v-menu ref="contextMenu" show-arrow placement="bottom-start">
		<v-list>
			<v-list-item clickable @click="renameActive = true">
				<v-list-item-icon>
					<v-icon name="edit" outline />
				</v-list-item-icon>
				<v-list-item-content>Rename Folder</v-list-item-content>
			</v-list-item>

			<v-list-item clickable @click="moveActive = true">
				<v-list-item-icon>
					<v-icon name="folder_move" outline />
				</v-list-item-icon>
				<v-list-item-content>Move to Folder</v-list-item-content>
			</v-list-item>

			<v-list-item class="danger" clickable @click="deleteActive = true">
				<v-list-item-icon>
					<v-icon name="delete" outline />
				</v-list-item-icon>
				<v-list-item-content>Delete Folder</v-list-item-content>
			</v-list-item>
		</v-list>
	</v-menu>

	<v-dialog v-model="renameActive" persistent @esc="renameActive = false" @apply="renameSave">
		<v-card>
			<v-card-title>Rename Folder</v-card-title>
			<v-card-text>
				<v-input v-model="renameValue" autofocus @keyup.enter="renameSave" />
			</v-card-text>
			<v-card-actions>
				<v-button secondary @click="renameActive = false">Cancel</v-button>
				<v-button :disabled="!renameValue?.trim()" :loading="renameSaving" @click="renameSave">Save</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>

	<v-dialog v-model="moveActive" persistent @esc="moveActive = false" @apply="moveSave">
		<v-card>
			<v-card-title>Move to Folder</v-card-title>
			<v-card-text>
				<storage-folder-picker
					v-model="moveValue"
					:location="location"
					:disabled-paths="disabledMovePaths"
				/>
			</v-card-text>
			<v-card-actions>
				<v-button secondary @click="moveActive = false">Cancel</v-button>
				<v-button :loading="moveSaving" @click="moveSave">Save</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>

	<delete-storage-folder-dialog
		v-model="deleteActive"
		:location="location"
		:paths="deletePaths"
		:folder-name="name"
		@done="onDeleteDone"
	/>
</template>

<style scoped>
.v-list-item.danger {
	--v-list-item-color: var(--theme--danger);
	--v-list-item-color-hover: var(--theme--danger);
	--v-list-item-icon-color: var(--theme--danger);
}
</style>
