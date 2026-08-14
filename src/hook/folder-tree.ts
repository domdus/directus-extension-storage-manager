export type FolderRow = {
	id: string;
	name: string;
	parent: string | null;
};

export function siblingGroupKey(parent: string | null, name: string): string {
	return `${parent ?? ''}::${name}`;
}

/** parent+name → folder ids (sorted for stable iteration / legacy bootstrap). */
export function buildSiblingNameIndex(folders: FolderRow[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const folder of folders) {
		const key = siblingGroupKey(folder.parent, folder.name);
		const list = groups.get(key) ?? [];
		list.push(folder.id);
		groups.set(key, list);
	}
	for (const list of groups.values()) {
		list.sort((a, b) => a.localeCompare(b));
	}
	return groups;
}

export async function loadFolderRows(database: any): Promise<FolderRow[]> {
	const all = await database('directus_folders').select('id', 'name', 'parent');
	return all.map((row: any) => ({
		id: String(row.id),
		name: String(row.name),
		parent: row.parent ? String(row.parent) : null,
	}));
}

/** Folder ids that share a parent + name (including `folderId` when present). */
export async function findSiblingIdsByName(
	database: any,
	parent: string | null,
	name: string,
): Promise<string[]> {
	const query = database('directus_folders').select('id').where('name', name);
	if (parent) query.where('parent', parent);
	else query.whereNull('parent');
	const rows = await query;
	return rows.map((r: any) => String(r.id)).sort((a: string, b: string) => a.localeCompare(b));
}
