import { normalizeUuid } from '../shared/uuid-extract';
import {
	LIFECYCLE_DEFAULTS,
	normalizeLifecycleSettings,
	type FileLifecycleDeselectAction,
	type FileLifecycleItemDeleteAction,
} from '../shared/lifecycle';
import { deleteUnreferencedFiles, discoverFileRelations } from '../endpoint/unreferenced';
import { loadSettings } from './settings';

type Logger = {
	warn: (msg: string, ...args: unknown[]) => void;
	info?: (msg: string, ...args: unknown[]) => void;
};

type HookContext = {
	database: any;
	services: Record<string, any>;
	getSchema: () => Promise<any>;
	logger: Logger;
};

type FieldLifecycleKind = 'native' | 'storage_manager';

type FieldLifecycleOptions = {
	kind: FieldLifecycleKind;
	onDeselect: FileLifecycleDeselectAction | null;
	onItemDelete: FileLifecycleItemDeleteAction | null;
};

const SM_IFACES = new Set([
	'storage-manager-file-with-storage',
	'storage-manager-image-with-storage',
	'storage-manager-files-with-storage',
]);

const NATIVE_IFACES = new Set(['file', 'file-image', 'files']);

async function loadFieldLifecycleMap(database: any): Promise<Map<string, FieldLifecycleOptions>> {
	const rows = await database('directus_fields').select('collection', 'field', 'interface', 'options');
	const map = new Map<string, FieldLifecycleOptions>();

	for (const row of rows || []) {
		const iface = String(row.interface || '');
		const kind: FieldLifecycleKind | null = SM_IFACES.has(iface)
			? 'storage_manager'
			: NATIVE_IFACES.has(iface)
				? 'native'
				: null;
		if (!kind) continue;

		let options: Record<string, unknown> = {};
		try {
			options =
				typeof row.options === 'string'
					? JSON.parse(row.options)
					: row.options && typeof row.options === 'object'
						? row.options
						: {};
		} catch {
			options = {};
		}

		const onDeselect = options.onDeselect;
		const onItemDelete = options.onItemDelete;

		map.set(`${row.collection}.${row.field}`, {
			kind,
			onDeselect:
				kind === 'storage_manager' &&
				(onDeselect === 'ask' || onDeselect === 'delete_if_unreferenced' || onDeselect === 'keep')
					? onDeselect
					: null, // inherit / missing → File Interfaces storage_manager default
			onItemDelete:
				kind === 'storage_manager' &&
				(onItemDelete === 'keep' || onItemDelete === 'delete_if_unreferenced')
					? onItemDelete
					: null, // inherit / missing → File Interfaces storage_manager default
		});
	}

	return map;
}

function resolveDeselectPolicy(
	fieldOpts: FieldLifecycleOptions | undefined,
	lifecycle: ReturnType<typeof normalizeLifecycleSettings>,
): FileLifecycleDeselectAction {
	if (fieldOpts?.kind === 'storage_manager') {
		return fieldOpts.onDeselect ?? lifecycle.storage_manager.on_deselect;
	}
	// Native (or unknown file relation): no Ask
	const policy = lifecycle.native.on_deselect;
	return policy === 'delete_if_unreferenced' ? policy : 'keep';
}

function resolveItemDeletePolicy(
	fieldOpts: FieldLifecycleOptions | undefined,
	lifecycle: ReturnType<typeof normalizeLifecycleSettings>,
): FileLifecycleItemDeleteAction {
	if (fieldOpts?.kind === 'storage_manager') {
		return fieldOpts.onItemDelete ?? lifecycle.storage_manager.on_item_delete;
	}
	return lifecycle.native.on_item_delete;
}

function extractFileIdsFromValue(value: unknown): string[] {
	if (value == null) return [];
	if (typeof value === 'string' || typeof value === 'number') {
		const id = normalizeUuid(String(value));
		return id ? [id] : [];
	}
	if (Array.isArray(value)) {
		const out: string[] = [];
		for (const entry of value) out.push(...extractFileIdsFromValue(entry));
		return out;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (obj.id != null) return extractFileIdsFromValue(obj.id);
		if (obj.directus_files_id != null) return extractFileIdsFromValue(obj.directus_files_id);
		for (const v of Object.values(obj)) {
			if (v && typeof v === 'object') {
				const nested = extractFileIdsFromValue(v);
				if (nested.length) return nested;
			}
		}
	}
	return [];
}

