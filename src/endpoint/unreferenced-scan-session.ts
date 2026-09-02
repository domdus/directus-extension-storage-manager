import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { diskRead, getStorageManager } from './storage';
import { listConfiguredLocations } from './usage';
import { createTmpFile } from './unreferenced-scan-tmp';

export type UnreferencedScanSessionMeta = {
	total_files: number;
	used_count: number;
	unreferenced_count: number;
	unreferenced_bytes: number;
	relation_targets: number;
	text_targets: number;
	collections_checked: number;
	min_age_minutes: number;
	scan_text_fields: boolean;
	elapsed_ms: number;
	truncated: boolean;
};

export type UnreferencedScanSession = {
	id: string;
	ids: string[];
	meta: UnreferencedScanSessionMeta;
	createdAt: number;
	fileId?: string;
	/** In-memory only — recomputed after reload. */
	filterCache?: { key: string; ids: string[]; bytes?: number };
};

export type UnreferencedScanSessionContext = {
	database: any;
	env: Record<string, unknown>;
	services: Record<string, any>;
	getSchema: () => Promise<any>;
	accountability?: unknown;
	logger?: { info?: (m: string) => void; warn?: (m: string) => void };
};

/** Keep scan results available for a full work day. */
export const UNREFERENCED_SCAN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * File Library folder for scan JSON snapshots.
 * Same approach as migration-bundle working folders:
 * https://github.com/directus-labs/extensions/tree/main/packages/migration-bundle
 */
export const UNREFERENCED_SCAN_FOLDER_NAME = 'Unreferenced File Scans';

const FILENAME_PREFIX = 'unreferenced-scan-';

/** Hot cache so paging does not re-download/parse huge JSON every request. */
const memory = new Map<string, UnreferencedScanSession>();

function isExpired(createdAt: number): boolean {
	return Date.now() - createdAt > UNREFERENCED_SCAN_TTL_MS;
}

function downloadName(scanId: string): string {
	return `${FILENAME_PREFIX}${scanId}.json`;
}

function defaultStorage(env: Record<string, unknown>): string {
	return listConfiguredLocations(env)[0] || 'local';
}

function filesService(ctx: UnreferencedScanSessionContext, schema: any) {
	const FilesService = ctx.services.FilesService;
	if (!FilesService) throw new Error('FilesService unavailable');
	return new FilesService({
		schema,
		accountability: ctx.accountability ?? null,
	});
}

function foldersService(ctx: UnreferencedScanSessionContext, schema: any) {
	const FoldersService = ctx.services.FoldersService;
	if (!FoldersService) throw new Error('FoldersService unavailable');
	return new FoldersService({
		schema,
		accountability: ctx.accountability ?? null,
	});
}

export async function getUnreferencedScanFolderId(database: any): Promise<string | null> {
	const row = await database('directus_folders')
		.select('id')
		.where({ name: UNREFERENCED_SCAN_FOLDER_NAME })
		.whereNull('parent')
		.first();
	return row?.id ? String(row.id) : null;
}

/**
 * Ensure the shared File Library folder exists (root-level).
 * Mirrors migration-bundle’s `FoldersService.createOne({ name, parent: null })`.
 */
