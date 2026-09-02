import { useApi, useStores } from '@directus/extensions-sdk';
import type { Field, Item } from '@directus/types';
import { computed, ref, watch, type Ref } from 'vue';
import type { LayoutOptions, LayoutQuery } from './use-files-browser-preset';

const COLLECTION = 'directus_files';
/** Match File Library tabular defaults — `$thumbnail` is the fake self-m2o cards/list use for previews. */
const DEFAULT_FIELDS = ['$thumbnail', 'title', 'type', 'filesize', 'modified_on', 'storage'] as const;

function normalizeLimit(raw: unknown): number {
	const n = Number(raw);
	const sizes = [25, 50, 100, 250, 500, 1000];
	if (sizes.includes(n)) return n;
	return 25;
}

/**
 * Host layout-cards / layout-tabular fed by `/storage-manager/unreferenced/items`
 * (scan session + SQL paging — no giant `id._in` querystrings).
 */
export function useUnreferencedFilesLayout(options: {
	scanId: Ref<string | null>;
	search: Ref<string | null>;
	filter: Ref<Record<string, unknown> | null>;
	layout: Ref<string>;
	layoutOptions: Ref<LayoutOptions>;
	layoutQuery: Ref<LayoutQuery>;
	selection: Ref<(string | number)[]>;
	resetPreset: () => void;
	fileDetailPath: (id: string | number) => string;
	routerPush: (path: string) => void;
	openInNewTab: (href: string) => void;
	resolveHref: (path: string) => string;
}) {
	const api = useApi();
	const { useFieldsStore, useCollectionsStore } = useStores();
	const fieldsStore = useFieldsStore();
	const collectionsStore = useCollectionsStore();

	const items = ref<Item[]>([]);
	const loading = ref(false);
	const loadingItemCount = ref(false);
	const error = ref<unknown>(null);
	const sessionExpired = ref(false);
	const totalCount = ref<number | null>(null);
	const totalBytes = ref<number | null>(null);
	const resultsFiltered = ref(false);
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
			options.layoutQuery.value = {
				...options.layoutQuery.value,
				limit: normalizeLimit(value),
				page: 1,
			};
		},
	});

	const fields = computed({
		get() {
			const raw = options.layoutQuery.value.fields;
			if (Array.isArray(raw) && raw.length) return raw.map(String);
			return [...DEFAULT_FIELDS];
		},
		set(value: string[]) {
			options.layoutQuery.value = { ...options.layoutQuery.value, fields: value };
		},
	});

	const sort = computed({
		get: () => (Array.isArray(options.layoutQuery.value.sort) ? options.layoutQuery.value.sort : ['-uploaded_on']),
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

	function applyTableHeaders(val: Array<{ value?: string; width?: number }>) {
		const nextFields = val.map((header) => String(header?.value || '')).filter(Boolean);
		const widths: Record<string, number> = { ...(options.layoutOptions.value?.widths || {}) };
		for (const header of val) {
			if (!header?.value) continue;
			widths[header.value] = header.width != null && Number.isFinite(Number(header.width))
				? Number(header.width)
				: widths[header.value] || 160;
		}
		options.layoutOptions.value = { ...options.layoutOptions.value, widths };
		if (nextFields.length) fields.value = nextFields;
	}

	const tableHeaders = computed({
		get() {
			return activeFields.value.map((field) => ({
				text: field.name,
				value: field.key,
				description: null,
				width: options.layoutOptions.value?.widths?.[field.key] || 160,
				align: options.layoutOptions.value?.align?.[field.key] || 'left',
				sortable:
					field.field !== '$thumbnail' &&
					!['json', 'alias', 'presentation', 'translations'].includes(String(field.type)),
				field: {
					display: field.meta?.display,
					displayOptions: field.meta?.display_options,
					interface: field.meta?.interface,
					interfaceOptions: field.meta?.options,
					type: field.type,
					field: field.field,
					collection: field.collection,
				},
			}));
		},
		set(val: Array<{ value: string; width?: number }>) {
			applyTableHeaders(val);
		},
	});

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

	const icon = computed({
		get: () => options.layoutOptions.value?.icon || 'insert_drive_file',
		set(value: string) {
			options.layoutOptions.value = { ...options.layoutOptions.value, icon: value };
		},
	});

	const imageFit = computed({
		get: () => options.layoutOptions.value?.imageFit || 'crop',
		set(value: string) {
			options.layoutOptions.value = { ...options.layoutOptions.value, imageFit: value };
		},
	});

	const titleTemplate = computed({
		get: () => options.layoutOptions.value?.title || '{{ title }}',
		set(value: string) {
			options.layoutOptions.value = { ...options.layoutOptions.value, title: value };
		},
	});

	const subtitleTemplate = computed({
		get: () => options.layoutOptions.value?.subtitle || '{{ type }} • {{ filesize }}',
		set(value: string) {
			options.layoutOptions.value = { ...options.layoutOptions.value, subtitle: value };
		},
	});

	/**
	 * Cards pass `item[imageSource]` into layout-card as `file` (needs `{ id, type, modified_on }`).
	 * Native File Library defaults to `$thumbnail`; we used to default to `id` (UUID string) so
	 * thumbnails never rendered and `/assets` was never requested.
	 */
	const imageSource = computed({
		get() {
			const raw = options.layoutOptions.value?.imageSource;
			if (!raw || raw === 'id') return '$thumbnail';
			return raw;
		},
		set(value: string | null) {
			options.layoutOptions.value = { ...options.layoutOptions.value, imageSource: value };
		},
	});

	const fileFields = computed(() => {
		const thumb = fieldsStore.getField(COLLECTION, '$thumbnail');
		return thumb ? [thumb] : [];
	});

	function onAlignChange(field: string, align: 'left' | 'center' | 'right') {
		options.layoutOptions.value = {
			...options.layoutOptions.value,
			align: { ...(options.layoutOptions.value?.align || {}), [field]: align },
		};
	}

	function onWidthChange(field: string, width: number) {
		options.layoutOptions.value = {
			...options.layoutOptions.value,
			widths: { ...(options.layoutOptions.value?.widths || {}), [field]: width },
		};
	}

	/** Same formula as File Library layout-cards — few items stay at `--size`, they do not stretch. */
	const isSingleRow = computed(() => {
		const count = items.value.length;
		if (count === 0 || cardsWidth.value <= 0) return true;
		const needed = count * (size.value * 40) + Math.max(0, count - 1) * 24;
		return needed <= cardsWidth.value;
	});

	let loadGeneration = 0;

	async function loadItems() {
		if (!options.scanId.value) {
			items.value = [];
			totalCount.value = 0;
			totalBytes.value = 0;
			resultsFiltered.value = false;
			return;
		}

		const generation = ++loadGeneration;
		loading.value = true;
		loadingItemCount.value = true;
		error.value = null;

		try {
			const res = await api.get('/storage-manager/unreferenced/items', {
				params: {
					scan_id: options.scanId.value,
					page: page.value,
					limit: limit.value,
					search: options.search.value?.trim() || undefined,
					filter: options.filter.value ? JSON.stringify(options.filter.value) : undefined,
					sort: sort.value?.[0],
				},
			});

			if (generation !== loadGeneration) return;

			sessionExpired.value = false;
			const rows = (res.data?.data || []) as Item[];
			items.value = rows.map((row) => ({
				...row,
				$thumbnail: row,
			}));
			totalCount.value = Number(res.data?.meta?.total_count) || 0;
			totalBytes.value =
				res.data?.meta?.total_bytes != null ? Number(res.data.meta.total_bytes) || 0 : null;
			resultsFiltered.value = Boolean(res.data?.meta?.filtered);
		} catch (err: any) {
			if (generation !== loadGeneration) return;
			items.value = [];
			totalCount.value = 0;
			totalBytes.value = null;
			resultsFiltered.value = false;

			const status = Number(err?.response?.status) || 0;
			const message = String(err?.response?.data?.errors?.[0]?.message || err?.message || '');
			const expired =
				status === 404 ||
				/scan session not found|expired/i.test(message);

			if (expired) {
				sessionExpired.value = true;
				error.value = null;
				// Stop retrying a dead session id on every page/filter change.
				options.scanId.value = null;
			} else {
				sessionExpired.value = false;
				error.value = err;
			}
		} finally {
			if (generation === loadGeneration) {
				loading.value = false;
				loadingItemCount.value = false;
			}
		}
	}

	async function refresh() {
		await loadItems();
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
		const pk = primaryKeyField.value?.field || 'id';
		options.selection.value = items.value.map((item) => item[pk]).filter((id) => id != null);
	}

	function getLinkForItem(item: Record<string, any>) {
		const pk = primaryKeyField.value?.field || 'id';
		const id = item?.[pk];
		if (id == null) return;
		return options.fileDetailPath(id);
	}

	function onRowClick({ item, event }: { item: Record<string, any>; event: MouseEvent }) {
		const pk = primaryKeyField.value?.field || 'id';
		const primaryKey = item?.[pk];
		if (primaryKey == null) return;

		if (options.selection.value.length > 0) {
			if (!options.selection.value.includes(primaryKey)) {
				options.selection.value = options.selection.value.concat(primaryKey);
			} else {
				options.selection.value = options.selection.value.filter((key) => key !== primaryKey);
			}
			return;
		}

		const path = options.fileDetailPath(primaryKey);
		if (event.ctrlKey || event.metaKey) options.openInNewTab(options.resolveHref(path));
		else options.routerPush(path);
	}

	watch(
		() =>
			[
				options.scanId.value,
				options.search.value,
				JSON.stringify(options.filter.value || null),
				page.value,
				limit.value,
				JSON.stringify(sort.value || []),
			] as const,
		() => {
			void loadItems();
		},
		{ immediate: true },
	);

	watch(
		() => [options.search.value, JSON.stringify(options.filter.value || null)] as const,
		() => {
			page.value = 1;
		},
	);

	const layoutState = computed(() => ({
		collection: COLLECTION,
		items: items.value,
		loading: loading.value,
		loadingItemCount: loadingItemCount.value,
		error: error.value,
		totalPages: totalPages.value,
		page: page.value,
		toPage,
		itemCount: totalCount.value,
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
		sortField: null,
		readonly: false,
		showSelect: 'multiple' as const,
		selectMode: options.selection.value.length > 0,
		selection: options.selection.value,
		filterUser: options.filter.value,
		search: options.search.value || undefined,
		aliasedFields: {},
		aliasedKeys: [] as string[],
		onRowClick,
		onSortChange,
		onAlignChange,
		onWidthChange,
		'onUpdate:tableHeaders': applyTableHeaders,
		'onUpdate:activeFields': (value: Array<{ field?: string; key?: string }>) => {
			const next = value.map((field) => String(field.field || field.key || '')).filter(Boolean);
			if (next.length) fields.value = next;
		},
		changeManualSort: async () => undefined,
		resetPresetAndRefresh,
		selectAll,
		refresh,
		download: () => undefined,
		size: size.value,
		icon: icon.value,
		imageFit: imageFit.value,
		title: titleTemplate.value,
		subtitle: subtitleTemplate.value,
		imageSource: imageSource.value,
		getLinkForItem,
		isSingleRow: isSingleRow.value,
		width: cardsWidth.value,
		sort: sort.value,
		hasPrependContent: false,
		fileFields: fileFields.value,
		/**
		 * Directus layout-options / layout components emit `update:X`.
		 * Host `createLayoutWrapper` exposes matching `onUpdate:X` on layoutState —
		 * without these, sidebar option changes are ignored.
		 */
		'onUpdate:size': (value: number) => {
			size.value = value;
		},
		'onUpdate:icon': (value: string) => {
			icon.value = value;
		},
		'onUpdate:imageFit': (value: string) => {
			imageFit.value = value;
		},
		'onUpdate:title': (value: string) => {
			titleTemplate.value = value;
		},
		'onUpdate:subtitle': (value: string) => {
			subtitleTemplate.value = value;
		},
		'onUpdate:imageSource': (value: string | null) => {
			imageSource.value = value;
		},
		'onUpdate:fields': (value: string[]) => {
			fields.value = value;
		},
		'onUpdate:limit': (value: number) => {
			limit.value = value;
		},
		'onUpdate:page': (value: number) => {
			page.value = value;
		},
		'onUpdate:sort': (value: string[]) => {
			sort.value = value;
		},
		'onUpdate:tableSpacing': (value: 'compact' | 'cozy' | 'comfortable') => {
			tableSpacing.value = value;
		},
		'onUpdate:table-spacing': (value: 'compact' | 'cozy' | 'comfortable') => {
			tableSpacing.value = value;
		},
		'onUpdate:selection': (value: (string | number)[]) => {
			options.selection.value = value;
		},
		'onUpdate:width': (value: number) => {
			cardsWidth.value = value;
		},
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

	function onTableHeadersUpdate(value: Array<{ value?: string; width?: number }>) {
		applyTableHeaders(value);
	}

	return {
		layoutState,
		refresh,
		sessionExpired,
		onLayoutWidth,
		onLimitUpdate,
		onFieldsUpdate,
		onTableSpacingUpdate,
		onSizeUpdate,
		onSortUpdate,
		onTableHeadersUpdate,
		totalCount,
		totalBytes,
		resultsFiltered,
	};
}
