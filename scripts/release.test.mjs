/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExisting, checkFiles, registry, waitForPublication } from './release.mjs';

test('post-publication verification tolerates registry propagation but never a different tarball', async () => {
  const entry = { name: 'teluala', version: '0.1.0-beta.3', integrity: 'sha512-reviewed' };
  let calls = 0;
  let sleeps = 0;
  const lookup = async (path) => {
    calls++;
    if (calls === 1) return null;
    if (path.includes('/')) return { ...entry, dist: { integrity: entry.integrity } };
    return { 'dist-tags': { beta: calls >= 5 ? entry.version : 'old' } };
  };
  await waitForPublication(entry, { lookup, sleep: async () => { sleeps++; } });
  assert.equal(sleeps, 2);
  await assert.rejects(waitForPublication(entry, {
    lookup: async () => ({ ...entry, dist: { integrity: 'sha512-wrong' } }),
    sleep: async () => { throw new Error('Should not retry mismatched artifacts'); },
  }), /Registry artifact differs/);
  await assert.rejects(waitForPublication(entry, {
    lookup: async () => null, sleep: async () => {}, attempts: 2,
  }), /visibility timed out/);
});

test('only registry 404 means absent; permissions and network errors stop publication', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ status: 404 });
    assert.equal(await registry('teluala/0.1.0-beta.3'), null);
    for (const status of [403, 429, 500]) {
      globalThis.fetch = async () => ({ status, ok: false });
      await assert.rejects(registry('teluala/0.1.0-beta.3'), /Registry lookup failed/);
    }
    globalThis.fetch = async () => { throw new Error('Network unavailable'); };
    await assert.rejects(registry('teluala/0.1.0-beta.3'), /Network unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a partial release can skip only the exact existing tarball', () => {
  const entry = { name: 'teluala', version: '0.1.0-beta.3', integrity: 'sha512-reviewed' };
  const metadata = { ...entry, dist: { integrity: entry.integrity } };
  assert.doesNotThrow(() => checkExisting(metadata, entry));
  assert.throws(() => checkExisting({ ...metadata, dist: { integrity: 'sha512-different' } }, entry), /differs/);
  assert.throws(() => checkExisting({ ...metadata, version: '0.1.0-beta.2' }, entry), /version mismatch/);
});

test('worker and CDN artifacts must be present before any package is published', () => {
  const files = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts'];
  assert.throws(() => checkFiles(files, 'teluala'), /missing dist\/teluala.min.js/);
  assert.throws(() => checkFiles(files, '@teluala/terrain'), /missing dist\/demWorker.js/);
  assert.throws(() => checkFiles(files, '@teluala/vector'), /missing dist\/mvtWorkerEntry.js/);
  assert.doesNotThrow(() => checkFiles([...files, 'dist/teluala.min.js'], 'teluala'));
  assert.throws(() => checkFiles([...files, '.npmrc'], '@teluala/raster'), /unexpected file/);
  assert.throws(() => checkFiles([...files, 'dist/index.js.map'], '@teluala/raster'), /unexpected file/);
});
