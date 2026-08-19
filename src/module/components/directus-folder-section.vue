<template>
	<!--
		Fragment of cards for Directus virtual folders — same grid pattern as
		File Library FolderSection / storage-folder-section.
	-->
	<div
		v-for="folder in folders"
		:key="folder.id"
		class="card folder-card"
		:class="{
			selected: selection.includes(folder.id),
			'select-mode': selectMode,
		}"
		tabindex="0"
		@click="onCardClick(folder)"
		@keydown.self.enter.prevent="onCardClick(folder)"
		@keydown.self.space.prevent="onCardClick(folder)"
	>
		<v-icon class="selector" :name="selectionIcon(folder.id)" clickable @click.stop="toggle(folder.id)" />
		<div class="header">
			<div class="selection-fade" />
			<v-icon large name="folder" outline />
		</div>
		<div class="title">{{ folder.name }}</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { FolderRaw } from '../composables/use-folders';

const props = defineProps<{
	folders: FolderRaw[];
	anyFileSelection?: boolean;
}>();

const selection = defineModel<string[]>('selection', { default: () => [] });
const router = useRouter();

const selectMode = computed(() => selection.value.length > 0 || (props.anyFileSelection ?? false));

function selectionIcon(id: string) {
	return selection.value.includes(id) ? 'check_circle' : 'radio_button_unchecked';
}

function openFolder(id: string) {
	router.push(`/storage-manager/folders/${id}`);
}

function toggle(id: string) {
	if (selection.value.includes(id)) {
		selection.value = selection.value.filter((value) => value !== id);
	} else {
		selection.value = [...selection.value, id];
	}
}

function onCardClick(folder: FolderRaw) {
	if (selectMode.value) {
		toggle(folder.id);
		return;
	}
	openFolder(folder.id);
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
	font-weight: 600;
	line-height: 1.3;
	white-space: nowrap;
	text-overflow: ellipsis;
}
</style>
