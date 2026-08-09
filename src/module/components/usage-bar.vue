<template>
	<div class="usage-bar" :class="{ compact, plain }">
		<div class="usage-top">
			<span class="label">{{ label }}</span>
			<span class="value">{{ primaryText }}</span>
		</div>
		<div v-if="showMeter" class="track">
			<div class="fill" :style="{ width: `${clamped}%` }" :class="tone" />
		</div>
		<div v-if="secondaryText" class="secondary">{{ secondaryText }}</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes, formatPercent } from '../../shared/format';
import type { StorageUsage } from '../../shared/types';

const props = withDefaults(
	defineProps<{
		usage: Pick<
			StorageUsage,
			| 'total_bytes'
			| 'file_count'
			| 'disk_available'
			| 'disk_used_percent'
			| 'disk_used_bytes'
			| 'disk_total_bytes'
			| 'disk_free_bytes'
		>;
		label?: string;
		compact?: boolean;
		/** No card chrome — for sidebar panels */
		plain?: boolean;
	}>(),
	{
		label: 'Usage',
		compact: false,
		plain: false,
	},
);

const showMeter = computed(() => props.usage.disk_available && props.usage.disk_used_percent != null);

const clamped = computed(() => {
	const p = props.usage.disk_used_percent ?? 0;
	return Math.max(0, Math.min(100, p));
});

const tone = computed(() => {
	const p = clamped.value;
	if (p >= 90) return 'danger';
	if (p >= 75) return 'warning';
	return 'ok';
});

const primaryText = computed(() => {
	if (showMeter.value) {
		return `${formatPercent(props.usage.disk_used_percent)} used · ${formatBytes(props.usage.disk_used_bytes)} / ${formatBytes(props.usage.disk_total_bytes)}`;
	}
	return `${props.usage.file_count.toLocaleString()} files · ${formatBytes(props.usage.total_bytes)}`;
});

const secondaryText = computed(() => {
	if (showMeter.value) {
		return `${props.usage.file_count.toLocaleString()} files in Directus · ${formatBytes(props.usage.total_bytes)} · ${formatBytes(props.usage.disk_free_bytes)} free`;
	}
	return 'Cloud quota not available — showing Directus-tracked size';
});
</script>

<style scoped>
.usage-bar {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 12px 14px;
	background: var(--theme--background-subdued);
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.usage-bar.compact {
	padding: 8px 10px;
}

.usage-bar.plain {
	padding: 0;
	background: transparent;
	border: none;
	border-radius: 0;
}

.usage-top {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	align-items: baseline;
}

.label {
	font-weight: 600;
	color: var(--theme--foreground);
}

.value {
	font-size: 13px;
	color: var(--theme--foreground);
	text-align: right;
}

.track {
	height: 8px;
	border-radius: 999px;
	background: var(--theme--background-normal);
	overflow: hidden;
}

.fill {
	height: 100%;
	border-radius: inherit;
	transition: width 200ms ease;
}

.fill.ok {
	background: var(--theme--primary);
}

.fill.warning {
	background: var(--theme--warning);
}

.fill.danger {
	background: var(--theme--danger);
}

.secondary {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}
</style>
