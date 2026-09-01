<template>
	<private-view title="Recycle Bin" icon="recycling">
		<template #headline>
			<v-breadcrumb
				:items="[
					{ name: 'Storage Manager', to: '/storage-manager' },
					{ name: 'Recycle Bin', to: '/storage-manager/recycle' },
				]"
			/>
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="about" icon="info" title="About" :close="false">
				<p class="sidebar-text">
					Universal File Library quarantine. Files in the recycle folder stay registered, but non-admins
					cannot load their assets. Optional daily cleanup installs a Schedule Flow — nothing is created
					until you opt in.
				</p>
			</sidebar-detail>
		</template>

		<div :class="pageClass">
			<v-divider
				class="section-divider"
				large
				:inline-title="false"
				:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
			>
				<template #icon><v-icon name="recycling" /></template>
				Recycle Bin
			</v-divider>

			<p class="page-intro">
				Opt-in quarantine for the File Library. Enabling creates
				<code>storage_manager_trashed_at</code> on <code>directus_files</code> and a folder (default:
				<code>_Recycle</code>). Unreferenced Files can move selections here instead of deleting immediately —
				and any other File Library file can be moved into this folder as well (editors included, if their
				permissions allow).
			</p>

			<div v-if="recycleLoading" class="result">
				<v-progress-circular indeterminate />
			</div>
			<template v-else>
				<div class="side-field">
					<label>Status</label>
					<div class="status-radios" role="radiogroup" aria-label="Recycle Bin status">
						<v-radio
							:model-value="recycle.enabled"
							:value="false"
							label="Off"
							:disabled="recycleBusy"
							@update:model-value="setEnabled(false)"
						/>
						<v-radio
							:model-value="recycle.enabled"
							:value="true"
							label="On"
							:disabled="recycleBusy"
							@update:model-value="setEnabled(true)"
						/>
					</div>
					<p class="field-hint">
						Turning off keeps the folder and field; a linked scheduled purge Flow is paused.
					</p>
				</div>

				<v-notice v-if="!recycle.enabled" type="info" class="notice">
					Recycle Bin is off. Unreferenced Files only offers permanent delete until you turn it on.
				</v-notice>
				<v-notice v-else type="success" class="notice">
					On
					<template v-if="recycle.file_count != null">
						· {{ recycle.file_count.toLocaleString() }} file(s) in Recycle
					</template>
					<template v-if="!recycle.field_ready"> · field missing — turn off/on to repair</template>
				</v-notice>

				<!-- Folder is choosable only while Off; locked while On -->
				<template v-if="!recycle.enabled">
					<div class="side-field">
						<label>Recycle Folder</label>
						<v-select
							v-model="recyclePickFolder"
							:items="recycleFolderSelectItems"
							:disabled="recycleBusy || foldersLoading"
							:placeholder="defaultFolderName"
						/>
						<p class="field-hint">
							Defaults to <code>{{ defaultFolderName }}</code>. Or pick another File Library folder.
						</p>
					</div>
				</template>

				<template v-if="recycle.enabled">
					<div class="side-field">
						<label>Recycle Folder</label>
						<v-select :model-value="recycle.folder_id" :items="recycleFolderChoices" disabled />
						<p class="field-hint">
							Renaming in the File Library is fine; logic uses the folder id, not the display name.
						</p>
					</div>

					<div class="side-field">
						<label>Retention (days)</label>
						<div class="retention-row">
							<v-input
								v-model="recycleRetention"
								type="number"
								:min="1"
								:max="3650"
								:disabled="recycleBusy"
							/>
							<v-button secondary :loading="recycleBusy" :disabled="recycleBusy" @click="saveRecycleRetention">
								Save Retention
							</v-button>
						</div>
					</div>

					<div class="actions">
						<v-button secondary :loading="purgeDryRunning" :disabled="recycleBusy" @click="purgeRecycle(true)">
							Dry Run Purge
						</v-button>
						<v-button kind="danger" :loading="purging" :disabled="recycleBusy" @click="confirmPurgeOpen = true">
							Purge Expired
						</v-button>
					</div>
					<div v-if="purgeResult" class="result">
						<v-notice type="info">
							<template v-if="purgeResult.dry_run">Dry run · </template>
							{{ purgeResult.candidate_count.toLocaleString() }} candidate(s)
							<template v-if="!purgeResult.dry_run">
								· deleted {{ purgeResult.deleted.toLocaleString() }}
								· skipped {{ purgeResult.skipped.toLocaleString() }}
								· failed {{ purgeResult.failed.toLocaleString() }}
							</template>
							· older than {{ purgeResult.older_than_days }}d
						</v-notice>
					</div>

					<v-divider
						class="section-divider scheduled-purge-divider"
						large
						:inline-title="false"
						:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
					>
						<template #icon><v-icon name="schedule" /></template>
						Scheduled Purge
					</v-divider>

					<div class="side-field scheduled-purge">
						<label>Daily Flow</label>
						<template v-if="purgeFlow">
							<v-notice type="success" class="notice notice--inline">
								Linked · <strong>{{ purgeFlow.name }}</strong>
								· {{ purgeFlow.status }}
								<template v-if="purgeFlow.cron"> · {{ purgeFlow.cron }}</template>
							</v-notice>
							<div class="actions actions--tight">
								<v-button secondary @click="openPurgeFlow">Open Flow</v-button>
								<v-button
									secondary
									:loading="purgeFlowBusy"
									:disabled="recycleBusy || purgeFlowBusy"
									@click="confirmRemoveFlowOpen = true"
								>
									Remove Flow
								</v-button>
							</div>
						</template>
						<template v-else>
							<p class="field-hint">
								Creates an active Schedule Flow (<code>{{ purgeCron }}</code>) that runs
								<strong>Purge Recycle Bin</strong> using your retention setting. Editable later in
								Settings → Flows.
							</p>
							<div class="actions actions--tight">
								<v-button
									:loading="purgeFlowBusy"
									:disabled="recycleBusy || purgeFlowBusy"
									@click="createPurgeFlow"
								>
									Create Daily Flow
								</v-button>
							</div>
						</template>
					</div>
				</template>

				<!-- Retention still editable? Only when on. When off, retention is used on enable. Show when off too for first setup. -->
				<div v-if="!recycle.enabled" class="side-field">
					<label>Retention (days)</label>
					<v-input
						v-model="recycleRetention"
						type="number"
						:min="1"
						:max="3650"
						:disabled="recycleBusy"
					/>
					<p class="field-hint">Applied when you turn Recycle Bin on.</p>
				</div>

				<div v-if="recycleMessage" class="result">
					<v-notice :type="recycleMessage.type">{{ recycleMessage.text }}</v-notice>
				</div>
			</template>
		</div>

		<v-dialog v-model="confirmPurgeOpen" @esc="confirmPurgeOpen = false">
			<v-card>
				<v-card-title>Purge expired Recycle Bin?</v-card-title>
				<v-card-text>
					Permanently deletes files in the recycle folder older than
					<strong>{{ recycleRetention || recycle.retention_days }}</strong>
					day(s), after re-checking that they are still unreferenced. This cannot be undone.
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmPurgeOpen = false">Cancel</v-button>
					<v-button kind="danger" :loading="purging" @click="purgeRecycle(false)">Purge</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="confirmRemoveFlowOpen" @esc="confirmRemoveFlowOpen = false">
			<v-card>
				<v-card-title>Remove daily purge Flow?</v-card-title>
				<v-card-text>
					Deletes the linked Schedule Flow from this project. Recycle Bin itself stays enabled; you can create
					the Flow again later.
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmRemoveFlowOpen = false">Cancel</v-button>
					<v-button kind="danger" :loading="purgeFlowBusy" @click="removePurgeFlow">Remove</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useApi } from '@directus/extensions-sdk';
