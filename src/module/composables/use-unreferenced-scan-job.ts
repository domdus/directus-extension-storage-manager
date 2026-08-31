import { useApi, useStores } from '@directus/extensions-sdk';
import { computed, reactive, ref } from 'vue';
import { formatBytes } from '../../shared/format';

export type UnreferencedScanPayload = {
	min_age_minutes: number;
	scan_text_fields: boolean;
	storage: string | null;
	limit?: number;
	offset?: number;
};

export type UnreferencedScanMeta = {
	total_files: number;
	used_count: number;
	unreferenced_count: number;
	unreferenced_bytes?: number;
	relation_targets: number;
	text_targets: number;
	collections_checked: number;
	min_age_minutes: number;
	scan_text_fields: boolean;
	elapsed_ms: number;
	truncated: boolean;
	ids_truncated?: boolean;
	ids?: string[];
};

export type UnreferencedScanProgress = {
	phase: 'idle' | 'relations' | 'text' | 'files' | 'finalize' | 'done' | 'error';
	message: string;
	current: number;
	total: number;
	used_count: number;
	unreferenced_count: number;
	elapsed_ms: number;
};

type JobListener = {
	onProgress?: (progress: UnreferencedScanProgress) => void;
	onDone?: (meta: UnreferencedScanMeta) => void;
	onError?: (error: Error) => void;
	onCancel?: () => void;
};

/**
 * Module-level unreferenced scan job — survives drawer close / route changes
 * (same pattern as useMigrateJob).
 */
const running = ref(false);
const backgrounded = ref(false);
const result = ref<UnreferencedScanMeta | null>(null);
const errorMessage = ref<string | null>(null);
const reopenNonce = ref(0);
const returnToPath = ref('/storage-manager/unreferenced');

const progress = reactive<UnreferencedScanProgress>({
	phase: 'idle',
	message: '',
	current: 0,
	total: 0,
	used_count: 0,
	unreferenced_count: 0,
	elapsed_ms: 0,
});

let abortController: AbortController | null = null;
let notificationId: string | null = null;
let listeners: JobListener = {};
let activePayload: UnreferencedScanPayload | null = null;
let navigateToDetails: (() => void) | null = null;
let startedAt = 0;

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

function resolveScanUrl(api: ReturnType<typeof useApi>): string {
	const base = String((api as any)?.defaults?.baseURL || '').replace(/\/$/, '');
	const path = '/storage-manager/unreferenced/scan/stream';
	return base ? `${base}${path}` : path;
}

function resetProgress() {
	progress.phase = 'idle';
	progress.message = 'Starting scan…';
	progress.current = 0;
	progress.total = 0;
	progress.used_count = 0;
	progress.unreferenced_count = 0;
	progress.elapsed_ms = 0;
}

function progressPercent(): number {
	if (progress.total > 0) {
		return Math.min(100, Math.round((progress.current / progress.total) * 100));
	}
	return 0;
}

function toastTitle(): string {
	if (progress.phase === 'files' && progress.total > 0) {
		return `Scanning files ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`;
	}
	if (progress.phase === 'relations' && progress.total > 0) {
		return `Checking relations ${progress.current}/${progress.total}`;
	}
	if (progress.phase === 'text' && progress.total > 0) {
		return `Scanning text fields ${progress.current}/${progress.total}`;
	}
	return progress.message || 'Scanning unreferenced files…';
}

function updateBackgroundToast() {
	if (!notificationId) return;
	const notifications = getNotificationsStore();
	if (!notifications) return;
	const pct = progress.total > 0 ? progressPercent() : undefined;
	notifications.update(notificationId, {
		title: toastTitle(),
		text: progress.message
			? `${progress.message} · click for details`
			: 'Click for details — scan continues in the background.',
		loading: progress.total === 0,
		progress: pct,
		type: 'info',
		persist: true,
		closeable: true,
		alwaysShowText: true,
		icon: 'radar',
		dismissText: 'Details',
		dismissIcon: 'open_in_new',
		dismissAction: () => {
			openDetailsFromToast();
		},
	});
}

