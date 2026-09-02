<template>
	<!--
		Fragment of cards — must be direct children of layout-cards `.grid`
		(same as File Library FolderSection + Card), not a nested grid wrapper.
	-->
	<div
		v-for="folder in folders"
		:key="folder.path"
		class="card folder-card"
		:class="{
			selected: !folder.virtual && selection.includes(folder.path),
			'select-mode': selectMode && !folder.virtual,
			virtual: folder.virtual,
		}"
		tabindex="0"
		@click="onCardClick(folder)"
		@keydown.self.enter.prevent="onCardClick(folder)"
		@keydown.self.space.prevent="onCardClick(folder)"
		@contextmenu.prevent="onContextMenu($event, folder)"
	>
		<v-icon
			v-if="!folder.virtual"
			class="selector"
			:name="selectionIcon(folder.path)"
			clickable
			@click.stop="toggle(folder.path)"
		/>
		<div class="header">
			<div class="selection-fade" />
			<v-icon large :name="folder.virtual ? 'recycling' : 'folder'" />
		</div>
		<div class="title">{{ folder.name }}</div>

		<storage-folder-context-menu
			v-if="!folder.virtual"
			:ref="(el) => setMenuRef(folder.path, el)"
			:location="location"
			:path="folder.path"
			:name="folder.name"
			@changed="onChanged"
		/>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { StorageBrowseFolder } from '../../shared/types';
import { storageManagerPath } from '../../shared/storage-path-url';
import StorageFolderContextMenu from './storage-folder-context-menu.vue';

const props = defineProps<{
	location: string;
	folders: StorageBrowseFolder[];
	anyFileSelection?: boolean;
}>();

const emit = defineEmits<{
	(e: 'changed'): void;
}>();

const selection = defineModel<string[]>('selection', { default: () => [] });
const router = useRouter();

const menuRefs = ref<Record<string, { open: (event: MouseEvent) => void } | null>>({});

const selectMode = computed(() => selection.value.length > 0 || (props.anyFileSelection ?? false));

function setMenuRef(path: string, el: unknown) {
	menuRefs.value[path] = el as { open: (event: MouseEvent) => void } | null;
}

function selectionIcon(path: string) {
	return selection.value.includes(path) ? 'check_circle' : 'radio_button_unchecked';
}

function openFolder(path: string) {
	router.push(storageManagerPath(props.location, path));
}

function toggle(path: string) {
	if (selection.value.includes(path)) {
		selection.value = selection.value.filter((p) => p !== path);
	} else {
		selection.value = [...selection.value, path];
	}
}

function onCardClick(folder: StorageBrowseFolder) {
	if (folder.virtual) {
		openFolder(folder.path);
		return;
	}
	if (selectMode.value) {
		toggle(folder.path);
		return;
	}
	openFolder(folder.path);
}

function onContextMenu(event: MouseEvent, folder: StorageBrowseFolder) {
	if (folder.virtual) return;
	menuRefs.value[folder.path]?.open(event);
}

function onChanged() {
	emit('changed');
}
</script>

<style scoped>
/* Port of Directus layouts/cards/components/card.vue (folder-only subset) */
.card {
	position: relative;
	cursor: pointer;
}

.card:focus-visible {
	outline: none;
}

.card:focus-visible::after {
	position: absolute;
	inset-block-start: 0;
	inset-inline-start: 0;
	z-index: 2;
	inline-size: 100%;
	aspect-ratio: 1 / 1;
	border-radius: var(--theme--border-radius);
	outline: var(--focus-ring-width) solid var(--focus-ring-color);
	outline-offset: var(--focus-ring-offset);
	content: '';
	pointer-events: none;
}

.header {
	position: relative;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	inline-size: 100%;
	overflow: hidden;
	background-color: var(--theme--background-normal);
	border-color: var(--theme--primary-subdued);
	border-style: solid;
	border-width: 0;
	border-radius: var(--theme--border-radius);
	transition: border-width var(--fast) var(--transition);
}

.header::after {
	display: block;
	padding-block-end: 100%;
	content: '';
}

.header .v-icon {
	--v-icon-color: var(--theme--foreground-subdued);
	position: absolute;
}

.card.virtual .header .v-icon {
	--v-icon-color: var(--theme--primary);
}

.selection-fade {
	position: absolute;
	inset-block-start: 0;
	inset-inline-start: 0;
	z-index: 1;
	inline-size: 100%;
	block-size: 2.6875rem;
	opacity: 0;
	transition: opacity var(--fast) var(--transition);
}

.selection-fade::before {
	position: absolute;
	inset-block-start: 0;
	inset-inline-start: 0;
	inline-size: 100%;
	block-size: 100%;
	background-image: linear-gradient(-180deg, rgb(38 50 56 / 0.1) 10%, rgb(38 50 56 / 0));
	content: '';
}

.card::before {
	position: absolute;
	inset-block-start: 0.375rem;
	inset-inline-start: 0.375rem;
	z-index: 2;
	inline-size: 1rem;
	block-size: 1rem;
	background-color: var(--theme--background);
	border-radius: 1.375rem;
	opacity: 0;
	transition: opacity var(--fast) var(--transition);
	content: '';
}

.selector {
	--v-icon-color: var(--white);
	--v-icon-color-hover: var(--white);
	--focus-ring-offset: 0;

	position: absolute;
	inset-block-start: 0;
	inset-inline-start: 0;
	z-index: 3;
	margin: 0.25rem;
	opacity: 0;
	transition:
		opacity var(--fast) var(--transition),
		color var(--fast) var(--transition);
}

.selector:focus-visible,
.selector:hover {
	opacity: 1 !important;
}

.card.select-mode .selector {
	opacity: 0.5;
}

.card.select-mode .header .selection-fade {
	opacity: 1;
}

.card.selected::before {
	opacity: 1;
}

.card.selected .selector {
	--v-icon-color: var(--theme--primary);
	--v-icon-color-hover: var(--theme--primary);
	opacity: 1;
}

.card.selected .header {
	border-width: 12px;
}

.card.selected .header .selection-fade {
	opacity: 1;
}

.card:hover .selector {
	opacity: 0.5;
}

.card:hover .header .selection-fade {
	opacity: 1;
}

.title {
	position: relative;
	display: flex;
	align-items: center;
	inline-size: 100%;
	block-size: 1.4375rem;
	margin-block-start: 0.125rem;
	overflow: hidden;
	line-height: 1.3;
	white-space: nowrap;
	text-overflow: ellipsis;
}
</style>
