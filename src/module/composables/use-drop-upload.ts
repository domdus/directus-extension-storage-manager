import { useApi, useStores } from '@directus/extensions-sdk';
import { computed, onMounted, onUnmounted, ref, unref, type MaybeRef } from 'vue';

export type UploadPreset = {
	storage?: string;
	folder?: string | null;
	/** Physical storage path to place uploads under (storage mode). */
	storagePath?: string | null;
};

type UploadOptions = {
	/** Fields merged into each POST /files FormData (storage, folder, …) */
	preset: MaybeRef<UploadPreset>;
	enabled?: MaybeRef<boolean>;
	onDone?: () => void | Promise<void>;
};

/**
 * Window-level drag & drop + multipart upload via core POST /files.
 * Mirrors File Library collection.vue behavior without relying on app-internal utils.
 */
export function useDropUpload(options: UploadOptions) {
	const api = useApi();
	const { useNotificationsStore, useServerStore } = useStores();
	const notificationsStore = useNotificationsStore();
	const serverStore = useServerStore?.();

	const showDropEffect = ref(false);
	const uploading = ref(false);
	const dragCounter = ref(0);
	const dragging = computed(() => dragCounter.value > 0);

	let dragNotificationID: string | undefined;
	let fileUploadNotificationID: string | undefined;

	function enableDropEffect() {
		showDropEffect.value = true;
		dragNotificationID = notificationsStore.add({
			title: 'Drop to upload',
			icon: 'cloud_upload',
			type: 'info',
			persist: true,
			closeable: false,
		});
	}

	function disableDropEffect() {
		showDropEffect.value = false;
		if (dragNotificationID) {
			notificationsStore.remove(dragNotificationID);
			dragNotificationID = undefined;
		}
	}

	function dropEnabled() {
		return unref(options.enabled) !== false;
	}

	function onDragEnter(event: DragEvent) {
		if (!dropEnabled()) return;
		if (!event.dataTransfer) return;
		if (event.dataTransfer.types.indexOf('Files') === -1) return;

		event.preventDefault();
		dragCounter.value++;

		const isDropzone = event.target && (event.target as HTMLElement).getAttribute?.('data-dropzone') === '';

		if (dragCounter.value === 1 && showDropEffect.value === false && isDropzone === false) {
			enableDropEffect();
		}

		if (isDropzone) {
			disableDropEffect();
			dragCounter.value = 0;
		}
	}

	function onDragOver(event: DragEvent) {
		if (!event.dataTransfer) return;
		if (event.dataTransfer.types.indexOf('Files') === -1) return;
		event.preventDefault();
	}

	function onDragLeave(event: DragEvent) {
		if (!event.dataTransfer) return;
		if (event.dataTransfer.types.indexOf('Files') === -1) return;

		event.preventDefault();
		dragCounter.value--;

		if (dragCounter.value === 0) {
			disableDropEffect();
		}

		if (event.target && (event.target as HTMLElement).getAttribute?.('data-dropzone') === '') {
			enableDropEffect();
			dragCounter.value = 1;
		}
	}

	async function onDrop(event: DragEvent) {
		if (!dropEnabled()) return;
		if (!event.dataTransfer) return;
		if (event.dataTransfer.types.indexOf('Files') === -1) return;

		event.preventDefault();
		showDropEffect.value = false;
		dragCounter.value = 0;

		if (dragNotificationID) {
			notificationsStore.remove(dragNotificationID);
			dragNotificationID = undefined;
		}

		const files = Array.from(event.dataTransfer.files).filter((file) => file.type);
		if (!files.length) return;

		await uploadFiles(files);
	}

	async function uploadOne(file: globalThis.File, onProgress: (pct: number) => void) {
		const formData = new FormData();
		const preset = unref(options.preset);

		if (preset.storage) formData.append('storage', preset.storage);
		if (preset.folder) formData.append('folder', preset.folder);

		formData.append('file', file);

		const res = await api.post('/files', formData, {
			onUploadProgress: (event: { loaded: number; total?: number }) => {
				if (!event.total) return;
				onProgress(Math.floor((event.loaded * 100) / event.total));
			},
		});

		const fileId = res?.data?.data?.id;
		const storagePath = preset.storagePath ? String(preset.storagePath).replace(/^\/+|\/+$/g, '') : '';
		if (fileId && preset.storage && storagePath) {
			await api.post(`/storage-manager/storages/${encodeURIComponent(preset.storage)}/place-file`, {
				file_id: fileId,
				target_path: storagePath,
			});
		}
	}

	async function uploadFiles(files: globalThis.File[]) {
		if (!dropEnabled() || !files.length || uploading.value) return;

		uploading.value = true;

		const progress = files.map(() => 0);
		const concurrency = Math.max(1, Number(serverStore?.info?.uploads?.maxConcurrency) || 2);

		fileUploadNotificationID = notificationsStore.add({
			title: `Uploading 0 of ${files.length}…`,
			type: 'info',
			persist: true,
			closeable: false,
			loading: true,
		});

		const updateProgress = () => {
			const done = progress.filter((p) => p === 100).length;
			const percentageDone = progress.reduce((a, b) => a + b, 0) / progress.length;
			if (!fileUploadNotificationID) return;
			notificationsStore.update(fileUploadNotificationID, {
				title: `Uploading ${done} of ${files.length}…`,
				loading: false,
				progress: percentageDone,
			});
		};

		let next = 0;
		let failed = 0;

		async function worker() {
			while (next < files.length) {
				const index = next++;
				const file = files[index]!;
				try {
					await uploadOne(file, (pct) => {
						progress[index] = pct;
						updateProgress();
					});
					progress[index] = 100;
					updateProgress();
				} catch (err: any) {
					failed++;
					progress[index] = 100;
					updateProgress();
					const message =
						err?.response?.data?.errors?.[0]?.message || err?.message || `Failed to upload ${file.name}`;
					notificationsStore.add({
						title: message,
						type: 'error',
						icon: 'error',
					});
				}
			}
		}

		try {
			await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
		} finally {
			if (fileUploadNotificationID) {
				notificationsStore.remove(fileUploadNotificationID);
				fileUploadNotificationID = undefined;
			}

			uploading.value = false;

			if (failed < files.length) {
				notificationsStore.add({
					title: failed ? `Uploaded ${files.length - failed} of ${files.length}` : 'Upload complete',
					type: failed ? 'warning' : 'success',
					icon: failed ? 'warning' : 'check',
				});
				await options.onDone?.();
			}
		}
	}

	function onFileInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []).filter((file) => file.type);
		input.value = '';
		if (files.length) void uploadFiles(files);
	}

	onMounted(() => {
		window.addEventListener('dragenter', onDragEnter);
		window.addEventListener('dragover', onDragOver);
		window.addEventListener('dragleave', onDragLeave);
		window.addEventListener('drop', onDrop);
	});

	onUnmounted(() => {
		window.removeEventListener('dragenter', onDragEnter);
		window.removeEventListener('dragover', onDragOver);
		window.removeEventListener('dragleave', onDragLeave);
		window.removeEventListener('drop', onDrop);
		disableDropEffect();
		if (fileUploadNotificationID) {
			notificationsStore.remove(fileUploadNotificationID);
		}
	});

	return {
		dragging,
		showDropEffect,
		uploading,
		uploadFiles,
		onFileInputChange,
	};
}
