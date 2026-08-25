import { getEndpoint } from '@directus/utils';
import { useApi } from '@directus/extensions-sdk';
import { merge } from 'lodash-es';
import { computed, ref, type MaybeRefOrGetter, type Ref, toValue, watch } from 'vue';
import type { RelationM2O } from './use-relation-m2o';
import { unexpectedError } from '../utils/unexpected-error';

export type RelationQuerySingle = {
	fields: string[];
};

export function useRelationSingle<T extends Record<string, any>>(
	value: Ref<number | string | Record<string, any> | null>,
	previewQuery: Ref<RelationQuerySingle>,
	relation: Ref<RelationM2O | undefined>,
	options?: { enabled?: MaybeRefOrGetter<boolean> },
) {
	const api = useApi();
	const displayItem: Ref<T | null> = ref(null);
	const loading = ref(false);
	const enabled = computed(() => (options?.enabled === undefined ? true : toValue(options?.enabled)));

	watch([value, previewQuery, relation, enabled], () => {
		if (enabled.value) void getDisplayItem();
	}, { immediate: true });

	return { update, remove, refresh, displayItem, loading };

	function update(item: Record<string, any> | string | number) {
		if (!relation.value) return;
		const pkField = relation.value.relatedPrimaryKeyField.field;

		if (value.value && typeof item === 'object' && !(pkField in item)) {
			const existingPk: string | number = typeof value.value === 'object' ? value.value[pkField] : value.value;
			item[pkField] = existingPk;
		}

		value.value = item;
	}

	function remove() {
		value.value = null;
	}

	async function refresh() {
		await getDisplayItem();
	}

	async function getDisplayItem() {
		const val = value.value;
		if (!val) {
			displayItem.value = null;
			return;
		}

		if (!relation.value) return;

		const relatedCollection = relation.value.relatedCollection.collection;
		const pkField = relation.value.relatedPrimaryKeyField.field;
		const id = typeof val === 'object' ? val[pkField] : val;

		if (!id) {
			displayItem.value = val as T;
			return;
		}

		const fields = new Set(previewQuery.value.fields);
		fields.add(pkField);
		loading.value = true;

		try {
			const response = await api.get(`${getEndpoint(relatedCollection)}/${encodeURIComponent(String(id))}`, {
				params: { fields: Array.from(fields) },
			});
			const item = response.data?.data as T;
			displayItem.value = typeof val === 'object' ? merge({}, item, val) : item;
		} catch (error: any) {
			if (typeof val === 'object' && error?.response?.status === 403) {
				displayItem.value = val as T;
			} else {
				unexpectedError(error);
			}
		} finally {
			loading.value = false;
		}
	}
}