type ParentM2MFileField = {
	/** Field on the parent collection (alias), e.g. `images`. */
	parentField: string;
	junctionTable: string;
	/** PK column on the junction table. */
	junctionPk: string;
	/** Column on the junction that stores the file UUID. */
	fileField: string;
};

/**
 * Resolve Files / M2M file fields on a parent collection.
 * These are alias relations (`schema: null`) whose payload uses `{ delete: [junctionPk, ...] }`.
 */
function findParentM2MFileFields(
	allRelations: any[],
	fileRelations: Array<{ collection: string; field: string }>,
	parentCollection: string,
	schema: any,
): ParentM2MFileField[] {
	const out: ParentM2MFileField[] = [];
	const seen = new Set<string>();

	for (const rel of allRelations) {
		if (String(rel?.collection || '') !== parentCollection) continue;
		if (String(rel?.related_collection || '') !== 'directus_files') continue;
		// M2O file/image fields have a real FK column; M2M aliases have no schema.
		if (rel?.schema) continue;

		const parentField = String(rel.field || '');
		if (!parentField) continue;

		const junctionField = rel?.meta?.junction_field ? String(rel.meta.junction_field) : '';
		// junction_field = column on junction pointing at the parent
		const junctionTable = fileRelations.find((fr) => {
			if (fr.collection === parentCollection) return false;
			const parentRel = allRelations.find(
				(r) =>
					String(r?.collection) === fr.collection &&
					String(r?.related_collection) === parentCollection &&
					String(r?.field) === junctionField,
			);
			return Boolean(parentRel);
		});

		let table = junctionTable?.collection || '';
		let fileField = junctionTable?.field || '';

		// Fallback: meta.one_collection_field / one_field patterns across Directus versions
		if (!table) {
			for (const fr of fileRelations) {
				if (fr.collection === parentCollection) continue;
				const parentRel = allRelations.find(
					(r) =>
						String(r?.collection) === fr.collection &&
						String(r?.related_collection) === parentCollection &&
						String(r?.field) !== fr.field,
				);
				if (!parentRel) continue;
				// Prefer match via junction_field when present
				if (junctionField && String(parentRel.field) !== junctionField) continue;
				table = fr.collection;
				fileField = fr.field;
				break;
			}
		}

		if (!table || !fileField) continue;
		const junctionPk = String(schema?.collections?.[table]?.primary || 'id');
		const key = `${parentCollection}.${parentField}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ parentField, junctionTable: table, junctionPk, fileField });
	}

	return out;
}

export function registerFileLifecycleHooks(
	{ filter, action }: { filter: any; action: any },
	ctx: HookContext,
): void {
	const { database, services, getSchema, logger } = ctx;

	/** collection+keys → pending file ids to try-delete after item delete */
	const pendingItemDeleteFiles = new Map<string, string[]>();
	/** collection+keys → file ids cleared on update */
	const pendingUpdateClears = new Map<string, string[]>();

	function pendingKey(collection: string, keys: string[]): string {
		return `${collection}::${[...keys].map(String).sort().join(',')}`;
	}

	filter('items.delete', async (payload: string[] | number[], meta: { collection?: string }) => {
		try {
			const collection = String(meta?.collection || '');
			if (!collection || collection === 'directus_files') return payload;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const fieldMap = await loadFieldLifecycleMap(database);
			const schema = await getSchema();
			const allRelations: any[] = Array.isArray(schema?.relations) ? schema.relations : [];
			const fileRelations = discoverFileRelations(schema);
			const directRels = fileRelations.filter((r) => r.collection === collection);

			const junctionScans: Array<{ table: string; fileField: string; parentField: string }> = [];
			for (const fileRel of fileRelations) {
				if (fileRel.collection === collection) continue;
				const parentRel = allRelations.find(
					(r) =>
						String(r?.collection) === fileRel.collection &&
						String(r?.related_collection) === collection &&
						String(r?.field) !== fileRel.field,
				);
				if (!parentRel?.field) continue;
				junctionScans.push({
					table: fileRel.collection,
					fileField: fileRel.field,
					parentField: String(parentRel.field),
				});
			}

			const m2mOnParent = findParentM2MFileFields(allRelations, fileRelations, collection, schema);

			if (!directRels.length && !junctionScans.length && !m2mOnParent.length) return payload;

			const keys = (Array.isArray(payload) ? payload : [payload]).map(String).filter(Boolean);
			if (!keys.length) return payload;

			const pk = schema.collections?.[collection]?.primary || 'id';
			const toDelete = new Set<string>();

			if (directRels.length) {
				const rows = await database(collection).select('*').whereIn(pk, keys);
				for (const row of rows) {
					for (const rel of directRels) {
						const fieldOpts = fieldMap.get(`${collection}.${rel.field}`);
						const policy = resolveItemDeletePolicy(fieldOpts, lifecycle);
						if (policy !== 'delete_if_unreferenced') continue;
						for (const id of extractFileIdsFromValue(row[rel.field])) toDelete.add(id);
					}
				}
			}

			// M2M files on this parent: capture junction file ids before cascade delete
			for (const m2m of m2mOnParent) {
				const fieldOpts = fieldMap.get(`${collection}.${m2m.parentField}`);
				const policy = resolveItemDeletePolicy(fieldOpts, lifecycle);
				if (policy !== 'delete_if_unreferenced') continue;
				const scan = junctionScans.find((j) => j.table === m2m.junctionTable && j.fileField === m2m.fileField);
				if (!scan) continue;
				try {
					const rows = await database(scan.table)
						.select(scan.fileField)
						.whereIn(scan.parentField, keys)
						.whereNotNull(scan.fileField);
					for (const row of rows) {
						for (const id of extractFileIdsFromValue(row[scan.fileField])) toDelete.add(id);
					}
				} catch (err: any) {
					logger.warn(
						`[storage-manager] lifecycle junction capture ${scan.table}: ${err?.message || err}`,
					);
				}
			}

			// Fallback: junctions with no resolvable parent M2M field — use native item-delete default
			if (!m2mOnParent.length && junctionScans.length && lifecycle.native.on_item_delete === 'delete_if_unreferenced') {
				for (const scan of junctionScans) {
					try {
						const rows = await database(scan.table)
							.select(scan.fileField)
							.whereIn(scan.parentField, keys)
							.whereNotNull(scan.fileField);
						for (const row of rows) {
							for (const id of extractFileIdsFromValue(row[scan.fileField])) toDelete.add(id);
						}
					} catch (err: any) {
						logger.warn(
							`[storage-manager] lifecycle junction capture ${scan.table}: ${err?.message || err}`,
						);
					}
				}
			}

			if (toDelete.size) {
				pendingItemDeleteFiles.set(pendingKey(collection, keys), Array.from(toDelete));
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] lifecycle items.delete capture failed: ${err?.message || err}`);
		}
		return payload;
	});

	action('items.delete', async (meta: { collection?: string; keys?: string[]; key?: string; payload?: string[] }) => {
		try {
			const collection = String(meta?.collection || '');
			const keys = (meta.keys ?? meta.payload ?? (meta.key ? [meta.key] : [])).map(String);
			const mapKey = pendingKey(collection, keys);
			const ids = pendingItemDeleteFiles.get(mapKey);
			pendingItemDeleteFiles.delete(mapKey);
			if (!ids?.length) return;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const schema = await getSchema();
			await deleteUnreferencedFiles(database, schema, services, { admin: true }, ids, {
				scanTextFields: lifecycle.scan_text_fields,
				logger,
			});
		} catch (err: any) {
			logger.warn(`[storage-manager] lifecycle items.delete cleanup failed: ${err?.message || err}`);
		}
	});

	filter('items.update', async (payload: Record<string, any>, meta: { collection?: string; keys?: string[]; key?: string }) => {
		try {
			const collection = String(meta?.collection || '');
			if (!collection || collection === 'directus_files') return payload;
			if (!payload || typeof payload !== 'object') return payload;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const fieldMap = await loadFieldLifecycleMap(database);
			const schema = await getSchema();
			const allRelations: any[] = Array.isArray(schema?.relations) ? schema.relations : [];
			const fileRelations = discoverFileRelations(schema);
			const m2mFields = findParentM2MFileFields(allRelations, fileRelations, collection, schema);
			// Only real FK columns (M2O file/image). M2M aliases have no DB column.
			const directRels = fileRelations.filter((r) => {
				if (r.collection !== collection) return false;
				const rel = allRelations.find(
					(x) => String(x?.collection) === collection && String(x?.field) === r.field,
				);
				return Boolean(rel?.schema);
			});
			if (!directRels.length && !m2mFields.length) {
				return payload;
			}

			const keys = (meta.keys ?? (meta.key ? [meta.key] : [])).map(String).filter(Boolean);
			if (!keys.length) return payload;

			const pk = schema.collections?.[collection]?.primary || 'id';
			const toDelete = new Set<string>();

			// M2O file / image columns on this collection
			const touchedDirect = directRels.filter((r) => Object.prototype.hasOwnProperty.call(payload, r.field));
			if (touchedDirect.length) {
				const rows = await database(collection)
					.select([pk, ...touchedDirect.map((t) => t.field)])
					.whereIn(pk, keys);

				for (const row of rows) {
					for (const rel of touchedDirect) {
						const fieldOpts = fieldMap.get(`${collection}.${rel.field}`);
						const policy = resolveDeselectPolicy(fieldOpts, lifecycle);
						// Auto-delete on clear only when policy is delete_if_unreferenced (ask is UI-only)
						if (policy !== 'delete_if_unreferenced') continue;

						const nextVal = payload[rel.field];
						const prevIds = extractFileIdsFromValue(row[rel.field]);
						const nextIds = new Set(extractFileIdsFromValue(nextVal));

						for (const id of prevIds) {
							if (!nextIds.has(id)) toDelete.add(id);
						}
					}
				}
			}

			// M2M files fields: payload uses { create, update, delete: [junctionPk, ...] }
			for (const m2m of m2mFields) {
				if (!Object.prototype.hasOwnProperty.call(payload, m2m.parentField)) continue;

				const fieldOpts = fieldMap.get(`${collection}.${m2m.parentField}`);
				const policy = resolveDeselectPolicy(fieldOpts, lifecycle);
				if (policy !== 'delete_if_unreferenced') continue;

				const nested = payload[m2m.parentField];
				const deleteKeys = Array.isArray(nested?.delete) ? nested.delete.map(String).filter(Boolean) : [];
				if (!deleteKeys.length) continue;

				try {
					const rows = await database(m2m.junctionTable)
						.select(m2m.fileField)
						.whereIn(m2m.junctionPk, deleteKeys)
						.whereNotNull(m2m.fileField);
					for (const row of rows) {
						for (const id of extractFileIdsFromValue(row[m2m.fileField])) toDelete.add(id);
					}
				} catch (err: any) {
					logger.warn(
						`[storage-manager] lifecycle M2M deselect capture ${m2m.junctionTable}: ${err?.message || err}`,
					);
				}
			}

			if (toDelete.size) {
				pendingUpdateClears.set(pendingKey(collection, keys), Array.from(toDelete));
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] lifecycle items.update capture failed: ${err?.message || err}`);
		}
		return payload;
	});

	action('items.update', async (meta: { collection?: string; keys?: string[]; key?: string }) => {
		try {
			const collection = String(meta?.collection || '');
			const keys = (meta.keys ?? (meta.key ? [meta.key] : [])).map(String);
			const mapKey = pendingKey(collection, keys);
			const ids = pendingUpdateClears.get(mapKey);
			pendingUpdateClears.delete(mapKey);
			if (!ids?.length) return;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const schema = await getSchema();
			const results = await deleteUnreferencedFiles(database, schema, services, { admin: true }, ids, {
				scanTextFields: lifecycle.scan_text_fields,
				logger,
			});
			const failed = results.filter((r) => r.status === 'failed');
			if (failed.length) {
				logger.warn(
					`[storage-manager] lifecycle items.update cleanup: ${failed.length} failed — ${failed
						.map((r) => `${r.id}:${r.reason || 'error'}`)
						.join(', ')}`,
				);
			}
		} catch (err: any) {
			logger.warn(`[storage-manager] lifecycle items.update cleanup failed: ${err?.message || err}`);
		}
	});
}
