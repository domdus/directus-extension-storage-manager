import fs from 'node:fs/promises';
import path from 'node:path';
import { diskDelete, diskExists, diskList, diskStat, getStorageManager } from './storage';
import { getLocationDriver, getLocationRoot } from './usage';
import { guessMime } from './orphans';
import {
	isRootAssetTransform,
	isRootStorageKey,
	matchesTransformSearch,
} from '../shared/transform-filename';

export type RootTransformRow = {
	filename_disk: string;
	filesize: number;
	type: string | null;
};

export type RootTransformListResult = {
	items: RootTransformRow[];
	page: number;
	limit: number;
	has_more: boolean;
};

export type RootTransformDeleteResult = {
	dry_run: boolean;
	deleted: number;
	skipped: number;
	failed: number;
	scanned: number;
	errors: Array<{ filename_disk: string; error: string }>;
};

function normalizeLimit(raw: unknown, fallback = 50): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.floor(n), 200);
}

function normalizePage(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.floor(n);
}

async function* iterateLocalRootFilenames(root: string): AsyncGenerator<string> {
	const absolute = path.isAbsolute(root) ? root : path.join(process.cwd(), root);
	let entries;
	try {
		entries = await fs.readdir(absolute, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name || entry.name.startsWith('.')) continue;
		if (entry.name === 'directus-health-file') continue;
		yield entry.name;
	}
}

async function* iterateRootStorageFilenames(
	location: string,
	env: Record<string, unknown>,
): AsyncGenerator<string> {
	const driver = getLocationDriver(env, location);
	const root = getLocationRoot(env, location);

	if (driver === 'local' && root) {
		yield* iterateLocalRootFilenames(root);
		return;
	}

	const storage = await getStorageManager();
	const disk = storage.location(location);

	try {
		for await (const filepath of diskList(disk, '')) {
			const name = String(filepath || '').replace(/^[/\\]+/, '');
			if (!isRootStorageKey(name)) continue;
			if (name.startsWith('.')) continue;
			if (name === 'directus-health-file') continue;
			yield name;
		}
	} catch {
		// unsupported driver
	}
}

async function statTransform(
	location: string,
	filename: string,
): Promise<{ filesize: number; type: string | null }> {
	try {
		const storage = await getStorageManager();
		const disk = storage.location(location);
		const stat = await diskStat(disk, filename);
		return { filesize: Number(stat.size) || 0, type: guessMime(filename) };
	} catch {
		return { filesize: 0, type: guessMime(filename) };
	}
}

export async function listRootTransforms(options: {
	location: string;
	env: Record<string, unknown>;
	page?: unknown;
	limit?: unknown;
	search?: string | null;
}): Promise<RootTransformListResult> {
	const page = normalizePage(options.page);
	const limit = normalizeLimit(options.limit);
	const search = options.search ?? null;
	const skip = (page - 1) * limit;

	const items: RootTransformRow[] = [];
	let skipped = 0;
	let hasMore = false;

	for await (const name of iterateRootStorageFilenames(options.location, options.env)) {
		if (!isRootAssetTransform(name)) continue;
		if (!matchesTransformSearch(name, search)) continue;

		if (skipped < skip) {
			skipped++;
			continue;
		}

		if (items.length < limit) {
			const meta = await statTransform(options.location, name);
			items.push({
				filename_disk: name,
				filesize: meta.filesize,
				type: meta.type,
			});
			continue;
		}

		hasMore = true;
		break;
	}

	return { items, page, limit, has_more: hasMore };
}

export async function countRootTransforms(options: {
	location: string;
	env: Record<string, unknown>;
	search?: string | null;
	max?: number;
}): Promise<{ count: number; capped: boolean }> {
	const max = Math.min(Math.max(Number(options.max) || 100_000, 1), 1_000_000);
	let count = 0;

	for await (const name of iterateRootStorageFilenames(options.location, options.env)) {
		if (!isRootAssetTransform(name)) continue;
		if (!matchesTransformSearch(name, options.search ?? null)) continue;
		count++;
		if (count >= max) return { count: max, capped: true };
	}

	return { count, capped: false };
}

export async function deleteAllRootTransforms(options: {
	database: any;
	location: string;
	env: Record<string, unknown>;
	search?: string | null;
	dryRun?: boolean;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<RootTransformDeleteResult> {
	const storage = await getStorageManager();
	const disk = storage.location(options.location);
	const search = options.search ?? null;
	const dryRun = Boolean(options.dryRun);

	let deleted = 0;
	let skipped = 0;
	let failed = 0;
	let scanned = 0;
	const errors: Array<{ filename_disk: string; error: string }> = [];

	for await (const name of iterateRootStorageFilenames(options.location, options.env)) {
		if (!isRootAssetTransform(name)) continue;
		if (!matchesTransformSearch(name, search)) continue;
		scanned++;

		try {
			const existing = await options.database('directus_files')
				.select('id')
				.where({ storage: options.location, filename_disk: name })
				.first();

			if (existing) {
				skipped++;
				continue;
			}

			if (dryRun) {
				deleted++;
				continue;
			}

			if (!(await diskExists(disk, name))) {
				skipped++;
				continue;
			}

			await diskDelete(disk, name);
			deleted++;
		} catch (error: any) {
			failed++;
			const message = error?.message || String(error);
			errors.push({ filename_disk: name, error: message });
			options.logger?.warn(`[storage-manager] Transform delete failed for ${name}: ${message}`);
		}
	}

	if (!dryRun && deleted > 0) {
		options.logger?.info(
			`[storage-manager] Deleted ${deleted} root transform(s) on ${options.location} (skipped ${skipped}, failed ${failed})`,
		);
	}

	return { dry_run: dryRun, deleted, skipped, failed, scanned, errors: errors.slice(0, 20) };
}
