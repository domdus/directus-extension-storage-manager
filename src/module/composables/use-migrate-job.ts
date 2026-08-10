import { useApi, useStores } from '@directus/extensions-sdk';
import { computed, reactive, ref } from 'vue';
import type { MigrateMode, MigrateProgressEvent, MigrateResponse } from '../../shared/types';
import { formatBytes } from '../../shared/format';

export type MigratePayload = {
	target_storage: string;
	mode: MigrateMode;
	file_ids?: string[];
	source_storage?: string;
	folder_id?: string | null;
	recursive?: boolean;
	concurrency?: number;
};

export type MigrateJobProgress = {
	from: string | null;
	to: string;
	currentIndex: number;
	totalFiles: number;
	currentName: string;
	transferredBytes: number;
	totalBytes: number;
	elapsedMs: number;
	speedBps: number;
	succeeded: number;
	skipped: number;
	failed: number;
};

type JobListener = {
	onProgress?: (event: MigrateProgressEvent) => void;
	onDone?: (result: MigrateResponse) => void;
	onError?: (error: Error) => void;
	onCancel?: (partial: MigrateResponse) => void;
};

/**
 * Module-level migrate job — survives drawer close / route changes inside Studio
 * (same idea as File Library drop uploads + persist notifications).
 */
const running = ref(false);
const backgrounded = ref(false);
const result = ref<MigrateResponse | null>(null);
/** Bumps when the progress toast is clicked so views can reopen the migrate drawer. */
const reopenNonce = ref(0);
const returnToPath = ref('/storage-manager');
const progress = reactive<MigrateJobProgress>({
	from: null,
	to: '',
	currentIndex: 0,
	totalFiles: 0,
	currentName: '',
	transferredBytes: 0,
	totalBytes: 0,
	elapsedMs: 0,
	speedBps: 0,
	succeeded: 0,
	skipped: 0,
	failed: 0,
});

let abortController: AbortController | null = null;
let notificationId: string | null = null;
let listeners: JobListener = {};
let activePayload: MigratePayload | null = null;
let navigateToDetails: (() => void) | null = null;
/** Captured from the first `useMigrateJob()` call inside a component setup. */
let notificationsStore: {
	add: (n: Record<string, unknown>) => string;
	update: (id: string, n: Record<string, unknown>) => void;
	remove: (id: string) => void;
} | null = null;

function getNotificationsStore() {
	return notificationsStore;
}

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
	if (typeof auth === 'string' && auth) headers.Authorization = auth;
	return headers;
}

function resolveMigrateUrl(api: ReturnType<typeof useApi>): string {
	const base = String((api as any)?.defaults?.baseURL || '').replace(/\/$/, '');
	const path = '/storage-manager/migrate/stream';
	return base ? `${base}${path}` : path;
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
	if (!response.body) throw new Error('No response body for progress stream');

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
			for (const line of chunk.split('\n')) {
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
				if (event.type === 'done') finalResult = event.data;
				if (event.type === 'error') throw new Error(event.message || 'Migration failed');
			}
		}
	}

	if (!finalResult) throw new Error('Migration stream ended without a result');
	return finalResult;
}

function resetProgress(to = '', estimatedCount = 0, estimatedBytes = 0, from: string | null = null) {
	progress.from = from;
	progress.to = to;
	progress.currentIndex = 0;
	progress.totalFiles = estimatedCount;
	progress.currentName = '';
	progress.transferredBytes = 0;
	progress.totalBytes = estimatedBytes;
	progress.elapsedMs = 0;
	progress.speedBps = 0;
	progress.succeeded = 0;
	progress.skipped = 0;
	progress.failed = 0;
}

