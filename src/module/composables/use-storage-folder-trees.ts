import { useApi } from '@directus/extensions-sdk';
import { ref, type Ref } from 'vue';
import type { StorageFolderNode } from '../../shared/types';

type UsableStorageFolderTrees = {
	trees: Ref<Record<string, StorageFolderNode[]>>;
	loading: Ref<boolean>;
	openFolders: Ref<string[]>;
	loadTree: (location: string) => Promise<void>;
	loadTrees: (locations: string[]) => Promise<void>;
	refreshTree: (location: string) => Promise<void>;
};

const trees = ref<Record<string, StorageFolderNode[]>>({});
const loading = ref(false);
/** Open group values: storage location keys (`@loc`) and folder paths (`loc:path`). */
const openFolders = ref<string[]>([]);

/**
 * Shared physical-folder trees for left-nav expandable storage adapters.
 */
export function useStorageFolderTrees(): UsableStorageFolderTrees {
	const api = useApi();

	async function loadTree(location: string) {
		try {
			const res = await api.get(`/storage-manager/storages/${encodeURIComponent(location)}/folder-tree`);
			trees.value = {
				...trees.value,
				[location]: (res.data?.data || []) as StorageFolderNode[],
			};
		} catch {
			trees.value = { ...trees.value, [location]: [] };
		}
	}

	async function loadTrees(locations: string[]) {
		loading.value = true;
		try {
			await Promise.all(locations.map((loc) => loadTree(loc)));
		} finally {
			loading.value = false;
		}
	}

	async function refreshTree(location: string) {
		await loadTree(location);
	}

	return { trees, loading, openFolders, loadTree, loadTrees, refreshTree };
}
