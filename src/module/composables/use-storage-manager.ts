import { useApi } from '@directus/extensions-sdk';
import { ref } from 'vue';
import type {
	FileRow,
	FolderNode,
	MigrateMode,
	MigrateProgressEvent,
	MigrateResponse,
	StorageLocationInfo,
} from '../../shared/types';

const storages = ref<StorageLocationInfo[]>([]);
const storagesLoading = ref(false);
const storagesError = ref<string | null>(null);
const folderCountsLoading = ref(false);

let folderCountsAbort: AbortController | null = null;

type MigratePayload = {
	target_storage: string;
	mode: MigrateMode;
	keep_source_file_on_disk?: boolean;
	file_ids?: string[];
	source_storage?: string;
	source_path?: string;
	folder_id?: string | null;
	recursive?: boolean;
	concurrency?: number;
};

function getAuthHeaders(api: ReturnType<typeof useApi>): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
	};

	const defaults = (api as any)?.defaults?.headers;
	const auth =
		defaults?.common?.Authorization ||
		defaults?.Authorization ||
		defaults?.common?.authorization ||
		defaults?.authorization;

	if (typeof auth === 'string' && auth) {
		headers.Authorization = auth;
	}

	return headers;
}

function resolveMigrateUrl(api: ReturnType<typeof useApi>): string {
	const base = String((api as any)?.defaults?.baseURL || '').replace(/\/$/, '');
	const path = '/storage-manager/migrate/stream';
	if (!base) return path;
	return `${base}${path}`;
}

async function parseSseStream(
	response: Response,
	onEvent: (event: MigrateProgressEvent) => void,
): Promise<MigrateResponse> {
	if (!response.ok) {
		let message = `Migration failed (${response.status})`;
		try {
			const json = await response.json();
			message = json?.errors?.[0]?.message || message;
		} catch {
			// ignore
		}
		throw new Error(message);
	}

	if (!response.body) {
		throw new Error('No response body for progress stream');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finalResult: MigrateResponse | null = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const chunks = buffer.split('\n\n');
		buffer = chunks.pop() || '';

		for (const chunk of chunks) {
			const lines = chunk.split('\n');
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) continue;
				const payload = trimmed.slice(5).trim();
				if (!payload) continue;

				let event: MigrateProgressEvent;
				try {
					event = JSON.parse(payload) as MigrateProgressEvent;
				} catch {
					continue;
				}

				onEvent(event);

				if (event.type === 'done') {
					finalResult = event.data;
				}
				if (event.type === 'error') {
					throw new Error(event.message || 'Migration failed');
				}
			}
		}
	}

	if (!finalResult) {
		throw new Error('Migration stream ended without a result');
	}

	return finalResult;
}

export function useStorageManager() {
	const api = useApi();

	async function loadFolderCounts() {
		folderCountsAbort?.abort();
		const ac = new AbortController();
		folderCountsAbort = ac;
		folderCountsLoading.value = true;

		try {
			const res = await api.get('/storage-manager/storages/folder-counts', {
				signal: ac.signal,
			});
			if (ac.signal.aborted) return;

			const counts = (res.data?.data || {}) as Record<string, number>;
			storages.value = storages.value.map((s) => ({
				...s,
				folder_count: Number(counts[s.location]) || 0,
			}));
		} catch (err: any) {
			if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || ac.signal.aborted) return;
			// Keep cards usable — show 0 if counts fail.
			storages.value = storages.value.map((s) => ({
				...s,
				folder_count: s.folder_count ?? 0,
			}));
		} finally {
			if (folderCountsAbort === ac) {
				folderCountsLoading.value = false;
				folderCountsAbort = null;
			}
		}
	}

	async function loadStorages(force = false) {
		if (storages.value.length && !force) return storages.value;
		storagesLoading.value = true;
		storagesError.value = null;
		try {
			const res = await api.get('/storage-manager/storages');
			storages.value = ((res.data?.data || []) as StorageLocationInfo[]).map((s) => ({
				...s,
				folder_count: s.folder_count ?? null,
			}));
			// Don't await — cards render with file counts first; folders fill in after.
			void loadFolderCounts();
			return storages.value;
		} catch (err: any) {
			storagesError.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Failed to load storages';
			throw err;
		} finally {
			storagesLoading.value = false;
		}
	}

	async function loadFiles(params: {
		storage?: string | null;
		folder?: string | null;
		search?: string;
		filter?: Record<string, unknown> | null;
		recursive?: boolean;
		page?: number;
		limit?: number;
		sort?: string;
	}) {
		const res = await api.get('/storage-manager/files', {
			params: {
				storage: params.storage || undefined,
				folder: params.folder === null ? 'null' : params.folder || undefined,
				search: params.search || undefined,
				filter: params.filter ? JSON.stringify(params.filter) : undefined,
				recursive: params.recursive ? 'true' : undefined,
				page: params.page || 1,
				limit: params.limit || 50,
				sort: params.sort || '-uploaded_on',
			},
		});
		return {
			data: (res.data?.data || []) as FileRow[],
			meta: res.data?.meta as {
				total_count: number;
				total_bytes: number;
				page: number;
				limit: number;
			},
		};
	}

	async function loadFolders(params: { parent?: string | null; storage?: string | null } = {}) {
		const res = await api.get('/storage-manager/folders', {
			params: {
				parent: params.parent === null ? 'null' : params.parent || undefined,
				storage: params.storage || undefined,
			},
		});
		return {
			data: (res.data?.data || []) as FolderNode[],
			root_files: res.data?.meta?.root_files as { file_count: number; total_bytes: number } | null,
		};
	}

	async function loadFolderPath(folderId: string) {
		const res = await api.get(`/storage-manager/folders/${folderId}/path`);
		return (res.data?.data || []) as Array<{ id: string; name: string }>;
	}

	async function migrate(payload: MigratePayload): Promise<MigrateResponse> {
		const res = await api.post('/storage-manager/migrate', payload);
		return res.data?.data as MigrateResponse;
	}

	async function migrateWithProgress(
		payload: MigratePayload,
		onEvent: (event: MigrateProgressEvent) => void,
		signal?: AbortSignal,
	): Promise<MigrateResponse> {
		const response = await fetch(resolveMigrateUrl(api), {
			method: 'POST',
			headers: getAuthHeaders(api),
			body: JSON.stringify(payload),
			credentials: 'same-origin',
			signal,
		});

		return parseSseStream(response, onEvent);
	}

	return {
		storages,
		storagesLoading,
		storagesError,
		folderCountsLoading,
		loadStorages,
		loadFolderCounts,
		loadFiles,
		loadFolders,
		loadFolderPath,
		migrate,
		migrateWithProgress,
	};
}
