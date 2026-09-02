import { useApi, useStores } from '@directus/extensions-sdk';
import { computed, reactive, ref } from 'vue';

export type RecycleRestorePayload = {
	storage: string | null;
};

export type RecycleRestoreResult = {
	restored: number;
	failed: number;
	total: number;
	cancelled: boolean;
	storage: string | null;
};

export type RecycleRestoreJobProgress = {
	phase: 'idle' | 'prepare' | 'restore' | 'done' | 'error';
	message: string;
	current: number;
	total: number;
	restored: number;
	failed: number;
	elapsed_ms: number;
};

type JobListener = {
	onProgress?: (progress: RecycleRestoreJobProgress) => void;
	onDone?: (result: RecycleRestoreResult) => void;
	onError?: (error: Error) => void;
	onCancel?: (partial: RecycleRestoreResult | null) => void;
};

const running = ref(false);
const backgrounded = ref(false);
const result = ref<RecycleRestoreResult | null>(null);
const errorMessage = ref<string | null>(null);
const reopenNonce = ref(0);
const returnToPath = ref('/storage-manager/recycle');

const progress = reactive<RecycleRestoreJobProgress>({
	phase: 'idle',
	message: '',
	current: 0,
	total: 0,
	restored: 0,
	failed: 0,
	elapsed_ms: 0,
});

let abortController: AbortController | null = null;
let notificationId: string | null = null;
let listeners: JobListener = {};
let activePayload: RecycleRestorePayload | null = null;
let navigateToDetails: (() => void) | null = null;
let startedAt = 0;
let lastPartial: RecycleRestoreResult | null = null;

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

function resolveRestoreUrl(api: ReturnType<typeof useApi>): string {
	const base = String((api as any)?.defaults?.baseURL || '').replace(/\/$/, '');
	const path = '/storage-manager/recycle/restore/stream';
	return base ? `${base}${path}` : path;
}

function resetProgress() {
	progress.phase = 'idle';
	progress.message = 'Starting restore…';
	progress.current = 0;
	progress.total = 0;
	progress.restored = 0;
	progress.failed = 0;
	progress.elapsed_ms = 0;
}

function progressPercent(): number {
	if (progress.phase === 'done' || progress.phase === 'error') return 100;
	if (progress.total > 0) {
		return Math.min(100, Math.round((progress.current / progress.total) * 100));
	}
	return 0;
}

function toastTitle(): string {
	if (progress.total > 0) {
		return `Restoring ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`;
	}
	return progress.message || 'Restoring Recycle files…';
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
			: 'Click for details — restore continues in the background.',
		loading: progress.total === 0,
		progress: pct,
		type: 'info',
		persist: true,
		closeable: true,
		alwaysShowText: true,
		icon: 'undo',
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
		progress.phase = 'prepare';
		progress.message = String(event.message || 'Starting restore…');
		progress.elapsed_ms = Date.now() - startedAt;
	} else if (event.type === 'progress') {
		progress.phase = (event.phase as RecycleRestoreJobProgress['phase']) || progress.phase;
		progress.message = String(event.message || 'Restoring…');
		progress.current = Number(event.current) || 0;
		progress.total = Number(event.total) || 0;
		if (event.restored != null) progress.restored = Number(event.restored) || 0;
		if (event.failed != null) progress.failed = Number(event.failed) || 0;
		progress.elapsed_ms = Date.now() - startedAt;
	}

	listeners.onProgress?.({ ...progress });
	if (backgrounded.value) updateBackgroundToast();
}

async function parseSseStream(
	response: Response,
	onEvent: (event: Record<string, any>) => void,
): Promise<RecycleRestoreResult> {
	if (!response.ok) {
		let message = `Restore failed (${response.status})`;
		try {
			const json = await response.json();
			message = json?.errors?.[0]?.message || message;
		} catch {
			// ignore
		}
		throw new Error(message);
	}
	if (!response.body) throw new Error('No response body for restore stream');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finalResult: RecycleRestoreResult | null = null;
	let cancelledResult: RecycleRestoreResult | null = null;

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
					throw new Error(event.message || 'Restore failed');
				}
				if (event.type === 'done' || event.type === 'cancelled') {
					finalResult = event.data as RecycleRestoreResult;
					if (event.type === 'cancelled') cancelledResult = finalResult;
					progress.phase = 'done';
					progress.message = String(finalResult?.cancelled ? 'Restore cancelled' : 'Restore complete');
					progress.elapsed_ms = Date.now() - startedAt;
					if (finalResult) {
						progress.restored = finalResult.restored;
						progress.failed = finalResult.failed;
						progress.current = finalResult.restored + finalResult.failed;
						progress.total = finalResult.total;
					}
				} else {
					onEvent(event);
				}
			}
		}
	}

	if (cancelledResult) return cancelledResult;
	if (!finalResult) throw new Error('Restore stream ended without a result');
	return finalResult;
}

export function useRecycleRestoreJob() {
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

	async function start(payload: RecycleRestorePayload, opts?: { listener?: JobListener }) {
		if (running.value) throw new Error('A restore is already running');

		activePayload = payload;
		running.value = true;
		backgrounded.value = false;
		result.value = null;
		errorMessage.value = null;
		lastPartial = null;
		abortController = new AbortController();
		startedAt = Date.now();
		if (opts?.listener) listeners = opts.listener;
		resetProgress();

		try {
			const response = await fetch(resolveRestoreUrl(api), {
				method: 'POST',
				headers: getAuthHeaders(api),
				body: JSON.stringify({ storage: payload.storage }),
				credentials: 'same-origin',
				signal: abortController.signal,
			});

			const data = await parseSseStream(response, applyProgressEvent);
			lastPartial = data;
			result.value = data;

			if (backgrounded.value) {
				if (data.cancelled) {
					finishToast(
						'warning',
						'Restore cancelled',
						`${data.restored.toLocaleString()} restored of ${data.total.toLocaleString()}`,
					);
				} else {
					finishToast(
						'success',
						`Restored ${data.restored.toLocaleString()} file(s)`,
						data.failed ? `${data.failed.toLocaleString()} failed` : undefined,
					);
				}
			}

			if (data.cancelled) listeners.onCancel?.(data);
			else listeners.onDone?.(data);
			return data;
		} catch (err: any) {
			if (err?.name === 'AbortError') {
				progress.phase = 'idle';
				progress.message = 'Restore cancelled';
				const partial: RecycleRestoreResult = lastPartial ?? {
					restored: progress.restored,
					failed: progress.failed,
					total: progress.total,
					cancelled: true,
					storage: payload.storage,
				};
				lastPartial = partial;
				if (backgrounded.value) {
					finishToast(
						'warning',
						'Restore cancelled',
						`${partial.restored.toLocaleString()} restored`,
					);
				}
				listeners.onCancel?.(partial);
				return partial;
			}

			const message = err?.message || 'Restore failed';
			errorMessage.value = message;
			progress.phase = 'error';
			progress.message = message;
			if (backgrounded.value) finishToast('error', 'Restore failed', message);
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
				text: 'Click for details — restore continues in the background.',
				type: 'info',
				persist: true,
				closeable: true,
				alwaysShowText: true,
				loading: progress.total === 0,
				progress: progress.total === 0 ? undefined : progressPercent(),
				icon: 'undo',
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
		lastPartial = null;
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
		start,
		runInBackground,
		attachForeground,
		cancel,
		clearLastResult,
	};
}
