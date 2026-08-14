<template>
	<span v-if="value" class="storage-location-badge">{{ value }}</span>
</template>

<script setup lang="ts">
defineProps<{
	value?: string | null;
}>();
</script>

<style scoped>
.storage-location-badge {
	display: inline-flex;
	align-items: center;
	max-inline-size: 100%;
	padding: 2px 8px;
	overflow: hidden;
	font-size: 11px;
	font-weight: 600;
	line-height: 1.35;
	color: var(--theme--primary-foreground, var(--white, #fff));
	white-space: nowrap;
	text-overflow: ellipsis;
	background: var(--theme--primary);
	border: none;
	border-radius: var(--theme--border-radius);
}
</style>
