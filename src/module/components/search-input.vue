<script setup lang="ts">
/**
 * Port of Directus app/src/views/private/components/search-input.vue (v11.17.4)
 * https://github.com/directus/directus/blob/v11.17.4/app/src/views/private/components/search-input.vue
 *
 * Kept as close as possible to upstream; uses host `interface-system-filter` in-template.
 */
import { useElementSize } from '@directus/composables';
import { computed, inject, onMounted, ref, watch, type Ref } from 'vue';

const props = withDefaults(
	defineProps<{
		modelValue: string | null;
		disabled?: boolean;
		showFilter?: boolean;
		collection?: string;
		filter?: Record<string, any> | null;
		autofocus?: boolean;
		placeholder?: string;
	}>(),
	{
		showFilter: true,
	},
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string | null): void;
	(e: 'update:filter', value: Record<string, any> | null): void;
}>();

const input = ref<HTMLInputElement | null>(null);

const active = ref(Boolean(props.autofocus));
const filterActive = ref(false);
const filterBorder = ref(false);

const mainElement = inject<Ref<Element | undefined> | undefined>('main-element', undefined);
const filterElement = ref<HTMLElement>();
const { width: mainElementWidth } = useElementSize(mainElement ?? ref(undefined));
const { width: filterElementWidth } = useElementSize(filterElement);

watch(
	[mainElementWidth, filterElementWidth],
	() => {
		if (!filterElement.value) return;

		const headerElement = mainElement?.value?.firstElementChild as HTMLElement | undefined;
		const searchElement = filterElement.value.parentElement;
		if (!searchElement) return;

		const minWidth = searchElement.offsetWidth - 4;

		if (!headerElement) {
			filterElement.value.style.maxInlineSize = '';
			return;
		}

		const maxWidth =
			searchElement.getBoundingClientRect().right -
			(headerElement.getBoundingClientRect().left +
				Number(window.getComputedStyle(headerElement).paddingInlineStart.replace('px', '')));

		filterElement.value.style.maxInlineSize = maxWidth > minWidth ? `${String(maxWidth)}px` : '0px';
	},
	{ immediate: true },
);

onMounted(() => {
	if (active.value) input.value?.focus();
});

const activeFilterCount = computed(() => {
	if (!props.filter) return 0;

	const filterOperators: string[] = [];
	parseLevel(props.filter);
	return filterOperators.length;

	function parseLevel(level: Record<string, any>) {
		for (const [key, value] of Object.entries(level)) {
			if (key === '_and' || key === '_or') {
				(value as any[])?.forEach?.(parseLevel);
			} else if (key.startsWith('_')) {
				filterOperators.push(key);
			} else if (value && typeof value === 'object') {
				parseLevel(value as Record<string, any>);
			}
		}
	}
});

function onClickOutside(event: { path?: HTMLElement[]; composedPath?: () => HTMLElement[] }) {
	const path = event.path || event.composedPath?.() || [];
	if (path.some((element) => element?.classList?.contains('v-menu-content'))) return false;
	return true;
}

function activate() {
	if (!active.value) input.value?.focus();
	active.value = true;
}

function toggleFilter() {
	filterActive.value = !filterActive.value;
	active.value = true;
	if (!filterActive.value) input.value?.focus();
}

function clear() {
	emit('update:modelValue', null);
	if (active.value) input.value?.focus();
}

function disable() {
	active.value = false;
	filterActive.value = false;
	input.value?.blur();
}

function onFocusOut(event: FocusEvent) {
	if (filterActive.value) return;

	const searchElement = (event.currentTarget as HTMLElement)?.closest('.search-input');
	const relatedTarget = event.relatedTarget as HTMLElement | null;
	if (relatedTarget && searchElement?.contains(relatedTarget)) return;

	disable();
}

function emitValue() {
	if (!input.value) return;
	emit('update:modelValue', input.value.value || null);
}

function onFilterBeforeEnter() {
	filterBorder.value = true;
}

function onFilterAfterLeave() {
	filterBorder.value = false;
}

