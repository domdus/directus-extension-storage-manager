import path from 'node:path';

/**
 * Directus AssetsService transform files: `{stem}__{objectHash}.{ext}` at storage root.
 * @see api/src/services/assets.ts getAssetSuffix
 */
export const ASSET_TRANSFORM_FILENAME_RE = /__[a-f0-9]{16,}(?:\.[^.]+)?$/i;

export function isAssetTransform(filename: string): boolean {
	return ASSET_TRANSFORM_FILENAME_RE.test(path.basename(String(filename || '')));
}

/** Canonical transforms sit at adapter root — no path separator in the key. */
export function isRootStorageKey(filename: string): boolean {
	const name = String(filename || '').replace(/^[/\\]+/, '');
	return Boolean(name) && !name.includes('/');
}

export function isRootAssetTransform(filename: string): boolean {
	return isRootStorageKey(filename) && isAssetTransform(filename);
}

export function matchesTransformSearch(filename: string, search: string | null | undefined): boolean {
	const q = String(search || '')
		.trim()
		.toLowerCase();
	if (!q) return true;
	return String(filename || '').toLowerCase().includes(q);
}
