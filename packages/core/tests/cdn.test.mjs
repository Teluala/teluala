/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as normal from '../dist/index.js';
import * as cdn from '../dist/teluala.min.js';

test('CDN build preserves the public API and numeric results', () => {
  assert.deepEqual(Object.keys(cdn).sort(), Object.keys(normal).sort());
  assert.deepEqual(cdn.CAMERA_LIMITS, normal.CAMERA_LIMITS);
  assert.equal(cdn.GlobeEngine.name, normal.GlobeEngine.name);
  assert.deepEqual(
    Object.getOwnPropertyNames(cdn.GlobeEngine.prototype).sort(),
    Object.getOwnPropertyNames(normal.GlobeEngine.prototype).sort(),
  );
  for (const position of [
    [0, 0, 0],
    [-120, 45, 0.1],
    [180, -60, 0.001],
  ]) {
    assert.deepEqual(cdn.ecef(...position), normal.ecef(...position));
    assert.deepEqual(cdn.geodeticNormal(...position), normal.geodeticNormal(...position));
  }
});
