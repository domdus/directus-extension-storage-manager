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

type FieldLifecycleOptions = {
	onDeselect: FileLifecycleDeselectAction | null;
	onItemDelete: FileLifecycleItemDeleteAction | null;
};

const STORAGE_IFACES = new Set([
	'storage-manager-file-with-storage',
	'storage-manager-image-with-storage',
	'storage-manager-files-with-storage',
	'file',
	'file-image',
	'files',
]);

async function loadFieldLifecycleMap(database: any): Promise<Map<string, FieldLifecycleOptions>> {
	const rows = await database('directus_fields').select('collection', 'field', 'interface', 'options');
	const map = new Map<string, FieldLifecycleOptions>();

	for (const row of rows || []) {
		const iface = String(row.interface || '');
		if (!STORAGE_IFACES.has(iface)) continue;

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
			onDeselect:
				onDeselect === 'keep' || onDeselect === 'ask' || onDeselect === 'delete_if_unreferenced'
					? onDeselect
					: null,
			onItemDelete:
				onItemDelete === 'keep' || onItemDelete === 'delete_if_unreferenced' ? onItemDelete : null,
		});
	}

	return map;
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

			if (!directRels.length && !junctionScans.length) return payload;

			const keys = (Array.isArray(payload) ? payload : [payload]).map(String).filter(Boolean);
			if (!keys.length) return payload;

			const pk = schema.collections?.[collection]?.primary || 'id';
			const toDelete = new Set<string>();

			if (directRels.length) {
				const rows = await database(collection).select('*').whereIn(pk, keys);
				for (const row of rows) {
					for (const rel of directRels) {
						const fieldOpts = fieldMap.get(`${collection}.${rel.field}`);
						const policy: FileLifecycleItemDeleteAction =
							fieldOpts?.onItemDelete ?? lifecycle.on_item_delete;
						if (policy !== 'delete_if_unreferenced') continue;
						for (const id of extractFileIdsFromValue(row[rel.field])) toDelete.add(id);
					}
				}
			}

			// Junction / files M2M: capture file ids before parent (and junction rows) are gone.
			const junctionPolicy: FileLifecycleItemDeleteAction = lifecycle.on_item_delete;
			if (junctionPolicy === 'delete_if_unreferenced') {
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
			await deleteUnreferencedFiles(database, schema, services, null, ids, {
				scanTextFields: lifecycle.scan_text_fields,
				logger,
			});
		} catch (err: any) {
			logger.warn(`[storage-manager] lifecycle items.delete cleanup failed: ${err?.message || err}`);
		}
	});

	filter('items.update', async (payload: Record<string, any>, meta: { collection?: string; keys?: string[] }) => {
		try {
			const collection = String(meta?.collection || '');
			if (!collection || collection === 'directus_files') return payload;
			if (!payload || typeof payload !== 'object') return payload;

			const settings = await loadSettings(database);
			const lifecycle = normalizeLifecycleSettings(settings.lifecycle ?? LIFECYCLE_DEFAULTS);
			const fieldMap = await loadFieldLifecycleMap(database);
			const schema = await getSchema();
			const relations = discoverFileRelations(schema).filter((r) => r.collection === collection);
			if (!relations.length) return payload;

			const touched = relations.filter((r) => Object.prototype.hasOwnProperty.call(payload, r.field));
			if (!touched.length) return payload;

			const keys = (meta.keys ?? []).map(String).filter(Boolean);
			if (!keys.length) return payload;

			const pk = schema.collections?.[collection]?.primary || 'id';
			const rows = await database(collection)
				.select([pk, ...touched.map((t) => t.field)])
				.whereIn(pk, keys);

			const toDelete = new Set<string>();

			for (const row of rows) {
				for (const rel of touched) {
					const fieldOpts = fieldMap.get(`${collection}.${rel.field}`);
					const policy: FileLifecycleDeselectAction =
						fieldOpts?.onDeselect ?? lifecycle.on_deselect;
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
			await deleteUnreferencedFiles(database, schema, services, null, ids, {
				scanTextFields: lifecycle.scan_text_fields,
				logger,
			});
		} catch (err: any) {
			logger.warn(`[storage-manager] lifecycle items.update cleanup failed: ${err?.message || err}`);
		}
	});
}
