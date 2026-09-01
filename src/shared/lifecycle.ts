export type FileLifecycleDeselectAction = 'keep' | 'ask' | 'delete_if_unreferenced';
export type FileLifecycleItemDeleteAction = 'keep' | 'delete_if_unreferenced';
/** Native interfaces have no Ask prompt — only keep or auto-delete. */
export type FileLifecycleNativeDeselectAction = 'keep' | 'delete_if_unreferenced';

export type LifecyclePolicyGroup = {
	on_deselect: FileLifecycleDeselectAction;
	on_item_delete: FileLifecycleItemDeleteAction;
};

export type LifecycleNativePolicyGroup = {
	on_deselect: FileLifecycleNativeDeselectAction;
	on_item_delete: FileLifecycleItemDeleteAction;
};

export type StorageManagerLifecycleSettings = {
	/**
	 * @deprecated Prefer `native` / `storage_manager`. Kept in sync with `storage_manager` for older readers.
	 */
	on_deselect: FileLifecycleDeselectAction;
	/**
	 * @deprecated Prefer `native` / `storage_manager`. Kept in sync with `storage_manager` for older readers.
	 */
	on_item_delete: FileLifecycleItemDeleteAction;
	/** Defaults for native Directus File / Image / Files interfaces (hooks on save / item delete). */
	native: LifecycleNativePolicyGroup;
	/** Defaults for Storage Manager File / Image / Files with Storage (UI + hooks). */
	storage_manager: LifecyclePolicyGroup;
	/** Skip files newer than this (minutes) in Find Unreferenced. */
	scan_min_age_minutes: number;
	/** Scan rich text / Markdown / JSON / code / text fields for UUIDs and /assets/ links. */
	scan_text_fields: boolean;
};

export const LIFECYCLE_DEFAULTS: StorageManagerLifecycleSettings = {
	on_deselect: 'keep',
	on_item_delete: 'keep',
	native: {
		on_deselect: 'keep',
		on_item_delete: 'keep',
	},
	storage_manager: {
		on_deselect: 'keep',
		on_item_delete: 'keep',
	},
	scan_min_age_minutes: 60,
	scan_text_fields: true,
};

function coerceDeselect(value: unknown): FileLifecycleDeselectAction {
	return value === 'ask' || value === 'delete_if_unreferenced' || value === 'keep'
		? value
		: LIFECYCLE_DEFAULTS.storage_manager.on_deselect;
}

function coerceNativeDeselect(value: unknown): FileLifecycleNativeDeselectAction {
	if (value === 'delete_if_unreferenced' || value === 'keep') return value;
	// Legacy "ask" (or anything else) → keep for native (no prompt UI)
	return LIFECYCLE_DEFAULTS.native.on_deselect;
}

function coerceItemDelete(value: unknown): FileLifecycleItemDeleteAction {
	return value === 'delete_if_unreferenced' || value === 'keep'
		? value
		: LIFECYCLE_DEFAULTS.native.on_item_delete;
}

export function normalizeLifecycleSettings(raw: unknown): StorageManagerLifecycleSettings {
	const partial = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const legacyDeselect = partial.on_deselect;
	const legacyItemDelete = partial.on_item_delete;
	const nativeRaw =
		partial.native && typeof partial.native === 'object'
			? (partial.native as Record<string, unknown>)
			: null;
	const smRaw =
		partial.storage_manager && typeof partial.storage_manager === 'object'
			? (partial.storage_manager as Record<string, unknown>)
			: null;

	const native: LifecycleNativePolicyGroup = {
		on_deselect: coerceNativeDeselect(nativeRaw?.on_deselect ?? legacyDeselect),
		on_item_delete: coerceItemDelete(nativeRaw?.on_item_delete ?? legacyItemDelete),
	};

	const storage_manager: LifecyclePolicyGroup = {
		on_deselect: coerceDeselect(smRaw?.on_deselect ?? legacyDeselect),
		on_item_delete: coerceItemDelete(smRaw?.on_item_delete ?? legacyItemDelete),
	};

	const minAge = Number(partial.scan_min_age_minutes);

	return {
		// Mirror SM group for older code paths that still read top-level keys
		on_deselect: storage_manager.on_deselect,
		on_item_delete: storage_manager.on_item_delete,
		native,
		storage_manager,
		scan_min_age_minutes:
			Number.isFinite(minAge) && minAge >= 0
				? Math.min(60 * 24 * 30, Math.floor(minAge))
				: LIFECYCLE_DEFAULTS.scan_min_age_minutes,
		scan_text_fields:
			partial.scan_text_fields === undefined
				? LIFECYCLE_DEFAULTS.scan_text_fields
				: Boolean(partial.scan_text_fields),
	};
}
