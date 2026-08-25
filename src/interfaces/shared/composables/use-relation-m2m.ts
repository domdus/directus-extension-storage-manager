import type { Field, Relation } from '@directus/types';
import { useStores } from '@directus/extensions-sdk';
import { computed, type Ref } from 'vue';

export type RelationM2M = {
	relation: Relation;
	relatedCollection: Record<string, any>;
	relatedPrimaryKeyField: Field;
	junctionCollection: Record<string, any>;
	junctionPrimaryKeyField: Field;
	junctionField: Field;
	reverseJunctionField: Field;
	junction: Relation;
	sortField?: string;
	type: 'm2m';
};

export function useRelationM2M(collection: Ref<string>, field: Ref<string>) {
	const relationsStore = useStores().useRelationsStore();
	const collectionsStore = useStores().useCollectionsStore();
	const fieldsStore = useStores().useFieldsStore();

	const relationInfo = computed<RelationM2M | undefined>(() => {
		const relations = relationsStore.getRelationsForField(collection.value, field.value);

		const junction = relations.find(
			(relation) =>
				relation.related_collection === collection.value &&
				relation.meta?.one_field === field.value &&
				relation.meta.junction_field,
		);

		if (!junction) return undefined;

		const relation = relations.find(
			(relation) => relation.collection === junction.collection && relation.field === junction.meta?.junction_field,
		);

		if (!relation) return undefined;

		return {
			relation,
			relatedCollection: collectionsStore.getCollection(relation.related_collection as string),
			relatedPrimaryKeyField: fieldsStore.getPrimaryKeyFieldForCollection(relation.related_collection as string),
			sortField: junction.meta?.sort_field ?? undefined,
			junctionCollection: collectionsStore.getCollection(junction.collection),
			junctionPrimaryKeyField: fieldsStore.getPrimaryKeyFieldForCollection(junction.collection),
			junctionField: fieldsStore.getField(junction.collection, junction.meta?.junction_field as string),
			reverseJunctionField: fieldsStore.getField(junction.collection, relation.meta?.junction_field as string),
			junction,
			type: 'm2m',
		} as RelationM2M;
	});

	return { relationInfo };
}
