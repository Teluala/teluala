/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobeEngine, usePlugins } from '../dist/index.js';
import { changeDetector } from '../dist/engine.js';

test('failed ground replacement releases the new subscription and keeps the old selection', () => {
  const engine = Object.create(GlobeEngine.prototype);
  const oldSurface = { heightAt: () => 1 };
  const failure = new Error('old subscription cleanup failed');
  let active = 0;
  let invalidations = 0;
  let listener;
  const nextSurface = {
    heightAt: () => 2,
    subscribe(callback) {
      active++;
      listener = callback;
      return () => {
        active--;
      };
    },
  };
  const oldDetach = () => {
    throw failure;
  };
  Object.assign(engine, {
    destroyed: false,
    groundSurface: oldSurface,
    detachGroundSurface: oldDetach,
    invalidate() {
      invalidations++;
    },
    scheduleTerrainChanged() {
      throw new Error('A failed replacement must not notify.');
    },
  });
  assert.throws(
    () => engine.setGroundSurface(nextSurface),
    (error) => error === failure,
  );
  assert.equal(active, 0);
  assert.equal(engine.groundSurface, oldSurface);
  assert.equal(engine.detachGroundSurface, oldDetach);
  listener();
  assert.equal(invalidations, 0);
  assert.equal(engine.terrainHeightMeters(0, 0), 1);
  assert.throws(
    () => engine.setGroundSurface(null),
    (error) => error === failure,
  );
  assert.equal(engine.groundSurface, oldSurface);
});

test('ground replacement reports both provider and rollback errors', () => {
  const engine = Object.create(GlobeEngine.prototype);
  const oldFailure = new Error('old cleanup');
  const newFailure = new Error('new cleanup');
  Object.assign(engine, {
    destroyed: false,
    groundSurface: { heightAt: () => 1 },
    detachGroundSurface() {
      throw oldFailure;
    },
  });
  const nextSurface = {
    heightAt: () => 2,
    subscribe() {
      return () => {
        throw newFailure;
      };
    },
  };
  assert.throws(
    () => engine.setGroundSurface(nextSurface),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [oldFailure, newFailure]);
      return true;
    },
  );
});

function globals(values) {
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  for (const [k, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [k, descriptor] of Object.entries(saved)) {
      descriptor ? Object.defineProperty(globalThis, k, descriptor) : delete globalThis[k];
    }
  };
}

test('failed engine initialization releases the acquired device', async () => {
  let destroyed = 0;
  const restore = globals({
    navigator: {
      gpu: {
        async requestAdapter() {
          return {
            async requestDevice() {
              return {
                destroy() {
                  destroyed++;
                },
              };
            },
          };
        },
      },
    },
  });
  try {
    await assert.rejects(GlobeEngine.create({ getContext: () => null }), /context/);
    assert.equal(destroyed, 1);
  } finally {
    restore();
  }
});

