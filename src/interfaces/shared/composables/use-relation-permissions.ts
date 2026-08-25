import { computed, type Ref } from 'vue';
import type { RelationM2M } from './use-relation-m2m';
import type { RelationM2O } from './use-relation-m2o';

export function useRelationPermissionsM2O(_info: Ref<RelationM2O | undefined>) {
	return {
		createAllowed: computed(() => true),
		updateAllowed: computed(() => true),
	};
}

export function useRelationPermissionsM2M(_info: Ref<RelationM2M | undefined>) {
	return {
		createAllowed: computed(() => true),
		selectAllowed: computed(() => true),
		updateAllowed: computed(() => true),
		deleteAllowed: computed(() => true),
	};
}
