import { Transform } from 'node:stream';
import {
	diskDeleteWithAssets,
	diskExists,
	diskListRelatedAssets,
	diskRead,
	diskStat,
	diskWrite,
	getStorageManager,
	type StorageDisk,
} from './storage';
import type {
	MigrateFileResult,
	MigrateMode,
	MigrateProgressEvent,
	MigrateResponse,
} from '../shared/types';

export type MigrateOptions = {
	fileIds: string[];
	targetStorage: string;
	mode: MigrateMode;
	concurrency?: number;
	database: any;
	logger?: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
	onProgress?: (event: MigrateProgressEvent) => void;
	/** Abort when this returns true (e.g. client disconnected). */
	isCancelled?: () => boolean;
};

type FileRow = {
	id: string;
	storage: string;
	filename_disk: string;
	filename_download?: string | null;
	title?: string | null;
	type: string | null;
	filesize: number | null;
};

function displayName(file: FileRow): string {
	return String(file.title || file.filename_download || file.filename_disk || file.id);
}

function createByteCounter(onChunk: (bytes: number) => void): Transform {
	return new Transform({
		transform(chunk, _encoding, callback) {
			const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
			if (len > 0) onChunk(len);
			callback(null, chunk);
		},
	});
}

async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
	isCancelled?: () => boolean,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;

	async function run() {
		while (next < items.length) {
			if (isCancelled?.()) return;
			const index = next++;
			results[index] = await worker(items[index]!, index);
		}
	}

	const runners = Array.from({ length: Math.min(concurrency, items.length) || 1 }, () => run());
	await Promise.all(runners);
	return results;
}

