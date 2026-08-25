import { computed, type Ref } from 'vue';

export function useUploadPreset(storage: Ref<string | undefined | null>) {
	return computed(() => ({
		storage: String(storage.value || 'local').trim() || 'local',
	}));
}
