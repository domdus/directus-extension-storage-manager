import { moveFilesToStoragePath } from '../endpoint/physical-folders';
import { buildPrefix, isDirectusFolderMirrorEnabled } from './prefix';
import { getLocationSettings, loadSettings } from './settings';

function defaultStorageLocation(env: Record<string, unknown>): string {
	return String(env['STORAGE_LOCATIONS'] ?? 'local')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)[0] ?? 'local';
}

/**
 * Mirror a freshly uploaded file under its Directus folder prefix on disk.
 *
 * Directus multipart uploads call createOne(..., { emitEvents: false }), which
 * skips filters — so files.create prefix injection never runs. files.upload
 * fires after the object is written; relocate the flat UUID path then.
 */
export async function mirrorFileAfterUpload(options: {
	database: any;
	env: Record<string, unknown>;
	fileId: string;
	logger: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<void> {
	const row = await options.database('directus_files')
		.select('id', 'storage', 'filename_disk', 'folder', 'type', 'uploaded_on')
		.where('id', options.fileId)
		.first();

	if (!row?.filename_disk) return;

	const location = String(row.storage ?? defaultStorageLocation(options.env));
	const settings = await loadSettings(options.database);
	const locSettings = getLocationSettings(settings, location);

	if (!isDirectusFolderMirrorEnabled(locSettings)) return;

	const prefix = await buildPrefix(locSettings, row, options.database);
	if (!prefix) return;

	const filenameDisk = String(row.filename_disk);
	if (filenameDisk.startsWith(`${prefix}/`) || filenameDisk === prefix) return;

	const result = await moveFilesToStoragePath(
		options.database,
		location,
		[options.fileId],
		prefix,
		options.logger,
		options.env,
	);

	const entry = result.results[0];
	if (entry?.status === 'failed') {
		options.logger.warn(
			`[storage-manager] Upload mirror failed for ${options.fileId}: ${entry.error || 'unknown error'}`,
		);
	}
}
