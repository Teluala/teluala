/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertWebMercatorTile,
  selectWebMercatorTiles,
  webMercatorRangeForZoom,
  webMercatorY,
  webMercatorZoom,
  worldPerCssPixel,
  WEB_MERCATOR_MAX_LATITUDE,
} from '../dist/index.js';
import { cases } from './fixtures/web-mercator-frames.mjs';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/web-mercator-tiles.golden.json', import.meta.url), 'utf8'),
);

// Any change to the selector must reproduce the golden file exactly; a
// deliberate behaviour change regenerates the file in its own commit so the
// diff shows what moved.
test('Web Mercator tile selection reproduces the recorded golden tiles', () => {
  assert.equal(golden.cases.length, cases.length);
  for (const [index, expected] of golden.cases.entries()) {
    const { name, frame, options = {} } = cases[index];
    assert.equal(expected.name, name);
    if (expected.throws) {
      assert.throws(
        () => selectWebMercatorTiles(frame, options),
        (error) => error.constructor.name === expected.throws && error.message === expected.message,
        name,
      );
      continue;
    }
    assert.deepEqual(selectWebMercatorTiles(frame, options), expected.tiles, name);
  }
});

test('Web Mercator tile selection validates its options', () => {
  const frame = cases[0].frame;
  assert.throws(() => selectWebMercatorTiles(frame, { minZoom: 5, maxZoom: 3 }), RangeError);
  assert.throws(() => selectWebMercatorTiles(frame, { maxZoom: 31 }), RangeError);
  assert.throws(() => selectWebMercatorTiles(frame, { tileSize: 0 }), RangeError);
  assert.throws(() => selectWebMercatorTiles(frame, { maxTiles: 0 }), RangeError);
  assert.equal(webMercatorY(0), 0.5);
  // asinh(tan(85.05°)) / π lands within one ulp of 1, so the pole is ≈0, not 0.
  assert.ok(Math.abs(webMercatorY(WEB_MERCATOR_MAX_LATITUDE)) < 1e-12);
  assert.equal(webMercatorY(90), webMercatorY(WEB_MERCATOR_MAX_LATITUDE));
});

// A toy scheme with nothing Mercator about it: three lat/lon grids of 10°, 1°
// and 0.1° cells, string cell ids, distance in cell units. If the policy runs
// this unchanged, it carries no Web Mercator assumption.
import { selectTiles } from '../dist/webMercatorTiles.js';

const GRID_DEGREES = [10, 1, 0.1];
const gridScheme = {
  levelFor(worldPerPixel) {
    // 1 world unit ≈ 57.3° at the equator; pick the level whose cell is about 200 px.
    const degreesPerPixel = (worldPerPixel * 180) / Math.PI;
    return GRID_DEGREES.findLastIndex((size) => size >= 200 * degreesPerPixel);
  },
  cover(bounds, lookAt, level) {
    const size = GRID_DEGREES[level];
    const i0 = Math.floor(bounds.west / size),
      i1 = Math.floor(bounds.east / size);
    const j0 = Math.floor(bounds.south / size),
      j1 = Math.floor(bounds.north / size);
    return {
      count: (i1 - i0 + 1) * (j1 - j0 + 1),
      *cells() {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const dx = i + 0.5 - lookAt.lon / size,
              dy = j + 0.5 - lookAt.lat / size;
            yield { cell: `${level}/${i}/${j}`, distance: dx * dx + dy * dy };
          }
        }
      },
    };
  },
};
const gridFrame = (range, viewBBox, height = 700) => ({
  // Inside a cell, not on a corner, so "nearest" has a single answer.
  camera: { lon: 5.3, lat: 45.3, range, heading: 0, pitch: -1, roll: 0 },
  viewBBox,
  fovYRad: Math.PI / 4,
  viewportPx: { width: 1000, height, dpr: 1 },
});

test('the selection policy runs a non-Mercator scheme unchanged', () => {
  const bbox = { west: 0, south: 40, east: 10, north: 50 };
  // Resolution → level through the scheme, then clamped by the caller's range.
  const near = selectTiles(gridFrame(0.001, bbox), gridScheme, {
    minLevel: 0,
    maxLevel: 2,
    maxCells: 100000,
  });
  assert.equal(near[0].split('/')[0], '2');
  const capped = selectTiles(gridFrame(0.001, bbox), gridScheme, {
    minLevel: 0,
    maxLevel: 1,
    maxCells: 100000,
  });
  assert.equal(capped[0].split('/')[0], '1');
  assert.equal(capped.length, 11 * 11);
  // Coarsening: a budget of 8 cannot hold the 1° cover, so the policy steps to 10°.
  const budget = selectTiles(gridFrame(0.001, bbox), gridScheme, {
    minLevel: 0,
    maxLevel: 1,
    maxCells: 8,
  });
  assert.equal(new Set(budget.map((c) => c.split('/')[0])).size, 1);
  assert.equal(budget[0].split('/')[0], '0');
  assert.equal(budget.length, 4);
  // Nearest first: the cell holding the look-at point comes first.
  assert.equal(capped[0], '1/5/45');
  // Frame validation is the policy's, whatever the scheme.
  assert.deepEqual(
    selectTiles(gridFrame(1, null), gridScheme, { minLevel: 0, maxLevel: 2, maxCells: 10 }),
    [],
  );
  assert.throws(
    () => selectTiles(gridFrame(-1, bbox), gridScheme, { minLevel: 0, maxLevel: 2, maxCells: 10 }),
    RangeError,
  );
});

