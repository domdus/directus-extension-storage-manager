export type DriverMeta = {
	id: string;
	label: string;
	short: string;
	icon: string;
};

const DRIVER_META: Record<string, DriverMeta> = {
	local: { id: 'local', label: 'Local Disk', short: 'Local', icon: 'hard_drive' },
	s3: { id: 's3', label: 'Amazon S3', short: 'S3', icon: 'cloud' },
	gcs: { id: 'gcs', label: 'Google Cloud Storage', short: 'GCS', icon: 'cloud_queue' },
	azure: { id: 'azure', label: 'Azure Blob', short: 'Azure', icon: 'cloud_done' },
	cloudinary: { id: 'cloudinary', label: 'Cloudinary', short: 'Cloudinary', icon: 'photo_library' },
	supabase: { id: 'supabase', label: 'Supabase', short: 'Supabase', icon: 'storage' },
};

export function getDriverMeta(driver: string | null | undefined): DriverMeta {
	const key = String(driver || 'local').toLowerCase();
	return (
		DRIVER_META[key] || {
			id: key,
			label: key,
			short: key.slice(0, 8).toUpperCase(),
			icon: 'storage',
		}
	);
}

export function parseStorageLocations(envValue: unknown): string[] {
	if (!envValue) return [];
	if (Array.isArray(envValue)) return envValue.map((v) => String(v).trim()).filter(Boolean);
	return String(envValue)
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}
