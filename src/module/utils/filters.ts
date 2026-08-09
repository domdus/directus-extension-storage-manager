type Filter = Record<string, any>;

/** Same shape as Directus `getFolderFilter` for the File Library root / folder views. */
export function getFolderFilter(folder?: string | null): Filter {
	const filterParsed: Filter = {
		_and: [
			{
				type: {
					_nnull: true,
				},
			},
		],
	};

	if (folder) {
		filterParsed._and.push({
			folder: {
				_eq: folder,
			},
		});
	} else {
		filterParsed._and.push({
			folder: {
				_null: true,
			},
		});
	}

	return filterParsed;
}

/** Files on a single storage adapter (any folder). */
export function getStorageFilter(location: string): Filter {
	return {
		_and: [
			{
				type: {
					_nnull: true,
				},
			},
			{
				storage: {
					_eq: location,
				},
			},
		],
	};
}

export function mergeFilters(a: Filter | null | undefined, b: Filter | null | undefined): Filter | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return { _and: [a, b] };
}
