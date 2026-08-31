export type FileLifecycleDeselectAction = 'keep' | 'ask' | 'delete_if_unreferenced';
export type FileLifecycleItemDeleteAction = 'keep' | 'delete_if_unreferenced';

export type StorageManagerLifecycleSettings = {
	/** File / Image / Files with Storage: default when field option is unset. */
	on_deselect: FileLifecycleDeselectAction;
	/** When a collection item is deleted: delete related files if unreferenced. */
	on_item_delete: FileLifecycleItemDeleteAction;
	/** Skip files newer than this (minutes) in Find Unreferenced. */
	scan_min_age_minutes: number;
	/** Scan rich text / Markdown / JSON / code / text fields for UUIDs and /assets/ links. */
	scan_text_fields: boolean;
};

export const LIFECYCLE_DEFAULTS: StorageManagerLifecycleSettings = {
	on_deselect: 'keep',
	on_item_delete: 'keep',
	scan_min_age_minutes: 60,
	scan_text_fields: true,
};

export function normalizeLifecycleSettings(raw: unknown): StorageManagerLifecycleSettings {
	const partial = (raw && typeof raw === 'object' ? raw : {}) as Partial<StorageManagerLifecycleSettings>;
	const onDeselect = partial.on_deselect;
	const onItemDelete = partial.on_item_delete;
	const minAge = Number(partial.scan_min_age_minutes);

	return {
		on_deselect:
			onDeselect === 'ask' || onDeselect === 'delete_if_unreferenced' || onDeselect === 'keep'
				? onDeselect
				: LIFECYCLE_DEFAULTS.on_deselect,
		on_item_delete:
			onItemDelete === 'delete_if_unreferenced' || onItemDelete === 'keep'
				? onItemDelete
				: LIFECYCLE_DEFAULTS.on_item_delete,
		scan_min_age_minutes:
			Number.isFinite(minAge) && minAge >= 0 ? Math.min(60 * 24 * 30, Math.floor(minAge)) : LIFECYCLE_DEFAULTS.scan_min_age_minutes,
		scan_text_fields:
			partial.scan_text_fields === undefined ? LIFECYCLE_DEFAULTS.scan_text_fields : Boolean(partial.scan_text_fields),
	};
}
