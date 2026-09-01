import fs from 'node:fs';
import path from 'node:path';
import { getDriverMeta, parseStorageLocations } from '../shared/drivers';
import type { StorageLocationInfo, StorageUsage } from '../shared/types';

type EnvLike = Record<string, unknown>;

function envString(env: EnvLike, key: string): string | null {
	const value = env[key];
	if (value == null) return null;
	const str = String(value).trim();
	return str === '' ? null : str;
}

export function listConfiguredLocations(env: EnvLike): string[] {
	const fromEnv = parseStorageLocations(env.STORAGE_LOCATIONS);
	if (fromEnv.length > 0) return fromEnv;
	return ['local'];
}

export function getLocationDriver(env: EnvLike, location: string): string {
	return envString(env, `STORAGE_${location.toUpperCase()}_DRIVER`) || 'local';
}

export function getLocationRoot(env: EnvLike, location: string): string | null {
	return envString(env, `STORAGE_${location.toUpperCase()}_ROOT`);
}

export function getLocationBucket(env: EnvLike, location: string): string | null {
	return (
		envString(env, `STORAGE_${location.toUpperCase()}_BUCKET`) ||
		envString(env, `STORAGE_${location.toUpperCase()}_CONTAINER_NAME`)
	);
}

async function readLocalDiskUsage(root: string | null): Promise<{
	disk_total_bytes: number | null;
	disk_free_bytes: number | null;
	disk_used_bytes: number | null;
	disk_used_percent: number | null;
	disk_available: boolean;
}> {
	const empty = {
		disk_total_bytes: null,
		disk_free_bytes: null,
		disk_used_bytes: null,
		disk_used_percent: null,
		disk_available: false,
	};

	if (!root) return empty;

	const base = process.env.PWD || process.cwd() || '/directus';
	const absolute = path.isAbsolute(root) ? root : path.join(base, root);

	try {
		if (!fs.existsSync(absolute)) return empty;

		// Node 18.15+ / 19.6+
		const statfs = (fs.promises as any).statfs as undefined | ((p: string) => Promise<any>);
		if (typeof statfs === 'function') {
			const s = await statfs(absolute);
			const block = Number(s.bsize || s.frsize || 0);
			const total = block * Number(s.blocks || 0);
			const free = block * Number(s.bavail ?? s.bfree ?? 0);
			const used = Math.max(0, total - free);
			const percent = total > 0 ? (used / total) * 100 : null;
			return {
				disk_total_bytes: total || null,
				disk_free_bytes: free || null,
				disk_used_bytes: used || null,
				disk_used_percent: percent,
				disk_available: total > 0,
			};
		}
	} catch {
		// ignore
	}

	return empty;
}

export async function aggregateFileUsage(
	database: any,
	location: string,
): Promise<{ file_count: number; total_bytes: number }> {
	const grouped = await aggregateFileUsageGrouped(database, [location]);
	return grouped.get(location) || { file_count: 0, total_bytes: 0 };
}

/** One scan of directus_files instead of one COUNT/SUM per location. */
export async function aggregateFileUsageGrouped(
	database: any,
	locations: string[],
): Promise<Map<string, { file_count: number; total_bytes: number }>> {
	const map = new Map<string, { file_count: number; total_bytes: number }>();
	for (const location of locations) {
		map.set(location, { file_count: 0, total_bytes: 0 });
	}
	if (!locations.length) return map;

	const rows = await database('directus_files')
		.whereIn('storage', locations)
		.select('storage')
		.select(
			database.raw('count(*) as file_count'),
			database.raw('coalesce(sum(filesize), 0) as total_bytes'),
		)
		.groupBy('storage');

	for (const row of rows || []) {
		map.set(String(row.storage), {
			file_count: Number(row.file_count || 0),
			total_bytes: Number(row.total_bytes || 0),
		});
	}
	return map;
}

export async function buildStorageUsage(
	env: EnvLike,
	database: any,
	location: string,
	precomputed?: { file_count: number; total_bytes: number },
): Promise<StorageUsage> {
	const driver = getLocationDriver(env, location);
	const { file_count, total_bytes } = precomputed || (await aggregateFileUsage(database, location));

	let disk = {
		disk_total_bytes: null as number | null,
		disk_free_bytes: null as number | null,
		disk_used_bytes: null as number | null,
		disk_used_percent: null as number | null,
		disk_available: false,
	};

	if (driver === 'local') {
		disk = await readLocalDiskUsage(getLocationRoot(env, location));
	}

	return {
		location,
		driver,
		file_count,
		total_bytes,
		...disk,
	};
}

export async function buildStorageLocationInfo(
	env: EnvLike,
	database: any,
	location: string,
	precomputed?: { file_count: number; total_bytes: number },
	folder_count = 0,
): Promise<StorageLocationInfo> {
	const usage = await buildStorageUsage(env, database, location, precomputed);
	const meta = getDriverMeta(usage.driver);

	return {
		...usage,
		label: meta.label,
		short: meta.short,
		icon: meta.icon,
		root: getLocationRoot(env, location),
		bucket: getLocationBucket(env, location),
		folder_count,
		mirror_directus_folders: false,
	};
}