/** Best-effort copy of Directus image transforms stored beside the original. */
async function migrateRelatedAssets(
	sourceDisk: StorageDisk,
	targetDisk: StorageDisk,
	filenameDisk: string,
	logger?: MigrateOptions['logger'],
): Promise<void> {
	let related: string[];
	try {
		related = await diskListRelatedAssets(sourceDisk, filenameDisk);
	} catch (err) {
		logger?.warn?.(
			`[storage-manager] Could not list asset transforms for ${filenameDisk}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	for (const name of related) {
		try {
			if (await diskExists(targetDisk, name)) continue;
			const stream = await diskRead(sourceDisk, name);
			await diskWrite(targetDisk, name, stream, null);
		} catch (err) {
			logger?.warn?.(
				`[storage-manager] Failed copying asset transform ${name}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

/**
 * Physically copy/move a single file between storage adapters, keeping the same
 * directus_files id and filename_disk. Also copies generated image transforms
 * (`{stem}__{hash}.ext`) when the driver supports list(). Source (and transforms)
 * are only deleted after the target is verified and the DB row is updated (move).
 */
export async function migrateOneFile(
	file: FileRow,
	targetStorage: string,
	mode: MigrateMode,
	database: any,
	logger?: MigrateOptions['logger'],
	onBytes?: (bytes: number) => void,
): Promise<MigrateFileResult> {
	const base: MigrateFileResult = {
		id: file.id,
		filename_disk: file.filename_disk,
		from: file.storage,
		to: targetStorage,
		status: 'failed',
	};

	if (!file.filename_disk) {
		return { ...base, status: 'failed', error: 'Missing filename_disk' };
	}

	if (file.storage === targetStorage) {
		return { ...base, status: 'skipped', error: 'Already on target storage' };
	}

	const storage = await getStorageManager();
	const sourceDisk = storage.location(file.storage);
	const targetDisk = storage.location(targetStorage);

	const sourceExists = await diskExists(sourceDisk, file.filename_disk);
	if (!sourceExists) {
		return { ...base, status: 'failed', error: `Source object missing on ${file.storage}` };
	}

	const targetAlreadyExists = await diskExists(targetDisk, file.filename_disk);
	if (targetAlreadyExists) {
		await migrateRelatedAssets(sourceDisk, targetDisk, file.filename_disk, logger);
		await database('directus_files').where({ id: file.id }).update({ storage: targetStorage });
		if (mode === 'move') {
			try {
				await diskDeleteWithAssets(sourceDisk, file.filename_disk);
			} catch (err) {
				logger?.warn?.(
					`[storage-manager] DB updated but failed deleting source ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const stat = await diskStat(targetDisk, file.filename_disk).catch(() => ({ size: Number(file.filesize) || 0 }));
		if (onBytes && stat.size > 0) onBytes(stat.size);
		return {
			...base,
			status: mode === 'move' ? 'moved' : 'copied',
			bytes: stat.size,
		};
	}

	const readStream = await diskRead(sourceDisk, file.filename_disk);
	const countedStream = onBytes ? readStream.pipe(createByteCounter(onBytes)) : readStream;

	try {
		await diskWrite(targetDisk, file.filename_disk, countedStream, file.type);
	} catch (err) {
		try {
			if (await diskExists(targetDisk, file.filename_disk)) {
				await diskDeleteWithAssets(targetDisk, file.filename_disk);
			}
		} catch {
			// ignore
		}
		return {
			...base,
			status: 'failed',
			error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const verified = await diskExists(targetDisk, file.filename_disk);
	if (!verified) {
		return { ...base, status: 'failed', error: 'Target write did not persist (exists check failed)' };
	}

	let targetSize = 0;
	try {
		const stat = await diskStat(targetDisk, file.filename_disk);
		targetSize = stat.size;
	} catch (err) {
		return {
			...base,
			status: 'failed',
			error: `Target stat failed after write: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (file.filesize != null && Number(file.filesize) > 0 && targetSize > 0) {
		const expected = Number(file.filesize);
		const delta = Math.abs(expected - targetSize);
		if (delta > Math.max(64, expected * 0.01) && targetSize < expected * 0.95) {
			try {
				await diskDeleteWithAssets(targetDisk, file.filename_disk);
			} catch {
				// ignore
			}
			return {
				...base,
				status: 'failed',
				error: `Size mismatch after write (expected ~${expected}, got ${targetSize})`,
			};
		}
	}

	await migrateRelatedAssets(sourceDisk, targetDisk, file.filename_disk, logger);

	try {
		await database('directus_files').where({ id: file.id }).update({ storage: targetStorage });
	} catch (err) {
		try {
			await diskDeleteWithAssets(targetDisk, file.filename_disk);
		} catch {
			// ignore
		}
		return {
			...base,
			status: 'failed',
			error: `DB update failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (mode === 'move') {
		try {
			await diskDeleteWithAssets(sourceDisk, file.filename_disk);
		} catch (err) {
			logger?.warn?.(
				`[storage-manager] Moved ${file.id} to ${targetStorage} but source delete failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return {
				...base,
				status: 'moved',
				bytes: targetSize,
				error: `Moved, but source cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	return {
		...base,
		status: mode === 'move' ? 'moved' : 'copied',
		bytes: targetSize,
	};
}

export async function migrateFiles(options: MigrateOptions): Promise<MigrateResponse> {
	const { fileIds, targetStorage, mode, database, logger, onProgress, isCancelled } = options;
	const concurrency = Math.min(8, Math.max(1, Number(options.concurrency) || 3));
	const startedAt = Date.now();

	const uniqueIds = Array.from(new Set(fileIds.filter(Boolean)));

	if (uniqueIds.length === 0) {
		const empty: MigrateResponse = {
			mode,
			target_storage: targetStorage,
			total: 0,
			succeeded: 0,
			skipped: 0,
			failed: 0,
			results: [],
			transferred_bytes: 0,
			total_bytes: 0,
			elapsed_ms: 0,
		};
		onProgress?.({ type: 'done', data: empty });
		return empty;
	}

	const rows: FileRow[] = await database('directus_files')
		.select('id', 'storage', 'filename_disk', 'filename_download', 'title', 'type', 'filesize')
		.whereIn('id', uniqueIds);

	const byId = new Map(rows.map((r) => [String(r.id), r]));
	const totalBytes = rows.reduce((sum, r) => sum + (Number(r.filesize) || 0), 0);
	const sourceHint =
		rows.length && rows.every((r) => r.storage === rows[0]!.storage) ? rows[0]!.storage : null;

	onProgress?.({
		type: 'start',
		mode,
		from: sourceHint,
		to: targetStorage,
		total: uniqueIds.length,
		total_bytes: totalBytes,
	});

	let transferredBytes = 0;
	let succeeded = 0;
	let skipped = 0;
	let failed = 0;
	let nextDisplayIndex = 0;

	// Per-file in-flight byte tracking for throttled file_bytes events
	const fileTransferred = new Map<string, number>();
	let lastBytesEmit = 0;

	const emitBytes = (index: number, file: FileRow, delta: number) => {
		transferredBytes += delta;
		const current = (fileTransferred.get(file.id) || 0) + delta;
		fileTransferred.set(file.id, current);

		const now = Date.now();
		if (now - lastBytesEmit < 120) return;
		lastBytesEmit = now;

		onProgress?.({
			type: 'file_bytes',
			index,
			id: file.id,
			file_transferred: current,
			file_bytes: Number(file.filesize) || 0,
			transferred_bytes: transferredBytes,
			total_bytes: totalBytes,
			elapsed_ms: now - startedAt,
		});
	};

	const results = await mapPool(
		uniqueIds,
		concurrency,
		async (id) => {
			if (isCancelled?.()) {
				return {
					id,
					filename_disk: '',
					from: '',
					to: targetStorage,
					status: 'failed' as const,
					error: 'Cancelled',
				};
			}

			const file = byId.get(id);
			const index = ++nextDisplayIndex;

			if (!file) {
				failed += 1;
				const result: MigrateFileResult = {
					id,
					filename_disk: '',
					from: '',
					to: targetStorage,
					status: 'failed',
					error: 'File not found',
				};
				onProgress?.({
					type: 'file_done',
					index,
					total: uniqueIds.length,
					result,
					name: id,
					succeeded,
					skipped,
					failed,
					transferred_bytes: transferredBytes,
					total_bytes: totalBytes,
					elapsed_ms: Date.now() - startedAt,
				});
				return result;
			}

			onProgress?.({
				type: 'file_start',
				index,
				total: uniqueIds.length,
				id: file.id,
				name: displayName(file),
				filename_disk: file.filename_disk,
				from: file.storage,
				to: targetStorage,
				bytes: Number(file.filesize) || 0,
			});

			fileTransferred.set(file.id, 0);

			let result: MigrateFileResult;
			try {
				result = await migrateOneFile(file, targetStorage, mode, database, logger, (delta) =>
					emitBytes(index, file, delta),
				);
			} catch (err) {
				result = {
					id: file.id,
					filename_disk: file.filename_disk,
					from: file.storage,
					to: targetStorage,
					status: 'failed',
					error: err instanceof Error ? err.message : String(err),
				};
			}

			if (result.status === 'moved' || result.status === 'copied') {
				succeeded += 1;
				// Ensure transferred reflects file size if counter under-reported (e.g. exists shortcut)
				const counted = fileTransferred.get(file.id) || 0;
				const reported = Number(result.bytes) || Number(file.filesize) || 0;
				if (reported > counted) {
					transferredBytes += reported - counted;
					fileTransferred.set(file.id, reported);
				}
			} else if (result.status === 'skipped') {
				skipped += 1;
			} else {
				failed += 1;
			}

			onProgress?.({
				type: 'file_done',
				index,
				total: uniqueIds.length,
				result,
				name: displayName(file),
				succeeded,
				skipped,
				failed,
				transferred_bytes: transferredBytes,
				total_bytes: totalBytes,
				elapsed_ms: Date.now() - startedAt,
			});

			return result;
		},
		isCancelled,
	);

	const response: MigrateResponse = {
		mode,
		target_storage: targetStorage,
		total: results.filter(Boolean).length,
		succeeded,
		skipped,
		failed,
		results: results.filter(Boolean),
		transferred_bytes: transferredBytes,
		total_bytes: totalBytes,
		elapsed_ms: Date.now() - startedAt,
	};

	logger?.info?.(
		`[storage-manager] ${mode} → ${targetStorage}: ${succeeded} ok, ${skipped} skipped, ${failed} failed (of ${response.total})`,
	);

	onProgress?.({ type: 'done', data: response });
	return response;
}
