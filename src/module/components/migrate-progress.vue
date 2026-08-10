<template>
	<div class="progress-panel">
		<div class="route">
			<div class="adapter">
				<v-icon :name="fromIcon" />
				<span>{{ fromLabel }}</span>
			</div>
			<v-icon class="arrow" name="arrow_forward" />
			<div class="adapter">
				<v-icon :name="toIcon" />
				<span>{{ toLabel }}</span>
			</div>
			<v-chip x-small class="mode-chip">{{ modeLabel }}</v-chip>
		</div>

		<div class="file-line">
			<span class="file-count">File {{ currentIndex }} / {{ totalFiles }}</span>
			<span class="file-name" :title="currentName">{{ currentName || 'Preparing…' }}</span>
		</div>

		<div class="bar-wrap">
			<div class="bar-track">
				<div class="bar-fill" :style="{ width: `${percent}%` }" />
			</div>
			<div class="bar-meta">
				<strong>{{ percentRounded }}%</strong>
				<span>{{ formatBytes(transferredBytes) }} / {{ formatBytes(totalBytes) }}</span>
			</div>
		</div>

		<div class="stats">
			<div class="stat">
				<span class="stat-label">Speed</span>
				<span class="stat-value">{{ formatMbit(speedBps) }}</span>
			</div>
			<div class="stat">
				<span class="stat-label">Elapsed</span>
				<span class="stat-value">{{ formatDuration(elapsedMs) }}</span>
			</div>
			<div class="stat">
				<span class="stat-label">Status</span>
				<span class="stat-value">{{ statusLabel }}</span>
			</div>
		</div>

		<div class="counts">
			<span class="ok">{{ succeeded }} Ok</span>
			<span class="skip">{{ skipped }} Skipped</span>
			<span class="fail">{{ failed }} Failed</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes, formatDuration, formatMbit } from '../../shared/format';
import type { MigrateMode, StorageLocationInfo } from '../../shared/types';

const props = defineProps<{
	storages: StorageLocationInfo[];
	mode: MigrateMode;
	from: string | null;
	to: string;
	currentIndex: number;
	totalFiles: number;
	currentName: string;
	transferredBytes: number;
	totalBytes: number;
	elapsedMs: number;
	speedBps: number;
	succeeded: number;
	skipped: number;
	failed: number;
	isDone: boolean;
	isCancelled?: boolean;
}>();

function meta(location: string | null) {
	if (!location) return { short: '—', icon: 'storage' };
	const found = props.storages.find((s) => s.location === location);
	return found || { short: location, icon: 'storage', location };
}

const fromMeta = computed(() => meta(props.from));
const toMeta = computed(() => meta(props.to));
const fromLabel = computed(() => (props.from ? `${props.from} (${fromMeta.value.short})` : 'Mixed sources'));
const toLabel = computed(() => `${props.to} (${toMeta.value.short})`);
const fromIcon = computed(() => fromMeta.value.icon);
const toIcon = computed(() => toMeta.value.icon);
const modeLabel = computed(() => (props.mode === 'copy' ? 'Copy' : 'Move'));

const percent = computed(() => {
	if (props.totalBytes > 0) {
		return Math.max(0, Math.min(100, (props.transferredBytes / props.totalBytes) * 100));
	}
	if (props.totalFiles > 0) {
		return Math.max(0, Math.min(100, (props.currentIndex / props.totalFiles) * 100));
	}
	return 0;
});

const percentRounded = computed(() => Math.round(percent.value));

const statusLabel = computed(() => {
	if (!props.isDone) return 'Transferring';
	if (props.isCancelled) return 'Cancelled';
	if (props.failed > 0) return 'Completed with errors';
	return 'Completed';
});
</script>

<style scoped>
.progress-panel {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 16px;
	border-radius: var(--theme--border-radius);
	border: var(--theme--border-width) solid var(--theme--border-color);
	background: var(--theme--background-subdued);
}

.route {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px;
}

.adapter {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-weight: 600;
}

.arrow {
	color: var(--theme--foreground-subdued);
}

.mode-chip {
	margin-left: auto;
}

.file-line {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.file-count {
	font-size: 12px;
	font-weight: 700;
	letter-spacing: 0.02em;
	text-transform: uppercase;
	color: var(--theme--foreground-subdued);
}

.file-name {
	font-size: 14px;
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.bar-wrap {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.bar-track {
	height: 10px;
	border-radius: 999px;
	background: var(--theme--background-normal);
	overflow: hidden;
}

.bar-fill {
	height: 100%;
	border-radius: inherit;
	background: var(--theme--primary);
	transition: width 160ms ease;
}

.bar-meta {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	font-size: 13px;
}

.stats {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
}

.stat {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 8px 10px;
	border-radius: var(--theme--border-radius);
	background: var(--theme--background);
}

.stat-label {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.03em;
	color: var(--theme--foreground-subdued);
}

.stat-value {
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

.counts {
	display: flex;
	gap: 12px;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}

.counts .ok {
	color: var(--theme--success);
}

.counts .fail {
	color: var(--theme--danger);
}
</style>
