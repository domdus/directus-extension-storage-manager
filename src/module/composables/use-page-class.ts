import { useStores } from '@directus/extensions-sdk';
import { computed, type ComputedRef } from 'vue';

function parseVersion(version: unknown): { major: number; minor: number } | null {
	if (typeof version !== 'string' || !version) return null;
	const cleaned = version.trim().replace(/^v/i, '');
	const [majorRaw, minorRaw] = cleaned.split('.');
	const major = Number.parseInt(majorRaw || '', 10);
	const minor = Number.parseInt(minorRaw || '', 10);
	if (!Number.isFinite(major)) return null;
	return { major, minor: Number.isFinite(minor) ? minor : 0 };
}

function hasSplitPanelLayout(): boolean {
	if (typeof document === 'undefined') return false;
	if (document.querySelector('.root-split, .main-split')) return true;
	if (document.querySelector('#navigation.module-bar')) return true;
	if (document.querySelector('aside.module-nav:not(#navigation)')) return true;
	return false;
}

function needsReducedTopPadding(version: unknown): boolean {
	if (hasSplitPanelLayout()) return false;
	const parsed = parseVersion(version);
	if (parsed) return parsed.major === 11 && parsed.minor < 14;
	if (typeof document === 'undefined') return false;
	return Boolean(document.querySelector('#navigation:not(.module-bar)'));
}

export function usePageClass(): ComputedRef<string[]> {
	const { useServerStore } = useStores() as {
		useServerStore: () => { info?: { version?: string } };
	};
	const serverStore = useServerStore();

	return computed(() => {
		const classes = ['page'];
		if (needsReducedTopPadding(serverStore?.info?.version)) {
			classes.push('page--flush-top');
		}
		return classes;
	});
}
