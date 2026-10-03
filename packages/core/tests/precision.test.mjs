/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { composeViewProjection, viewProjectionAt } from '../dist/index.js';

const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
// A translation Float32 cannot hold: 0.5 + 2^-30 rounds to 0.5 in Float32
// (ulp at 0.5 is 2^-24), so the product with translate(-0.5) keeps the 2^-30
// only when it is formed from the double-precision vp64.
const vp64 = new Float64Array(translation(0.5 + 2 ** -30, 0, 0));
const vp = new Float32Array(vp64);

test('viewProjectionAt forms vp × translate(origin) from vp64 and rounds once at the write', () => {
  const out = viewProjectionAt(new Float32Array(16), vp, vp64, -0.5, 0, 0);
  assert.equal(out[12], 2 ** -30);
  assert.deepEqual(
    [...out.slice(0, 12)],
    [...vp.slice(0, 12)],
    'columns 0..2 are the view-projection itself',
  );
  assert.equal(out[15], 1);
  const fallback = viewProjectionAt(new Float32Array(16), vp, undefined, -0.5, 0, 0);
  assert.equal(fallback[12], 0, 'without vp64 the Float32 product loses the translation');
});

test('composeViewProjection forms vp × model from vp64 and falls back to vp alone', () => {
  const out = composeViewProjection(new Float32Array(16), vp, vp64, translation(-0.5, 0, 0));
  assert.equal(out[12], 2 ** -30);
  const identity = composeViewProjection(new Float32Array(16), vp, vp64, undefined);
  assert.deepEqual([...identity], [...vp]);
  // A rotation in the model matrix reaches every column.
  const rotate90z = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rotated = composeViewProjection(
    new Float32Array(16),
    new Float32Array(translation(0, 0, 0)),
    undefined,
    rotate90z,
  );
  assert.deepEqual([...rotated], rotate90z);
});