import ModuleNavigation from './navigation.vue';
import { useFolders } from './composables/use-folders';
import { usePageClass } from './composables/use-page-class';
import {
	RECYCLE_DEFAULT_FOLDER_NAME,
	RECYCLE_DEFAULTS,
	RECYCLE_PURGE_FLOW_CRON,
} from '../shared/recycle';

/** Sentinel: create/reuse folder by default name on enable (not a real folder id). */
const CREATE_DEFAULT_FOLDER = '__create_default__';

const api = useApi();
const router = useRouter();
const pageClass = usePageClass();
const { folders, loading: foldersLoading, fetchFolders } = useFolders();

type PurgeFlowInfo = {
	id: string;
	name: string;
	status: string;
	cron: string | null;
};

type RecycleStatus = {
	enabled: boolean;
	folder_id: string | null;
	folder_name: string | null;
	retention_days: number;
	field: string;
	field_ready: boolean;
	file_count: number;
	purge_flow_id: string | null;
	purge_flow: PurgeFlowInfo | null;
};

const recycle = ref<RecycleStatus>({
	...RECYCLE_DEFAULTS,
	folder_name: null,
	field_ready: false,
	file_count: 0,
	purge_flow: null,
});
const recycleLoading = ref(true);
const recycleBusy = ref(false);
const recycleRetention = ref(RECYCLE_DEFAULTS.retention_days);
/** Selected folder id, or CREATE_DEFAULT_FOLDER for “_Recycle”. */
const recyclePickFolder = ref<string>(CREATE_DEFAULT_FOLDER);
const recycleMessage = ref<{ type: 'success' | 'danger'; text: string } | null>(null);
const confirmPurgeOpen = ref(false);
const confirmRemoveFlowOpen = ref(false);
const purging = ref(false);
const purgeDryRunning = ref(false);
const purgeFlowBusy = ref(false);
const purgeCron = RECYCLE_PURGE_FLOW_CRON;
const defaultFolderName = RECYCLE_DEFAULT_FOLDER_NAME;
const purgeResult = ref<{
	dry_run: boolean;
	candidate_count: number;
	deleted: number;
	skipped: number;
	failed: number;
	older_than_days: number;
} | null>(null);

