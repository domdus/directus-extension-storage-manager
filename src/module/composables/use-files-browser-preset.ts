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
						layoutQuery: layoutQuery.value,
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

	return {
		layout,
		layoutOptions,
		layoutQuery,
		filter,
		search,
		resetPreset,
	};
}
