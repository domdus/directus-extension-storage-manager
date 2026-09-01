<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { computed, onMounted, ref, watch } from 'vue';

type StorageChoice = {
	text: string;
	value: string;
};

const props = withDefaults(
	defineProps<{
		value?: string | null;
		disabled?: boolean;
		/** When true, allow empty selection (“All Storages”). */
		includeAll?: boolean;
	}>(),
	{
		includeAll: false,
	},
);

const emit = defineEmits<{
	input: [value: string | null];
}>();

const api = useApi();
const choices = ref<StorageChoice[]>([]);
const loading = ref(true);

const items = computed(() => {
	if (!props.includeAll) return choices.value;
	return [{ value: '', text: 'All Storages' }, ...choices.value];
});

function emitValue(value: string | null | undefined) {
	const next = value == null ? '' : String(value).trim();
	if (props.includeAll) {
		emit('input', next || null);
		return;
	}
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
			if (props.includeAll) {
				if (current && !next.some((c) => c.value === current)) {
					emitValue(null);
				}
				return;
			}
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
			if (!props.includeAll && !props.value) emitValue('local');
		}
		loading.value = false;
	}
});

watch(
	() => props.value,
	(value) => {
		if (loading.value || props.includeAll) return;
		if (!value && choices.value.length) {
			emitValue(choices.value.find((c) => c.value === 'local')?.value || choices.value[0]!.value);
		}
	},
);
</script>

<template>
	<v-select
		:model-value="value ?? ''"
		:items="items"
		item-text="text"
		item-value="value"
		:disabled="disabled || loading"
		:loading="loading"
		:placeholder="includeAll ? 'All Storages' : 'Storage location'"
		:show-deselect="includeAll"
		@update:model-value="emitValue"
	/>
</template>
