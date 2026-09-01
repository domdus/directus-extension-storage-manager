import {
	extractAllUuids,
	extractAssetUuids,
	normalizeUuid,
	valueToSearchText,
} from '../shared/uuid-extract';

export type FileRelationRef = {
	collection: string;
	field: string;
	/** When true, collection is a singleton (read one row). */
	singleton: boolean;
};

export type TextScanTarget = {
	collection: string;
	field: string;
	/** Prefer /assets/uuid extraction; still collect bare UUIDs for json/code. */
	mode: 'assets_and_uuids' | 'assets_only';
};

export type UnreferencedFileRow = {
	id: string;
	title: string | null;
	filename_download: string;
	filename_disk: string;
	storage: string;
	type: string | null;
	filesize: number | null;
	folder: string | null;
	uploaded_on: string | null;
};

export type UnreferencedScanMeta = {
	total_files: number;
	used_count: number;
	unreferenced_count: number;
	/** Sum of `filesize` for all unreferenced files (full count, not list-capped). */
	unreferenced_bytes: number;
	relation_targets: number;
	text_targets: number;
	/** Unique collections covered by relation and/or text targets. */
	collections_checked: number;
	min_age_minutes: number;
	scan_text_fields: boolean;
	elapsed_ms: number;
	truncated: boolean;
	/** True when more unreferenced files exist than were returned in `ids`. */
	ids_truncated: boolean;
	/** Unreferenced file ids (capped) for native layout filter. */
	ids: string[];
};

export type UnreferencedScanResult = {
	files: UnreferencedFileRow[];
	meta: UnreferencedScanMeta;
};

/** Collections whose text/json must not count as live file usage. */
const TEXT_SCAN_SKIP_COLLECTIONS = new Set([
	'directus_activity',
	'directus_revisions',
	'directus_sessions',
	'directus_migrations',
	'directus_notifications',
	'directus_shares',
	'directus_operations',
	'directus_flows',
	'directus_panels',
	'directus_dashboards',
	'directus_versions',
	'directus_extensions',
	'directus_permissions',
	'directus_access',
	'directus_policies',
	'directus_presets',
	'directus_deployments',
	'directus_deployment_projects',
	'directus_deployment_runs',
	'unused_files',
	'unused_files_iteration',
]);

function shouldSkipTextScanCollection(collection: string): boolean {
	if (!collection) return true;
	if (TEXT_SCAN_SKIP_COLLECTIONS.has(collection)) return true;
	// System tables are full of JSON/code meta — not content that embeds /assets/ UUIDs.
	if (collection.startsWith('directus_')) return true;
	return false;
}

const TEXT_SCAN_INTERFACES = new Set([
	'input-rich-text-html',
	'input-rich-text-md',
	'input-rich-text-mdm',
	'input-code',
	'input-multiline',
	'input-block-editor',
	'json',
	'list',
	'tags',
	'markdown',
	'wysiwyg',
]);

const TEXT_SCAN_TYPES = new Set(['text', 'json', 'csv']);

const BATCH = 500;
/** Chunk size when walking `directus_files` (keyset). */
const FILE_CHUNK = 5_000;
/**
 * Cap ids returned for the native layout `id._in` filter.
 * Directus querystring parsing defaults `QUERYSTRING_ARRAY_LIMIT` to 100–500;
 * larger `_in` lists are truncated/mishandled and the grid renders empty.
 * Full `unreferenced_count` / `unreferenced_bytes` still cover every match.
 */
const MAX_IDS_RETURNED = 500;

