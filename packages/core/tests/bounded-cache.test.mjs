/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedCache } from '../dist/index.js';

test('BoundedCache evicts least recently used first and never a protected entry', () => {
  const cache = new BoundedCache({ limit: 3 });
  for (const k of ['a', 'b', 'c']) cache.set(k, k.toUpperCase());
  assert.equal(cache.get('a'), 'A'); // a becomes most recent: order b, c, a
  cache.set('d', 'D');
  assert.deepEqual(cache.prune(), [['b', 'B']]);
  assert.deepEqual([...cache.keys()], ['c', 'a', 'd']);
  cache.set('e', 'E');
  // c is the oldest but protected, so a goes.
  assert.deepEqual(
    cache.prune((key) => key === 'c'),
    [['a', 'A']],
  );
  assert.deepEqual([...cache.keys()], ['c', 'd', 'e']);
  // peek does not touch recency; get does.
  cache.peek('c');
  cache.set('f', 'F');
  assert.deepEqual(
    cache.prune().map(([k]) => k),
    ['c'],
  );
  assert.equal(cache.size, 3);
  assert.equal(cache.delete('zzz'), undefined);
  assert.equal(cache.delete('d'), 'D');
  assert.equal(cache.has('d'), false);
});

test('BoundedCache bounds by sizeOf and keeps zero-sized entries out of the budget', () => {
  const cache = new BoundedCache({ limit: 100, sizeOf: (v) => v.bytes });
  cache.set('s', { bytes: 0, structural: true });
  cache.set('x', { bytes: 60 });
  cache.set('y', { bytes: 60 });
  assert.equal(cache.total, 120);
  assert.deepEqual(
    cache.prune().map(([k]) => k),
    ['x'],
  );
  assert.equal(cache.total, 60);
  // A size that changes after insertion counts at its current value.
  const y = cache.peek('y');
  y.bytes = 30;
  assert.equal(cache.total, 30);
  cache.set('z', { bytes: 80 });
  assert.deepEqual(
    cache.prune().map(([k]) => k),
    ['y'],
  );
  assert.deepEqual(cache.prune(), []);
  cache.clear();
  assert.equal(cache.total, 0);
  assert.throws(() => new BoundedCache({ limit: -1 }), RangeError);
  assert.throws(() => new BoundedCache({ limit: NaN }), RangeError);
});

test('BoundedCache prune protecting everything drops nothing and leaves total over the limit', () => {
  const cache = new BoundedCache({ limit: 1 });
  cache.set(1, 'a');
  cache.set(2, 'b');
  assert.deepEqual(
    cache.prune(() => true),
    [],
  );
  assert.equal(cache.total, 2);
});

test('BoundedCache.prune takes a per-call limit so a cache can bound what it keeps BEYOND the protected set', () => {
  // A frame that draws 3 entries and retains 1 more: the bound is 3 + 1, whatever the constructor said.
  const cache = new BoundedCache({ limit: 0 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) cache.set(k, k.toUpperCase());
  const drawn = new Set(['c', 'd', 'e']);
  assert.deepEqual(
    cache.prune((key) => drawn.has(key), drawn.size + 1).map(([k]) => k),
    ['a'],
  );
  assert.deepEqual([...cache.keys()], ['b', 'c', 'd', 'e']);
  // Without the override the constructor limit applies.
  assert.deepEqual(
    cache.prune((key) => drawn.has(key)).map(([k]) => k),
    ['b'],
  );
  assert.throws(() => cache.prune(undefined, -1), RangeError);
});
