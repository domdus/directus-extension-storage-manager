<script setup lang="ts">
import type { Filter } from '@directus/types';
import { deepMap } from '@directus/utils';
import { useApi } from '@directus/extensions-sdk';
import { render } from 'micromustache';
import { computed, inject, ref, toRef, toRefs } from 'vue';
import { useMimeTypeFilter } from '../shared/composables/use-mime-type-filter';
import { useRelationM2O } from '../shared/composables/use-relation-m2o';
import { useRelationPermissionsM2O } from '../shared/composables/use-relation-permissions';
import { useRelationSingle, type RelationQuerySingle } from '../shared/composables/use-relation-single';
import { getAssetUrl } from '../shared/utils/get-asset-url';
import { parseFilter } from '../shared/utils/parse-filter';
import { readableMimeType } from '../shared/utils/readable-mime-type';
import { unexpectedError } from '../shared/utils/unexpected-error';
import { useUploadPreset } from '../shared/utils/upload-preset';

type FileInfo = {
	id: string;
	title: string;
	type: string;
};

const props = withDefaults(
	defineProps<{
		value: string | Record<string, any> | null;
		disabled?: boolean;
		nonEditable?: boolean;
		loading?: boolean;
		folder?: string;
		storage?: string;
		filter?: Filter;
		collection: string;
		field: string;
		enableCreate?: boolean;
		enableSelect?: boolean;
		allowedMimeTypes?: string[];
		/** keep | ask | delete_if_unreferenced */
		onDeselect?: string;
		/** keep | delete_if_unreferenced — applied by API hook on item delete */
		onItemDelete?: string;
	}>(),
	{
		enableCreate: true,
		enableSelect: true,
		storage: 'local',
		onDeselect: 'keep',
		onItemDelete: 'keep',
	},
);

const emit = defineEmits<{
	input: [value: string | Record<string, any> | null];
}>();

const api = useApi();
const storageRef = toRef(props, 'storage');
const uploadPreset = useUploadPreset(storageRef);

const value = computed({
	get: () => props.value,
	set: (next) => emit('input', next),
});

const { mimeTypeFilter, combinedAcceptString } = useMimeTypeFilter(toRef(props, 'allowedMimeTypes'));

const query = ref<RelationQuerySingle>({
	fields: ['id', 'title', 'type', 'filename_download', 'modified_on'],
});

const { collection, field } = toRefs(props);
const { relationInfo } = useRelationM2O(collection, field);

const activeDialog = ref<'upload' | 'choose' | 'url' | null>(null);
const menuOpen = ref(false);

const {
	displayItem: file,
	loading,
	update,
	remove,
} = useRelationSingle(value, query, relationInfo, {
	enabled: computed(() => !props.loading),
});

const { createAllowed } = useRelationPermissionsM2O(relationInfo);

const deselectDialog = ref(false);
const deselectDeleting = ref(false);

function currentFileId(): string | null {
	const val = props.value;
	if (!val) return null;
	if (typeof val === 'object' && val.id) return String(val.id);
	return String(val);
}

async function deleteFileIfUnreferenced(fileId: string) {
	try {
		await api.post('/storage-manager/files/delete-if-unreferenced', { file_ids: [fileId] });
	} catch (error) {
		unexpectedError(error);
	}
}

async function onDeselectAction() {
	const policy = props.onDeselect || 'keep';
	const fileId = currentFileId();

	if (policy === 'ask' && fileId) {
		deselectDialog.value = true;
		return;
	}

	if (policy === 'delete_if_unreferenced' && fileId) {
		remove();
		await deleteFileIfUnreferenced(fileId);
		return;
	}

	remove();
}

async function confirmDeselectOnly() {
	deselectDialog.value = false;
	remove();
}

async function confirmDeselectAndDelete() {
	const fileId = currentFileId();
	deselectDeleting.value = true;
	try {
		remove();
		if (fileId) await deleteFileIfUnreferenced(fileId);
	} finally {
		deselectDeleting.value = false;
		deselectDialog.value = false;
	}
}

const fileExtension = computed(() => {
	if (file.value === null) return null;
	return readableMimeType(file.value.type, true);
});

const imageThumbnail = computed(() => {
	if (file.value === null || props.value === null) return null;
	if (!file.value.type.includes('image')) return null;

	if (file.value.type.includes('svg')) {
		return getAssetUrl(file.value.id, { cacheBuster: file.value.modified_on });
	}

	return getAssetUrl(file.value.id, {
		imageKey: 'system-small-cover',
		cacheBuster: file.value.modified_on,
	});
});

const imageThumbnailError = ref<any>(null);
const { url, isValidURL, loading: urlLoading, importFromURL } = useURLImport();
const editDrawerActive = ref(false);

const edits = computed(() => {
	if (!props.value || typeof props.value !== 'object') return {};
	return props.value;
});

