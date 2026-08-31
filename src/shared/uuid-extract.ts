/** RFC-like UUID (Directus file ids). */
export const UUID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/** `/assets/<uuid>` (optional query/hash). Case-insensitive path segment. */
export const ASSET_URL_RE =
	/(?:^|[^a-z0-9_])(?:\/?assets\/)([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\b|[/?#])/gi;

export function normalizeUuid(id: string): string {
	return String(id || '').trim().toLowerCase();
}

export function extractAssetUuids(text: string): string[] {
	if (!text) return [];
	const out = new Set<string>();
	ASSET_URL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ASSET_URL_RE.exec(text)) !== null) {
		if (match[1]) out.add(normalizeUuid(match[1]));
	}
	return Array.from(out);
}

/** Any UUID-shaped token (JSON / code / markdown without /assets/). */
export function extractAllUuids(text: string): string[] {
	if (!text) return [];
	const out = new Set<string>();
	UUID_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = UUID_RE.exec(text)) !== null) {
		out.add(normalizeUuid(match[0]));
	}
	return Array.from(out);
}

export function valueToSearchText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
