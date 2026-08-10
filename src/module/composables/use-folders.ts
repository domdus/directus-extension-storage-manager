import { useApi } from '@directus/extensions-sdk';
import { computed, ref, type Ref } from 'vue';

export type FolderRaw = {
	id: string;
	name: string;
	parent: string | null;
};

export type Folder = FolderRaw & {
	children?: Folder[];
};

type UsableFolders = {
	loading: Ref<boolean>;
	folders: Ref<Folder[] | null>;
	nestedFolders: Ref<Folder[] | null>;
	fetchFolders: () => Promise<void>;
	openFolders: Ref<string[]>;
};

const OPEN_FOLDERS_INITIAL: string[] = [];

const loading = ref(false);
const folders = ref<Folder[] | null>(null);
const globalNestedFolders = ref<Folder[] | null>(null);
const globalOpenFolders = ref<string[]>([...OPEN_FOLDERS_INITIAL]);

export function nestFolders(rawFolders: FolderRaw[]): Folder[] {
	const childrenMap = new Map<string, FolderRaw[]>();

	for (const folder of rawFolders) {
		if (folder.parent) {
			const children = childrenMap.get(folder.parent) || [];
			children.push(folder);
			childrenMap.set(folder.parent, children);
		}
	}

	const buildTree = (folder: FolderRaw): Folder => {
		const children = childrenMap.get(folder.id) || [];
		if (children.length > 0) {
			return {
				...folder,
				children: children.map(buildTree),
			};
		}
		return { ...folder };
	};

	return rawFolders.filter((folder) => folder.parent === null).map(buildTree);
}

function findFolder(tree: Folder[] | null, id: string | undefined): Folder[] | null {
	if (!tree) return null;
	if (!id) return tree;

	for (const folder of tree) {
		if (folder.id === id) return folder.children ?? null;
		if (folder.children) {
			const result = findFolder(folder.children, id);
			if (result) return result;
		}
	}

	return null;
}

/**
 * Port of Directus `app/src/composables/use-folders.ts` (v11.17.0)
 * Uses extension SDK `useApi` instead of app-internal `fetchAll`.
 */
export function useFolders(): UsableFolders {
	const api = useApi();

	const nestedFolders = computed(() => findFolder(globalNestedFolders.value, undefined));

	const openFolders = computed({
		get() {
			return globalOpenFolders.value;
		},
		set(value: string[]) {
			globalOpenFolders.value = value;
		},
	});

	if (folders.value === null) {
		fetchFolders();
	}

	return { loading, folders, nestedFolders, fetchFolders, openFolders };

	async function fetchFolders() {
		if (loading.value) return;
		loading.value = true;

		try {
			const response = await api.get('/folders', {
				params: {
					sort: 'name',
					limit: -1,
					fields: ['id', 'name', 'parent'],
				},
			});
			const data = (response.data?.data || []) as FolderRaw[];
			folders.value = data;
			globalNestedFolders.value = nestFolders(data);
		} catch {
			folders.value = [];
			globalNestedFolders.value = [];
		} finally {
			loading.value = false;
		}
	}
}
