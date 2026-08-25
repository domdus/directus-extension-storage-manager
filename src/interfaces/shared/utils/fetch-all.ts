import { useApi, useStores } from '@directus/extensions-sdk';
import { cloneDeep, set } from 'lodash-es';

export async function fetchAll<T = unknown>(
	url: Parameters<ReturnType<typeof useApi>['get']>[0],
	config: Parameters<ReturnType<typeof useApi>['get']>[1] = {},
	limit = Infinity,
): Promise<T[]> {
	const api = useApi();
	const { info } = useStores().useServerStore();

	let page = 1;
	let hasMore = true;

	if (!info.queryLimit || info.queryLimit?.max === -1) {
		set(config, 'params.limit', -1);
		const { data } = await api.get(url, config);
		return (data.data ?? []) as T[];
	}

	const pageSize = info.queryLimit!.max;
	const result: T[] = [];

	while (result.length < limit && hasMore) {
		const configWithPagination = cloneDeep(config);
		set(configWithPagination, 'params.page', page);
		set(configWithPagination, 'params.limit', pageSize);

		const { data } = await api.get(url, configWithPagination);

		if (!data.data?.length) {
			hasMore = false;
		} else {
			result.push(...data.data);
		}

		page++;
	}

	return Number.isFinite(limit) ? result.slice(0, limit) : result;
}
