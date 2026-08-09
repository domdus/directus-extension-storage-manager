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
	for await (const filepath of disk.list(prefix)) {
		yield String(filepath);
	}
}

/**
 * Directus transform siblings: `{stem}__{hash}.ext` next to the original on the same adapter.
 * @see AssetsService getAssetSuffix
 */
const ASSET_TRANSFORM_BASENAME_RE = /__[a-f0-9]{16,}(?:\.[^.]+)?$/i;

/** List generated asset variants stored beside `filenameDisk` (requires driver `.list()`). */
export async function diskListRelatedAssets(disk: StorageDisk, filenameDisk: string): Promise<string[]> {
	if (typeof disk.list !== 'function') return [];

	const stem = path.parse(filenameDisk).name;
	const marker = `${stem}__`;
	const related: string[] = [];

	for await (const filepath of disk.list(stem)) {
		const name = String(filepath || '').replace(/^[/\\]+/, '');
		const base = path.basename(name);
		if (base.startsWith(marker) && ASSET_TRANSFORM_BASENAME_RE.test(base)) {
			related.push(name);
		}
	}

	return related;
}

/** Delete primary object plus any generated asset variants sharing the file prefix. */
export async function diskDeleteWithAssets(disk: StorageDisk, filenameDisk: string): Promise<void> {
	const parsed = path.parse(filenameDisk);
	const prefix = parsed.name;

	if (typeof disk.list === 'function') {
		for await (const filepath of disk.list(prefix)) {
			try {
				await diskDelete(disk, filepath);
			} catch {
				// best-effort cleanup
			}
		}
		return;
	}

	await diskDelete(disk, filenameDisk);
}