const purgeFlow = computed(() => recycle.value.purge_flow);

function openPurgeFlow() {
	const id = purgeFlow.value?.id;
	if (!id) return;
	// Named route — avoids `/admin/settings/settings/flows/...` from path joining.
	void router.push({ name: 'settings-flows-item', params: { primaryKey: id } });
}

const rootRecycleFolderId = computed(() => {
	const list = folders.value || [];
	const hit = list.find(
		(f) => !f.parent && f.name === RECYCLE_DEFAULT_FOLDER_NAME,
	);
	return hit?.id ? String(hit.id) : null;
});

const recycleFolderSelectItems = computed(() => {
	const list = folders.value || [];
	const byId = new Map(list.map((f) => [f.id, f]));
	const labelFor = (id: string, name: string) => {
		const parts = [name];
		let cur = byId.get(id);
		while (cur?.parent) {
			const parent = byId.get(cur.parent);
			if (!parent) break;
			parts.unshift(parent.name);
			cur = parent;
		}
		return parts.join(' / ');
	};

	const defaultValue = rootRecycleFolderId.value || CREATE_DEFAULT_FOLDER;
	const items: Array<{ text: string; value: string }> = [
		{ text: RECYCLE_DEFAULT_FOLDER_NAME, value: defaultValue },
	];

	for (const f of list) {
		if (f.id === defaultValue) continue;
		items.push({ text: labelFor(f.id, f.name), value: f.id });
	}
	return items;
});

const recycleFolderChoices = computed(() => {
	const id = recycle.value.folder_id;
	if (!id) return [] as Array<{ text: string; value: string }>;
	const name = recycle.value.folder_name || id;
	return [{ text: name, value: id }];
});

onMounted(async () => {
	await Promise.all([loadRecycle(), fetchFolders()]);
	syncPickDefault();
});

function syncPickDefault() {
	if (recycle.value.folder_id) {
		recyclePickFolder.value = recycle.value.folder_id;
		return;
	}
	recyclePickFolder.value = rootRecycleFolderId.value || CREATE_DEFAULT_FOLDER;
}

async function loadRecycle() {
	recycleLoading.value = true;
	try {
		const res = await api.get('/storage-manager/recycle', {
			headers: { 'Cache-Control': 'no-cache' },
			params: { _ts: Date.now() },
		});
		applyRecycleData(res.data?.data || {});
		syncPickDefault();
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Failed to load Recycle Bin',
		};
	} finally {
		recycleLoading.value = false;
	}
}

function applyRecycleData(data: Record<string, any>) {
	const flow = data.purge_flow && !data.purge_flow.missing ? data.purge_flow : null;
	recycle.value = {
		enabled: Boolean(data.enabled),
		folder_id: data.folder_id || null,
		folder_name: data.folder_name || null,
		retention_days: Number(data.retention_days) || RECYCLE_DEFAULTS.retention_days,
		field: data.field || RECYCLE_DEFAULTS.field,
		field_ready: Boolean(data.field_ready),
		file_count: Number(data.file_count) || 0,
		purge_flow_id: data.purge_flow_id || flow?.id || null,
		purge_flow: flow
			? {
					id: String(flow.id),
					name: String(flow.name || ''),
					status: String(flow.status || ''),
					cron: flow.cron ? String(flow.cron) : null,
				}
			: null,
	};
	recycleRetention.value = recycle.value.retention_days;
}

async function setEnabled(next: boolean) {
	if (recycleBusy.value || next === recycle.value.enabled) return;
	if (next) await enableRecycle();
	else await disableRecycle();
}

