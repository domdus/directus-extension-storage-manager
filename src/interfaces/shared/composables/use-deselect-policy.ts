import { useApi } from '@directus/extensions-sdk';
import { computed, onMounted, ref, type Ref } from 'vue';

export type DeselectPolicy = 'keep' | 'ask' | 'delete_if_unreferenced' | 'move_to_recycle';

const POLICY_VALUES = new Set<DeselectPolicy>([
	'keep',
	'ask',
	'delete_if_unreferenced',
	'move_to_recycle',
]);

function asPolicy(value: unknown): DeselectPolicy | null {
	return typeof value === 'string' && POLICY_VALUES.has(value as DeselectPolicy)
		? (value as DeselectPolicy)
		: null;
}

/**
 * Resolves On Deselect: field option wins; `inherit` / empty uses
 * Storage Manager File Interfaces default (`lifecycle.storage_manager.on_deselect`).
 */
export function useDeselectPolicy(localPolicy: Ref<string | undefined>) {
	const api = useApi();
	const globalPolicy = ref<DeselectPolicy>('keep');

	onMounted(async () => {
		try {
			const res = await api.get('/storage-manager/settings');
			const value = asPolicy(res.data?.data?.lifecycle?.storage_manager?.on_deselect);
			if (value) globalPolicy.value = value;
		} catch {
			/* keep default */
		}
	});

	const effectiveDeselect = computed<DeselectPolicy>(() => {
		const local = localPolicy.value;
		if (!local || local === 'inherit') return globalPolicy.value;
		return asPolicy(local) ?? globalPolicy.value;
	});

	return { effectiveDeselect };
}
