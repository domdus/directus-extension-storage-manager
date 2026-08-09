export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes === 0) return '0 B';

	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / Math.pow(1024, exp);
	const digits = value >= 100 || exp === 0 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits)} ${units[exp]}`;
}

export function formatPercent(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return '—';
	return `${Math.round(value)}%`;
}

/** Format throughput as megabit/s (SI Mbit, decimal). */
export function formatMbit(bytesPerSecond: number | null | undefined): string {
	if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '—';
	const mbit = (bytesPerSecond * 8) / 1_000_000;
	if (mbit < 0.1) return `${mbit.toFixed(2)} Mbit/s`;
	if (mbit < 10) return `${mbit.toFixed(1)} Mbit/s`;
	return `${Math.round(mbit)} Mbit/s`;
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}