function applyProgressEvent(event: MigrateProgressEvent) {
	if (event.type === 'start') {
		progress.from = event.from || progress.from;
		progress.to = event.to;
		progress.totalFiles = event.total;
		progress.totalBytes = event.total_bytes;
		progress.currentIndex = 0;
		progress.currentName = '';
		progress.transferredBytes = 0;
		progress.elapsedMs = 0;
		progress.speedBps = 0;
		progress.succeeded = 0;
		progress.skipped = 0;
		progress.failed = 0;
	} else if (event.type === 'file_start') {
		progress.currentIndex = event.index;
		progress.totalFiles = event.total;
		progress.currentName = event.name || event.filename_disk;
		if (!progress.from) progress.from = event.from;
		progress.to = event.to;
	} else if (event.type === 'file_bytes') {
		progress.currentIndex = event.index;
		progress.transferredBytes = event.transferred_bytes;
		progress.totalBytes = event.total_bytes || progress.totalBytes;
		progress.elapsedMs = event.elapsed_ms;
		progress.speedBps = event.elapsed_ms > 0 ? (event.transferred_bytes * 1000) / event.elapsed_ms : 0;
	} else if (event.type === 'file_done') {
		progress.currentIndex = event.index;
		progress.totalFiles = event.total;
		progress.currentName = event.name || event.result.filename_disk;
		progress.succeeded = event.succeeded;
		progress.skipped = event.skipped;
		progress.failed = event.failed;
		progress.transferredBytes = event.transferred_bytes;
		progress.totalBytes = event.total_bytes || progress.totalBytes;
		progress.elapsedMs = event.elapsed_ms;
		progress.speedBps = event.elapsed_ms > 0 ? (event.transferred_bytes * 1000) / event.elapsed_ms : 0;
	} else if (event.type === 'done') {
		progress.succeeded = event.data.succeeded;
		progress.skipped = event.data.skipped;
		progress.failed = event.data.failed;
		progress.transferredBytes = event.data.transferred_bytes ?? progress.transferredBytes;
		progress.totalBytes = event.data.total_bytes ?? progress.totalBytes;
		progress.elapsedMs = event.data.elapsed_ms ?? progress.elapsedMs;
		progress.totalFiles = event.data.total;
		progress.currentIndex = event.data.total;
		progress.speedBps =
			progress.elapsedMs > 0 ? (progress.transferredBytes * 1000) / progress.elapsedMs : 0;
	}

	listeners.onProgress?.(event);
	if (backgrounded.value) updateBackgroundToast();
}

function progressPercent(): number {
	if (progress.totalBytes > 0) {
		return Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100));
	}
	if (progress.totalFiles > 0) {
		return Math.min(100, Math.round((progress.currentIndex / progress.totalFiles) * 100));
	}
	return 0;
}

function toastTitle(): string {
	const mode = activePayload?.mode === 'copy' ? 'Copying' : 'Moving';
	const to = progress.to || activePayload?.target_storage || '…';
	const from = progress.from ? `${progress.from} → ` : '';
	if (!progress.totalFiles) return `${mode} files to ${to}…`;
	const n = Math.min(progress.currentIndex || 0, progress.totalFiles);
	return `${mode} ${n}/${progress.totalFiles} · ${from}${to}`;
}

function updateBackgroundToast() {
	if (!notificationId) return;
	const notifications = getNotificationsStore();
	if (!notifications) return;
	notifications.update(notificationId, {
		title: toastTitle(),
		text: progress.currentName
			? `${progress.currentName} · click for details`
			: `${formatBytes(progress.transferredBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''} · click for details`,
		loading: progress.totalFiles === 0,
		progress: progress.totalFiles === 0 ? undefined : progressPercent(),
		type: 'info',
		persist: true,
		closeable: true,
		alwaysShowText: true,
		icon: 'swap_horiz',
		dismissText: 'Details',
		dismissIcon: 'open_in_new',
		dismissAction: () => {
			openDetailsFromToast();
		},
	});
}

function openDetailsFromToast() {
	// Snackbar click removes the toast after dismissAction — keep the job running and reopen the drawer.
	notificationId = null;
	backgrounded.value = false;
	reopenNonce.value += 1;
	navigateToDetails?.();
}

function finishToast(kind: 'success' | 'error' | 'warning', title: string, text?: string) {
	const notifications = getNotificationsStore();
	if (!notifications) return;

	if (notificationId) {
		notifications.remove(notificationId);
		notificationId = null;
	}

	notifications.add({
		title,
		text,
		type: kind === 'warning' ? 'warning' : kind,
		icon: kind === 'success' ? 'check_circle' : kind === 'warning' ? 'cancel' : 'error',
		persist: false,
		closeable: true,
	});
}

function cancelledResult(mode: MigrateMode, target: string): MigrateResponse {
	return {
		mode,
		target_storage: target,
		total: progress.totalFiles,
		succeeded: progress.succeeded,
		skipped: progress.skipped,
		failed: progress.failed,
		results: [],
		transferred_bytes: progress.transferredBytes,
		total_bytes: progress.totalBytes,
		elapsed_ms: progress.elapsedMs,
		cancelled: true,
	};
}

