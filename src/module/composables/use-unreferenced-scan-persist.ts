import { ref } from 'vue';
import type { UnreferencedScanMeta } from './use-unreferenced-scan-job';

export type PersistedUnreferencedScan = UnreferencedScanMeta & {
	scan_id: string;
	/** Client timestamp when this snapshot was saved. */
	saved_at?: number;
};

const STORAGE_KEY = 'storage-manager-unreferenced-scan';

/** Survives in-app navigation while the module bundle stays loaded. */
const memoryScan = ref<PersistedUnreferencedScan | null>(null);

function readStorage(): PersistedUnreferencedScan | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PersistedUnreferencedScan;
		if (!parsed?.scan_id || typeof parsed.scan_id !== 'string') return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeStorage(value: PersistedUnreferencedScan | null) {
	try {
		if (!value) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		/* quota / private mode */
	}
}

/**
 * Remember the last unreferenced scan so returning to the page can reopen the
 * server session (`scan_id`) without rescanning. Only the id + summary meta are
 * stored client-side — the ID list stays in the DB-backed server session.
 */
export function useUnreferencedScanPersist() {
	function save(meta: PersistedUnreferencedScan) {
		memoryScan.value = { ...meta, saved_at: Date.now() };
		writeStorage(memoryScan.value);
	}

	function clear() {
		memoryScan.value = null;
		writeStorage(null);
	}

	function load(): PersistedUnreferencedScan | null {
		if (memoryScan.value?.scan_id) return { ...memoryScan.value };
		const stored = readStorage();
		if (stored) memoryScan.value = stored;
		return stored ? { ...stored } : null;
	}

	return { save, clear, load, memoryScan };
}
