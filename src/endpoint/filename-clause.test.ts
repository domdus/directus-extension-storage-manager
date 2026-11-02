import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeLike, filenameEqualsClause, filenamePrefixClause } from './filename-clause';

const db = (client: string) => ({ client: { config: { client } } });

test('escapeLike escapes every LIKE metacharacter', () => {
	assert.equal(escapeLike('video_files'), 'video!_files');
	assert.equal(escapeLike('100%!'), '100!%!!');
	assert.equal(escapeLike('a[b]'), 'a![b]');
});

test('Postgres relies on its case-sensitive LIKE', () => {
	assert.deepEqual(filenamePrefixClause(db('pg'), 'a_b/'), ["filename_disk LIKE ? ESCAPE '!'", ['a!_b/%']]);
});

test('SQLite compares the prefix exactly, counting characters', () => {
	assert.deepEqual(filenamePrefixClause(db('sqlite3'), 'Fötö/'), ['substr(filename_disk, 1, ?) = ?', [5, 'Fötö/']]);
	assert.deepEqual(filenamePrefixClause(db('sqlite3'), '😀/')[1], [2, '😀/']);
});

test('MySQL and MariaDB compare bytes', () => {
	for (const client of ['mysql', 'mysql2']) {
		assert.match(filenamePrefixClause(db(client), 'a/')[0], /CAST\(\? AS BINARY\)/);
		assert.match(filenameEqualsClause(db(client), 'a')[0], /CAST\(\? AS BINARY\)/);
	}
});

test('MSSQL uses a binary collation', () => {
	assert.match(filenamePrefixClause(db('mssql'), 'a/')[0], /COLLATE Latin1_General_100_BIN2/);
});