export function useMigrateJob() {
	const api = useApi();

	// Must run in setup so Pinia injection works; reuse for background toasts later.
	if (!notificationsStore) {
		try {
			const { useNotificationsStore } = useStores() as {
				useNotificationsStore?: () => {
					add: (n: Record<string, unknown>) => string;
					update: (id: string, n: Record<string, unknown>) => void;
					remove: (id: string) => void;
				};
			};
			notificationsStore = useNotificationsStore?.() ?? null;
		} catch {
			notificationsStore = null;
		}
	}

	const isBusy = computed(() => running.value);

	function setListeners(next: JobListener) {
		listeners = next;
	}

	function clearListeners() {
		listeners = {};
	}

	async function start(
		payload: MigratePayload,
		opts?: {
			estimatedCount?: number;
			estimatedBytes?: number;
			sourceStorage?: string | null;
			listener?: JobListener;
		},
	) {
		if (running.value) throw new Error('A migration is already running');

		activePayload = payload;
		running.value = true;
		backgrounded.value = false;
		result.value = null;
		abortController = new AbortController();
		if (opts?.listener) listeners = opts.listener;

		resetProgress(
			payload.target_storage,
			opts?.estimatedCount ?? payload.file_ids?.length ?? 0,
			opts?.estimatedBytes || 0,
			opts?.sourceStorage || payload.source_storage || null,
		);

		try {
			const response = await fetch(resolveMigrateUrl(api), {
				method: 'POST',
				headers: getAuthHeaders(api),
				body: JSON.stringify(payload),
				credentials: 'same-origin',
				signal: abortController.signal,
			});

			const res = await parseSseStream(response, applyProgressEvent);
			result.value = res;

			if (backgrounded.value) {
				finishToast(
					res.failed ? 'warning' : 'success',
					res.failed
						? `Migration finished with ${res.failed} failure(s)`
						: `Migration complete · ${res.succeeded} file(s)`,
					`${payload.mode === 'copy' ? 'Copied' : 'Moved'} to ${payload.target_storage}`,
				);
			}

			listeners.onDone?.(res);
			return res;
		} catch (err: any) {
			if (err?.name === 'AbortError') {
				const partial = cancelledResult(payload.mode, payload.target_storage);
				result.value = partial;
				if (backgrounded.value) {
					finishToast('warning', 'Migration cancelled', `${progress.succeeded} file(s) completed before cancel`);
				}
				listeners.onCancel?.(partial);
				return partial;
			}

			const message = err?.message || 'Migration failed';
			if (backgrounded.value) finishToast('error', 'Migration failed', message);
			listeners.onError?.(err instanceof Error ? err : new Error(message));
			throw err;
		} finally {
			running.value = false;
			backgrounded.value = false;
			abortController = null;
			activePayload = null;
			if (notificationId) {
				const notifications = getNotificationsStore();
				notifications?.remove(notificationId);
				notificationId = null;
			}
		}
	}

	/** Keep the SSE job alive and show Studio snackbar progress (upload-toast style). */
	function runInBackground(opts?: { returnTo?: string; navigate?: () => void }) {
		if (!running.value || backgrounded.value) return false;

		backgrounded.value = true;
		clearListeners();
		if (opts?.returnTo) returnToPath.value = opts.returnTo;
		navigateToDetails = opts?.navigate || null;

		const notifications = getNotificationsStore();
		if (notifications && !notificationId) {
			notificationId = notifications.add({
				title: toastTitle(),
				text: 'Click for details — transfer continues in the background.',
				type: 'info',
				persist: true,
				closeable: true,
				alwaysShowText: true,
				loading: progress.totalFiles === 0,
				progress: progress.totalFiles === 0 ? undefined : progressPercent(),
				icon: 'swap_horiz',
				dismissText: 'Details',
				dismissIcon: 'open_in_new',
				dismissAction: () => {
					openDetailsFromToast();
				},
			});
		}

		return true;
	}

	/** Re-attach drawer listeners after opening details from the toast. */
	function attachForeground(listener?: JobListener) {
		backgrounded.value = false;
		if (listener) listeners = listener;
		if (notificationId) {
			const notifications = getNotificationsStore();
			notifications?.remove(notificationId);
			notificationId = null;
		}
	}

	function cancel() {
		abortController?.abort();
	}

	function clearLastResult() {
		result.value = null;
	}

	return {
		running,
		backgrounded,
		result,
		progress,
		reopenNonce,
		returnToPath,
		activeMode: computed(() => activePayload?.mode ?? null),
		activeTarget: computed(() => activePayload?.target_storage ?? null),
		isBusy,
		start,
		runInBackground,
		attachForeground,
		cancel,
		clearLastResult,
		setListeners,
		clearListeners,
	};
}
