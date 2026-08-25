import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diskDelete, diskExists, diskList, diskStat, getStorageManager } from './storage';
import { getLocationDriver, getLocationRoot } from './usage';
import { readImageDimensions, shouldReadImageDimensions } from './image-meta';
import { isAssetTransform } from '../shared/transform-filename';

export type OrphanFile = {
	filename_disk: string;
	filesize: number;
	type: string | null;
	suggested_id: string | null;
	filename_download: string;
	title: string;
};

function isIgnoredDiskEntry(filename: string): boolean {
	const base = path.basename(filename);
	if (!base || base.startsWith('.')) return true;
	if (base === 'directus-health-file') return true;
	if (isAssetTransform(filename)) return true;
	return false;
}

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.json': 'application/json',
	'.txt': 'text/plain',
	'.csv': 'text/csv',
	'.zip': 'application/zip',
};

export function guessMime(filename: string): string | null {
	const ext = path.extname(filename).toLowerCase();
	return MIME_BY_EXT[ext] || null;
}

/** Title from filename_disk: basename without extension, underscores → spaces. */
export function titleFromFilenameDisk(filenameDisk: string): string {
	const base = path.parse(path.basename(filenameDisk)).name;
	return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || base || filenameDisk;
}

function uuidFromFilename(filename: string): string | null {
	const base = path.parse(path.basename(filename)).name;
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(base)) {
		return base.toLowerCase();
	}
	return null;
}

async function listLocalRootFiles(root: string): Promise<string[]> {
	const absolute = path.isAbsolute(root) ? root : path.join(process.cwd(), root);
	const names: string[] = [];

	async function walk(dir: string, rel = ''): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(path.join(dir, entry.name), childRel);
			} else if (entry.isFile()) {
				if (!isIgnoredDiskEntry(childRel)) names.push(childRel);
			}
		}
	}

	await walk(absolute);
	return names;
}

/**
 * List object keys on a storage location.
 * Prefer driver.list(); for local drivers also walk the root (list('') is unreliable
 * on @directus/storage-driver-local because dirname(root) escapes the uploads folder).
 */
export async function listDiskFilenames(location: string, env?: Record<string, unknown>): Promise<string[]> {
	const names = new Set<string>();

	if (env) {
		const driver = getLocationDriver(env, location);
		const root = getLocationRoot(env, location);
		if (driver === 'local' && root) {
			for (const name of await listLocalRootFiles(root)) names.add(name);
			return Array.from(names);
		}
	}

	const storage = await getStorageManager();
	const disk = storage.location(location);

	try {
		for await (const filepath of diskList(disk, '')) {
			const name = String(filepath || '').replace(/^[/\\]+/, '');
			if (!name || isIgnoredDiskEntry(name)) continue;
			names.add(name);
		}
	} catch (error: any) {
		throw new Error(
			`Could not list files on storage “${location}”: ${error?.message || error}`,
		);
	}

	return Array.from(names);
}

