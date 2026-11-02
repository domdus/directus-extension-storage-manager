/** `_` and `%` are wildcards in LIKE, so `video_files` would also match `video-files`. */
export function escapeLike(value: string): string {
	return value.replace(/[!%_\[]/g, '!$&');
}

function clientName(database: any): string {
	return String(database?.client?.config?.client || database?.client?.dialect || '').toLowerCase();
}

export type SqlClause = [sql: string, bindings: Array<string | number>];

/**
 * `filename_disk` starts with `prefix`, wildcards and case included. Storage keys are
 * case-sensitive, but LIKE ignores case on SQLite and with the default MySQL, MariaDB
 * and MSSQL collations, so `Photos/` would otherwise select `photos/`.
 */
export function filenamePrefixClause(database: any, prefix: string): SqlClause {
	const client = clientName(database);
	const pattern = `${escapeLike(prefix)}%`;
	if (client.includes('sqlite')) return ['substr(filename_disk, 1, ?) = ?', [[...prefix].length, prefix]];
	if (client.includes('mysql') || client.includes('maria')) {
		return ["filename_disk LIKE CAST(? AS BINARY) ESCAPE '!'", [pattern]];
	}
	if (client.includes('mssql')) return ["filename_disk COLLATE Latin1_General_100_BIN2 LIKE ? ESCAPE '!'", [pattern]];
	return ["filename_disk LIKE ? ESCAPE '!'", [pattern]];
}

/** Exact `filename_disk` match with the same case rules as {@link filenamePrefixClause}. */
export function filenameEqualsClause(database: any, value: string): SqlClause {
	const client = clientName(database);
	if (client.includes('mysql') || client.includes('maria')) return ['filename_disk = CAST(? AS BINARY)', [value]];
	if (client.includes('mssql')) return ['filename_disk COLLATE Latin1_General_100_BIN2 = ?', [value]];
	return ['filename_disk = ?', [value]];
}
