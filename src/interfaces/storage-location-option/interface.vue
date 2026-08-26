<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { onMounted, ref, watch } from 'vue';

type StorageChoice = {
	text: string;
	value: string;
};

const props = defineProps<{
	value?: string | null;
	disabled?: boolean;
}>();

const emit = defineEmits<{
	input: [value: string];
}>();

const api = useApi();
const choices = ref<StorageChoice[]>([]);
const loading = ref(true);

function emitValue(value: string | null | undefined) {
	const next = String(value || '').trim();
	if (next) emit('input', next);
}

onMounted(async () => {
	try {
		const res = await api.get('/storage-manager/storages');
		const rows = Array.isArray(res.data?.data) ? res.data.data : [];
		const next = rows
			.map((row: { location?: string; label?: string; short?: string; root?: string | null }) => {
				const value = String(row?.location || '').trim();
				if (!value) return null;
				const driver = String(row?.short || row?.label || '').trim();
				const text = driver && driver.toLowerCase() !== value.toLowerCase() ? `${value} (${driver})` : value;
				return { value, text };
			})
			.filter(Boolean) as StorageChoice[];

		if (next.length) {
			choices.value = next;
			const current = String(props.value || '').trim();
			if (!current || !next.some((c) => c.value === current)) {
				const preferred = next.find((c) => c.value === 'local')?.value || next[0]!.value;
				emitValue(preferred);
			}
			return;
		}
	} catch {
		// Fall back when the endpoint is unavailable.
	} finally {
		if (!choices.value.length) {
			choices.value = [{ value: 'local', text: 'local' }];
			if (!props.value) emitValue('local');
		}
		loading.value = false;
	}
});

watch(
	() => props.value,
	(value) => {
		if (!loading.value && !value && choices.value.length) {
			emitValue(choices.value.find((c) => c.value === 'local')?.value || choices.value[0]!.value);
		}
	},
);
</script>

<template>
	<v-select
		:model-value="value"
		:items="choices"
		item-text="text"
		item-value="value"
		:disabled="disabled || loading"
		:loading="loading"
		placeholder="Storage location"
		@update:model-value="emitValue"
	/>
</template>
