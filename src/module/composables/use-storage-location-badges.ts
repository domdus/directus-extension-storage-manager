import { useApi } from '@directus/extensions-sdk';
import { nextTick, watch, type Ref } from 'vue';

const STORAGE_BADGE_CLASS = 'storage-location-badge';

function createStorageBadge(text: string): HTMLSpanElement {
	const badge = document.createElement('span');
	badge.className = STORAGE_BADGE_CLASS;
	badge.textContent = text;
	return badge;
}

export function clearStorageLocationBadges() {
	document.querySelectorAll(`.layout-cards .header .${STORAGE_BADGE_CLASS}`).forEach((el) => {
		el.remove();
	});
	document.querySelectorAll(`.layout-tabular .${STORAGE_BADGE_CLASS}`).forEach((el) => {
		const parent = el.parentElement;
		const text = el.textContent || '';
		el.remove();
		if (parent && !parent.querySelector(`.${STORAGE_BADGE_CLASS}`)) {
			parent.append(text);
		}
	});
}

function applyTableStorageBadges() {
	const headerRow = document.querySelector('.layout-tabular thead tr');
	if (!headerRow) return;

	const headers = Array.from(headerRow.children);
	let storageIndex = headers.findIndex((th) => {
		const classes = String((th as HTMLElement).className || '').split(/\s+/);
		return classes.includes('storage') || th.getAttribute('data-field') === 'storage';
	});
	if (storageIndex < 0) {
		storageIndex = headers.findIndex((th) => th.textContent?.trim().toLowerCase() === 'storage');
	}
	if (storageIndex < 0) return;

	document.querySelectorAll('.layout-tabular tbody tr').forEach((row) => {
		const cell = row.children[storageIndex] as HTMLElement | undefined;
		if (!cell || cell.querySelector(`.${STORAGE_BADGE_CLASS}`)) return;
		const text = String(cell.textContent || '').trim();
		if (!text) return;
		cell.textContent = '';
		cell.appendChild(createStorageBadge(text));
	});
}

/**
 * Inject storage location badges into host layout-cards / layout-tabular —
 * same chrome as Directus Folders in Storage Manager.
 */
export function useStorageLocationBadges(options: {
	enabled: Ref<boolean>;
	layout: Ref<string>;
	layoutRef?: Ref<any>;
	layoutQuery: Ref<Record<string, any>>;
	/** When set (Unreferenced custom layout), use these instead of `layoutRef.state`. */
	items?: Ref<unknown[] | undefined>;
	loading?: Ref<boolean>;
}) {
	const api = useApi();

	function currentItems(): Record<string, any>[] | undefined {
		if (options.items) return options.items.value as Record<string, any>[] | undefined;
		return options.layoutRef?.value?.state?.items;
	}

	function currentLoading(): boolean {
		if (options.loading) return Boolean(options.loading.value);
		return Boolean(options.layoutRef?.value?.state?.loading);
	}

	async function applyStorageBadges(items: Record<string, any>[] | undefined) {
		clearStorageLocationBadges();

		if (!options.enabled.value) return;

		await nextTick();
		await nextTick();

		if (options.layout.value === 'tabular') {
			applyTableStorageBadges();
			return;
		}

		if (options.layout.value !== 'cards' || !items?.length) return;

		let cards = document.querySelectorAll('.layout-cards .grid .card:not(.folder-card)');

		for (let attempt = 0; attempt < 8 && !cards.length; attempt++) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			cards = document.querySelectorAll('.layout-cards .grid .card:not(.folder-card)');
		}

		if (!cards.length) {
			cards = document.querySelectorAll('.layout-cards .card:not(.folder-card)');
		}

		if (!cards.length) return;

		const pk = 'id';
		const missingStorage = items.some((item) => item[pk] != null && item.storage == null);
		let storageById: Record<string, string> = {};

		if (missingStorage) {
			const ids = items.map((item) => item[pk]).filter(Boolean);
			if (!ids.length) return;

			try {
				const res = await api.get('/files', {
					params: {
						filter: JSON.stringify({ id: { _in: ids } }),
						fields: ['id', 'storage'],
						limit: ids.length,
					},
				});

				for (const row of res.data?.data || []) {
					storageById[String(row.id)] = String(row.storage || '');
				}
			} catch {
				return;
			}
		}

		cards.forEach((cardEl, index) => {
			const item = items[index];
			if (!item) return;

			const storage = String(item.storage ?? storageById[String(item[pk])] ?? '').trim();
			if (!storage) return;

			const header = cardEl.querySelector('.header');
			if (!header) return;

			header.appendChild(createStorageBadge(storage));
		});
	}

	function scheduleStorageBadges(items: Record<string, any>[] | undefined) {
		void applyStorageBadges(items).catch(() => undefined);
	}

	watch(
		() =>
			[
				options.enabled.value,
				options.layout.value,
				options.layoutQuery.value.page,
				options.layoutQuery.value.limit,
				JSON.stringify(options.layoutQuery.value.sort ?? []),
				currentLoading(),
				currentItems(),
			] as const,
		() => {
			if (currentLoading()) return;
			scheduleStorageBadges(currentItems());
		},
		{ deep: true, flush: 'post' },
	);

	return {
		clearStorageLocationBadges,
		scheduleStorageBadges,
	};
}

/** Shared unscoped styles for `.storage-location-badge` (inject once via a style block). */
export const STORAGE_LOCATION_BADGE_CSS = `
.storage-location-badge {
	display: inline-flex;
	align-items: center;
	max-inline-size: 100%;
	padding: 2px 8px;
	overflow: hidden;
	font-size: 11px;
	font-weight: 600;
	line-height: 1.35;
	color: var(--theme--primary-foreground, var(--white, #fff));
	white-space: nowrap;
	text-overflow: ellipsis;
	pointer-events: none;
	background: var(--theme--primary);
	border: none;
	border-radius: var(--theme--border-radius);
}

.layout-cards .header .storage-location-badge {
	position: absolute;
	inset-block-end: 8px;
	inset-inline-start: 8px;
	z-index: 2;
	max-inline-size: calc(100% - 16px);
	box-shadow: 0 1px 3px rgb(38 50 56 / 0.2);
}
`;
