<script setup lang="ts">
import type { ContentVersion, Filter } from '@directus/types';
import { deepMap, getFieldsFromTemplate } from '@directus/utils';
import { clamp, get, isEmpty, isNil, set } from 'lodash-es';
import { render } from 'micromustache';
import { computed, inject, ref, toRef, toRefs } from 'vue';
import Draggable from 'vuedraggable';
import { useMimeTypeFilter } from '../shared/composables/use-mime-type-filter';
import { useRelationM2M } from '../shared/composables/use-relation-m2m';
import {
	useRelationMultiple,
	type DisplayItem,
	type RelationQueryMultiple,
} from '../shared/composables/use-relation-multiple';
import { useRelationPermissionsM2M } from '../shared/composables/use-relation-permissions';
import { getAssetUrl } from '../shared/utils/get-asset-url';
import { parseFilter } from '../shared/utils/parse-filter';
import { useUploadPreset } from '../shared/utils/upload-preset';

const props = withDefaults(
	defineProps<{
		value: (number | string | Record<string, any>)[] | Record<string, any> | null;
		primaryKey: string | number;
		collection: string;
		field: string;
		disabled?: boolean;
		nonEditable?: boolean;
		version: ContentVersion | null;
		template?: string | null;
		enableCreate?: boolean;
		enableSelect?: boolean;
		folder?: string;
		storage?: string;
		filter?: Filter;
		limit?: number;
		allowedMimeTypes?: string[];
	}>(),
	{
		nonEditable: false,
		template: null,
		enableCreate: true,
		enableSelect: true,
		storage: 'local',
		limit: 15,
	},
);

const emit = defineEmits<{
	input: [value: (number | string | Record<string, any>)[] | Record<string, any> | null];
}>();

const { collection, field, primaryKey, limit, version } = toRefs(props);
const { relationInfo } = useRelationM2M(collection, field);
const uploadPreset = useUploadPreset(toRef(props, 'storage'));

const value = computed({
	get: () => props.value,
	set: (val) => emit('input', val),
});

const { mimeTypeFilter, combinedAcceptString } = useMimeTypeFilter(toRef(props, 'allowedMimeTypes'));

const templateWithDefaults = computed(() => {
	if (!relationInfo.value) return null;
	if (props.template) return props.template;

	if (relationInfo.value.junctionCollection.meta?.display_template) {
		return relationInfo.value.junctionCollection.meta.display_template;
	}

	let relatedDisplayTemplate = relationInfo.value.relatedCollection.meta?.display_template;

	if (relatedDisplayTemplate) {
		const regex = /({{.*?}})/g;
		const parts = relatedDisplayTemplate.split(regex).filter((p) => p);

		for (const part of parts) {
			if (!part.startsWith('{{')) continue;
			const key = part.replace(/{{/g, '').replace(/}}/g, '').trim();
			const newPart = `{{${relationInfo.value.relation.field}.${key}}}`;
			relatedDisplayTemplate = relatedDisplayTemplate.replace(part, newPart);
		}

		return relatedDisplayTemplate;
	}

	return `{{${relationInfo.value.relation.field}.${relationInfo.value.relatedPrimaryKeyField.field}}}`;
});

const fields = computed(() => {
	if (!relationInfo.value) return [];
	const fromTemplate = getFieldsFromTemplate(templateWithDefaults.value);
	return [...fromTemplate, `${relationInfo.value.relation.field}.filename_download`];
});

const page = ref(1);

const query = computed<RelationQueryMultiple>(() => ({
	fields: fields.value,
	limit: limit.value,
	page: page.value,
}));

const {
	update,
	remove,
	select,
	displayItems,
	totalItemCount,
	loading,
	selected,
	isItemSelected,
	isLocalItem,
	getItemEdits,
} = useRelationMultiple(value, query, relationInfo, primaryKey, version);

const { createAllowed, updateAllowed, selectAllowed, deleteAllowed } = useRelationPermissionsM2M(relationInfo);

const pageCount = computed(() => Math.ceil(totalItemCount.value / limit.value));

function sortItems(items: DisplayItem[]) {
	const info = relationInfo.value;
	const sortField = info?.sortField;
	if (!info || !sortField) return;

	const sortedItems = items.map((item, index) => {
		const junctionId = item?.[info.junctionPrimaryKeyField.field];
		const relatedId = item?.[info.junctionField.field]?.[info.relatedPrimaryKeyField.field];

		const changes: Record<string, any> = {
			$index: item.$index,
			$type: item.$type,
			$edits: item.$edits,
			...getItemEdits(item),
			[sortField]: index + 1,
		};

		if (!isNil(junctionId)) changes[info.junctionPrimaryKeyField.field] = junctionId;
		if (!isNil(relatedId)) {
			set(changes, `${info.junctionField.field}.${info.relatedPrimaryKeyField.field}`, relatedId);
		}

		return changes;
	});

	update(...sortedItems);
}