async function enableRecycle() {
	recycleBusy.value = true;
	recycleMessage.value = null;
	try {
		const pick = recyclePickFolder.value;
		const creatingDefault = !pick || pick === CREATE_DEFAULT_FOLDER;
		const res = await api.post('/storage-manager/recycle/enable', {
			folder_id: creatingDefault ? null : pick,
			folder_name: RECYCLE_DEFAULT_FOLDER_NAME,
			retention_days: Number(recycleRetention.value) || RECYCLE_DEFAULTS.retention_days,
		});
		applyRecycleData(res.data?.data || { enabled: true });
		await fetchFolders();
		syncPickDefault();
		recycleMessage.value = {
			type: 'success',
			text: 'Recycle Bin turned on. Field and folder are ready.',
		};
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Enable failed',
		};
		await loadRecycle();
	} finally {
		recycleBusy.value = false;
	}
}

async function disableRecycle() {
	recycleBusy.value = true;
	recycleMessage.value = null;
	try {
		const res = await api.post('/storage-manager/recycle/disable');
		applyRecycleData(res.data?.data || { enabled: false });
		syncPickDefault();
		recycleMessage.value = {
			type: 'success',
			text: 'Recycle Bin turned off. Folder and field were kept; linked purge Flow was paused if present.',
		};
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Disable failed',
		};
		await loadRecycle();
	} finally {
		recycleBusy.value = false;
	}
}

async function saveRecycleRetention() {
	recycleBusy.value = true;
	recycleMessage.value = null;
	try {
		await api.patch('/storage-manager/recycle', {
			retention_days: Number(recycleRetention.value) || RECYCLE_DEFAULTS.retention_days,
		});
		recycleMessage.value = { type: 'success', text: 'Retention saved.' };
		await loadRecycle();
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Save failed',
		};
	} finally {
		recycleBusy.value = false;
	}
}

async function createPurgeFlow() {
	purgeFlowBusy.value = true;
	recycleMessage.value = null;
	try {
		await api.post('/storage-manager/recycle/purge-flow');
		// Linked notice below is the confirmation — no extra success banner.
		await loadRecycle();
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Create Flow failed',
		};
	} finally {
		purgeFlowBusy.value = false;
	}
}

async function removePurgeFlow() {
	purgeFlowBusy.value = true;
	recycleMessage.value = null;
	try {
		await api.delete('/storage-manager/recycle/purge-flow');
		confirmRemoveFlowOpen.value = false;
		await loadRecycle();
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Remove Flow failed',
		};
	} finally {
		purgeFlowBusy.value = false;
	}
}

async function purgeRecycle(dryRun: boolean) {
	if (dryRun) purgeDryRunning.value = true;
	else purging.value = true;
	recycleMessage.value = null;
	purgeResult.value = null;
	try {
		const res = await api.post('/storage-manager/recycle/purge', {
			older_than_days: Number(recycleRetention.value) || recycle.value.retention_days,
			dry_run: dryRun,
		});
		purgeResult.value = res.data?.data || null;
		confirmPurgeOpen.value = false;
		if (!dryRun) await loadRecycle();
	} catch (error: any) {
		recycleMessage.value = {
			type: 'danger',
			text: error?.response?.data?.errors?.[0]?.message || error?.message || 'Purge failed',
		};
	} finally {
		purgeDryRunning.value = false;
		purging.value = false;
	}
}
</script>

<style scoped>
.page-container {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding);
	max-inline-size: 67.5rem;
}

.section-divider {
	margin-block-end: 0.75rem;
}

.page-intro,
.sidebar-text {
	margin: 0 0 1.25rem;
	color: var(--theme--foreground);
	line-height: 1.45;
}

.page-intro code,
.sidebar-text code,
.field-hint code,
.v-card-text code {
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: 0.9em;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 16px;
	align-items: center;
}

.actions--tight {
	margin-bottom: 0;
}

.notice,
.result {
	margin-bottom: 16px;
}

.notice--inline {
	margin-bottom: 0.85rem;
	flex: 1 1 100%;
}

.side-field {
	margin: 0 0 1rem;
	max-inline-size: 36rem;
}

.side-field label {
	display: block;
	margin-bottom: 0.35rem;
	font-weight: 600;
	font-size: 0.85rem;
}

.field-hint {
	margin: 0.35rem 0 0;
	font-size: 0.9rem;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.status-radios {
	display: flex;
	flex-wrap: wrap;
	gap: 1rem 1.25rem;
	align-items: center;
}

.retention-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.retention-row :deep(.v-input),
.retention-row :deep(.v-select) {
	flex: 1 1 8rem;
	min-inline-size: 6rem;
	max-inline-size: 18rem;
}

.scheduled-purge-divider {
	margin-block: 2.5rem 0.75rem;
}

.scheduled-purge {
	margin-block-end: 1.25rem;
	padding: 1rem 1.1rem;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
}
</style>