test('the selection policy holds no Web Mercator branch', () => {
  // A crude tripwire: the policy source must not mention the projection.
  const source = selectTiles.toString();
  for (const needle of ['ercator', '85.05', 'asinh', 'tan(', 'unwrap']) {
    assert.equal(source.includes(needle), false, `policy references ${needle}`);
  }
});

// One resolution definition (CSS pixels) and one detail input. The default
// detail log2(dpr) reproduces the device-pixel selection the golden records;
// detail 0 is the map zoom in CSS pixels that data conventions are written in.
test('worldPerCssPixel, webMercatorZoom and its inverse agree with the selection', () => {
  const bbox = { west: 11.4, south: 47.95, east: 11.8, north: 48.25 };
  const at = (range, dpr, height = 700 * dpr) => ({
    camera: { lon: 11.6, lat: 48.1, range, heading: 0, pitch: -1, roll: 0 },
    viewBBox: bbox,
    fovYRad: Math.PI / 4,
    viewportPx: { width: 1000 * dpr, height, dpr },
  });
  // CSS resolution does not depend on dpr; the sampled resolution does.
  assert.equal(worldPerCssPixel(at(0.001, 2)), worldPerCssPixel(at(0.001, 1)));
  assert.equal(webMercatorZoom(at(0.001, 2), { detail: 0 }), webMercatorZoom(at(0.001, 1)));
  assert.ok(Math.abs(webMercatorZoom(at(0.001, 2)) - webMercatorZoom(at(0.001, 1)) - 1) < 1e-12);
  // A 512-pixel zoom without the frustum factor 2 is the 256-tile CSS zoom.
  const frame = at(0.001, 2);
  const alternative = Math.log2(
    (2 * Math.PI * 700) / (512 * frame.camera.range * Math.tan(frame.fovYRad / 2)),
  );
  assert.ok(Math.abs(webMercatorZoom(frame, { tileSize: 256, detail: 0 }) - alternative) < 1e-12);
  // The selection rounds the default zoom (budget large enough not to coarsen).
  for (const dpr of [1, 2]) {
    for (const range of [0.02, 0.004, 0.001, 0.0003]) {
      const z = selectWebMercatorTiles(at(range, dpr), { maxTiles: 100000 })[0].z;
      assert.equal(z, Math.round(webMercatorZoom(at(range, dpr))), `dpr ${dpr} range ${range}`);
      assert.equal(
        selectWebMercatorTiles(at(range, dpr), { maxTiles: 100000, detail: 0 })[0].z,
        Math.round(webMercatorZoom(at(range, dpr), { detail: 0 })),
      );
    }
  }
  // Inverse: the range for a zoom sits exactly at that zoom, under the same options.
  for (const options of [{}, { detail: 0 }, { tileSize: 512 }]) {
    const range = webMercatorRangeForZoom(at(1, 2), 14, options);
    assert.ok(
      Math.abs(webMercatorZoom(at(range, 2), options) - 14) < 1e-12,
      JSON.stringify(options),
    );
  }
  assert.equal(
    selectWebMercatorTiles(at(webMercatorRangeForZoom(at(1, 2), 14), 2), { maxTiles: 100000 })[0].z,
    14,
  );
  assert.throws(() => webMercatorZoom(at(0.001, 1), { detail: NaN }), RangeError);
  assert.throws(() => webMercatorRangeForZoom(at(0.001, 1), Infinity), RangeError);
});

// One validator for every package that names XYZ tiles.
test('assertWebMercatorTile rejects what no XYZ source can serve', () => {
  assert.doesNotThrow(() => assertWebMercatorTile(0, 0, 0));
  assert.doesNotThrow(() => assertWebMercatorTile(30, 2 ** 30 - 1, 0));
  assert.doesNotThrow(() => assertWebMercatorTile(5, 31, 31, 5));
  for (const [z, x, y] of [
    [1.5, 0, 0],
    [1, NaN, 0],
    [1, 0, '0'],
  ]) {
    assert.throws(() => assertWebMercatorTile(z, x, y), TypeError);
  }
  assert.throws(() => assertWebMercatorTile(-1, 0, 0), /zoom must be 0\.\.30/);
  assert.throws(() => assertWebMercatorTile(31, 0, 0), RangeError);
  assert.throws(() => assertWebMercatorTile(6, 0, 0, 5), /zoom must be 0\.\.5/);
  assert.throws(() => assertWebMercatorTile(2, 4, 0), /outside zoom 2: 4\/0/);
  assert.throws(() => assertWebMercatorTile(2, 0, -1), RangeError);
});
