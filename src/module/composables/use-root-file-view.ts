import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export type RootFileView = 'files' | 'transforms';

const VALID_VIEWS = new Set<RootFileView>(['files', 'transforms']);

export function useRootFileView() {
	const route = useRoute();
	const router = useRouter();

	const rootFileView = computed<RootFileView>(() => {
		const raw = String(route.query.view || 'files');
		if (raw === 'all') return 'files';
		return VALID_VIEWS.has(raw as RootFileView) ? (raw as RootFileView) : 'files';
	});

	function setRootFileView(view: RootFileView) {
		const query: Record<string, string | string[]> = { ...route.query };
		if (view === 'files') {
			delete query.view;
		} else {
			query.view = view;
		}
		router.replace({ path: route.path, query });
	}

	return { rootFileView, setRootFileView };
}
