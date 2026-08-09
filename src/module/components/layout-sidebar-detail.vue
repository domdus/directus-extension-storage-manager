<script setup lang="ts">
/**
 * Simplified port of Directus layout-sidebar-detail.vue (v11.17.0)
 * Lists host-registered layouts (cards / tabular) without app-internal useExtensions.
 */
import { computed } from 'vue';

const props = defineProps<{
	modelValue: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
}>();

const layout = computed({
	get() {
		return props.modelValue ?? 'cards';
	},
	set(value: string) {
		emit('update:modelValue', value);
	},
});

const layouts = [
	{ text: 'Cards', value: 'cards', icon: 'grid_view' },
	{ text: 'Table', value: 'tabular', icon: 'table_rows' },
];
</script>

<template>
	<sidebar-detail id="layout" icon="layers" title="Layout Options">
		<div class="layout-options">
			<div class="field">
				<div class="type-label">Layout</div>
				<v-select v-model="layout" :items="layouts" item-text="text" item-value="value" item-icon="icon" />
			</div>
			<slot />
		</div>
	</sidebar-detail>
</template>

<style scoped>
.layout-options {
	--theme--form--row-gap: 1.125rem;
	margin-bottom: 0.25rem;
	display: flex;
	flex-direction: column;
	gap: var(--theme--form--row-gap);
}

.field {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.type-label {
	font-weight: 600;
	font-size: 13px;
}
</style>
