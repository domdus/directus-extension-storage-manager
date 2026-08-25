const MIME_MAP: Record<string, string> = {
	'image/jpeg': 'JPG',
	'image/png': 'PNG',
	'image/gif': 'GIF',
	'image/svg+xml': 'SVG',
	'image/webp': 'WEBP',
	'video/mp4': 'MP4',
	'audio/mpeg': 'MP3',
	'application/pdf': 'PDF',
	'text/plain': 'TXT',
};

export function readableMimeType(type: string, short = false): string {
	if (!type) return '';
	if (MIME_MAP[type]) return MIME_MAP[type];

	if (!short) return type;

	const parts = type.split('/');
	if (parts.length !== 2) return 'FILE';

	let ext = parts[1]!;
	if (ext.includes('-')) ext = ext.split('-').pop() || ext;
	if (ext.includes('.')) ext = ext.split('.').pop() || ext;
	return ext.toUpperCase();
}
