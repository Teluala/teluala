/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExisting, checkFiles, registry } from './release.mjs';

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