const values = inject('values', ref<Record<string, unknown>>({}));

const customFilter = computed(() => {
	const filter = parseFilter(
		deepMap(props.filter, (val: unknown) => {
			if (val && typeof val === 'string') return render(val, values.value);
			return val;
		}),
	);

	if (!mimeTypeFilter.value) return filter;
	if (!filter) return mimeTypeFilter.value;
	return { _and: [filter, mimeTypeFilter.value] };
});

const internalDisabled = computed(
	() => props.disabled || (props.enableCreate === false && props.enableSelect === false),
);

const interfaceOpen = computed(() => Boolean(activeDialog.value) || menuOpen.value || editDrawerActive.value);

function setSelection(selection: (string | number)[] | null) {
	if (selection?.[0]) update(selection[0]);
	else void onDeselectAction();
}

function onUpload(fileInfo: FileInfo) {
	file.value = fileInfo;
	activeDialog.value = null;
	update(fileInfo.id);
}

function useURLImport() {
	const url = ref('');
	const loading = ref(false);

	const isValidURL = computed(() => {
		try {
			new URL(url.value);
			return true;
		} catch {
			return false;
		}
	});

	async function importFromURL() {
		loading.value = true;
		try {
			const response = await api.post('/files/import', {
				url: url.value,
				data: {
					folder: props.folder,
					storage: uploadPreset.value.storage,
				},
				options: { filterMimeType: props.allowedMimeTypes },
			});

			file.value = response.data.data;
			activeDialog.value = null;
			url.value = '';
			update(file.value?.id);
		} catch (error) {
			unexpectedError(error);
		} finally {
			loading.value = false;
		}
	}

	return { url, loading, isValidURL, importFromURL };
}
</script>

