<script setup lang="ts">
/**
 * Read-only display of the configured Recycle Bin folder (Flow operation context).
 */
import { useApi } from '@directus/extensions-sdk';
import { onMounted, ref } from 'vue';

defineProps<{
	value?: string | null;
	disabled?: boolean;
}>();

const api = useApi();
const label = ref('Loading…');
const hint = ref('');
const loading = ref(true);

onMounted(async () => {
	try {
		const res = await api.get('/storage-manager/recycle');
		const data = res.data?.data || {};
		if (!data.enabled) {
			label.value = 'Recycle Bin is not enabled';
			hint.value = 'Enable it under Storage Manager → Recycle Bin before scheduling purge.';
			return;
		}
		const name = data.folder_name || data.folder_id || '—';
		const count = Number(data.file_count) || 0;
		label.value = `${name} (${count.toLocaleString()} file${count === 1 ? '' : 's'})`;
		hint.value = `Retention: ${Number(data.retention_days) || 30} days · folder id ${data.folder_id || '—'}`;
	} catch (err: any) {
		label.value = 'Could not load Recycle Bin status';
		hint.value = err?.response?.data?.errors?.[0]?.message || err?.message || '';
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<div class="recycle-folder-info">
		<v-skeleton-loader v-if="loading" type="input" />
		<template v-else>
			<v-input :model-value="label" disabled />
			<p v-if="hint" class="hint">{{ hint }}</p>
		</template>
	</div>
</template>

<style scoped>
.recycle-folder-info {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.hint {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--theme--foreground-subdued);
}
</style>