export async function detectOrphans(
	database: any,
	location: string,
	env?: Record<string, unknown>,
	pathPrefix?: string | null,
): Promise<{ orphans: OrphanFile[]; scanned: number; known: number; path: string }> {
	const prefix = String(pathPrefix || '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\/+/g, '/');

	const onDiskAll = await listDiskFilenames(location, env);
	const onDisk = prefix
		? onDiskAll.filter((name) => name === prefix || name.startsWith(`${prefix}/`))
		: onDiskAll;

	const rows = await database('directus_files').select('filename_disk').where('storage', location);
	const known = new Set(
		rows.map((r: { filename_disk: string | null }) => String(r.filename_disk || '')).filter(Boolean),
	);

	const storage = await getStorageManager();
	const disk = storage.location(location);
	const orphans: OrphanFile[] = [];

	for (const filename_disk of onDisk) {
		if (known.has(filename_disk)) continue;

		let filesize = 0;
		try {
			const stat = await diskStat(disk, filename_disk);
			filesize = Number(stat.size) || 0;
		} catch {
			filesize = 0;
		}

		orphans.push({
			filename_disk,
			filesize,
			type: guessMime(filename_disk),
			suggested_id: uuidFromFilename(filename_disk),
			filename_download: path.basename(filename_disk),
			title: titleFromFilenameDisk(filename_disk),
		});
	}

	orphans.sort((a, b) => a.filename_disk.localeCompare(b.filename_disk));

	return { orphans, scanned: onDisk.length, known: known.size, path: prefix };
}

export type ImportOrphanResult = {
	filename_disk: string;
	id?: string;
	status: 'imported' | 'skipped' | 'failed';
	error?: string;
};

export async function importOrphans(
	database: any,
	location: string,
	filenameDisks: string[],
	options?: { folder?: string | null },
): Promise<ImportOrphanResult[]> {
	const storage = await getStorageManager();
	const disk = storage.location(location);
	const results: ImportOrphanResult[] = [];

	for (const filename_disk of filenameDisks) {
		const name = String(filename_disk || '').trim();
		if (!name || isIgnoredDiskEntry(name)) {
			results.push({ filename_disk: name, status: 'skipped', error: 'Ignored path' });
			continue;
		}

		try {
			const existing = await database('directus_files')
				.select('id')
				.where({ storage: location, filename_disk: name })
				.first();

			if (existing) {
				results.push({ filename_disk: name, id: String(existing.id), status: 'skipped', error: 'Already in database' });
				continue;
			}

			const exists = await diskExists(disk, name);
			if (!exists) {
				results.push({ filename_disk: name, status: 'failed', error: 'File not found on disk' });
				continue;
			}

			const stat = await diskStat(disk, name);
			const suggested = uuidFromFilename(name);
			let id = suggested || randomUUID();

			if (suggested) {
				const idTaken = await database('directus_files').select('id').where({ id: suggested }).first();
				if (idTaken) id = randomUUID();
			}

			const now = new Date();
			const filename_download = path.basename(name);
			const type = guessMime(name);
			const title = titleFromFilenameDisk(name);

			let width: number | null = null;
			let height: number | null = null;
			if (shouldReadImageDimensions(type)) {
				const dims = await readImageDimensions(disk, name);
				if (dims) {
					width = dims.width;
					height = dims.height;
				}
			}

			await database('directus_files').insert({
				id,
				storage: location,
				filename_disk: name,
				filename_download,
				title,
				type,
				filesize: Number(stat.size) || 0,
				width,
				height,
				folder: options?.folder || null,
				uploaded_on: now,
				modified_on: now,
			});

			results.push({ filename_disk: name, id, status: 'imported' });
		} catch (error: any) {
			results.push({
				filename_disk: name,
				status: 'failed',
				error: error?.message || String(error),
			});
		}
	}

	return results;
}

export type DeleteOrphanResult = {
	filename_disk: string;
	status: 'deleted' | 'skipped' | 'failed';
	error?: string;
};

export async function deleteOrphans(
	database: any,
	location: string,
	filenameDisks: string[],
): Promise<DeleteOrphanResult[]> {
	const storage = await getStorageManager();
	const disk = storage.location(location);
	const results: DeleteOrphanResult[] = [];

	for (const filename_disk of filenameDisks) {
		const name = String(filename_disk || '').trim();
		if (!name || isIgnoredDiskEntry(name)) {
			results.push({
				filename_disk: name,
				status: 'skipped',
				error: name && isAssetTransform(name) ? 'Generated thumbnail' : 'Ignored path',
			});
			continue;
		}

		try {
			const existing = await database('directus_files')
				.select('id')
				.where({ storage: location, filename_disk: name })
				.first();

			if (existing) {
				results.push({
					filename_disk: name,
					status: 'skipped',
					error: 'Registered in Directus — use File Library to delete',
				});
				continue;
			}

			const exists = await diskExists(disk, name);
			if (!exists) {
				results.push({ filename_disk: name, status: 'skipped', error: 'Not found on disk' });
				continue;
			}

			await diskDelete(disk, name);
			results.push({ filename_disk: name, status: 'deleted' });
		} catch (error: any) {
			results.push({
				filename_disk: name,
				status: 'failed',
				error: error?.message || String(error),
			});
		}
	}

	return results;
}