watch(filterActive, (open) => {
	if (open) onFilterBeforeEnter();
	else onFilterAfterLeave();
});
</script>

<template>
	<v-badge
		bottom
		right
		class="search-badge"
		:class="{ active, 'filter-active': filterActive }"
		:value="activeFilterCount"
		:disabled="disabled || !activeFilterCount || filterActive"
	>
		<div
			v-click-outside="{
				handler: disable,
				middleware: onClickOutside,
				disabled: !active,
			}"
			class="search-input"
			:class="{
				active,
				disabled,
				'filter-active': filterActive,
				'has-content': !!modelValue,
				'filter-border': filterBorder,
				'show-filter': showFilter,
			}"
			role="search"
			@click="activate"
		>
			<v-icon
				small
				name="search"
				class="icon-search"
				:disabled="disabled"
				:clickable="!active"
				@click="input?.focus()"
			/>
			<input
				ref="input"
				:value="modelValue"
				:placeholder="placeholder ?? 'Search items…'"
				type="search"
				spellcheck="false"
				autocapitalize="off"
				autocorrect="off"
				autocomplete="off"
				:tabindex="!active && !modelValue ? -1 : undefined"
				:disabled="disabled"
				@input="emitValue"
				@paste="emitValue"
				@keydown.esc="disable"
				@focusin="activate"
				@focusout="onFocusOut"
			/>
			<div class="spacer" />
			<v-icon
				v-if="modelValue"
				v-tooltip.bottom="'Clear value'"
				small
				clickable
				class="icon-clear"
				name="close"
				:disabled="disabled"
				@click.stop="clear"
			/>
			<template v-if="showFilter">
				<v-icon
					v-tooltip.bottom="!disabled && 'Filter'"
					small
					clickable
					class="icon-filter"
					name="filter_list"
					:disabled="disabled"
					@click="toggleFilter"
				/>

				<div v-show="filterActive" ref="filterElement" class="filter" :class="{ active }">
					<interface-system-filter
						class="filter-input"
						inline
						:value="filter"
						:collection-name="collection"
						@input="$emit('update:filter', $event)"
					/>
				</div>
			</template>
		</div>
	</v-badge>
</template>

<style scoped>
/* Mirrors upstream search-input.vue styles (logical props → physical where needed). */
.search-badge {
	--v-badge-background-color: var(--theme--primary);
	--v-badge-offset-y: 0.4375rem;
	--v-badge-offset-x: 0.4375rem;
}

@media (width <= 22.5rem) {
	.search-badge.active,
	.search-badge.filter-active {
		position: absolute;
		inset-inline: 0;
		z-index: 1;
		background-color: var(--theme--header--background);
	}
}

.search-badge :deep(.badge) {
	pointer-events: none;
}

.search-input {
	--button-size: 2rem;
	--search-input-size: calc(var(--button-size) - var(--theme--border-width) * 2);
	--search-input-radius: calc(var(--button-size) / 2);
	--icon-size: 1rem;
	--icon-search-padding-left: 0.375rem;
	--icon-search-padding-right: 0.25rem;
	--icon-filter-margin-right: 0.4375rem;

	position: relative;
	box-sizing: content-box;
	display: flex;
	align-items: center;
	width: var(--search-input-size);
	min-height: var(--search-input-size);
	max-width: calc(100% - var(--theme--border-width) * 2);
	overflow: hidden;
	border: var(--theme--border-width) solid var(--theme--form--field--input--border-color);
	border-radius: var(--search-input-radius);
	transition:
		width var(--slow, 300ms) var(--transition, ease-in-out),
		border-bottom-left-radius var(--fast, 125ms) var(--transition, ease-in-out),
		border-bottom-right-radius var(--fast, 125ms) var(--transition, ease-in-out);
}

.search-input.show-filter {
	width: calc(
		var(--icon-size) * 2 + var(--icon-search-padding-left) + var(--icon-search-padding-right) +
			var(--icon-filter-margin-right)
	);
}

