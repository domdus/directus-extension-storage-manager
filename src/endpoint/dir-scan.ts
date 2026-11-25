import fs from 'node:fs/promises';

/**
 * Shared, cached listing of one local directory.
 *
 * Browse, root transforms (list / count / delete) and the folder tree all read the same
 * directories. Each used to run its own fs.readdir, in parallel and again on every reload,
 * and kept running after the browser had given up. On flat storages with hundreds of
 * thousands of files on NFS (PlayboyPlus `pbp`: ~323k files in one folder) that tied up
 * libuv's file-system threads for minutes, so asset requests and /server/health of the
 * whole CMS timed out (Nov 2026).
 *
 * Now:
 * - one scan per directory at a time; concurrent callers share it
 * - streamed with fs.opendir, yielding to the event loop every few thousand entries
 * - at most MAX_PARALLEL_SCANS directories are scanned at once (others wait their turn)
 * - results are cached (SMALL_DIR_TTL_MS, or CACHE_TTL_MS for big folders); write requests
 *   through this extension invalidate the cache (see index.ts)
 * - callers wait at most `waitMs`; a scan that takes longer keeps running in the
 *   background (single, cached) and the caller gets `{ complete: false, scanned }` so the
 *   API can answer "scan running" instead of hitting the proxy timeout
 */

export type DirListing = {
	files: string[];
	dirs: string[];
	scannedAt: number;
};

export type DirScanResult =
	| { complete: true; listing: DirListing }
	| { complete: false; scanned: number };

export const CACHE_TTL_MS = 10 * 60 * 1000;
export const SMALL_DIR_TTL_MS = 30 * 1000;
export const BIG_DIR_ENTRIES = 5_000;

export function listingTtl(listing: DirListing): number {
	return listing.files.length + listing.dirs.length >= BIG_DIR_ENTRIES ? CACHE_TTL_MS : SMALL_DIR_TTL_MS;
}

export const DEFAULT_WAIT_MS = 15_000;
const MAX_PARALLEL_SCANS = 1;
const YIELD_EVERY = 2_000;
const OPENDIR_BUFFER = 512;

type Entry = {
	promise: Promise<DirListing>;
	progress: { scanned: number };
	listing?: DirListing;
	error?: unknown;
};

const entries = new Map<string, Entry>();
let running = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
	if (running < MAX_PARALLEL_SCANS) {
		running++;
		return Promise.resolve();
	}
	return new Promise((resolve) => queue.push(() => { running++; resolve(); }));
}

function release() {
	running--;
	const next = queue.shift();
	if (next) next();
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function readDirectory(absPath: string, progress: { scanned: number }): Promise<DirListing> {
	await acquire();
	try {
		const files: string[] = [];
		const dirs: string[] = [];
		let dir;
		try {
			dir = await fs.opendir(absPath, { bufferSize: OPENDIR_BUFFER });
		} catch (error: any) {
			if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { files, dirs, scannedAt: Date.now() };
			throw error;
		}
		for await (const dirent of dir) {
			progress.scanned++;
			const name = dirent.name;
			if (name && !name.startsWith('.')) {
				if (dirent.isDirectory()) dirs.push(name);
				else if (dirent.isFile()) files.push(name);
			}
			if (progress.scanned % YIELD_EVERY === 0) await yieldToEventLoop();
		}
		return { files, dirs, scannedAt: Date.now() };
	} finally {
		release();
	}
}

function startScan(absPath: string): Entry {
	const progress = { scanned: 0 };
	const entry: Entry = { progress, promise: Promise.resolve(null as unknown as DirListing) };
	entry.promise = readDirectory(absPath, progress).then(
		(listing) => {
			entry.listing = listing;
			return listing;
		},
		(error) => {
			entry.error = error;
			// failed scans are not cached
			if (entries.get(absPath) === entry) entries.delete(absPath);
			throw error;
		},
	);
	// background scans must never produce unhandled rejections
	entry.promise.catch(() => {});
	entries.set(absPath, entry);
	return entry;
}

function getEntry(absPath: string, now = Date.now()): Entry {
	const existing = entries.get(absPath);
	if (existing) {
		const fresh = !existing.listing || now - existing.listing.scannedAt < listingTtl(existing.listing);
		if (fresh && !existing.error) return existing;
	}
	return startScan(absPath);
}

/** Listing of `absPath`, waiting at most `waitMs` for a running scan. */
export async function scanDirectory(absPath: string, waitMs = DEFAULT_WAIT_MS): Promise<DirScanResult> {
	const entry = getEntry(absPath);
	if (entry.listing) return { complete: true, listing: entry.listing };

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), Math.max(0, waitMs));
	});
	try {
		const result = await Promise.race([entry.promise, timeout]);
		if (result === 'timeout') return { complete: false, scanned: entry.progress.scanned };
		return { complete: true, listing: result };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Full listing, however long it takes (for explicit actions like delete-all). */
export async function scanDirectoryFully(absPath: string): Promise<DirListing> {
	return getEntry(absPath).promise;
}

/** Drop cached listings for `absPath` (and, with `recursive`, everything below it). */
export function invalidateDirectory(absPath?: string, recursive = false): void {
	if (!absPath) {
		for (const [key, entry] of entries) if (entry.listing || entry.error) entries.delete(key);
		return;
	}
	for (const [key, entry] of entries) {
		const match = key === absPath || (recursive && key.startsWith(absPath.endsWith('/') ? absPath : `${absPath}/`));
		// a running scan stays; it is replaced once finished and stale
		if (match && (entry.listing || entry.error)) entries.delete(key);
	}
}

/** Thrown by helpers when a listing is not ready yet; endpoints answer 202 "scan running". */
export class ScanInProgressError extends Error {
	readonly scanned: number;
	readonly path: string;
	constructor(path: string, scanned: number) {
		super(`Folder scan in progress (${scanned} entries so far)`);
		this.name = 'ScanInProgressError';
		this.scanned = scanned;
		this.path = path;
	}
}

/** Listing or ScanInProgressError. */
export async function requireDirectoryListing(absPath: string, waitMs = DEFAULT_WAIT_MS): Promise<DirListing> {
	const result = await scanDirectory(absPath, waitMs);
	if (!result.complete) throw new ScanInProgressError(absPath, result.scanned);
	return result.listing;
}

/** Test hook. */
export function __resetDirScanForTests() {
	entries.clear();
	running = 0;
	queue.length = 0;
}