const selectedPrimaryKeys = computed(() => {
	if (!relationInfo.value) return [];
	const junctionField = relationInfo.value.junctionField.field;
	const relationPkField = relationInfo.value.relatedPrimaryKeyField.field;
	return selected.value.map((item) => item[junctionField][relationPkField]);
});

const editModalActive = ref(false);
const currentlyEditing = ref<string | number | null>(null);
const relatedPrimaryKey = ref<string | number | null>(null);
const selectModalActive = ref(false);
const editsAtStart = ref<Record<string, any>>({});
const showUpload = ref(false);

function editItem(item: DisplayItem) {
	if (!relationInfo.value) return;

	const relationPkField = relationInfo.value.relatedPrimaryKeyField.field;
	const junctionField = relationInfo.value.junctionField.field;
	const junctionPkField = relationInfo.value.junctionPrimaryKeyField.field;

	editsAtStart.value = getItemEdits(item);
	editModalActive.value = true;

	if (item?.$type === 'created' && !isItemSelected(item)) {
		currentlyEditing.value = null;
		relatedPrimaryKey.value = null;
	} else {
		currentlyEditing.value = get(item, [junctionPkField], null);
		relatedPrimaryKey.value = get(item, [junctionField, relationPkField], null);
	}
}

function stageEdits(item: Record<string, any>) {
	if (isEmpty(item)) return;
	update(item);
}

function deleteItem(item: DisplayItem) {
	if (
		page.value === Math.ceil(totalItemCount.value / limit.value) &&
		page.value !== Math.ceil((totalItemCount.value - 1) / limit.value)
	) {
		page.value = Math.max(1, page.value - 1);
	}
	remove(item);
}

function onUpload(files: Record<string, any>[] | null) {
	showUpload.value = false;
	if (!files?.length || !relationInfo.value) return;
	select(files.map((file) => file.id));
}

function onSelect(selectedIds: (string | number)[] | null) {
	select(selectedIds!.filter((id) => !selectedPrimaryKeys.value.includes(id)));
}

const downloadName = computed(() => {
	if (relatedPrimaryKey.value === null || relationInfo.value?.relatedCollection.collection !== 'directus_files') {
		return;
	}
	const junctionField = relationInfo.value.junctionField.field;
	const relationPkField = relationInfo.value.relatedPrimaryKeyField.field;
	return displayItems.value.find(
		(item) => get(item, [junctionField, relationPkField]) === relatedPrimaryKey.value,
	)?.[junctionField]?.filename_download;
});

const downloadUrl = computed(() => {
	if (relatedPrimaryKey.value === null || relationInfo.value?.relatedCollection.collection !== 'directus_files') {
		return;
	}
	return getAssetUrl(String(relatedPrimaryKey.value), { isDownload: true });
});

function getFilename(junctionRow: Record<string, any>) {
	const junctionField = relationInfo.value?.junctionField.field;
	if (!junctionField) return;
	return junctionRow[junctionField]?.id ?? junctionRow[junctionField] ?? null;
}

function getDownloadName(junctionRow: Record<string, any>) {
	const junctionField = relationInfo.value?.junctionField.field;
	if (!junctionField) return;
	return junctionRow[junctionField]?.filename_download;
}

const values = inject('values', ref<Record<string, unknown>>({}));

const customFilter = computed(() => {
	if (!relationInfo.value) return;

	const filter: Filter = { _and: [] };
	const reverseRelation = `$FOLLOW(${relationInfo.value.junctionCollection.collection},${relationInfo.value.junctionField.field})`;

	const selectFilter: Filter = {
		[reverseRelation]: {
			_none: {
				[relationInfo.value.reverseJunctionField.field]: { _eq: props.primaryKey },
			},
		},
	};

	if (selectedPrimaryKeys.value.length > 0) {
		filter._and.push({
			[relationInfo.value.relatedPrimaryKeyField.field]: { _nin: selectedPrimaryKeys.value },
		});
	}

	if (props.primaryKey !== '+') filter._and.push(selectFilter);

	if (props.filter) {
		filter._and.push(
			parseFilter(
				deepMap(props.filter, (val: unknown) => {
					if (val && typeof val === 'string') return render(val, values.value);
					return val;
				}),
			),
		);
	}

	if (mimeTypeFilter.value) filter._and.push(mimeTypeFilter.value);
	return filter;
});

const allowDrag = computed(
	() =>
		totalItemCount.value <= limit.value &&
		relationInfo.value?.sortField !== undefined &&
		!props.disabled &&
		updateAllowed.value,
);

const menuActive = computed(() => editModalActive.value || selectModalActive.value || showUpload.value);
</script>