.search-input input {
	width: 0;
	height: 100%;
	margin: 0;
	padding: 0;
	overflow: hidden;
	color: var(--theme--foreground);
	text-overflow: ellipsis;
	background-color: transparent;
	border: none;
	border-radius: 0;
	flex-grow: 1;
	opacity: 0;
	outline: none;
	font: inherit;
}

.search-input input::placeholder {
	color: var(--theme--foreground-subdued);
}

.search-input.disabled input {
	color: var(--theme--foreground-subdued);
}

.search-input .spacer {
	width: 0.4375rem;
}

.search-input .icon-clear {
	--v-icon-color: var(--theme--foreground-subdued);
	--v-icon-color-hover: var(--theme--danger);
	min-width: auto;
	overflow: hidden;
}

.search-input .icon-search,
.search-input .icon-filter {
	--v-icon-color-hover: var(--theme--primary);
}

.search-input.disabled .icon-search,
.search-input.disabled .icon-filter {
	--v-icon-color: var(--theme--foreground-subdued);
}

.search-input .icon-search {
	margin-block: 0;
	margin-inline: var(--icon-search-padding-left) var(--icon-search-padding-right);
}

.search-input .icon-filter {
	margin-inline-end: var(--icon-filter-margin-right);
}

.search-input:focus-within,
.search-input:not(.disabled):not(.active):hover {
	border-color: var(--theme--form--field--input--border-color-hover);
}

.search-input.has-content {
	width: 11.25rem;
}

.search-input.has-content .icon-clear {
	margin-inline-end: 0.4375rem;
}

.search-input.has-content input {
	opacity: 1;
}

.search-input.has-content.show-filter .icon-clear {
	margin-inline-end: 0;
}

.search-input.active {
	width: 100%;
	border-color: var(--theme--form--field--input--border-color-focus);
}

@media (width > 22.5rem) {
	.search-input.active {
		width: 8.4375rem;
	}
}

@media (width >= 48rem) {
	.search-input.active {
		width: 11.25rem;
	}
}

.search-input.active input {
	opacity: 1;
}

.search-input.filter-active {
	width: 100%;
}

.search-input.filter-active .icon-filter {
	--v-icon-color: var(--theme--primary);
}

@media (width > 22.5rem) {
	.search-input.filter-active {
		width: 8.4375rem;
	}
}

@media (width >= 48rem) {
	.search-input.filter-active {
		width: 11.25rem;
	}
}

@media (width >= 54rem) {
	.search-input.filter-active {
		width: 16.875rem;
	}
}

@media (width >= 70.875rem) {
	.search-input.filter-active {
		width: 23.625rem;
	}
}

.search-input.filter-border {
	padding-block-end: var(--theme--border-width);
	border-block-end: none;
	border-bottom-right-radius: 0;
	border-bottom-left-radius: 0;
	transition:
		border-bottom-left-radius 0s,
		border-bottom-right-radius 0s;
}

.search-input.filter-border::after {
	position: absolute;
	inset-inline: var(--theme--border-width) var(--theme--border-width);
	bottom: calc(-1 * var(--theme--border-width));
	width: auto;
	height: var(--theme--border-width);
	background-color: var(--theme--border-color-subdued);
	content: '';
	pointer-events: none;
}

/* Allow the absolute filter panel to paint below the collapsed pill (upstream uses TransitionExpand). */
.search-input.filter-active,
.search-input.filter-border {
	overflow: visible;
}

.filter {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 10;
	width: auto;
	min-width: 100%;
	padding: 0;
	background-color: var(--theme--background-subdued);
	border: var(--theme--border-width) solid var(--theme--form--field--input--border-color);
	border-top-right-radius: 0;
	border-bottom-right-radius: var(--search-input-radius);
	border-bottom-left-radius: var(--search-input-radius);
}

.filter.active {
	border-color: var(--theme--form--field--input--border-color-focus);
}

.filter .filter-input {
	margin: 0.5625rem 0.4375rem;
}
</style>
