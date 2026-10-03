/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRetryAfter, retryDelay, TileHttpError, isRetryableError } from '../dist/index.js';

test('tile retry policy distinguishes transient and permanent failures', () => {
  assert.equal(isRetryableError(new TileHttpError(429, 'fixture')), true);
  assert.equal(isRetryableError(new TileHttpError(503, 'fixture')), true);
  assert.equal(isRetryableError(new TileHttpError(404, 'fixture')), false);
  assert.equal(isRetryableError(new TypeError('network')), true);
  assert.equal(isRetryableError(Object.assign(new Error('stop'), { name: 'AbortError' })), false);
});

test('Retry-After supports seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('1.5', 0), 1500);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:02 GMT', 500), 1500);
  assert.equal(parseRetryAfter('invalid', 0), null);
});

test('tile retry delay honors jitter, Retry-After, and its maximum', () => {
  assert.equal(
    retryDelay(2, new TileHttpError(503, 'fixture', '1.5'), {
      baseMs: 100,
      maxMs: 1000,
      random: () => 0.5,
      now: () => 0,
    }),
    1000,
  );
  assert.equal(
    retryDelay(2, new TypeError('network'), {
      baseMs: 100,
      maxMs: 1000,
      random: () => 0.5,
    }),
    100,
  );
  assert.throws(() => retryDelay(0, new Error()), /positive integer/);
});

test('TileHttpError carries status, url and Retry-After', () => {
  const error = new TileHttpError(503, 'https://tiles.example/1/2/3.png', '2');
  assert.equal(error.status, 503);
  assert.equal(error.url, 'https://tiles.example/1/2/3.png');
  assert.equal(error.retryAfter, '2');
  assert.equal(error.name, 'TileHttpError');
  assert.match(error.message, /503/);
  assert.ok(error instanceof Error);
});
