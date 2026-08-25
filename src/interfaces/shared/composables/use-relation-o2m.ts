import type { Field, Relation } from '@directus/types';
import { useStores } from '@directus/extensions-sdk';
import { computed, type Ref } from 'vue';

export type RelationO2M = {
	relation: Relation;
	relatedCollection: Record<string, any>;
	relatedPrimaryKeyField: Field;
	reverseJunctionField: Field;
	sortField?: string;
	type: 'o2m';
};

export function useRelationO2M(collection: Ref<string>, field: Ref<string>) {
	const relationsStore = useStores().useRelationsStore();
	const collectionsStore = useStores().useCollectionsStore();
	const fieldsStore = useStores().useFieldsStore();

	const relationInfo = computed<RelationO2M | undefined>(() => {
		const relation = relationsStore.getRelationsForField(collection.value, field.value)?.[0];
		if (!relation) return undefined;

		return {
			relation,
			relatedCollection: collectionsStore.getCollection(relation.related_collection),
			relatedPrimaryKeyField: fieldsStore.getPrimaryKeyFieldForCollection(relation.related_collection),
			reverseJunctionField: fieldsStore.getField(relation.related_collection, relation.meta?.one_field as string),
			sortField: relation.meta?.sort_field ?? undefined,
			type: 'o2m',
		} as RelationO2M;
	});

	return { relationInfo };
}