function isSafeIdent(name: string): boolean {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function primaryKeyField(schema: any, collection: string): string {
	const raw = schema?.collections?.[collection]?.primary;
	if (typeof raw === 'string' && isSafeIdent(raw)) return raw;
	if (Array.isArray(raw) && raw.length === 1 && isSafeIdent(String(raw[0]))) return String(raw[0]);
	return 'id';
}

export type UnreferencedScanProgress = {
	phase: 'relations' | 'text' | 'files' | 'finalize';
	message: string;
	current: number;
	total: number;
	used_count?: number;
	unreferenced_count?: number;
};

function yieldEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export function discoverFileRelations(schema: any): FileRelationRef[] {
	const relations: any[] = Array.isArray(schema?.relations) ? schema.relations : [];
	const collections = schema?.collections && typeof schema.collections === 'object' ? schema.collections : {};
	const out: FileRelationRef[] = [];
	const seen = new Set<string>();

	for (const rel of relations) {
		if (String(rel?.related_collection || '') !== 'directus_files') continue;
		const collection = String(rel.collection || '');
		const field = String(rel.field || '');
		if (!collection || !field || !isSafeIdent(collection) || !isSafeIdent(field)) continue;
		if (collection === 'directus_files') continue;
		if (TEXT_SCAN_SKIP_COLLECTIONS.has(collection)) continue;

		const key = `${collection}.${field}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const meta = collections[collection];
		out.push({
			collection,
			field,
			singleton: Boolean(meta?.singleton),
		});
	}

	return out.sort((a, b) => a.collection.localeCompare(b.collection) || a.field.localeCompare(b.field));
}

type FieldMetaRow = {
	collection: string;
	field: string;
	interface: string | null;
	type: string | null;
	special: string | null;
};

/**
 * Field `type` lives on the DB schema / getSchema() overview — not on directus_fields
 * (Directus stores only UI meta there: interface, special, options, …).
 */
export async function loadFieldMetaRows(database: any, schema?: any): Promise<FieldMetaRow[]> {
	const rows = await database('directus_fields').select('collection', 'field', 'interface', 'special');
	const collections = schema?.collections && typeof schema.collections === 'object' ? schema.collections : {};

	return (rows || []).map((row: any) => {
		const collection = String(row.collection || '');
		const field = String(row.field || '');
		const schemaType = collections[collection]?.fields?.[field]?.type;
		return {
			collection,
			field,
			interface: row.interface != null ? String(row.interface) : null,
			type: schemaType != null ? String(schemaType) : null,
			special: row.special != null ? String(row.special) : null,
		};
	});
}

export function discoverTextScanTargets(fieldRows: FieldMetaRow[], relationKeys: Set<string>): TextScanTarget[] {
	const out: TextScanTarget[] = [];
	const seen = new Set<string>();

	for (const row of fieldRows) {
		const { collection, field } = row;
		if (!collection || !field) continue;
		if (!isSafeIdent(collection) || !isSafeIdent(field)) continue;
		if (shouldSkipTextScanCollection(collection)) continue;
		if (collection === 'directus_files') continue;

		const key = `${collection}.${field}`;
		if (relationKeys.has(key)) continue; // already covered as FK
		if (seen.has(key)) continue;

		const special = (row.special || '').toLowerCase();
		if (special.includes('alias') || special.includes('no-data')) continue;
		if (special.includes('file') || special.includes('files')) continue;

		const iface = (row.interface || '').toLowerCase();
		const type = (row.type || '').toLowerCase();

		const byInterface = TEXT_SCAN_INTERFACES.has(iface);
		const byType = TEXT_SCAN_TYPES.has(type);
		if (!byInterface && !byType) continue;

		seen.add(key);
		out.push({
			collection,
			field,
			mode: byType && (type === 'json' || type === 'csv' || iface === 'input-code' || iface === 'json' || iface === 'list')
				? 'assets_and_uuids'
				: byInterface &&
					  (iface.includes('rich-text') ||
							iface === 'wysiwyg' ||
							iface === 'markdown' ||
							iface === 'input-rich-text-md' ||
							iface === 'input-block-editor')
					? 'assets_only'
					: 'assets_and_uuids',
		});
	}

	return out.sort((a, b) => a.collection.localeCompare(b.collection) || a.field.localeCompare(b.field));
}

async function tableExists(
	database: any,
	collection: string,
	cache: Map<string, boolean>,
): Promise<boolean> {
	if (cache.has(collection)) return cache.get(collection)!;
	try {
		const ok = Boolean(await database.schema.hasTable(collection));
		cache.set(collection, ok);
		return ok;
	} catch {
		cache.set(collection, false);
		return false;
	}
}

async function columnExists(
	database: any,
	collection: string,
	field: string,
	cache: Map<string, boolean>,
): Promise<boolean> {
	const key = `${collection}.${field}`;
	if (cache.has(key)) return cache.get(key)!;
	try {
		const ok = Boolean(await database.schema.hasColumn(collection, field));
		cache.set(key, ok);
		return ok;
	} catch {
		cache.set(key, false);
		return false;
	}
}

export async function collectUsedFileIds(
	database: any,
	opts: {
		relations: FileRelationRef[];
		textTargets: TextScanTarget[];
		scanTextFields: boolean;
		schema?: any;
		logger?: { warn: (msg: string) => void };
		onProgress?: (event: UnreferencedScanProgress) => void;
		isCancelled?: () => boolean;
	},
): Promise<Set<string>> {
	const used = new Set<string>();
	const { relations, textTargets, scanTextFields, schema, logger, onProgress, isCancelled } = opts;
	const tableCache = new Map<string, boolean>();
	const columnCache = new Map<string, boolean>();

	for (let i = 0; i < relations.length; i++) {
		if (isCancelled?.()) break;
		const ref = relations[i]!;
		onProgress?.({
			phase: 'relations',
			message: `Checking relation ${ref.collection}.${ref.field}`,
			current: i + 1,
			total: relations.length,
			used_count: used.size,
		});

		try {
			if (!(await tableExists(database, ref.collection, tableCache))) continue;
			if (!(await columnExists(database, ref.collection, ref.field, columnCache))) continue;

			if (ref.singleton) {
				const row = await database(ref.collection).select(ref.field).first();
				const raw = row?.[ref.field];
				if (raw == null) continue;
				if (typeof raw === 'object' && raw.id) used.add(normalizeUuid(raw.id));
				else used.add(normalizeUuid(String(raw)));
				continue;
			}

			const rows = await database(ref.collection).distinct(ref.field).whereNotNull(ref.field);
			for (const row of rows) {
				const raw = row?.[ref.field];
				if (raw == null) continue;
				used.add(normalizeUuid(String(raw)));
			}
		} catch (err: any) {
			logger?.warn(
				`[storage-manager] unreferenced: skip relation ${ref.collection}.${ref.field}: ${err?.message || err}`,
			);
		}

		if (i % 5 === 4) await yieldEventLoop();
	}

	if (!scanTextFields || !textTargets.length || isCancelled?.()) {
		used.delete('');
		return used;
	}

	for (let i = 0; i < textTargets.length; i++) {
		if (isCancelled?.()) break;
		const target = textTargets[i]!;
		onProgress?.({
			phase: 'text',
			message: `Scanning ${target.collection}.${target.field}`,
			current: i + 1,
			total: textTargets.length,
			used_count: used.size,
		});

		try {
			if (!(await tableExists(database, target.collection, tableCache))) continue;
			if (!(await columnExists(database, target.collection, target.field, columnCache))) continue;

			const pk = primaryKeyField(schema, target.collection);
			const pkOk = await columnExists(database, target.collection, pk, columnCache);
			let after: string | number | null = null;
			let offset = 0;
			let rowsRead = 0;

			for (;;) {
				if (isCancelled?.()) break;

				let query = database(target.collection).whereNotNull(target.field).limit(BATCH);

				if (pkOk) {
					query = query.select(pk, target.field).orderBy(pk, 'asc');
					if (after != null) query = query.where(pk, '>', after);
				} else {
					query = query.select(target.field).offset(offset);
				}

				const rows = await query;
				if (!rows.length) break;

				for (const row of rows) {
					const text = valueToSearchText(row?.[target.field]);
					if (!text) continue;
					for (const id of extractAssetUuids(text)) used.add(id);
					if (target.mode === 'assets_and_uuids') {
						for (const id of extractAllUuids(text)) used.add(id);
					}
				}

				rowsRead += rows.length;
				if (pkOk) {
					after = rows[rows.length - 1]?.[pk] ?? after;
				} else {
					offset += rows.length;
				}

				if (rowsRead % (BATCH * 20) === 0) {
					onProgress?.({
						phase: 'text',
						message: `Scanning ${target.collection}.${target.field} (${rowsRead.toLocaleString()} rows)`,
						current: i + 1,
						total: textTargets.length,
						used_count: used.size,
					});
					await yieldEventLoop();
				}

				if (rows.length < BATCH) break;
			}
		} catch (err: any) {
			logger?.warn(
				`[storage-manager] unreferenced: skip text ${target.collection}.${target.field}: ${err?.message || err}`,
			);
		}
	}

	used.delete('');
	return used;
}

function applyFileScopeFilters(
	query: any,
	options: { storage?: string | null; folder?: string | null; cutoff: string | null },
) {
	if (options.storage) query.where('storage', String(options.storage));
	if (options.folder !== undefined && options.folder !== null) {
		query.where('folder', String(options.folder));
	}
	if (options.cutoff) {
		query.andWhere((qb: any) => {
			qb.where('uploaded_on', '<', options.cutoff).orWhereNull('uploaded_on');
		});
	}
	return query;
}

export type UnreferencedScanOptions = {
	minAgeMinutes?: number;
	scanTextFields?: boolean;
	storage?: string | null;
	folder?: string | null;
	limit?: number;
	offset?: number;
	logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
	onProgress?: (event: UnreferencedScanProgress) => void;
	isCancelled?: () => boolean;
};

export async function scanUnreferencedFiles(
	database: any,
	schema: any,
	options: UnreferencedScanOptions = {},
): Promise<UnreferencedScanResult> {
	const started = Date.now();
	const minAgeMinutes = Math.max(0, Number(options.minAgeMinutes ?? 60) || 0);
	const scanTextFields = options.scanTextFields !== false;
	const limit = Math.min(500, Math.max(1, Number(options.limit ?? 100) || 100));
	const offset = Math.max(0, Number(options.offset ?? 0) || 0);
	const onProgress = options.onProgress;
	const isCancelled = options.isCancelled;

	const relations = discoverFileRelations(schema);
	const relationKeys = new Set(relations.map((r) => `${r.collection}.${r.field}`));

	let textTargets: TextScanTarget[] = [];
	if (scanTextFields) {
		const fieldRows = await loadFieldMetaRows(database, schema);
		textTargets = discoverTextScanTargets(fieldRows, relationKeys);
	}

	const used = await collectUsedFileIds(database, {
		relations,
		textTargets,
		scanTextFields,
		schema,
		logger: options.logger,
		onProgress,
		isCancelled,
	});

	if (isCancelled?.()) {
		return {
			files: [],
			meta: {
				total_files: 0,
				used_count: used.size,
				unreferenced_count: 0,
				unreferenced_bytes: 0,
				relation_targets: relations.length,
				text_targets: textTargets.length,
				collections_checked: new Set([
					...relations.map((r) => r.collection),
					...textTargets.map((t) => t.collection),
				]).size,
				min_age_minutes: minAgeMinutes,
				scan_text_fields: scanTextFields,
				elapsed_ms: Date.now() - started,
				truncated: false,
				ids_truncated: false,
				ids: [],
			},
		};
	}

	const cutoff =
		minAgeMinutes > 0 ? new Date(Date.now() - minAgeMinutes * 60_000).toISOString() : null;
	const scope = { storage: options.storage, folder: options.folder, cutoff };

	const countQuery = applyFileScopeFilters(database('directus_files').count({ total: '*' }), scope);
	const countRow = await countQuery.first();
	const totalFiles = Number(countRow?.total ?? countRow?.['count(*)'] ?? 0) || 0;

	onProgress?.({
		phase: 'files',
		message: `Walking File Library (${totalFiles.toLocaleString()} files)`,
		current: 0,
		total: totalFiles,
		used_count: used.size,
		unreferenced_count: 0,
	});

	const unreferencedIds: string[] = [];
	let unreferencedCount = 0;
	let unreferencedBytes = 0;
	let idsTruncated = false;
	let scanned = 0;
	let after: string | null = null;

	while (!isCancelled?.()) {
		const chunkQuery = applyFileScopeFilters(
			database('directus_files').select('id', 'filesize').orderBy('id', 'asc').limit(FILE_CHUNK),
			scope,
		);
		if (after) chunkQuery.where('id', '>', after);

		const rows: Array<{ id: string; filesize: number | null }> = await chunkQuery;
		if (!rows.length) break;

		for (const row of rows) {
			const id = String(row.id);
			if (!used.has(normalizeUuid(id))) {
				unreferencedCount++;
				unreferencedBytes += Number(row.filesize) || 0;
				if (unreferencedIds.length < MAX_IDS_RETURNED) unreferencedIds.push(id);
				else idsTruncated = true;
			}
		}

		scanned += rows.length;
		after = String(rows[rows.length - 1]!.id);

		onProgress?.({
			phase: 'files',
			message: `Checked ${scanned.toLocaleString()} / ${totalFiles.toLocaleString()} files`,
			current: scanned,
			total: totalFiles,
			used_count: used.size,
			unreferenced_count: unreferencedCount,
		});

		await yieldEventLoop();
		if (rows.length < FILE_CHUNK) break;
	}

	onProgress?.({
		phase: 'finalize',
		message: 'Preparing results',
		current: totalFiles,
		total: totalFiles,
		used_count: used.size,
		unreferenced_count: unreferencedCount,
	});

	const pageIds = unreferencedIds.slice(offset, offset + limit);

	let page: UnreferencedFileRow[] = [];
	if (pageIds.length) {
		const rows = await database('directus_files')
			.select(
				'id',
				'title',
				'filename_download',
				'filename_disk',
				'storage',
				'type',
				'filesize',
				'folder',
				'uploaded_on',
			)
			.whereIn('id', pageIds);

		const byId = new Map(rows.map((r: UnreferencedFileRow) => [normalizeUuid(r.id), r]));
		page = pageIds.map((id) => byId.get(normalizeUuid(id))).filter(Boolean) as UnreferencedFileRow[];
	}

	const collectionsChecked = new Set([
		...relations.map((r) => r.collection),
		...textTargets.map((t) => t.collection),
	]).size;

	return {
		files: page,
		meta: {
			total_files: totalFiles,
			used_count: used.size,
			unreferenced_count: unreferencedCount,
			unreferenced_bytes: unreferencedBytes,
			relation_targets: relations.length,
			text_targets: textTargets.length,
			collections_checked: collectionsChecked,
			min_age_minutes: minAgeMinutes,
			scan_text_fields: scanTextFields,
			elapsed_ms: Date.now() - started,
			truncated: offset + limit < unreferencedIds.length || idsTruncated,
			ids_truncated: idsTruncated,
			ids: unreferencedIds,
		},
	};
}

/**
 * Fast path: is this file id still referenced by any known relation or text field?
 * Used by delete-if-unreferenced (deselect / item delete).
 */
export async function isFileReferenced(
	database: any,
	schema: any,
	fileId: string,
	opts: { scanTextFields?: boolean; logger?: { warn: (msg: string) => void } } = {},
): Promise<boolean> {
	const id = normalizeUuid(fileId);
	if (!id) return false;

	const relations = discoverFileRelations(schema);
	const tableCache = new Map<string, boolean>();
	const columnCache = new Map<string, boolean>();

	for (const ref of relations) {
		try {
			if (!(await tableExists(database, ref.collection, tableCache))) continue;
			if (!(await columnExists(database, ref.collection, ref.field, columnCache))) continue;
			const row = await database(ref.collection).select(ref.field).where(ref.field, id).first();
			if (row) return true;
		} catch (err: any) {
			opts.logger?.warn(
				`[storage-manager] refcheck relation ${ref.collection}.${ref.field}: ${err?.message || err}`,
			);
		}
	}

	if (opts.scanTextFields === false) return false;

	const fieldRows = await loadFieldMetaRows(database, schema);
	const relationKeys = new Set(relations.map((r) => `${r.collection}.${r.field}`));
	const textTargets = discoverTextScanTargets(fieldRows, relationKeys);
	const like = `%${id}%`;

	for (const target of textTargets) {
		try {
			if (!(await tableExists(database, target.collection, tableCache))) continue;
			if (!(await columnExists(database, target.collection, target.field, columnCache))) continue;

			const row = await database(target.collection)
				.select(target.field)
				.where(target.field, 'like', like)
				.first();

			if (!row) continue;

			const text = valueToSearchText(row[target.field]);
			const hits =
				target.mode === 'assets_only' ? extractAssetUuids(text) : [...extractAssetUuids(text), ...extractAllUuids(text)];
			if (hits.includes(id)) return true;
		} catch (err: any) {
			opts.logger?.warn(
				`[storage-manager] refcheck text ${target.collection}.${target.field}: ${err?.message || err}`,
			);
		}
	}

	return false;
}

export async function deleteUnreferencedFiles(
	database: any,
	schema: any,
	services: Record<string, any>,
	accountability: unknown,
	fileIds: string[],
	opts: { scanTextFields?: boolean; logger?: { warn: (msg: string) => void; info?: (msg: string) => void } } = {},
): Promise<Array<{ id: string; status: 'deleted' | 'skipped' | 'failed'; reason?: string }>> {
	const FilesService = services.FilesService;
	if (!FilesService) {
		return fileIds.map((id) => ({ id, status: 'failed' as const, reason: 'FilesService unavailable' }));
	}

	const filesService = new FilesService({ accountability, schema });
	const results: Array<{ id: string; status: 'deleted' | 'skipped' | 'failed'; reason?: string }> = [];

	for (const rawId of fileIds) {
		const id = normalizeUuid(rawId);
		if (!id) {
			results.push({ id: rawId, status: 'skipped', reason: 'invalid id' });
			continue;
		}

		try {
			const exists = await database('directus_files').select('id').where('id', id).first();
			if (!exists) {
				results.push({ id, status: 'skipped', reason: 'not found' });
				continue;
			}

			const referenced = await isFileReferenced(database, schema, id, {
				scanTextFields: opts.scanTextFields,
				logger: opts.logger,
			});

			if (referenced) {
				results.push({ id, status: 'skipped', reason: 'still referenced' });
				continue;
			}

			await filesService.deleteOne(id);
			results.push({ id, status: 'deleted' });
		} catch (err: any) {
			results.push({ id, status: 'failed', reason: err?.message || String(err) });
		}
	}

	return results;
}
