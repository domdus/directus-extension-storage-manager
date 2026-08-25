import type { Field, Relation } from '@directus/types';
import { useStores } from '@directus/extensions-sdk';
import { computed, type Ref } from 'vue';

export type RelationM2A = {
	relation: Relation;
	junctionCollection: Record<string, any>;
	junctionPrimaryKeyField: Field;
	junctionField: Field;
	reverseJunctionField: Field;
	collectionField: Field;
	junction: Relation;
	sortField?: string;
	allowedCollections: Record<string, any>[];
	type: 'm2a';
	relationPrimaryKeyFields: Record<string, Field>;
};

export function useRelationM2A(collection: Ref<string>, field: Ref<string>) {
	const relationsStore = useStores().useRelationsStore();
	const collectionsStore = useStores().useCollectionsStore();
	const fieldsStore = useStores().useFieldsStore();

	const relationInfo = computed<RelationM2A | undefined>(() => {
		const relations = relationsStore.getRelationsForField(collection.value, field.value);

		const junction = relations.find(
			(relation) =>
				relation.related_collection === collection.value &&
				relation.meta?.one_field === field.value &&
				relation.meta.junction_field,
		);

		if (!junction) return undefined;

		const allowedCollections =
			junction.meta?.one_allowed_collections?.map((key: string) => collectionsStore.getCollection(key)) ?? [];

		const relationPrimaryKeyFields: Record<string, Field> = {};

		for (const allowed of allowedCollections) {
			if (!allowed?.collection) continue;
			relationPrimaryKeyFields[allowed.collection] = fieldsStore.getPrimaryKeyFieldForCollection(allowed.collection);
		}

		return {
			relation: junction,
			junctionCollection: collectionsStore.getCollection(junction.collection),
			junctionPrimaryKeyField: fieldsStore.getPrimaryKeyFieldForCollection(junction.collection),
			junctionField: fieldsStore.getField(junction.collection, junction.meta?.junction_field as string),
			reverseJunctionField: fieldsStore.getField(
				junction.collection,
				relations.find((r) => r.collection === junction.collection)?.meta?.junction_field as string,
			),
			collectionField: fieldsStore.getField(junction.collection, junction.meta?.one_collection_field as string),
			junction,
			sortField: junction.meta?.sort_field ?? undefined,
			allowedCollections,
			relationPrimaryKeyFields,
			type: 'm2a',
		} as RelationM2A;
	});

	return { relationInfo };
}