<template>
	<div v-prevent-focusout="interfaceOpen" class="file-with-storage">
		<v-menu v-model="menuOpen" attached :disabled="loading || internalDisabled">
			<template #activator="{ toggle, active, deactivate }">
				<div>
					<v-skeleton-loader v-if="loading" type="input" />

					<v-list-item
						v-else
						class="activator"
						clickable
						readonly
						block
						:active
						:disabled="!(nonEditable && file) && internalDisabled"
						:non-editable="nonEditable"
						:placeholder="$t('no_file_selected')"
						:model-value="file && file.title"
						@click="!nonEditable ? toggle() : (editDrawerActive = true)"
					>
						<v-list-item-icon>
							<div
								class="preview"
								:class="{ 'has-file': file, 'is-svg': file?.type?.includes('svg') }"
							>
								<v-image
									v-if="imageThumbnail && !imageThumbnailError"
									:src="imageThumbnail"
									:alt="file?.title"
									@error="imageThumbnailError = $event"
								/>
								<span v-else-if="fileExtension" class="extension">{{ fileExtension }}</span>
								<v-icon v-else name="folder_open" />
							</div>
						</v-list-item-icon>

						<v-list-item-content>
							<v-text-overflow v-if="file?.title" :text="file.title" />
							<v-text-overflow v-else class="placeholder" :text="$t('no_file_selected')" />
						</v-list-item-content>

						<div v-if="!nonEditable" class="item-actions">
							<template v-if="file">
								<v-icon
									v-tooltip="!internalDisabled && $t('edit_item')"
									name="edit"
									clickable
									:disabled="internalDisabled"
									@click.stop="
										deactivate();
										editDrawerActive = true;
									"
								/>
								<v-remove
									:item-info="relationInfo"
									:item-edits="edits"
									deselect
									:disabled="internalDisabled"
									@action="onDeselectAction"
								/>
							</template>
							<v-icon v-else name="attach_file" />
						</div>
					</v-list-item>
				</div>
			</template>

			<v-dialog v-model="deselectDialog" @esc="deselectDialog = false">
				<v-card>
					<v-card-title>Remove file from this item?</v-card-title>
					<v-card-text>
						Deselect clears the field only. Delete removes the file from the library if nothing else
						references it (relations, <code>/assets/</code> links, or JSON/code UUIDs).
					</v-card-text>
					<v-card-actions>
						<v-button secondary :disabled="deselectDeleting" @click="deselectDialog = false">Cancel</v-button>
						<v-button secondary :disabled="deselectDeleting" @click="confirmDeselectOnly">Deselect only</v-button>
						<v-button kind="danger" :loading="deselectDeleting" @click="confirmDeselectAndDelete">
							Deselect &amp; delete if unused
						</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>

			<v-list>
				<template v-if="file">
					<v-list-item
						clickable
						:download="file.filename_download"
						:href="getAssetUrl(file.id, { isDownload: true })"
					>
						<v-list-item-icon><v-icon name="get_app" /></v-list-item-icon>
						<v-list-item-content>{{ $t('download_file') }}</v-list-item-content>
					</v-list-item>
					<v-divider v-if="!internalDisabled" />
				</template>
				<template v-if="!internalDisabled">
					<v-list-item v-if="createAllowed && enableCreate" clickable @click="activeDialog = 'upload'">
						<v-list-item-icon><v-icon name="phonelink" /></v-list-item-icon>
						<v-list-item-content>
							{{ $t(file ? 'replace_from_device' : 'upload_from_device') }}
						</v-list-item-content>
					</v-list-item>
					<v-list-item v-if="enableSelect" clickable @click="activeDialog = 'choose'">
						<v-list-item-icon><v-icon name="folder_open" /></v-list-item-icon>
						<v-list-item-content>
							{{ $t(file ? 'replace_from_library' : 'choose_from_library') }}
						</v-list-item-content>
					</v-list-item>
					<v-list-item v-if="createAllowed && enableCreate" clickable @click="activeDialog = 'url'">
						<v-list-item-icon><v-icon name="link" /></v-list-item-icon>
						<v-list-item-content>
							{{ $t(file ? 'replace_from_url' : 'import_from_url') }}
						</v-list-item-content>
					</v-list-item>
				</template>
			</v-list>
		</v-menu>

		<drawer-item
			v-if="file"
			v-model:active="editDrawerActive"
			collection="directus_files"
			:primary-key="file.id"
			:edits="edits"
			:disabled="internalDisabled"
			:non-editable="nonEditable"
			@input="update"
		>
			<template #actions>
				<v-button
					secondary
					rounded
					icon
					:href="getAssetUrl(file.id, { isDownload: true })"
					:download="file.filename_download"
				>
					<v-icon name="download" />
				</v-button>
			</template>
		</drawer-item>

		<v-dialog
			:model-value="activeDialog === 'upload'"
			@esc="activeDialog = null"
			@update:model-value="activeDialog = null"
		>
			<v-card>
				<v-card-title>{{ $t('upload_from_device') }}</v-card-title>
				<v-card-text>
					<v-upload
						from-url
						:folder="folder"
						:preset="uploadPreset"
						:accept="combinedAcceptString"
						@input="onUpload"
					/>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="activeDialog = null">{{ $t('cancel') }}</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<drawer-files
			v-if="activeDialog === 'choose'"
			:folder="folder"
			:field="field"
			:active="activeDialog === 'choose'"
			:filter="customFilter"
			@update:active="activeDialog = null"
			@input="setSelection"
		/>

		<v-dialog
			:model-value="activeDialog === 'url'"
			:persistent="urlLoading"
			@update:model-value="activeDialog = null"
			@esc="activeDialog = null"
		>
			<v-card>
				<v-card-title>{{ $t('import_from_url') }}</v-card-title>
				<v-card-text>
					<v-input v-model="url" autofocus :placeholder="$t('url')" :nullable="false" :disabled="urlLoading" />
				</v-card-text>
				<v-card-actions>
					<v-button :disabled="urlLoading" secondary @click="activeDialog = null">
						{{ $t('cancel') }}
					</v-button>
					<v-button :loading="urlLoading" :disabled="isValidURL === false" @click="importFromURL">
						{{ $t('import_label') }}
					</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<style scoped>
.v-list-item.activator {
	--v-list-item-color-active: var(--v-list-item-color);
	--v-list-item-background-color-active: var(
		--v-list-item-background-color,
		var(--v-list-background-color, var(--theme--form--field--input--background))
	);
}

.v-list-item.activator.disabled:not(.non-editable) {
	--v-list-item-color: var(--theme--foreground-subdued);
	--v-list-item-background-color: var(--theme--form--field--input--background-subdued);
}

.v-list-item.activator.active:not(.disabled),
.v-list-item.activator:focus-within:not(.disabled) {
	--v-list-item-border-color: var(--v-input-border-color-focus, var(--theme--form--field--input--border-color-focus));
	box-shadow: var(--theme--form--field--input--box-shadow-focus);
}

.item-actions {
	display: flex;
	align-items: center;
	gap: 2px;
	padding-inline-start: 0.4375rem;
}

.preview {
	display: flex;
	align-items: center;
	justify-content: center;
	inline-size: 2.25rem;
	block-size: 2.25rem;
	margin-inline-start: -0.4375rem;
	overflow: hidden;
	background-color: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
}

.preview.has-file {
	background-color: var(--theme--primary-background);
}

.preview.is-svg {
	padding: 0.25rem;
}

.preview img {
	inline-size: 100%;
	block-size: 100%;
	object-fit: cover;
}

.preview.is-svg img {
	object-fit: contain;
}

.placeholder {
	color: var(--theme--foreground-subdued);
}

.extension {
	color: var(--theme--primary);
	font-weight: 600;
	font-size: 0.625rem;
	text-transform: uppercase;
}
</style>
