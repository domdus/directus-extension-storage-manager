import { ref, watch, type Ref } from 'vue';

const STORAGE_KEY = 'storage-manager-files-preset';

type LayoutOptions = Record<string, any>;
type LayoutQuery = Record<string, any>;

const systemDefaults = {
	layout: 'cards',
	layoutOptions: {
		icon: 'insert_drive_file',
		title: '{{ title }}',
		subtitle: '{{ type }} • {{ filesize }}',
		size: 4,
		imageFit: 'crop',
	} as LayoutOptions,
	layoutQuery: {
		sort: ['-uploaded_on'],
		page: 1,
		limit: 25,
	} as LayoutQuery,
};

function loadStored(): Partial<{
	layout: string;
	layoutOptions: LayoutOptions;
	layoutQuery: LayoutQuery;
}> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * Lightweight stand-in for Directus `usePreset('directus_files')`.
 * Persists layout / options / query locally so we don't depend on app-internal presets.
 *
 * Pagination + page size UI live inside host `layout-cards` / `layout-tabular`
 * (VPagination + per-page select: 25/50/100/250/500/1000). We only own `page`/`limit`
 * in layoutQuery — same contract as File Library.
 */
export function useFilesBrowserPreset() {
	const stored = loadStored();

	const layout = ref(stored.layout || systemDefaults.layout) as Ref<string>;
	const layoutOptions = ref({
		...systemDefaults.layoutOptions,
		...(stored.layoutOptions || {}),
	}) as Ref<LayoutOptions>;
	const layoutQuery = ref({
		...systemDefaults.layoutQuery,
		...(stored.layoutQuery || {}),
		// Always keep File Library pagination keys (layouts read these via useLayout).
		page: Math.max(1, Number(stored.layoutQuery?.page) || 1),
		limit: normalizeLimit(stored.layoutQuery?.limit),
	}) as Ref<LayoutQuery>;
	const filter = ref<Record<string, unknown> | null>(null);
	const search = ref<string | null>(null);

	watch(
		[layout, layoutOptions, layoutQuery],
		() => {
			try {
				localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({
						layout: layout.value,
						layoutOptions: layoutOptions.value,
						layoutQuery: {
							...layoutQuery.value,
							page: Math.max(1, Number(layoutQuery.value.page) || 1),
							limit: normalizeLimit(layoutQuery.value.limit),
						},
					}),
				);
			} catch {
				// ignore quota
			}
		},
		{ deep: true },
	);

	function resetPreset() {
		layout.value = systemDefaults.layout;
		layoutOptions.value = { ...systemDefaults.layoutOptions };
		layoutQuery.value = { ...systemDefaults.layoutQuery };
		filter.value = null;
		search.value = null;
	}

	function resetPage() {
		if (Number(layoutQuery.value.page) !== 1) {
			layoutQuery.value = { ...layoutQuery.value, page: 1 };
		}
	}

	return {
		layout,
		layoutOptions,
		layoutQuery,
		filter,
		search,
		resetPreset,
		resetPage,
	};
}

/** Same page-size options as Directus layout-cards / layout-tabular. */
const PAGE_SIZES = [25, 50, 100, 250, 500, 1000] as const;

function normalizeLimit(raw: unknown): number {
	const n = Number(raw);
	if (PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number])) return n;
	return 25;
}
