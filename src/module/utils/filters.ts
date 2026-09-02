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

/**
 * Files on a single storage adapter, limited to immediate children of `storagePath`
 * (File Library parity: folders + files in the same view, not recursive).
 *
 * Note: Directus string filters do **not** support `_regex` (validation-only), so we use
 * `_ncontains` / `_starts_with` / `_nstarts_with` instead. Do not filter transform
 * filenames with `_ncontains: '__'` — SQL LIKE treats `_` as a wildcard and excludes all rows.
 *
 * @param childFolderNames Immediate child folder names under `storagePath` (from browse).
 *        Used to exclude files that live under those subfolders when browsing a nested path.
 */
export function getStorageFilter(
	location: string,
	storagePath?: string | null,
	childFolderNames: string[] = [],
): Filter {
	const path = String(storagePath || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');

	const clauses: Filter[] = [
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
	];

	if (!path) {
		// Root: only files whose filename_disk has no directory separator.
		clauses.push({
			filename_disk: {
				_ncontains: '/',
			},
		});
	} else {
		// Nested: under this path…
		clauses.push({
			filename_disk: {
				_starts_with: `${path}/`,
			},
		});
		// …but not under any immediate child folder (those appear as folder cards).
		for (const name of childFolderNames) {
			const segment = String(name || '').trim();
			if (!segment || segment.includes('/')) continue;
			clauses.push({
				filename_disk: {
					_nstarts_with: `${path}/${segment}/`,
				},
			});
		}
	}

	return { _and: clauses };
}

/** All Recycle Bin files on one storage adapter (virtual `_Recycle` folder). */
export function getRecycleStorageFilter(location: string, recycleFolderId: string): Filter {
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
			{
				folder: {
					_eq: recycleFolderId,
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
