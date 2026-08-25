import { useApi } from '@directus/extensions-sdk';
import { ref, type Ref } from 'vue';
import type { StorageBrowseFolder, StorageFolderNode } from '../../shared/types';

type UsableStorageFolderTrees = {
	trees: Ref<Record<string, StorageFolderNode[]>>;
	loading: Ref<boolean>;
	openFolders: Ref<string[]>;
	isTreeLoaded: (location: string) => boolean;
	loadTree: (location: string) => Promise<void>;
	loadTrees: (locations: string[]) => Promise<void>;
	loadFolderChildren: (location: string, parentPath: string) => Promise<void>;
	ensurePathLoaded: (location: string, path: string) => Promise<void>;
	refreshTree: (location: string) => Promise<void>;
};

const trees = ref<Record<string, StorageFolderNode[]>>({});
const loading = ref(false);
/** Open group values: storage location keys (`@loc`) and folder paths (`loc:path`). */
const openFolders = ref<string[]>([]);

function findNode(nodes: StorageFolderNode[], path: string): StorageFolderNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children?.length) {
			const found = findNode(node.children, path);
			if (found) return found;
		}
	}
	return null;
}

function cloneAndSetChildren(
	nodes: StorageFolderNode[],
	targetPath: string,
	children: StorageFolderNode[],
): StorageFolderNode[] {
	return nodes.map((node) => {
		if (node.path === targetPath) {
			return { ...node, children, childrenLoaded: true };
		}
		if (node.children?.length) {
			return { ...node, children: cloneAndSetChildren(node.children, targetPath, children) };
		}
		return { ...node };
	});
}

function mapBrowseFolders(folders: StorageBrowseFolder[]): StorageFolderNode[] {
	return folders.map((folder) => ({
		name: folder.name,
		path: folder.path,
	}));
}

/**
 * Shared lazy physical-folder trees for left-nav (and similar expand-on-demand UIs).
 * Loads immediate children via GET /storages/:location/browse?path=…
 */
export function useStorageFolderTrees(): UsableStorageFolderTrees {
	const api = useApi();

	function isTreeLoaded(location: string): boolean {
		return Object.prototype.hasOwnProperty.call(trees.value, location);
	}

	async function fetchChildren(location: string, parentPath: string): Promise<StorageFolderNode[]> {
		const res = await api.get(`/storage-manager/storages/${encodeURIComponent(location)}/browse`, {
			params: { path: parentPath || '' },
		});
		const folders = (res.data?.data?.folders || []) as StorageBrowseFolder[];
		return mapBrowseFolders(folders);
	}

	async function loadTree(location: string) {
		if (isTreeLoaded(location)) return;
		try {
			const children = await fetchChildren(location, '');
			trees.value = { ...trees.value, [location]: children };
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

	async function loadFolderChildren(location: string, parentPath: string) {
		const parent = String(parentPath || '');

		if (!parent) {
			await loadTree(location);
			return;
		}

		if (!isTreeLoaded(location)) {
			await loadTree(location);
		}

		const roots = trees.value[location];
		if (!roots) return;

		const parentNode = findNode(roots, parent);
		if (!parentNode || parentNode.childrenLoaded) return;

		try {
			const children = await fetchChildren(location, parent);
			trees.value = {
				...trees.value,
				[location]: cloneAndSetChildren(roots, parent, children),
			};
		} catch {
			trees.value = {
				...trees.value,
				[location]: cloneAndSetChildren(roots, parent, []),
			};
		}
	}

	async function ensurePathLoaded(location: string, path: string) {
		await loadTree(location);
		const normalized = String(path || '').replace(/^\/+|\/+$/g, '');
		if (!normalized) return;

		const parts = normalized.split('/').filter(Boolean);
		for (let i = 0; i < parts.length; i++) {
			const parentPath = parts.slice(0, i).join('/');
			await loadFolderChildren(location, parentPath);
		}
	}

	async function refreshTree(location: string) {
		const openPaths = openFolders.value
			.filter((value) => value.startsWith(`${location}:`))
			.map((value) => value.slice(location.length + 1));

		try {
			const children = await fetchChildren(location, '');
			trees.value = { ...trees.value, [location]: children };
		} catch {
			trees.value = { ...trees.value, [location]: [] };
		}

		const sorted = [...openPaths].sort(
			(a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length,
		);

		for (const path of sorted) {
			await loadFolderChildren(location, path);
		}
	}

	return {
		trees,
		loading,
		openFolders,
		isTreeLoaded,
		loadTree,
		loadTrees,
		loadFolderChildren,
		ensurePathLoaded,
		refreshTree,
	};
}
