import type { PrefixStrategy } from './types';

export type StrategyChoice = {
	value: PrefixStrategy;
	text: string;
};

/** Select options — keep labels short for sidebar + overview dropdowns. */
export const STRATEGY_CHOICES: StrategyChoice[] = [
	{ value: 'none', text: 'None' },
	{ value: 'folder', text: 'Mirror Folders by Name' },
	{ value: 'folder_id', text: 'Mirror Folders by UID' },
	{ value: 'type', text: 'Create by File Type' },
	{ value: 'date', text: 'Create by Date' },
];

/** Compact labels for overview storage cards. */
export const STRATEGY_CARD_LABELS: Record<PrefixStrategy, string> = {
	none: 'None',
	folder: 'Mirror by Name',
	folder_id: 'Mirror by UID',
	type: 'By File Type',
	date: 'By Date',
};

/** Short hints under the strategy select (per-storage sidebar). Examples live in STRATEGY_GLOSSARY. */
export const STRATEGY_HINTS: Record<PrefixStrategy, string> = {
	none: 'Directus default — flat paths, no storage folders.',
	folder: 'Organises uploads using virtual folder names.',
	folder_id: 'Organises uploads using virtual folder IDs.',
	type: 'Organises uploads by MIME category.',
	date: 'Organises uploads by upload date.',
};

export type StrategyGlossaryEntry = {
	value: string;
	title: string;
	body: string;
};

/** Shown at the top of the Strategy Guide — applies to every strategy. */
export const STRATEGY_SCOPE_NOTE =
	'A strategy applies from when you save it — only to new uploads. It does not reorganise files already on that storage.';

/**
 * Virtual vs physical — Strategy Guide + Sync section.
 * Directus folders are logical; files inside can sit on different adapters.
 */
export const VIRTUAL_FOLDER_NOTE =
	'A Directus folder is virtual — it organises files across any storage adapter. When Mirror Directus Folders is enabled on a storage, new uploads land on the matching physical path and folder renames or deletes are kept in sync on that adapter. Files on other adapters are unaffected.';

/** Main intro on /storage-manager/folders (root). */
export const DIRECTUS_FOLDERS_PAGE_INTRO =
	'Browse the Directus folder tree. Use Move to Storage Folder to place files on a physical path, or Materialize to build that folder tree on disk. The virtual structure in the File Library is never changed here.';

/** Longer copy for the overview Strategy Guide (strategies). */
export const STRATEGY_GLOSSARY: StrategyGlossaryEntry[] = [
	{
		value: 'none',
		title: 'None',
		body: 'Directus default. New uploads keep a flat filename_disk (no storage folder). Use when you organise paths manually or not at all.',
	},
	{
		value: 'folder',
		title: 'Mirror Folders by Name',
		body: 'Mirrors the Directus virtual folder tree onto storage using folder names. Example: Articles/Drafts/. Created siblings with the same name on same hierarchy level use name_<folder-uid> for uniqueness and to prevent conflicts.',
	},
	{
		value: 'folder_id',
		title: 'Mirror Folders by UID',
		body: 'Mirrors the virtual folder tree using folder IDs. Example: <parent-uuid>/<child-uuid>/. Paths stay unique and do not change when a folder is renamed.',
	},
	{
		value: 'type',
		title: 'Create by File Type',
		body: 'Places new uploads under a folder derived from MIME category. Example: images/, videos/, documents/. Configure the type map on the storage card.',
	},
	{
		value: 'date',
		title: 'Create by Date',
		body: 'Places new uploads under a date path. Example: 2024/01/ (or 2024/01/15 with day format). Configure the date format on the storage card.',
	},
];

/**
 * Sync Folder Changes — shown in the Strategy Guide under mirror strategies.
 * Configure per storage (overview Configure dialog or browse sidebar).
 */
export const SYNC_GLOSSARY: StrategyGlossaryEntry[] = [
	{
		value: 'sync',
		title: 'Sync Folder Changes',
		body: 'Optional for Mirror by Name / by UID, configured per storage. When enabled on an adapter, renames and deletes in the Directus virtual folder tree also update physical paths on that adapter only (filename_disk + objects). Files in the same virtual folder that live on other storages are untouched unless those adapters also have Sync on. Turned off, only new uploads follow the mirror.',
	},
	{
		value: 'rename_move',
		title: 'On Rename — Move Files',
		body: 'Rewrites storage paths to match the new folder name (e.g. Articles/Drafts/… → Articles/Published/…). Can be expensive for large folders (each file is read, written, and verified). Prefer when you need the mirror to stay accurate.',
	},
	{
		value: 'rename_leave',
		title: 'On Rename — Leave Files',
		body: 'Does not move existing objects. New uploads use the new folder name; files already on disk keep their old path in filename_disk. Cheap, but the mirror and disk can diverge until you migrate or clean up.',
	},
	{
		value: 'delete_parent',
		title: 'On Delete — Move to Parent',
		body: 'Matches File Library’s “move content to parent” behaviour on disk: files under the deleted folder’s storage prefix are relocated one level up (e.g. Articles/Drafts/file.jpg → Articles/file.jpg). Sync never deletes registered files. If you recursively delete files in File Library first, there is nothing left to relocate.',
	},
];

export function strategyHint(strategy: PrefixStrategy | string | null | undefined): string {
	if (!strategy) return '';
	return STRATEGY_HINTS[strategy as PrefixStrategy] || '';
}
