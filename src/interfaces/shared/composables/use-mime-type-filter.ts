import type { Filter } from '@directus/types';
import { useStores } from '@directus/extensions-sdk';
import { computed, type MaybeRef, unref } from 'vue';

function parseGlobalMimeTypeAllowList(allowList: string[] | undefined): string[] | undefined {
	if (!allowList?.length) return undefined;
	if (allowList.length === 1 && allowList[0] === '*/*') return undefined;
	return allowList;
}

function intersectMimeTypes(interfaceTypes: string[], globalTypes: string[]): string[] {
	const result: string[] = [];

	for (const interfaceType of interfaceTypes) {
		const isAllowed = globalTypes.some((globalType) => {
			if (globalType.endsWith('/*')) return interfaceType.startsWith(globalType.slice(0, -1));
			if (interfaceType.endsWith('/*')) return globalType.startsWith(interfaceType.slice(0, -1));
			return interfaceType === globalType;
		});

		if (isAllowed) result.push(interfaceType);
	}

	return [...new Set(result)];
}

export function useMimeTypeFilter(allowedMimeTypes: MaybeRef<string[] | undefined>) {
	const globalMimeTypes = computed(() =>
		parseGlobalMimeTypeAllowList(useStores().useServerStore().info?.files?.mimeTypeAllowList),
	);

	const mimeTypeFilter = computed<Filter | null>(() => {
		const types = unref(allowedMimeTypes);
		if (!types?.length) return null;

		const mimeFilters = types.map((mimeType) => {
			if (mimeType.endsWith('/*')) {
				return { type: { _starts_with: mimeType.slice(0, -1) } };
			}
			return { type: { _eq: mimeType } };
		});

		return mimeFilters.length === 1 ? (mimeFilters[0] as Filter) : { _or: mimeFilters };
	});

	const combinedAcceptString = computed(() => {
		const interfaceTypes = unref(allowedMimeTypes);
		const globalTypes = globalMimeTypes.value;

		if (!globalTypes?.length) return interfaceTypes?.join(',');
		if (!interfaceTypes?.length) return globalTypes.join(',');

		const intersection = intersectMimeTypes(interfaceTypes, globalTypes);
		return intersection.length ? intersection.join(',') : globalTypes.join(',');
	});

	return { mimeTypeFilter, combinedAcceptString };
}
