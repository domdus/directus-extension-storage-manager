import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type StorageDisk = {
	read?: (filepath: string, options?: unknown) => Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;
	write?: (filepath: string, content: NodeJS.ReadableStream, type?: string) => Promise<unknown>;
	delete?: (filepath: string) => Promise<unknown>;
	stat?: (filepath: string) => Promise<{ size: number; modified?: Date }>;
	exists?: (filepath: string) => Promise<boolean>;
	list?: (prefix?: string) => AsyncIterable<string>;
	/** Legacy driver methods (pre storage refactor). */
	getStream?: (filepath: string, range?: unknown) => NodeJS.ReadableStream;
	put?: (filepath: string, content: NodeJS.ReadableStream | Buffer | string, type?: string) => Promise<unknown>;
	getStat?: (filepath: string) => Promise<{ size: number }>;
};

export type StorageManagerLike = {
	location: (name: string) => StorageDisk;
};

type GetStorageFn = () => Promise<StorageManagerLike>;

let cachedGetStorage: GetStorageFn | null = null;

function candidatePaths(): string[] {
	const cwd = process.cwd();
	const roots = Array.from(
		new Set(
			[
				cwd,
				path.resolve(cwd, '..'),
				'/directus',
				path.dirname(process.execPath),
			].filter(Boolean),
		),
	);

	const relative = [
		'node_modules/@directus/api/dist/storage/index.js',
		'node_modules/@directus/api/storage/index.js',
		'node_modules/directus/dist/storage/index.js',
		'node_modules/directus/storage/index.js',
	];

	const paths: string[] = [];
	for (const root of roots) {
		for (const rel of relative) {
			paths.push(path.join(root, rel));
		}
	}
	return paths;
}

async function tryImport(specifier: string): Promise<GetStorageFn | null> {
	try {
		const mod: any = await import(specifier);
		const fn = mod?.getStorage || mod?.default?.getStorage;
		if (typeof fn === 'function') return fn as GetStorageFn;
	} catch {
		// continue
	}
	return null;
}

async function tryRequire(filePath: string): Promise<GetStorageFn | null> {
	if (!fs.existsSync(filePath)) return null;
	try {
		const require = createRequire(path.join(process.cwd(), 'package.json'));
		const mod = require(filePath);
		const fn = mod?.getStorage || mod?.default?.getStorage;
		if (typeof fn === 'function') return fn as GetStorageFn;
	} catch {
		// continue
	}

	try {
		return await tryImport(pathToFileURL(filePath).href);
	} catch {
		return null;
	}
}

/**
 * Resolve Directus `getStorage()` across package layouts (npm, Docker monorepo, etc.).
 * Official extension context does not expose storage — this is intentional bridging.
 */
export async function resolveGetStorage(): Promise<GetStorageFn> {
	if (cachedGetStorage) return cachedGetStorage;

	const importSpecs = [
		'@directus/api/dist/storage/index.js',
		'@directus/api/storage/index.js',
		'directus/dist/storage/index.js',
	];

	for (const spec of importSpecs) {
		const fn = await tryImport(spec);
		if (fn) {
			cachedGetStorage = fn;
			return fn;
		}
	}

	for (const filePath of candidatePaths()) {
		const fn = await tryRequire(filePath);
		if (fn) {
			cachedGetStorage = fn;
			return fn;
		}
	}

	throw new Error(
		'Could not resolve Directus getStorage(). Ensure this extension runs inside the Directus API process (not sandboxed).',
	);
}

export async function getStorageManager(): Promise<StorageManagerLike> {
	const getStorage = await resolveGetStorage();
	return getStorage();
}

export async function diskRead(disk: StorageDisk, filename: string): Promise<NodeJS.ReadableStream> {
	if (typeof disk.read === 'function') {
		return await disk.read(filename);
	}
	if (typeof disk.getStream === 'function') {
		return disk.getStream(filename);
	}
	throw new Error('Storage disk does not support read/getStream');
}

export async function diskWrite(
	disk: StorageDisk,
	filename: string,
	stream: NodeJS.ReadableStream,
	type?: string | null,
): Promise<void> {
	if (typeof disk.write === 'function') {
		await disk.write(filename, stream, type || undefined);
		return;
	}
	if (typeof disk.put === 'function') {
		await disk.put(filename, stream, type || undefined);
		return;
	}
	throw new Error('Storage disk does not support write/put');
}

export async function diskExists(disk: StorageDisk, filename: string): Promise<boolean> {
	if (typeof disk.exists === 'function') {
		return await disk.exists(filename);
	}
	try {
		await diskStat(disk, filename);
		return true;
	} catch {
		return false;
	}
}

export async function diskStat(disk: StorageDisk, filename: string): Promise<{ size: number }> {
	if (typeof disk.stat === 'function') {
		const stat = await disk.stat(filename);
		return { size: Number(stat.size) || 0 };
	}
	if (typeof disk.getStat === 'function') {
		const stat = await disk.getStat(filename);
		return { size: Number(stat.size) || 0 };
	}
	throw new Error('Storage disk does not support stat/getStat');
}

export async function diskDelete(disk: StorageDisk, filename: string): Promise<void> {
	if (typeof disk.delete !== 'function') {
		throw new Error('Storage disk does not support delete');
	}
	await disk.delete(filename);
}

