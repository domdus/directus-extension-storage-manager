import { useApi, useStores } from '@directus/extensions-sdk';
import type { Field, Item } from '@directus/types';
import { computed, ref, watch, type Ref } from 'vue';
import type { LayoutOptions, LayoutQuery } from './use-files-browser-preset';

type TransformRow = {
	filename_disk: string;
	filesize: number;
	type: string | null;
};

const COLLECTION = 'directus_files';
const DEFAULT_FIELDS = ['filename_disk', 'type', 'filesize'] as const;
const ALLOWED_FIELDS = new Set([...DEFAULT_FIELDS, 'title']);

function normalizeLimit(raw: unknown): number {
	const n = Number(raw);
	const sizes = [25, 50, 100, 250, 500, 1000];
	if (sizes.includes(n)) return n;
	return 25;
}

function toLayoutItems(rows: TransformRow[]): Item[] {
	return rows.map((row) => ({
		id: row.filename_disk,
		filename_disk: row.filename_disk,
		title: row.filename_disk,
		type: row.type,
		filesize: row.filesize,
	}));
}

export function useRootTransformsLayout(options: {
	location: Ref<string | undefined>;
	search: Ref<string | null>;
	layout: Ref<string>;
	layoutOptions: Ref<LayoutOptions>;
	layoutQuery: Ref<LayoutQuery>;
	resetPreset: () => void;
}) {
	const api = useApi();
	const { useFieldsStore, useCollectionsStore } = useStores();
	const fieldsStore = useFieldsStore();
	const collectionsStore = useCollectionsStore();

	const items = ref<Item[]>([]);
	const loading = ref(false);
	const loadingItemCount = ref(false);
	const error = ref<unknown>(null);
	const totalCount = ref<number | null>(null);
	const cardsWidth = ref(0);

	const page = computed({
		get: () => Math.max(1, Number(options.layoutQuery.value.page) || 1),
		set(value: number) {
			options.layoutQuery.value = { ...options.layoutQuery.value, page: Math.max(1, value) };
		},
	});

	const limit = computed({
		get: () => normalizeLimit(options.layoutQuery.value.limit),
		set(value: number) {
			options.layoutQuery.value = { ...options.layoutQuery.value, limit: normalizeLimit(value), page: 1 };
		},
	});

	const fields = computed({
		get() {
			const raw = options.layoutQuery.value.fields;
			if (Array.isArray(raw) && raw.length) {
				const filtered = raw.filter((field) => ALLOWED_FIELDS.has(String(field)));
				if (filtered.length) return filtered;
			}
			return [...DEFAULT_FIELDS];
		},
		set(value: string[]) {
			options.layoutQuery.value = { ...options.layoutQuery.value, fields: value };
		},
	});

	const sort = computed({
		get: () => (Array.isArray(options.layoutQuery.value.sort) ? options.layoutQuery.value.sort : []),
		set(value: string[]) {
			options.layoutQuery.value = { ...options.layoutQuery.value, sort: value };
		},
	});

	const tableSpacing = computed({
		get: () => options.layoutOptions.value?.spacing || 'cozy',
		set(value: 'compact' | 'cozy' | 'comfortable') {
			options.layoutOptions.value = { ...options.layoutOptions.value, spacing: value };
		},
	});

	const tableRowHeight = computed(() => {
		switch (tableSpacing.value) {
			case 'compact':
				return 32;
			case 'comfortable':
				return 48;
			default:
				return 40;
		}
	});

	const primaryKeyField = computed(() => fieldsStore.getPrimaryKeyFieldForCollection(COLLECTION));
	const fieldsInCollection = computed(() => fieldsStore.getFieldsForCollection(COLLECTION));
	const info = computed(() => collectionsStore.getCollection(COLLECTION));

	const activeFields = computed(() =>
		fields.value
			.map((key) => {
				const field = fieldsStore.getField(COLLECTION, key);
				if (!field) return null;
				return { ...field, key };
			})
			.filter(Boolean) as Array<Field & { key: string }>,
	);

	const tableHeaders = computed(() =>
		activeFields.value.map((field) => ({
			text: field.name,
			value: field.key,
			description: null,
			width: options.layoutOptions.value?.widths?.[field.key] || 144,
			align: options.layoutOptions.value?.align?.[field.key] || 'left',
			field: {
				display: field.meta?.display,
				displayOptions: field.meta?.display_options,
				interface: field.meta?.interface,
				interfaceOptions: field.meta?.options,
				type: field.type,
				field: field.field,
				collection: field.collection,
			},
		})),
	);

	const tableSort = computed(() => {
		const raw = sort.value?.[0];
		if (!raw) return null;
		if (raw.startsWith('-')) return { by: raw.slice(1), desc: true };
		return { by: raw, desc: false };
	});

	const itemCount = computed(() => items.value.length);

	const totalPages = computed(() => {
		if (!totalCount.value) return 1;
		return Math.max(1, Math.ceil(totalCount.value / limit.value));
	});

	const showingCount = computed(() => {
		if (!totalCount.value || !itemCount.value) return;
		const start = (page.value - 1) * limit.value + 1;
		const end = start + itemCount.value - 1;
		if (totalCount.value <= end) return `${start}–${totalCount.value} of ${totalCount.value}`;
		return `${start}–${end} of ${totalCount.value}`;
	});

	const size = computed({
		get: () => Number(options.layoutOptions.value?.size) || 4,
		set(value: number) {
			options.layoutOptions.value = { ...options.layoutOptions.value, size: value };
		},
	});

	const icon = computed(() => options.layoutOptions.value?.icon || 'insert_drive_file');
	const imageFit = computed(() => options.layoutOptions.value?.imageFit || 'crop');
	const titleTemplate = computed(() => options.layoutOptions.value?.title || '{{ title }}');
	const subtitleTemplate = computed(() => options.layoutOptions.value?.subtitle || '{{ type }} • {{ filesize }}');

	const isSingleRow = computed(() => {
		const cards = Math.max(1, Math.ceil(items.value.length / Math.max(1, size.value)));
		return cards <= 1 && cardsWidth.value > 0;
	});

	let loadGeneration = 0;

	async function loadCount() {
		if (!options.location.value) {
			totalCount.value = 0;
			return;
		}

		loadingItemCount.value = true;
		try {
			const res = await api.get(
				`/storage-manager/storages/${encodeURIComponent(options.location.value)}/root-transforms/count`,
				{ params: { search: options.search.value?.trim() || undefined } },
			);
			totalCount.value = Number(res.data?.data?.count) || 0;
		} catch {
			totalCount.value = null;
		} finally {
			loadingItemCount.value = false;
		}
	}

	async function loadItems() {
		if (!options.location.value) {
			items.value = [];
			return;
		}

		const generation = ++loadGeneration;
		loading.value = true;
		error.value = null;

		try {
			const res = await api.get(
				`/storage-manager/storages/${encodeURIComponent(options.location.value)}/root-transforms`,
				{
					params: {
						page: page.value,
						limit: limit.value,
						search: options.search.value?.trim() || undefined,
					},
				},
			);

			if (generation !== loadGeneration) return;

			const rows = (res.data?.data || []) as TransformRow[];
			items.value = toLayoutItems(rows);
		} catch (err) {
			if (generation !== loadGeneration) return;
			items.value = [];
			error.value = err;
		} finally {
			if (generation === loadGeneration) loading.value = false;
		}
	}

	async function refresh() {
		await Promise.all([loadItems(), loadCount()]);
	}

	function toPage(newPage: number) {
		page.value = newPage;
	}

	function onSortChange(newSort: { by: string; desc: boolean }) {
		sort.value = [newSort.desc ? `-${newSort.by}` : newSort.by];
		page.value = 1;
	}

	async function resetPresetAndRefresh() {
		options.resetPreset();
		page.value = 1;
		await refresh();
	}

	function selectAll() {
		// Read-only thumbnails view — no selection.
	}

	watch(
		() =>
			[
				options.location.value,
				options.search.value,
				page.value,
				limit.value,
			] as const,
		() => {
			void loadItems();
		},
		{ immediate: true },
	);

	watch(
		() => [options.location.value, options.search.value] as const,
		() => {
			page.value = 1;
			void loadCount();
		},
		{ immediate: true },
	);

	const transformsLayoutState = computed(() => ({
		collection: COLLECTION,
		items: items.value,
		loading: loading.value,
		loadingItemCount: loadingItemCount.value,
		error: error.value,
		totalPages: totalPages.value,
		page: page.value,
		toPage,
		itemCount: itemCount.value,
		totalCount: totalCount.value,
		limit: limit.value,
		fields: fields.value,
		tableHeaders: tableHeaders.value,
		tableSort: tableSort.value,
		tableRowHeight: tableRowHeight.value,
		tableSpacing: tableSpacing.value,
		activeFields: activeFields.value,
		primaryKeyField: primaryKeyField.value,
		fieldsInCollection: fieldsInCollection.value,
		info: info.value,
		showingCount: showingCount.value,
		sortField: 'filename_disk',
		readonly: true,
		showSelect: 'none' as const,
		selectMode: false,
		selection: [] as Item[],
		filterUser: null,
		search: options.search.value || undefined,
		aliasedFields: {},
		aliasedKeys: [] as string[],
		onRowClick: () => undefined,
		onSortChange,
		onAlignChange: () => undefined,
		changeManualSort: async () => undefined,
		resetPresetAndRefresh,
		selectAll,
		refresh,
		download: () => undefined,
		// Cards layout
		size: size.value,
		icon: icon.value,
		imageFit: imageFit.value,
		title: titleTemplate.value,
		subtitle: subtitleTemplate.value,
		imageSource: undefined,
		getLinkForItem: () => undefined,
		isSingleRow: isSingleRow.value,
		width: cardsWidth.value,
		sort: sort.value,
		hasPrependContent: false,
		fileFields: [] as string[],
	}));

	function onLayoutWidth(value: number) {
		cardsWidth.value = value;
	}

	function onLimitUpdate(value: number) {
		limit.value = value;
	}

	function onFieldsUpdate(value: string[]) {
		fields.value = value;
	}

	function onTableSpacingUpdate(value: 'compact' | 'cozy' | 'comfortable') {
		tableSpacing.value = value;
	}

	function onSizeUpdate(value: number) {
		size.value = value;
	}

	function onSortUpdate(value: string[]) {
		sort.value = value;
	}

	return {
		transformsLayoutState,
		refreshTransforms: refresh,
		onLayoutWidth,
		onLimitUpdate,
		onFieldsUpdate,
		onTableSpacingUpdate,
		onSizeUpdate,
		onSortUpdate,
	};
}