<template>
	<v-notice v-if="!relationInfo" type="warning">{{ $t('relationship_not_setup') }}</v-notice>
	<div v-else v-prevent-focusout="menuActive" class="files-with-storage">
		<template v-if="loading">
			<v-skeleton-loader
				v-for="n in clamp(totalItemCount - (page - 1) * limit, 1, limit)"
				:key="n"
				:type="totalItemCount > 4 ? 'block-list-item-dense' : 'block-list-item'"
			/>
		</template>

		<template v-else>
			<v-notice v-if="displayItems.length === 0">{{ $t('no_items') }}</v-notice>

			<Draggable
				v-else
				:model-value="displayItems"
				tag="v-list"
				item-key="id"
				handle=".drag-handle"
				:disabled="!allowDrag"
				v-bind="{ 'force-fallback': true }"
				@update:model-value="sortItems($event)"
			>
				<template #item="{ element }">
					<v-list-item
						:class="{ deleted: element.$type === 'deleted' }"
						:dense="totalItemCount > 4"
						:disabled="disabled && !nonEditable"
						block
						clickable
						@click="editItem(element)"
					>
						<v-icon v-if="allowDrag" name="drag_handle" class="drag-handle" left @click.stop="() => {}" />

						<render-template
							:collection="relationInfo.junctionCollection.collection"
							:item="element"
							:template="templateWithDefaults"
						/>

						<div class="spacer" />

						<div v-if="!nonEditable" class="item-actions">
							<v-remove
								v-if="deleteAllowed || isLocalItem(element)"
								:disabled="disabled"
								:item-type="element.$type"
								:item-info="relationInfo"
								:item-is-local="isLocalItem(element)"
								:item-edits="getItemEdits(element)"
								@action="deleteItem(element)"
							/>

							<v-menu show-arrow placement="bottom-end" :disabled="disabled">
								<template #activator="{ toggle, active }">
									<v-icon
										name="more_vert"
										clickable
										class="menu"
										:class="{ active }"
										:disabled="disabled"
										@click.stop="toggle"
									/>
								</template>
								<v-list>
									<v-list-item clickable :href="getAssetUrl(getFilename(element))">
										<v-list-item-icon><v-icon name="launch" /></v-list-item-icon>
										<v-list-item-content>{{ $t('open_file_in_tab') }}</v-list-item-content>
									</v-list-item>
									<v-list-item
										clickable
										:download="getDownloadName(element)"
										:href="getAssetUrl(getFilename(element), { isDownload: true })"
									>
										<v-list-item-icon><v-icon name="download" /></v-list-item-icon>
										<v-list-item-content>{{ $t('download_file') }}</v-list-item-content>
									</v-list-item>
								</v-list>
							</v-menu>
						</div>
					</v-list-item>
				</template>
			</Draggable>
		</template>

		<div v-if="!nonEditable || pageCount > 1" class="actions">
			<template v-if="!nonEditable">
				<v-button v-if="enableCreate && createAllowed" :disabled="disabled" @click="showUpload = true">
					{{ $t('upload_file') }}
				</v-button>
				<v-button v-if="enableSelect && selectAllowed" :disabled="disabled" @click="selectModalActive = true">
					{{ $t('add_existing') }}
				</v-button>
			</template>
			<div class="spacer" />
			<v-pagination v-if="pageCount > 1" v-model="page" :length="pageCount" :total-visible="2" show-first-last />
		</div>

		<drawer-item
			v-model:active="editModalActive"
			:disabled="disabled"
			:non-editable="nonEditable"
			:collection="relationInfo.junctionCollection.collection"
			:primary-key="currentlyEditing || '+'"
			:related-primary-key="relatedPrimaryKey || '+'"
			:junction-field="relationInfo.junctionField.field"
			:edits="editsAtStart"
			:circular-field="relationInfo.reverseJunctionField.field"
			@input="stageEdits"
		>
			<template #actions>
				<v-button
					v-if="currentlyEditing !== '+' && relationInfo.relatedCollection.collection === 'directus_files'"
					secondary
					rounded
					icon
					:download="downloadName"
					:href="downloadUrl"
				>
					<v-icon name="download" />
				</v-button>
			</template>
		</drawer-item>

		<drawer-files
			v-if="!disabled"
			v-model:active="selectModalActive"
			:collection="relationInfo.relatedCollection.collection"
			:folder="folder"
			:field="field"
			:filter="customFilter"
			multiple
			@input="onSelect"
		/>

		<v-dialog v-if="!disabled" v-model="showUpload">
			<v-card>
				<v-card-title>{{ $t('upload_file') }}</v-card-title>
				<v-card-text>
					<v-upload
						multiple
						from-url
						:folder="folder"
						:preset="uploadPreset"
						:accept="combinedAcceptString"
						@input="onUpload"
					/>
				</v-card-text>
				<v-card-actions>
					<v-button @click="showUpload = false">{{ $t('done') }}</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<style scoped>
.files-with-storage :deep(.v-list) {
	--v-list-padding: 0;
}

.v-list-item.disabled:not(.non-editable) {
	--v-list-item-background-color: var(--theme--form--field--input--background-subdued);
}

.item-actions {
	display: flex;
	align-items: center;
	gap: 2px;
}

.actions {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-block-start: 8px;
}

.spacer {
	flex-grow: 1;
}

.menu.active {
	--v-icon-color: var(--theme--form--field--input--foreground);
}
</style>
