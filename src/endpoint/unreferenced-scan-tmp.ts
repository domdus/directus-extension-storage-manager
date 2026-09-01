import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Same pattern as migration-bundle `create-tmp` — stage JSON before FilesService.uploadOne. */
export async function createTmpFile() {
	const dir = await fs.mkdtemp(path.join(tmpdir(), 'storage-manager-scan-'));
	const filename = createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12);
	const filePath = path.join(dir, filename);

	const fd = await fs.open(filePath, 'wx');
	await fd.close();

	async function cleanup() {
		await fs.unlink(filePath).catch(() => undefined);
		await fs.rmdir(dir).catch(() => undefined);
	}

	return { path: filePath, cleanup };
}
