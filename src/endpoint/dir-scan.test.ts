import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	__resetDirScanForTests,
	invalidateDirectory,
	requireDirectoryListing,
	scanDirectory,
	scanDirectoryFully,
	ScanInProgressError,
} from './dir-scan';

let tmp: string;
const realOpendir = fs.opendir;
let opendirCalls = 0;

beforeEach(async () => {
	__resetDirScanForTests();
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-scan-'));
	await fs.mkdir(path.join(tmp, 'sub'));
	await fs.mkdir(path.join(tmp, '.hidden'));
	await fs.writeFile(path.join(tmp, 'a.jpg'), 'x');
	await fs.writeFile(path.join(tmp, 'b__thumb.avif'), 'x');
	await fs.writeFile(path.join(tmp, '.dotfile'), 'x');
	opendirCalls = 0;
	(fs as any).opendir = async (...args: any[]) => {
		opendirCalls++;
		return (realOpendir as any)(...args);
	};
});

afterEach(async () => {
	(fs as any).opendir = realOpendir;
	await fs.rm(tmp, { recursive: true, force: true });
});

test('lists files and folders, skipping dot entries', async () => {
	const listing = await scanDirectoryFully(tmp);
	assert.deepEqual([...listing.files].sort(), ['a.jpg', 'b__thumb.avif']);
	assert.deepEqual(listing.dirs, ['sub']);
});

test('concurrent callers share one scan and later calls hit the cache', async () => {
	const [a, b, c] = await Promise.all([scanDirectoryFully(tmp), scanDirectory(tmp), requireDirectoryListing(tmp)]);
	assert.equal(opendirCalls, 1);
	assert.equal(a.files.length, 2);
	assert.equal(b.complete, true);
	assert.equal(c.dirs.length, 1);
	await scanDirectoryFully(tmp);
	assert.equal(opendirCalls, 1);
});

test('invalidateDirectory forces a fresh read', async () => {
	await scanDirectoryFully(tmp);
	await fs.writeFile(path.join(tmp, 'c.png'), 'x');
	assert.equal((await scanDirectoryFully(tmp)).files.length, 2);
	invalidateDirectory(tmp);
	assert.equal((await scanDirectoryFully(tmp)).files.length, 3);
	assert.equal(opendirCalls, 2);
});

test('a slow scan answers "in progress" and finishes in the background', async () => {
	(fs as any).opendir = async (...args: any[]) => {
		opendirCalls++;
		await new Promise((r) => setTimeout(r, 150));
		return (realOpendir as any)(...args);
	};
	const first = await scanDirectory(tmp, 20);
	assert.equal(first.complete, false);
	await assert.rejects(requireDirectoryListing(tmp, 20), ScanInProgressError);
	const done = await scanDirectoryFully(tmp);
	assert.equal(done.files.length, 2);
	assert.equal(opendirCalls, 1, 'the background scan is reused, not restarted');
	assert.equal((await scanDirectory(tmp, 0)).complete, true);
});

test('a missing folder is an empty listing, not an error', async () => {
	const listing = await scanDirectoryFully(path.join(tmp, 'nope'));
	assert.deepEqual(listing.files, []);
	assert.deepEqual(listing.dirs, []);
});

test('only one directory is scanned at a time', async () => {
	await fs.mkdir(path.join(tmp, 'other'));
	let active = 0;
	let maxActive = 0;
	(fs as any).opendir = async (...args: any[]) => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((r) => setTimeout(r, 30));
		const dir = await (realOpendir as any)(...args);
		active--;
		return dir;
	};
	await Promise.all([scanDirectoryFully(tmp), scanDirectoryFully(path.join(tmp, 'other')), scanDirectoryFully(path.join(tmp, 'sub'))]);
	assert.equal(maxActive, 1);
});