function openDetailsFromToast() {
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

function applyProgressEvent(event: Record<string, any>) {
	if (event.type === 'heartbeat') {
		progress.elapsed_ms = Date.now() - startedAt;
		return;
	}
	if (event.type === 'start') {
		progress.phase = 'relations';
		progress.message = String(event.message || 'Starting scan…');
		progress.elapsed_ms = Date.now() - startedAt;
	} else if (event.type === 'progress') {
		progress.phase = (event.phase as UnreferencedScanProgress['phase']) || progress.phase;
		progress.message = String(event.message || 'Scanning…');
		progress.current = Number(event.current) || 0;
		progress.total = Number(event.total) || 0;
		if (event.used_count != null) progress.used_count = Number(event.used_count) || 0;
		if (event.unreferenced_count != null) {
			progress.unreferenced_count = Number(event.unreferenced_count) || 0;
		}
		progress.elapsed_ms = Date.now() - startedAt;
	}

	listeners.onProgress?.({ ...progress });
	if (backgrounded.value) updateBackgroundToast();
}

async function parseSseStream(
	response: Response,
	onEvent: (event: Record<string, any>) => void,
): Promise<UnreferencedScanMeta> {
	if (!response.ok) {
		let message = `Scan failed (${response.status})`;
		try {
			const json = await response.json();
			message = json?.errors?.[0]?.message || message;
		} catch {
			// ignore
		}
		throw new Error(message);
	}
	if (!response.body) throw new Error('No response body for scan stream');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finalMeta: UnreferencedScanMeta | null = null;

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
				let event: Record<string, any>;
				try {
					event = JSON.parse(payload);
				} catch {
					continue;
				}

				if (event.type === 'error') {
					throw new Error(event.message || 'Scan failed');
				}
				if (event.type === 'done') {
					finalMeta = event.meta as UnreferencedScanMeta;
					progress.phase = 'done';
					progress.message = 'Scan complete';
					progress.elapsed_ms = Number(finalMeta?.elapsed_ms) || Date.now() - startedAt;
					if (finalMeta) {
						progress.unreferenced_count = finalMeta.unreferenced_count;
						progress.used_count = finalMeta.used_count;
						progress.current = finalMeta.total_files;
						progress.total = finalMeta.total_files;
					}
				} else {
					onEvent(event);
				}
			}
		}
	}

	if (!finalMeta) throw new Error('Scan stream ended without a result');
	return finalMeta;
}

export function useUnreferencedScanJob() {
	const api = useApi();

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

	async function start(payload: UnreferencedScanPayload, opts?: { listener?: JobListener }) {
		if (running.value) throw new Error('A scan is already running');

		activePayload = payload;
		running.value = true;
		backgrounded.value = false;
		result.value = null;
		errorMessage.value = null;
		abortController = new AbortController();
		startedAt = Date.now();
		if (opts?.listener) listeners = opts.listener;
		resetProgress();

		try {
			const response = await fetch(resolveScanUrl(api), {
				method: 'POST',
				headers: getAuthHeaders(api),
				body: JSON.stringify({
					min_age_minutes: payload.min_age_minutes,
					scan_text_fields: payload.scan_text_fields,
					storage: payload.storage,
					limit: payload.limit ?? 1,
					offset: payload.offset ?? 0,
				}),
				credentials: 'same-origin',
				signal: abortController.signal,
			});

			const meta = await parseSseStream(response, applyProgressEvent);
			result.value = meta;

			if (backgrounded.value) {
				const sizeHint =
					meta.unreferenced_bytes != null ? ` · ${formatBytes(meta.unreferenced_bytes)}` : '';
				finishToast(
					'success',
					`Scan complete · ${meta.unreferenced_count.toLocaleString()} unreferenced${sizeHint}`,
					`${meta.total_files.toLocaleString()} files checked`,
				);
			}

			listeners.onDone?.(meta);
			return meta;
		} catch (err: any) {
			if (err?.name === 'AbortError') {
				progress.phase = 'idle';
				progress.message = 'Scan cancelled';
				if (backgrounded.value) {
					finishToast('warning', 'Scan cancelled', progress.message);
				}
				listeners.onCancel?.();
				return null;
			}

			const message = err?.message || 'Scan failed';
			errorMessage.value = message;
			progress.phase = 'error';
			progress.message = message;
			if (backgrounded.value) finishToast('error', 'Scan failed', message);
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

	function runInBackground(opts?: { returnTo?: string; navigate?: () => void }) {
		if (!running.value || backgrounded.value) return false;

		backgrounded.value = true;
		listeners = {};
		if (opts?.returnTo) returnToPath.value = opts.returnTo;
		navigateToDetails = opts?.navigate || null;

		const notifications = getNotificationsStore();
		if (notifications && !notificationId) {
			notificationId = notifications.add({
				title: toastTitle(),
				text: 'Click for details — scan continues in the background.',
				type: 'info',
				persist: true,
				closeable: true,
				alwaysShowText: true,
				loading: progress.total === 0,
				progress: progress.total === 0 ? undefined : progressPercent(),
				icon: 'radar',
				dismissText: 'Details',
				dismissIcon: 'open_in_new',
				dismissAction: () => {
					openDetailsFromToast();
				},
			});
		}

		return true;
	}

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
		errorMessage.value = null;
	}

	return {
		running,
		backgrounded,
		result,
		errorMessage,
		progress,
		reopenNonce,
		returnToPath,
		activePayload: computed(() => activePayload),
		isBusy,
		start,
		runInBackground,
		attachForeground,
		cancel,
		clearLastResult,
	};
}