/** List object keys under an optional prefix (requires driver `.list()`). */
export async function* diskList(disk: StorageDisk, prefix = ''): AsyncGenerator<string> {
	if (typeof disk.list !== 'function') {
		throw new Error('Storage disk does not support list() — cannot detect orphan files on this driver');
	}

	const d = disk as any;
	const inputPrefix = String(prefix || '');

	/**
	 * Directus DriverGCS / DriverAzure build list prefixes via `path.join(root, prefix)`.
	 * When ROOT is empty, `join('', '') === '.'`, so the cloud API is queried with prefix `'.'`
	 * and only keys that literally start with `.` are returned — empty folders marked as
	 * `folder/.keep` disappear from browse/nav. S3 remaps `'.' → ''`; GCS/Azure do not.
	 */
	if (d?.bucket && typeof d.bucket.getFiles === 'function') {
		const root = String(d.root || '');
		let listPrefix =
			typeof d.fullPath === 'function' ? String(d.fullPath(inputPrefix) || '') : inputPrefix;
		if (listPrefix === '.') listPrefix = '';

		let query: Record<string, unknown> = {
			prefix: listPrefix,
			autoPaginate: false,
			maxResults: 500,
		};

		while (query) {
			const [files, nextQuery] = await d.bucket.getFiles(query);
			for (const file of files || []) {
				const raw = String(file?.name || '')
					.slice(root.length)
					.replace(/^[/\\]+/, '');
				if (raw) yield raw;
			}
			query = nextQuery;
		}
		return;
	}

	if (d?.containerClient && typeof d.containerClient.listBlobsFlat === 'function') {
		const root = String(d.root || '');
		let listPrefix =
			typeof d.fullPath === 'function' ? String(d.fullPath(inputPrefix) || '') : inputPrefix;
		if (listPrefix === '.') listPrefix = '';

		for await (const blob of d.containerClient.listBlobsFlat({ prefix: listPrefix })) {
			const raw = String(blob?.name || '')
				.slice(root.length)
				.replace(/^[/\\]+/, '');
			if (raw) yield raw;
		}
		return;
	}

	for await (const filepath of disk.list(inputPrefix)) {
		const raw = String(filepath || '').replace(/^[/\\]+/, '');
		if (raw) yield raw;
	}
}

/**
 * Directus AssetsService transform files:
 * `{basename(stem)}__{objectHash}.{ext}` stored at the **storage root** (not under folder prefixes).
 * @see api/src/services/assets.ts getAssetSuffix
 *
 * Nested originals may also have orphaned copies beside the file if an older move
 * incorrectly relocated them — those are "colocated" transforms.
 */
const ASSET_TRANSFORM_BASENAME_RE = /__[a-f0-9]{16,}(?:\.[^.]+)?$/i;

function posixFileParts(filenameDisk: string): { dir: string; stem: string } {
	const normalized = String(filenameDisk || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '');
	const parsed = path.posix.parse(normalized);
	return { dir: parsed.dir, stem: parsed.name };
}

function isTransformBasename(base: string, stem: string): boolean {
	return base.startsWith(`${stem}__`) && ASSET_TRANSFORM_BASENAME_RE.test(base);
}

/** Canonical transforms at storage root (`uuid__hash.ext`) — what AssetsService reads/writes. */
export async function diskListCanonicalAssets(disk: StorageDisk, filenameDisk: string): Promise<string[]> {
	if (typeof disk.list !== 'function') return [];

	const { stem } = posixFileParts(filenameDisk);
	const related: string[] = [];

	for await (const filepath of disk.list(stem)) {
		const name = String(filepath || '').replace(/^[/\\]+/, '');
		if (name.includes('/')) continue;
		if (isTransformBasename(name, stem)) related.push(name);
	}

	return related;
}

/** Transforms sitting in the same directory as a nested original (orphans / legacy moves). */
export async function diskListColocatedAssets(disk: StorageDisk, filenameDisk: string): Promise<string[]> {
	if (typeof disk.list !== 'function') return [];

	const { dir, stem } = posixFileParts(filenameDisk);
	if (!dir) return [];

	const related: string[] = [];
	for await (const filepath of disk.list(`${dir}/${stem}`)) {
		const name = String(filepath || '').replace(/^[/\\]+/, '');
		const base = path.posix.basename(name);
		if (path.posix.dirname(name) === dir && isTransformBasename(base, stem)) {
			related.push(name);
		}
	}

	return related;
}

/** Canonical root transforms + colocated orphans (for cross-adapter migrate). */
export async function diskListRelatedAssets(disk: StorageDisk, filenameDisk: string): Promise<string[]> {
	const canonical = await diskListCanonicalAssets(disk, filenameDisk);
	const colocated = await diskListColocatedAssets(disk, filenameDisk);
	return [...new Set([...canonical, ...colocated])];
}

/** Delete primary object plus canonical and colocated transform variants. */
export async function diskDeleteWithAssets(disk: StorageDisk, filenameDisk: string): Promise<void> {
	const related = await diskListRelatedAssets(disk, filenameDisk);
	for (const name of related) {
		try {
			await diskDelete(disk, name);
		} catch {
			// best-effort
		}
	}

	try {
		await diskDelete(disk, filenameDisk);
	} catch {
		// best-effort
	}
}
