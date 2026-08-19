import { createRequire } from 'node:module';
import path from 'node:path';
import { diskRead, type StorageDisk } from './storage';

/** Formats Directus extracts size for (and AssetsService can transform, except GIF). */
const IMAGE_METADATA_TYPES = new Set([
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/tiff',
	'image/tif',
	'image/avif',
]);

const HEAD_BYTES = 2 * 1024 * 1024;

type SharpFactory = (
	input: Buffer,
	opts?: { failOn?: string },
) => { metadata: () => Promise<{ width?: number; height?: number; orientation?: number }> };

let cachedSharp: SharpFactory | null | undefined;

export function shouldReadImageDimensions(type: string | null | undefined): boolean {
	if (!type) return false;
	const mime = type.toLowerCase();
	if (mime === 'image/svg+xml') return false;
	return IMAGE_METADATA_TYPES.has(mime) || mime.startsWith('image/');
}

async function resolveSharp(): Promise<SharpFactory | null> {
	if (cachedSharp !== undefined) return cachedSharp;

	try {
		const require = createRequire(path.join(process.cwd(), 'package.json'));
		const mod = require('sharp');
		const factory = typeof mod === 'function' ? mod : mod?.default;
		if (typeof factory === 'function') {
			cachedSharp = factory;
			return cachedSharp;
		}
	} catch {
		// Directus always ships sharp; resolution can still fail in odd layouts.
	}

	try {
		const mod: any = await import('sharp');
		const factory = typeof mod.default === 'function' ? mod.default : mod;
		if (typeof factory === 'function') {
			cachedSharp = factory;
			return cachedSharp;
		}
	} catch {
		// fall through to header parser
	}

	cachedSharp = null;
	return null;
}

function destroyStream(stream: NodeJS.ReadableStream): void {
	try {
		const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
		if (typeof s.destroy === 'function') s.destroy();
	} catch {
		// ignore
	}
}

async function readStreamHead(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of stream) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			chunks.push(buf);
			total += buf.length;
			if (total >= maxBytes) break;
		}
	} finally {
		destroyStream(stream);
	}
	const buf = Buffer.concat(chunks);
	return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
}

function parsePngSize(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 24) return null;
	if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (width > 0 && height > 0) return { width, height };
	return null;
}

function parseGifSize(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 10) return null;
	const header = buf.toString('ascii', 0, 6);
	if (header !== 'GIF87a' && header !== 'GIF89a') return null;
	const width = buf.readUInt16LE(6);
	const height = buf.readUInt16LE(8);
	if (width > 0 && height > 0) return { width, height };
	return null;
}

function parseJpegSize(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 8 < buf.length) {
		if (buf[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = buf[offset + 1];
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0x01) {
			offset += 2;
			continue;
		}
		if (
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf)
		) {
			const height = buf.readUInt16BE(offset + 5);
			const width = buf.readUInt16BE(offset + 7);
			if (width > 0 && height > 0) return { width, height };
			return null;
		}
		if (offset + 4 > buf.length) return null;
		const size = buf.readUInt16BE(offset + 2);
		if (size < 2) return null;
		offset += 2 + size;
	}
	return null;
}

function parseWebpSize(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 30) return null;
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
	const chunk = buf.toString('ascii', 12, 16);
	if (chunk === 'VP8X') {
		const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
		const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
		if (width > 0 && height > 0) return { width, height };
		return null;
	}
	if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
		const width = buf.readUInt16LE(26) & 0x3fff;
		const height = buf.readUInt16LE(28) & 0x3fff;
		if (width > 0 && height > 0) return { width, height };
		return null;
	}
	if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
		const bits = buf.readUInt32LE(21);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		if (width > 0 && height > 0) return { width, height };
	}
	return null;
}

function parseImageSizeFromBuffer(buf: Buffer): { width: number; height: number } | null {
	return parsePngSize(buf) || parseJpegSize(buf) || parseGifSize(buf) || parseWebpSize(buf);
}

async function sizeFromSharp(buf: Buffer): Promise<{ width: number; height: number } | null> {
	const sharp = await resolveSharp();
	if (!sharp) return null;
	try {
		const meta = await sharp(buf, { failOn: 'none' }).metadata();
		let width = meta.width ?? 0;
		let height = meta.height ?? 0;
		if (meta.orientation && meta.orientation >= 5) {
			const swapped = width;
			width = height;
			height = swapped;
		}
		if (width > 0 && height > 0) return { width, height };
	} catch {
		// partial buffer / unsupported
	}
	return null;
}

export async function readImageDimensions(
	disk: StorageDisk,
	filename: string,
): Promise<{ width: number; height: number } | null> {
	let stream: NodeJS.ReadableStream;
	try {
		stream = await diskRead(disk, filename);
	} catch {
		return null;
	}

	let buf: Buffer;
	try {
		buf = await readStreamHead(stream, HEAD_BYTES);
	} catch {
		return null;
	}
	if (!buf.length) return null;

	return (await sizeFromSharp(buf)) || parseImageSizeFromBuffer(buf);
}
