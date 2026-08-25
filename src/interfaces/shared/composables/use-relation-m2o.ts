import type { Field, Relation } from '@directus/types';
import { useStores } from '@directus/extensions-sdk';
import { computed, type Ref } from 'vue';

export type RelationM2O = {
	relation: Relation;
	relatedCollection: Record<string, any>;
	relatedPrimaryKeyField: Field;
	type: 'm2o';
};

export function useRelationM2O(collection: Ref<string>, field: Ref<string>) {
	const relationsStore = useStores().useRelationsStore();
	const collectionsStore = useStores().useCollectionsStore();
	const fieldsStore = useStores().useFieldsStore();

	const relationInfo = computed<RelationM2O | undefined>(() => {
		const relations = relationsStore.getRelationsForField(collection.value, field.value);
		if (!relations.length) return undefined;

		const relation = relations[0] as Relation;

		return {
			relation,
			relatedCollection: collectionsStore.getCollection(relation.related_collection),
			relatedPrimaryKeyField: fieldsStore.getPrimaryKeyFieldForCollection(relation.related_collection),
			type: 'm2o',
		} as RelationM2O;
	});

	return { relationInfo };
}