test('destroy completes cleanup despite extension failures and is idempotent', () => {
  const calls = [];
  const restore = globals({ cancelAnimationFrame: () => {} });
  const engine = Object.create(GlobeEngine.prototype);
  const resource = (name) => ({
    destroy() {
      calls.push(name);
    },
  });
  Object.assign(engine, {
    destroyed: false,
    layers: [
      {
        destroy() {
          calls.push('bad-layer');
          throw new Error('layer');
        },
      },
      {
        destroy() {
          calls.push('good-layer');
        },
      },
    ],
    detachGroundSurface() {
      calls.push('unsubscribe');
      throw new Error('surface');
    },
    detachControls() {
      calls.push('controls');
    },
    resizeObs: {
      disconnect() {
        calls.push('resize');
      },
    },
    device: resource('device'),
    earthVB: resource('vertices'),
    ctx: {
      unconfigure() {
        calls.push('context');
      },
    },
    terrainChangedTimer: null,
  });
  try {
    assert.throws(
      () => engine.destroy(),
      (error) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.deepEqual(calls, [
      'unsubscribe',
      'controls',
      'resize',
      'bad-layer',
      'good-layer',
      'vertices',
      'context',
      'device',
    ]);
    engine.destroy();
    assert.equal(calls.length, 8);
    assert.throws(() => engine.attachLayer({}), /destroyed/);
    assert.throws(() => engine.setGroundSurface(null), /destroyed/);
    assert.throws(() => engine.flyTo({}), /destroyed/);
  } finally {
    restore();
  }
});

test('scheduled terrain notification does not fire after destruction', () => {
  let callback,
    notifications = 0;
  const restore = globals({
    setTimeout: (fn) => {
      callback = fn;
      return 1;
    },
    clearTimeout: () => {},
    cancelAnimationFrame: () => {},
  });
  const engine = Object.create(GlobeEngine.prototype);
  Object.assign(engine, {
    destroyed: false,
    layers: [],
    device: { destroy() {} },
    terrainChangedTimer: null,
    onTerrainTilesChanged() {
      notifications++;
    },
  });
  try {
    engine.scheduleTerrainChanged();
    engine.destroy();
    callback();
    assert.equal(notifications, 0);
  } finally {
    restore();
  }
});

test('detaching a failing layer removes it and invalidates the scene', () => {
  let invalidated = 0;
  const engine = Object.create(GlobeEngine.prototype);
  Object.assign(engine, {
    layers: [
      {
        name: 'bad',
        destroy() {
          throw new Error('cleanup');
        },
      },
    ],
    invalidate() {
      invalidated++;
    },
  });
  assert.throws(() => engine.detachLayer('bad'), /cleanup/);
  assert.equal(engine.layers.length, 0);
  assert.equal(invalidated, 1);
  engine.detachLayer('bad');
});

test('flyTo rejects non-finite input and uses the shortest wrapped path', () => {
  let callback,
    now = 0;
  const restore = globals({
    requestAnimationFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelAnimationFrame: () => {},
    performance: { now: () => now },
  });
  const engine = Object.create(GlobeEngine.prototype);
  Object.assign(engine, {
    camera: { lon: 0, lat: 0, range: 1, heading: 0, pitch: -1, roll: 0 },
    cameraLimits: GlobeEngine.resolveCameraLimits(),
    invalidate() {},
  });
  try {
    assert.throws(() => engine.flyTo({ heading: Infinity }), /finite/);
    assert.throws(() => engine.flyTo({ lon: NaN }), /finite/);
    assert.throws(() => engine.flyTo({}, Infinity), /duration/);
    engine.flyTo({ lon: 1081, heading: 4 * Math.PI + 0.5 }, 100);
    now = 100;
    callback();
    assert.equal(engine.camera.lon, 1);
    assert.equal(engine.camera.heading, 0.5);
  } finally {
    restore();
  }
});

test('plugin failures are caught and cleanup is performed once', async () => {
  const calls = [],
    warnings = [];
  const restore = globals({ console: { ...console, warn: (...args) => warnings.push(args) } });
  let finish;
  try {
    const handle = usePlugins({ engine: {}, canvas: {}, ui: {} }, [
      {
        name: 'sync',
        setup() {
          throw new Error('sync');
        },
        dispose() {
          calls.push('sync');
        },
      },
      {
        name: 'async',
        async setup() {
          throw new Error('async');
        },
        dispose() {
          calls.push('async');
        },
      },
      {
        name: 'pending',
        setup() {
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        dispose() {
          calls.push('pending');
        },
      },
      {
        name: 'ready',
        setup() {},
        dispose() {
          calls.push('ready');
        },
      },
    ]);
    handle.dispose();
    handle.dispose();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual([...calls].sort(), ['async', 'pending', 'ready', 'sync']);
    assert.equal(warnings.length, 2);
  } finally {
    restore();
  }
});

test('cancelled pointer capture ends camera dragging and removes listeners', () => {
  const listeners = new Map();
  const engine = Object.create(GlobeEngine.prototype);
  const canvas = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    setPointerCapture() {},
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  };
  Object.assign(engine, {
    canvas,
    camera: { heading: 0, pitch: -1 },
    cancelFly() {},
    invalidate() {},
    cameraLimits: GlobeEngine.resolveCameraLimits(),
  });
  const detach = engine.attachControls();
  listeners.get('pointerdown')({ button: 2, clientX: 0, clientY: 0, pointerId: 1 });
  listeners.get('pointercancel')();
  listeners.get('pointermove')({ clientX: 20, clientY: 20 });
  assert.equal(engine.camera.heading, 0);
  listeners.get('pointerdown')({ button: 2, clientX: 0, clientY: 0, pointerId: 1 });
  listeners.get('lostpointercapture')();
  listeners.get('pointermove')({ clientX: 20, clientY: 20 });
  assert.equal(engine.camera.heading, 0);
  detach();
  assert.equal(listeners.size, 0);
});

test('a stationary ground-height change continues rendering through the quiet interval', () => {
  const engine = Object.create(GlobeEngine.prototype);
  Object.assign(engine, {
    camera: { lon: 0, lat: 0, range: 1, heading: 0, pitch: -1, roll: 0 },
    cameraLimits: GlobeEngine.resolveCameraLimits(),
    groundSurface: { heightAt: () => 1000 },
    exaggeration: 1,
    camTargetAlt: 0,
    cameraMoved: changeDetector(),
    camAltQuietAt: 0,
    needsRender: false,
  });
  engine.updateCamTargetAlt(0);
  assert.equal(engine.needsRender, true);
  engine.needsRender = false;
  engine.updateCamTargetAlt(300);
  assert.ok(engine.camTargetAlt > 0);
  assert.equal(engine.needsRender, true);
});

test('initial camera rejects invalid values before configuring the canvas', async () => {
  let destroyed = 0,
    contexts = 0;
  const restore = globals({
    navigator: {
      gpu: {
        async requestAdapter() {
          return {
            async requestDevice() {
              return {
                destroy() {
                  destroyed++;
                },
              };
            },
          };
        },
      },
    },
  });
  const canvas = {
    getContext() {
      contexts++;
      return null;
    },
  };
  try {
    for (const initial of [{ lon: NaN }, { heading: Infinity }, { range: 0 }, { range: -1 }]) {
      await assert.rejects(GlobeEngine.create(canvas, { initial }), /Initial camera/);
    }
    assert.equal(contexts, 0);
    assert.equal(destroyed, 4);
    await assert.rejects(GlobeEngine.create(canvas, { initial: { range: undefined } }), /context/);
    assert.equal(contexts, 1);
    assert.equal(destroyed, 5);
  } finally {
    restore();
  }
});
