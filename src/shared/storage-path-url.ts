/**
 * Human-friendly storage path segments in Studio URLs.
 * Disk / DB paths keep real spaces; URLs use underscores so links stay readable
 * (e.g. "My Test Folder" → /path/My_Test_Folder).
 *
 * Encoding is reversible: existing underscores become "__", spaces become "_".
 */

function normalizeRawPath(path: string | null | undefined): string {
	return String(path || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

export function encodeStoragePathSegment(segment: string): string {
	return String(segment).replace(/_/g, '__').replace(/ /g, '_');
}

export function decodeStoragePathSegment(segment: string): string {
	// DecodeURIComponent first so legacy %20 URLs still resolve.
	let value = String(segment || '');
	try {
		value = decodeURIComponent(value);
	} catch {
		// leave as-is
	}
	return value.replace(/__/g, '\0').replace(/_/g, ' ').replace(/\0/g, '_');
}

/** Disk path → URL path (no leading/trailing slash). */
export function encodeStoragePathForUrl(path: string | null | undefined): string {
	return normalizeRawPath(path)
		.split('/')
		.filter(Boolean)
		.map(encodeStoragePathSegment)
		.join('/');
}

/** URL path param → disk path. */
export function decodeStoragePathFromUrl(path: string | null | undefined): string {
	return normalizeRawPath(path)
		.split('/')
		.filter(Boolean)
		.map(decodeStoragePathSegment)
		.join('/');
}

/** Studio route for a storage adapter, optionally under a physical path. */
export function storageManagerPath(location: string, path?: string | null): string {
	const base = `/storage-manager/storage/${encodeURIComponent(location)}`;
	const encoded = encodeStoragePathForUrl(path);
	return encoded ? `${base}/path/${encoded}` : base;
}
