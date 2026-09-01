import { useApi, useStores } from '@directus/extensions-sdk';
import { ref } from 'vue';
import { userHasAdminAccess } from '../../shared/admin';
import {
	normalizeStorageManagerSettings,
	serializeStorageManagerSettings,
} from '../../shared/settings';
import type { StorageManagerSettings } from '../../shared/types';

export type CleanupExtensionResult = {
	cleared_value: boolean;
	deleted_field: boolean;
	deleted_purge_flow: boolean;
	deleted_scan_files: number;
	deleted_scan_folder: boolean;
	emptied_recycle: boolean;
	deleted_recycle_files: number;
	deleted_recycle_folder: boolean;
	warnings: string[];
};

export function useStorageSettingsAdmin() {
	const api = useApi();
	const { useUserStore, useSettingsStore } = useStores() as {
		useUserStore: () => { currentUser: unknown };
		useSettingsStore: () => { hydrate?: () => Promise<void> };
	};
	const userStore = useUserStore();
	const settingsStore = useSettingsStore();

	const loading = ref(false);
	const cleaning = ref(false);
	const settings = ref<StorageManagerSettings>({ locations: {} });

	let loadPromise: Promise<void> | null = null;

	async function ensureLoaded(force = false) {
		if (loadPromise && !force) return loadPromise;

		loadPromise = (async () => {
			loading.value = true;
			try {
				const res = await api.get('/storage-manager/settings');
				settings.value = serializeStorageManagerSettings(res.data?.data ?? { locations: {} });
			} finally {
				loading.value = false;
			}
		})();

		return loadPromise;
	}

	function exportStorageManagerConfig() {
		const payload = {
			...settings.value,
			storage_manager: settings.value,
			exported_at: new Date().toISOString(),
			extension: 'directus-extension-storage-manager',
		};

		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
		anchor.href = url;
		anchor.download = `storage-manager-${stamp}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	async function importStorageManagerConfig(raw: unknown) {
		if (!userHasAdminAccess(userStore.currentUser)) {
			throw new Error('Admin access required');
		}

		const next = normalizeStorageManagerSettings(raw);
		settings.value = next;

		// Use extension endpoint so sticky name_mirror_claims are preserved server-side.
		await api.patch('/storage-manager/settings', {
			locations: next.locations,
		});

		try {
			await settingsStore.hydrate?.();
		} catch {
			// ignore
		}

		loadPromise = null;
	}

	/**
	 * Remove extension-owned settings + Flow + scan snapshots.
	 * Optionally permanently empty the Recycle Bin folder.
	 */
	async function cleanupExtensionData(opts?: {
		empty_recycle?: boolean;
	}): Promise<CleanupExtensionResult> {
		if (!userHasAdminAccess(userStore.currentUser)) {
			throw new Error('Admin access required');
		}

		cleaning.value = true;
		try {
			const res = await api.post('/storage-manager/cleanup', {
				empty_recycle: Boolean(opts?.empty_recycle),
			});
			const data = (res.data?.data || {}) as CleanupExtensionResult;

			settings.value = { locations: {} };
			loadPromise = null;

			try {
				await settingsStore.hydrate?.();
			} catch {
				// ignore
			}

			return {
				cleared_value: Boolean(data.cleared_value),
				deleted_field: Boolean(data.deleted_field),
				deleted_purge_flow: Boolean(data.deleted_purge_flow),
				deleted_scan_files: Number(data.deleted_scan_files) || 0,
				deleted_scan_folder: Boolean(data.deleted_scan_folder),
				emptied_recycle: Boolean(data.emptied_recycle),
				deleted_recycle_files: Number(data.deleted_recycle_files) || 0,
				deleted_recycle_folder: Boolean(data.deleted_recycle_folder),
				warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
			};
		} finally {
			cleaning.value = false;
		}
	}

	return {
		loading,
		cleaning,
		settings,
		ensureLoaded,
		exportStorageManagerConfig,
		importStorageManagerConfig,
		cleanupExtensionData,
	};
}
