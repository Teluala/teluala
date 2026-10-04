/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import * as teluala from '../dist/index.js';
import { GlobeEngine } from '../dist/index.js';
import { changeDetector } from '../dist/engine.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('package metadata points only to public Teluala properties', () => {
  assert.equal(packageJson.name, 'teluala');
  assert.equal(packageJson.version, '0.1.0-beta.2');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.author, undefined);
  assert.equal(packageJson.homepage, 'https://teluala.github.io/');
  assert.equal(packageJson.publishConfig.tag, 'beta');
  assert.match(packageJson.repository.url, /github\.com\/teluala\/teluala/);
});

test('package exports only the core entry point', () => {
  assert.equal(packageJson.exports['.'].import, './dist/index.js');
  assert.deepEqual(Object.keys(packageJson.exports), ['.']);
});

test('core exposes a format-independent ground-surface injection point', async () => {
  assert.equal(typeof GlobeEngine.prototype.setGroundSurface, 'function');
  const declarations = await readFile(new URL('../dist/ground.d.ts', import.meta.url), 'utf8');
  assert.match(declarations, /interface GroundSurface/);
  assert.match(declarations, /heightAt\(lon: number, lat: number\): number/);
  assert.match(declarations, /subscribe\?\(listener: \(\) => void\): \(\) => void/);
  assert.match(declarations, /interface TiledGroundSurface extends GroundSurface/);
  assert.match(declarations, /readonly data: Float32Array/);
  assert.doesNotMatch(declarations, /raster|DEM|encoding|Worker|https?:/i);
  const runtime = await readFile(new URL('../dist/ground.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /class |function |fetch\(|Worker/);
});

test('core package fetches no data and starts no workers', async () => {
  const engine = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /fetch\(|new Worker/);
});

test('ground-surface injection subscribes without taking provider ownership', () => {
  const engine = Object.create(GlobeEngine.prototype);
  let invalidations = 0;
  let terrainNotifications = 0;
  let unsubscribed = 0;
  let listener = null;
  Object.assign(engine, {
    groundSurface: null,
    detachGroundSurface: null,
    destroyed: false,
    cameraMoved: changeDetector(),
    invalidate() {
      invalidations++;
    },
    scheduleTerrainChanged() {
      terrainNotifications++;
    },
  });
  const surface = {
    heightAt: () => 123,
    subscribe(value) {
      listener = value;
      return () => {
        unsubscribed++;
      };
    },
  };

  assert.equal(engine.cameraMoved('cached'), true);
  engine.setGroundSurface(surface);
  assert.equal(engine.hasGroundSurface, true);
  assert.equal(engine.terrainHeightMeters(0, 0), 123);
  // The unchanged camera reads as moved again: the freeze interval restarts.
  assert.equal(engine.cameraMoved('cached'), true);
  listener();
  assert.equal(invalidations, 2);
  assert.equal(terrainNotifications, 2);

  engine.setGroundSurface(null);
  assert.equal(unsubscribed, 1);
  assert.equal(engine.hasGroundSurface, false);
  assert.equal(engine.terrainHeightMeters(0, 0), 0);
  assert.equal(typeof surface.destroy, 'undefined');
  assert.throws(() => engine.setGroundSurface({}), /heightAt/);
});

test('ground-surface collision applies the same terrain exaggeration as rendering', () => {
  const engine = Object.create(GlobeEngine.prototype);
  const heightMetres = 1000;
  Object.assign(engine, {
    camera: {
      lon: 11.575,
      lat: 48.137,
      range: 3e-5,
      heading: 0,
      pitch: -Math.PI / 2 + 0.001,
      roll: 0,
    },
    groundSurface: { heightAt: () => heightMetres },
    exaggeration: 4,
    cameraLimits: GlobeEngine.resolveCameraLimits(),
    camTargetAlt: 0,
    cameraMoved: changeDetector(),
    camAltQuietAt: 0,
    needsRender: false,
  });

  engine.updateCamTargetAlt(0);
  const expectedWorldHeight = (heightMetres * 4) / 6378137;
  assert.ok(Math.abs(engine.camTargetAlt - expectedWorldHeight) < 1e-12);
  assert.equal(engine.terrainHeightMeters(engine.camera.lon, engine.camera.lat), heightMetres);
});

test('README distinguishes the core picking pass from layer-specific selection', () => {
  assert.match(readme, /core owns one shared GPU picking pass/);
  assert.match(
    readme,
    /Format-specific feature tables and selection logic remain in their layer\s+packages/,
  );
});

test('README keeps optional packages out of the core installation examples', () => {
  assert.match(readme, /The core examples do not need\s+them/);
  assert.match(readme, /^npm install teluala@beta$/m);
  assert.doesNotMatch(readme, /npm install[^\n]*@teluala\//);
  assert.doesNotMatch(readme, /from '@teluala\//);
});

test('FrameState carries the double-precision view-projection alongside the Float32 one', async () => {
  const declarations = await readFile(new URL('../dist/layer.d.ts', import.meta.url), 'utf8');
  assert.match(
    declarations,
    /vp64\?: Float64Array;/,
    'FrameState.vp64 is declared (optional, additive to layer-spec v1)',
  );
  assert.match(declarations, /pickVp64\?: Float64Array;/, 'FrameState.pickVp64 is declared');
  const engine = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
  assert.match(
    engine,
    /vp64: new Float64Array\(vp\)/,
    'the engine fills vp64 from its double-precision matrix',
  );
  assert.match(engine, /pickVp64/, 'the engine fills pickVp64 for the pick pass');
});

test('entry point exports the WGS84 geodesy helpers used by layers', () => {
  for (const name of ['ecef', 'geodeticNormal', 'rayEllipsoid']) {
    assert.equal(typeof teluala[name], 'function', name);
  }
  assert.equal(teluala.WGS84_A, 1);
  assert.ok(Math.abs(teluala.WGS84_E2 - 0.0066943799901413165) < 1e-15);
  assert.equal(teluala.D2R, Math.PI / 180);
  // View-matrix construction is not part of the public surface.
  assert.equal(teluala.lookAt, undefined);
  assert.equal(teluala.perspectiveZ01, undefined);
  assert.equal(teluala.mul4, undefined);
  const p = teluala.ecef(0, 0, 0);
  assert.ok(Math.abs(p[0] - 1) < 1e-12 && Math.abs(p[1]) < 1e-12 && Math.abs(p[2]) < 1e-12);
});

// One declaration of the stratum unit for every backend that shares the
// engine's depth buffer.
test('entry point owns the stratum depth-bias unit and its conversion', () => {
  assert.equal(teluala.DEPTH_BIAS_PER_STRATUM, 8);
  assert.equal(teluala.depthBiasForStratum(), 0);
  assert.equal(teluala.depthBiasForStratum(0), 0);
  assert.equal(teluala.depthBiasForStratum(3), -3 * teluala.DEPTH_BIAS_PER_STRATUM);
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => teluala.depthBiasForStratum(bad), RangeError);
  }
  assert.equal(teluala.DEPTH_BIAS_SLOPE_PER_STRATUM, 1);
  assert.equal(teluala.depthBiasSlopeScaleForStratum(), 0);
  assert.equal(teluala.depthBiasSlopeScaleForStratum(2), -2 * teluala.DEPTH_BIAS_SLOPE_PER_STRATUM);
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => teluala.depthBiasSlopeScaleForStratum(bad), RangeError);
  }
});

test('uploadBuffer creates, writes and destroys on a failed write', () => {
  const calls = [];
  const device = {
    createBuffer: ({ size, usage }) => ({ size, usage, destroy: () => calls.push('destroy') }),
    queue: {
      writeBuffer: (buffer, offset, source, byteOffset, byteLength) =>
        calls.push(['write', buffer.size, offset, byteOffset, byteLength]),
    },
  };
  const data = new Float32Array([1, 2, 3]);
  const buffer = teluala.uploadBuffer(device, data, 32);
  assert.deepEqual([buffer.size, buffer.usage], [12, 32]);
  assert.deepEqual(calls, [['write', 12, 0, 0, 12]]);
  calls.length = 0;
  const empty = teluala.uploadBuffer(device, new Uint8Array(0), 32);
  assert.equal(empty.size, 4, 'an empty array still gets a valid 4-byte buffer');
  assert.deepEqual(calls, [], 'nothing to write');
  device.queue.writeBuffer = () => {
    throw new Error('boom');
  };
  assert.throws(() => teluala.uploadBuffer(device, data, 32), /boom/);
  assert.deepEqual(calls, ['destroy']);
});