export async function ensureUnreferencedScanFolder(ctx: UnreferencedScanSessionContext): Promise<string> {
	const existing = await getUnreferencedScanFolderId(ctx.database);
	if (existing) return existing;

	const schema = await ctx.getSchema();
	const id = await foldersService(ctx, schema).createOne({
		name: UNREFERENCED_SCAN_FOLDER_NAME,
		parent: null,
	});
	ctx.logger?.info?.(`[storage-manager] Created File Library folder “${UNREFERENCED_SCAN_FOLDER_NAME}”`);
	return String(id);
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream as AsyncIterable<Buffer | string>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function findFileRow(database: any, folderId: string, scanId: string) {
	return database('directus_files')
		.select('id', 'storage', 'filename_disk', 'uploaded_on')
		.where({ folder: folderId, filename_download: downloadName(scanId) })
		.first();
}

async function readSessionFromFileRow(
	fileRow: { id: string; storage: string; filename_disk: string },
): Promise<UnreferencedScanSession | null> {
	const storage = await getStorageManager();
	const disk = storage.location(String(fileRow.storage));
	const stream = await diskRead(disk, String(fileRow.filename_disk));
	const raw = await streamToString(stream);
	const parsed = JSON.parse(raw) as {
		id?: string;
		createdAt?: number;
		meta?: UnreferencedScanSessionMeta;
		ids?: string[];
	};

	const id = String(parsed.id || '');
	const createdAt = Number(parsed.createdAt) || 0;
	if (!id || !parsed.meta || !Array.isArray(parsed.ids) || isExpired(createdAt)) return null;

	return {
		id,
		ids: parsed.ids.map(String),
		meta: parsed.meta,
		createdAt,
		fileId: String(fileRow.id),
	};
}

async function pruneExpiredScanFiles(ctx: UnreferencedScanSessionContext, folderId: string) {
	const cutoff = Date.now() - UNREFERENCED_SCAN_TTL_MS;
	for (const [id, session] of memory) {
		if (session.createdAt < cutoff) memory.delete(id);
	}

	const rows = await ctx.database('directus_files')
		.select('id', 'filename_download', 'uploaded_on')
		.where({ folder: folderId })
		.where('filename_download', 'like', `${FILENAME_PREFIX}%`);

	if (!rows?.length) return;

	const schema = await ctx.getSchema();
	const service = filesService(ctx, schema);
	for (const row of rows) {
		const uploaded = row.uploaded_on ? new Date(row.uploaded_on).getTime() : 0;
		if (uploaded && uploaded >= cutoff) continue;
		try {
			await service.deleteOne(String(row.id));
			const name = String(row.filename_download || '');
			const scanId = name.startsWith(FILENAME_PREFIX)
				? name.slice(FILENAME_PREFIX.length).replace(/\.json$/i, '')
				: '';
			if (scanId) memory.delete(scanId);
		} catch {
			/* best-effort */
		}
	}
}

async function uploadSessionJson(
	ctx: UnreferencedScanSessionContext,
	folderId: string,
	session: UnreferencedScanSession,
): Promise<string> {
	const payload = JSON.stringify({
		id: session.id,
		createdAt: session.createdAt,
		meta: session.meta,
		ids: session.ids,
	});

	const tmp = await createTmpFile();
	try {
		await appendFile(tmp.path, payload);
		const schema = await ctx.getSchema();
		const service = filesService(ctx, schema);
		// Same upload shape as migration-bundle `saveToFile`.
		const fileId = await service.uploadOne(createReadStream(tmp.path), {
			title: `Unreferenced scan ${new Date(session.createdAt).toISOString()}`,
			folder: folderId,
			filename_download: downloadName(session.id),
			storage: defaultStorage(ctx.env),
			type: 'application/json',
		});
		return String(fileId);
	} finally {
		await tmp.cleanup().catch(() => undefined);
	}
}

/**
 * Persist scan IDs as a JSON file in File Library (migration-bundle style).
 */
export async function saveUnreferencedScanSession(
	ctx: UnreferencedScanSessionContext,
	ids: string[],
	meta: UnreferencedScanSessionMeta,
): Promise<UnreferencedScanSession> {
	const folderId = await ensureUnreferencedScanFolder(ctx);
	await pruneExpiredScanFiles(ctx, folderId);

	const session: UnreferencedScanSession = {
		id: randomUUID(),
		ids: ids.map(String),
		meta: { ...meta },
		createdAt: Date.now(),
	};

	session.fileId = await uploadSessionJson(ctx, folderId, session);
	memory.set(session.id, session);
	return session;
}

export async function getUnreferencedScanSession(
	ctx: UnreferencedScanSessionContext,
	scanId: string,
): Promise<UnreferencedScanSession | null> {
	const id = String(scanId || '');
	if (!id) return null;

	const cached = memory.get(id);
	if (cached) {
		if (isExpired(cached.createdAt)) {
			memory.delete(id);
			return null;
		}
		return cached;
	}

	const folderId = await getUnreferencedScanFolderId(ctx.database);
	if (!folderId) return null;

	const row = await findFileRow(ctx.database, folderId, id);
	if (!row) return null;

	try {
		const session = await readSessionFromFileRow(row);
		if (!session) {
			const schema = await ctx.getSchema();
			await filesService(ctx, schema).deleteOne(String(row.id)).catch(() => undefined);
			return null;
		}
		memory.set(id, session);
		return session;
	} catch (err) {
		ctx.logger?.warn?.(
			`[storage-manager] Failed to read scan session ${id}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export async function removeIdsFromUnreferencedScanSession(
	ctx: UnreferencedScanSessionContext,
	scanId: string,
	removeIds: string[],
): Promise<number> {
	const session = await getUnreferencedScanSession(ctx, scanId);
	if (!session) return 0;

	const removed = applyRemovedIdsToUnreferencedScanSession(session, removeIds);
	if (!removed) return 0;

	await persistUnreferencedScanSession(ctx, session);
	return removed;
}

/** Mutate in-memory session only (caller persists). */
export function applyRemovedIdsToUnreferencedScanSession(
	session: UnreferencedScanSession,
	removeIds: string[],
): number {
	const drop = new Set(removeIds.map(String));
	const before = session.ids.length;
	session.ids = session.ids.filter((id) => !drop.has(id));
	const removed = before - session.ids.length;
	if (!removed) return 0;

	session.meta.unreferenced_count = Math.max(0, session.meta.unreferenced_count - removed);
	if (session.filterCache) {
		session.filterCache = {
			key: session.filterCache.key,
			ids: session.filterCache.ids.filter((id) => !drop.has(id)),
		};
	}
	return removed;
}

/** Rewrite the scan JSON snapshot from the in-memory session (ids already mutated). */
export async function persistUnreferencedScanSession(
	ctx: UnreferencedScanSessionContext,
	session: UnreferencedScanSession,
): Promise<void> {
	const folderId = await ensureUnreferencedScanFolder(ctx);
	const schema = await ctx.getSchema();
	const service = filesService(ctx, schema);

	if (session.fileId) {
		await service.deleteOne(session.fileId).catch(() => undefined);
	} else {
		const existing = await findFileRow(ctx.database, folderId, session.id);
		if (existing?.id) await service.deleteOne(String(existing.id)).catch(() => undefined);
	}

	session.fileId = await uploadSessionJson(ctx, folderId, session);
	memory.set(session.id, session);
}

export async function clearUnreferencedScanSession(
	ctx: UnreferencedScanSessionContext,
	scanId: string,
): Promise<void> {
	const id = String(scanId || '');
	memory.delete(id);
	const folderId = await getUnreferencedScanFolderId(ctx.database);
	if (!folderId) return;
	const row = await findFileRow(ctx.database, folderId, id);
	if (!row?.id) return;
	const schema = await ctx.getSchema();
	await filesService(ctx, schema).deleteOne(String(row.id)).catch(() => undefined);
}
