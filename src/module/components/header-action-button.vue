<script setup lang="ts">
/**
 * Port of Directus PrivateViewHeaderBarActionButton (v11.17.4)
 * https://github.com/directus/directus/blob/v11.17.4/app/src/views/private/private-view/components/private-view-header-bar-action-button.vue
 *
 * File Library header actions are `icon rounded small` — not the default button size.
 */
defineProps<{
	icon: string;
	disabled?: boolean;
	loading?: boolean;
	secondary?: boolean;
	outlined?: boolean;
	to?: string | Record<string, unknown>;
	active?: boolean;
}>();

defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<v-button
		:disabled="disabled"
		:active="active"
		:loading="loading"
		:secondary="secondary"
		:outlined="outlined"
		:to="to"
		icon
		rounded
		small
		@click="$emit('click')"
	>
		<v-icon :name="icon" small />
	</v-button>
</template>
