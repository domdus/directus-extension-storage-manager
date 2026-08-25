type AssetUrlOptions = {
	isDownload?: boolean;
	imageKey?: string;
	cacheBuster?: boolean | string | number | Date;
};

export function getAssetUrl(
	filename: string,
	{ isDownload = false, imageKey, cacheBuster }: AssetUrlOptions = {},
): string {
	const assetUrl = new URL(`assets/${filename}`, window.location.origin);

	if (isDownload) assetUrl.searchParams.set('download', '');
	if (imageKey) assetUrl.searchParams.set('key', imageKey);
	if (cacheBuster) {
		assetUrl.searchParams.set('v', cacheBuster === true ? Date.now().toString() : String(cacheBuster));
	}

	return assetUrl.href;
}
