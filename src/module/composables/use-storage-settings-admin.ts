import { useApi, useStores } from '@directus/extensions-sdk';
import { ref } from 'vue';
import { userHasAdminAccess } from '../../shared/admin';
import {
	normalizeStorageManagerSettings,
	serializeStorageManagerSettings,
} from '../../shared/settings';
import { STORAGE_MANAGER_FIELD, type StorageManagerSettings } from '../../shared/types';

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
	 * Removes only the dedicated `storage_manager` settings field/value.
	 */
	async function cleanupExtensionData(): Promise<{ clearedValue: boolean; deletedField: boolean }> {
		if (!userHasAdminAccess(userStore.currentUser)) {
			throw new Error('Admin access required');
		}

		cleaning.value = true;
		let clearedValue = false;
		let deletedField = false;

		try {
			try {
				await api.patch('/settings', {
					[STORAGE_MANAGER_FIELD]: null,
				});
				clearedValue = true;
			} catch (error: any) {
				const status = error?.response?.status;
				const message = String(error?.response?.data?.errors?.[0]?.message || error?.message || '');
				if (status !== 400 && status !== 403 && !/unknown|does not exist|forbidden/i.test(message)) {
					throw error;
				}
			}

			try {
				await api.delete(`/fields/directus_settings/${STORAGE_MANAGER_FIELD}`);
				deletedField = true;
			} catch (error: any) {
				const status = error?.response?.status;
				if (status !== 404) throw error;
				deletedField = true;
			}

			settings.value = { locations: {} };
			loadPromise = null;

			try {
				await settingsStore.hydrate?.();
			} catch {
				// ignore
			}

			return { clearedValue, deletedField };
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
