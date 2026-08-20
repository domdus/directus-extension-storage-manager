import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	EXTENSION_GITHUB_URL,
	EXTENSION_MARKETPLACE_UID,
	EXTENSION_NPM_URL,
	EXTENSION_PACKAGE_NAME,
} from '../shared/extension-meta';

function readInstalledVersion(): string {
	const candidates: string[] = [];
	try {
		candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
	} catch {
		// bundled environment without import.meta.url
	}
	candidates.push(
		path.resolve(process.cwd(), 'extensions', EXTENSION_PACKAGE_NAME, 'package.json'),
		path.resolve(process.cwd(), 'package.json'),
	);

	for (const file of candidates) {
		try {
			const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
			if (pkg.name === EXTENSION_PACKAGE_NAME && pkg.version) return String(pkg.version);
		} catch {
			// try next path
		}
	}

	return 'unknown';
}

type UpdateCheckResponse = {
	current_version: string;
	latest_version: string | null;
	has_update: boolean;
	registry: 'npm';
	checked_at: string;
	release_url: string | null;
	links: {
		npm: string;
		github: string;
		marketplace: string | null;
	};
	error?: string;
};

let cache: { expiresAt: number; data: UpdateCheckResponse } | null = null;
const TTL_MS = 30 * 60 * 1000;

function normalizeVersion(raw: string): string {
	return String(raw || '').trim().replace(/^v/, '');
}

function splitVersion(version: string): { nums: number[]; prerelease: string[] } {
	const normalized = normalizeVersion(version);
	const [core, prereleaseRaw] = normalized.split('-', 2);
	const nums = core
		.split('.')
		.map((part) => parseInt(part, 10))
		.map((n) => (Number.isFinite(n) ? n : 0));
	const prerelease = prereleaseRaw ? prereleaseRaw.split('.') : [];
	return { nums, prerelease };
}

function compareSemver(a: string, b: string): number {
	const av = splitVersion(a);
	const bv = splitVersion(b);
	const len = Math.max(av.nums.length, bv.nums.length, 3);
	for (let i = 0; i < len; i++) {
		const left = av.nums[i] ?? 0;
		const right = bv.nums[i] ?? 0;
		if (left > right) return 1;
		if (left < right) return -1;
	}
	if (!av.prerelease.length && bv.prerelease.length) return 1;
	if (av.prerelease.length && !bv.prerelease.length) return -1;
	const pLen = Math.max(av.prerelease.length, bv.prerelease.length);
	for (let i = 0; i < pLen; i++) {
		const left = av.prerelease[i];
		const right = bv.prerelease[i];
		if (left == null) return -1;
		if (right == null) return 1;
		const lNum = /^[0-9]+$/.test(left) ? parseInt(left, 10) : null;
		const rNum = /^[0-9]+$/.test(right) ? parseInt(right, 10) : null;
		if (lNum != null && rNum != null) {
			if (lNum > rNum) return 1;
			if (lNum < rNum) return -1;
			continue;
		}
		if (lNum != null && rNum == null) return -1;
		if (lNum == null && rNum != null) return 1;
		if (left > right) return 1;
		if (left < right) return -1;
	}
	return 0;
}

function marketplaceUrl(basePath = ''): string | null {
	if (!EXTENSION_MARKETPLACE_UID) return null;
	return `${basePath}/admin/settings/marketplace/extension/${EXTENSION_MARKETPLACE_UID}`;
}

export async function checkForUpdates(force = false): Promise<UpdateCheckResponse> {
	if (!force && cache && Date.now() < cache.expiresAt) return cache.data;

	const currentVersion = normalizeVersion(readInstalledVersion());
	const links = {
		npm: EXTENSION_NPM_URL,
		github: EXTENSION_GITHUB_URL,
		marketplace: marketplaceUrl(''),
	};

	const base: UpdateCheckResponse = {
		current_version: currentVersion,
		latest_version: null,
		has_update: false,
		registry: 'npm',
		checked_at: new Date().toISOString(),
		release_url: links.npm,
		links,
	};

	try {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(EXTENSION_PACKAGE_NAME)}`, {
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
		if (!response.ok) {
			throw new Error(`npm registry request failed (${response.status})`);
		}
		const payload = (await response.json()) as {
			'dist-tags'?: Record<string, string>;
			versions?: Record<string, unknown>;
		};
		const latestRaw = payload?.['dist-tags']?.latest || '';
		const latestVersion = normalizeVersion(latestRaw);
		if (!latestVersion) throw new Error('No latest version found in npm dist-tags');

		const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
		const data: UpdateCheckResponse = {
			...base,
			latest_version: latestVersion,
			has_update: hasUpdate,
			release_url: hasUpdate ? `${EXTENSION_NPM_URL}?activeTab=versions` : EXTENSION_NPM_URL,
			checked_at: new Date().toISOString(),
		};
		cache = { data, expiresAt: Date.now() + TTL_MS };
		return data;
	} catch (error: any) {
		const data: UpdateCheckResponse = {
			...base,
			error: error?.message || 'Update check failed',
			checked_at: new Date().toISOString(),
		};
		cache = { data, expiresAt: Date.now() + Math.min(5 * 60 * 1000, TTL_MS) };
		return data;
	}
}
