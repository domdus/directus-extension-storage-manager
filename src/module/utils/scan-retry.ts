/**
 * GET that waits for a server-side folder scan.
 *
 * The endpoint answers 202 `{ meta: { scanning: true, scanned } }` while a large storage folder
 * is still being read (dir-scan.ts on the API side) instead of holding the request until the
 * proxy times out. Poll until the listing is ready, the caller lost interest, or maxWaitMs.
 */
export type ScanProgress = { scanned: number };

export async function getWithScanRetry(
	api: { get: (url: string, config?: any) => Promise<any> },
	url: string,
	config?: any,
	options: {
		intervalMs?: number;
		maxWaitMs?: number;
		isStale?: () => boolean;
		onProgress?: (progress: ScanProgress) => void;
	} = {},
): Promise<any> {
	const intervalMs = options.intervalMs ?? 2000;
	const deadline = Date.now() + (options.maxWaitMs ?? 5 * 60 * 1000);

	for (;;) {
		const res: any = await api.get(url, config);
		const scanning = res?.status === 202 && res?.data?.meta?.scanning === true;
		if (!scanning) return res;
		options.onProgress?.({ scanned: Number(res.data.meta.scanned) || 0 });
		if (options.isStale?.()) return res;
		if (Date.now() + intervalMs > deadline) {
			throw new Error('Folder scan is taking too long, please try again in a few minutes.');
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		if (options.isStale?.()) return res;
	}
}
