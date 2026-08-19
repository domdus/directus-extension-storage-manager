/**
 * Directus FilesService.deleteMany lists disk objects by basename stem at the
 * storage root (`disk.list(path.parse(filename_disk).name)`). That finds
 * AssetsService thumbnails (`uuid__hash.ext`) but not nested originals
 * (`folder/uuid.jpg`). Capture those paths before the DB row is gone, then
 * delete the leftover objects.
 */
import { diskDeleteWithAssets, getStorageManager } from '../endpoint/storage';

export type NestedFileRef = {
	id: string;
	storage: string;
	filename_disk: string;
};

export async function captureNestedFilesForDelete(
	database: any,
	keys: string[],
): Promise<NestedFileRef[]> {
	const ids = (keys || []).map(String).filter(Boolean);
	if (!ids.length) return [];

	const rows = await database('directus_files').select('id', 'storage', 'filename_disk').whereIn('id', ids);
	const nested: NestedFileRef[] = [];

	for (const row of rows || []) {
		const filename = String(row?.filename_disk || '')
			.replace(/\\/g, '/')
			.replace(/^\/+/, '');
		if (!filename.includes('/')) continue;
		const storage = String(row?.storage || '').trim();
		if (!storage) continue;
		nested.push({ id: String(row.id), storage, filename_disk: filename });
	}

	return nested;
}

export async function deleteNestedFileObjects(
	files: NestedFileRef[],
	logger?: { warn: (msg: string) => void },
): Promise<void> {
	if (!files.length) return;

	const storage = await getStorageManager();

	for (const file of files) {
		try {
			const disk = storage.location(file.storage);
			await diskDeleteWithAssets(disk, file.filename_disk);
		} catch (err: any) {
			logger?.warn(
				`[storage-manager] Nested file leftover after delete (${file.storage}/${file.filename_disk}): ${err?.message || err}`,
			);
		}
	}
}
