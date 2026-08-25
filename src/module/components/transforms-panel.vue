<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { computed, ref, watch } from 'vue';
import { formatBytes } from '../../shared/format';

type TransformRow = {
	filename_disk: string;
	filesize: number;
	type: string | null;
};

const props = withDefaults(
	defineProps<{
		location: string;
		search?: string | null;
		compact?: boolean;
	}>(),
	{
		search: null,
		compact: false,
	},
);

const api = useApi();

const items = ref<TransformRow[]>([]);
const loading = ref(false);
const error = ref('');
const page = ref(1);
const limit = ref(50);
const hasMore = ref(false);

const pageSizes = [25, 50, 100];

const title = computed(() => (props.compact ? 'Generated Transforms' : 'Transforms'));

async function load() {
	loading.value = true;
	error.value = '';
	try {
		const res = await api.get(
			`/storage-manager/storages/${encodeURIComponent(props.location)}/root-transforms`,
			{
				params: {
					page: page.value,
					limit: limit.value,
					search: props.search?.trim() || undefined,
				},
			},
		);
		items.value = (res.data?.data || []) as TransformRow[];
		hasMore.value = Boolean(res.data?.meta?.has_more);
	} catch (err: any) {
		items.value = [];
		hasMore.value = false;
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Failed to load transforms';
	} finally {
		loading.value = false;
	}
}

watch(
	() => [props.location, props.search, page.value, limit.value] as const,
	() => {
		void load();
	},
	{ immediate: true },
);

watch(
	() => [props.location, props.search] as const,
	() => {
		page.value = 1;
	},
);

function prevPage() {
	if (page.value > 1) page.value -= 1;
}

function nextPage() {
	if (hasMore.value) page.value += 1;
}

defineExpose({ refresh: load });
</script>

<template>
	<section class="transforms-panel" :class="{ compact }">
		<div class="header">
			<h3 class="title">{{ title }}</h3>
			<p class="subtitle">Disk-only files at the storage root — not registered in Directus Files.</p>
		</div>

		<div v-if="loading" class="state">
			<v-progress-circular indeterminate small />
			<span>Loading transforms…</span>
		</div>

		<p v-else-if="error" class="state error">{{ error }}</p>

		<p v-else-if="!items.length" class="state empty">
			<template v-if="search?.trim()">No transforms match your search.</template>
			<template v-else>No generated transforms at the storage root.</template>
		</p>

		<div v-else class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>filename_disk</th>
						<th>Type</th>
						<th>Size</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="row in items" :key="row.filename_disk">
						<td class="name" :title="row.filename_disk">{{ row.filename_disk }}</td>
						<td>{{ row.type || '—' }}</td>
						<td>{{ formatBytes(row.filesize) }}</td>
					</tr>
				</tbody>
			</table>
		</div>

		<div v-if="items.length || page > 1" class="pager">
			<v-button secondary small :disabled="page <= 1 || loading" @click="prevPage">Previous</v-button>
			<span class="page-label">Page {{ page }}</span>
			<v-button secondary small :disabled="!hasMore || loading" @click="nextPage">Next</v-button>
			<v-select v-model="limit" class="limit-select" :items="pageSizes" inline />
		</div>
	</section>
</template>

<style scoped>
.transforms-panel {
	margin: 0 var(--content-padding, 16px) 24px;
	padding: 16px;
	background: var(--theme--background-subdued);
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
}

.transforms-panel.compact {
	margin-block-start: 16px;
	margin-block-end: 0;
}

.header {
	margin-bottom: 12px;
}

.title {
	margin: 0 0 4px;
	font-size: 14px;
	font-weight: 600;
}

.subtitle {
	margin: 0;
	font-size: 12px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.state {
	display: flex;
	align-items: center;
	gap: 10px;
	margin: 0;
	font-size: 13px;
	color: var(--theme--foreground-subdued);
}

.state.error {
	color: var(--theme--danger);
}

.table-wrap {
	overflow: auto;
	max-height: min(420px, 50vh);
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background);
}

table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
}

th,
td {
	padding: 8px 12px;
	text-align: start;
	border-bottom: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

th {
	position: sticky;
	top: 0;
	background: var(--theme--background-subdued);
	font-weight: 600;
}

.name {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 12px;
	word-break: break-all;
}

.pager {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-top: 12px;
	flex-wrap: wrap;
}

.page-label {
	font-size: 13px;
	color: var(--theme--foreground-subdued);
}

.limit-select {
	margin-inline-start: auto;
	min-width: 5rem;
}
</style>
