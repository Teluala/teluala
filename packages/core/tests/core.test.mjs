/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ecef, rayEllipsoid } from '../dist/math3d.js';
import { pickViewProjection } from '../dist/pick.js';
import { nearFar } from '../dist/cameraMath.js';
import { CAMERA_LIMITS, GlobeEngine, changeDetector } from '../dist/engine.js';

test('WGS84 equator maps to the normalized positive x axis', () => {
  const point = ecef(0, 0, 0);
  assert.ok(Math.abs(point[0] - 1) < 1e-12);
  assert.ok(Math.abs(point[1]) < 1e-12);
  assert.ok(Math.abs(point[2]) < 1e-12);
});

test('rayEllipsoid returns the near intersection in lon/lat', () => {
  const hit = rayEllipsoid([2, 0, 0], [-1, 0, 0]);
  assert.ok(hit);
  assert.ok(Math.abs(hit[0]) < 1e-12);
  assert.ok(Math.abs(hit[1]) < 1e-12);
});

test('pickViewProjection moves the selected NDC point to the 1x1 target center', () => {
  const vp = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
  const nx = 0.25;
  const ny = -0.5;
  const pickVp = pickViewProjection(vp, nx, ny, 800, 600);
  const point = [3, 2, 1, 1];
  const apply = (matrix, row) =>
    matrix[row] * point[0] +
    matrix[4 + row] * point[1] +
    matrix[8 + row] * point[2] +
    matrix[12 + row] * point[3];
  const originalW = apply(vp, 3);
  assert.equal(apply(pickVp, 0), 800 * (apply(vp, 0) - nx * originalW));
  assert.equal(apply(pickVp, 1), 600 * (apply(vp, 1) - ny * originalW));
  assert.equal(apply(pickVp, 2), apply(vp, 2));
  assert.equal(apply(pickVp, 3), originalW);
});

test('pickViewProjection validates its public inputs', () => {
  assert.throws(() => pickViewProjection(new Float32Array(15), 0, 0, 1, 1), /16-value/);
  assert.throws(() => pickViewProjection(new Float32Array(16), 0, 0, 0, 1), /positive/);
});

test('pickViewProjection accepts a Float64Array and keeps its precision', () => {
  const vp = new Float64Array(16);
  // Column-major identity with a translation whose value is not representable in Float32.
  vp[0] = 1;
  vp[5] = 1;
  vp[10] = 1;
  vp[15] = 1;
  vp[12] = 0.1 + 1e-9;
  const result = pickViewProjection(vp, 0, 0, 10, 20);
  assert.ok(result instanceof Float64Array, 'a Float64Array input yields a Float64Array');
  assert.equal(result[12], 10 * (0.1 + 1e-9), 'the double-precision translation survives');
  assert.equal(result[0], 10);
  assert.equal(result[5], 20);
});

test('nearFar keeps its default policy (near = max(range/4, 48 m))', () => {
  const metre = 1 / 6378137;
  assert.equal(nearFar(3e-5).near, 7.5e-6);
  assert.ok(Math.abs(nearFar(9e-4).near - 2.25e-4) < 1e-12);
  const street = nearFar(19 * metre, { nearScale: 0.05, nearMin: 1 * metre });
  assert.ok(Math.abs(street.near - 1 * metre) < 1e-15);
  assert.ok(street.far > nearFar(19 * metre).near);
});

test('resolveCameraLimits overlays overrides on CAMERA_LIMITS and validates them', () => {
  assert.deepEqual(GlobeEngine.resolveCameraLimits(), { ...CAMERA_LIMITS });
  const street = GlobeEngine.resolveCameraLimits({
    rangeMin: 3e-6,
    pitchMax: -0.02,
    eyeAltitudeMin: 2.5e-7,
    nearScale: 0.05,
    nearMin: 1.6e-7,
  });
  assert.equal(street.rangeMin, 3e-6);
  assert.equal(street.rangeMax, CAMERA_LIMITS.rangeMax);
  assert.equal(street.pitchMin, CAMERA_LIMITS.pitchMin);
  assert.throws(() => GlobeEngine.resolveCameraLimits({ rangeMin: 0 }), /rangeMin/);
  assert.throws(() => GlobeEngine.resolveCameraLimits({ pitchMax: 2 }), /pitch/);
  assert.throws(() => GlobeEngine.resolveCameraLimits({ nearMin: Number.NaN }), /finite/);
});

// --- NDC → ray without a matrix inverse -----------------------------------
import { cameraRay, cameraViewProj, cameraEye, FOV } from '../dist/cameraMath.js';
import { mul4 } from '../dist/math3d.js';

// Test-local general inverse (Gauss-Jordan) so the reference does not depend on
// any engine helper.
function gaussJordanInverse(m) {
  const a = [];
  for (let r = 0; r < 4; r++) {
    a.push([m[r], m[4 + r], m[8 + r], m[12 + r], ...[0, 1, 2, 3].map((c) => (c === r ? 1 : 0))]);
  }
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let c = 0; c < 8; c++) a[col][c] /= p;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const k = a[r][col];
      for (let c = 0; c < 8; c++) a[r][c] -= k * a[col][c];
    }
  }
  const out = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r][4 + c];
  return out;
}

function unprojectRay(vp, eye, nx, ny, z = 0.9) {
  const inv = gaussJordanInverse(vp);
  const X = inv[0] * nx + inv[4] * ny + inv[8] * z + inv[12];
  const Y = inv[1] * nx + inv[5] * ny + inv[9] * z + inv[13];
  const Z = inv[2] * nx + inv[6] * ny + inv[10] * z + inv[14];
  const W = inv[3] * nx + inv[7] * ny + inv[11] * z + inv[15];
  const d = [X / W - eye[0], Y / W - eye[1], Z / W - eye[2]];
  const l = Math.hypot(...d);
  return d.map((v) => v / l);
}

test('cameraRay matches inverse-view-projection unprojection for every camera regime', () => {
  const aspect = 1.6;
  const cameras = [
    { lon: 11.575, lat: 48.137, range: 3, heading: 0, pitch: -1.2, roll: 0 },
    { lon: 11.575, lat: 48.137, range: 1e-3, heading: 0.3, pitch: -0.9, roll: 0 },
    { lon: 11.575, lat: 48.137, range: 3e-6, heading: 4.7, pitch: -0.02, roll: 0 },
    { lon: -74, lat: 40.7, range: 1e-3, heading: 1.0, pitch: -Math.PI / 2 + 0.01, roll: 0 }, // near-vertical: up-hint switch
    { lon: 13.4, lat: 52.5, range: 1e-3, heading: 2.0, pitch: -0.7, roll: 0.4 }, // roll
  ];
  for (const c of cameras) {
    const vp = cameraViewProj(c, aspect);
    const eye = cameraEye(c);
    for (let nx = -1; nx <= 1; nx += 0.5) {
      for (let ny = -1; ny <= 1; ny += 0.5) {
        const ray = cameraRay(c, aspect, nx, ny);
        const ref = unprojectRay(vp, eye, nx, ny);
        assert.ok(
          Math.hypot(ray.origin[0] - eye[0], ray.origin[1] - eye[1], ray.origin[2] - eye[2]) <
            1e-15,
        );
        const dot = ray.dir[0] * ref[0] + ray.dir[1] * ref[1] + ray.dir[2] * ref[2];
        assert.ok(
          Math.acos(Math.min(1, dot)) < 1e-7,
          `pitch ${c.pitch} roll ${c.roll} ndc ${nx},${ny}: ${Math.acos(Math.min(1, dot))}`,
        );
        assert.ok(Math.abs(Math.hypot(...ray.dir) - 1) < 1e-12);
      }
    }
    // the centre ray points at the look-at target
    const centre = cameraRay(c, aspect, 0, 0);
    const t = ecef(c.lon, c.lat, 0);
    const toT = [t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]];
    const l = Math.hypot(...toT);
    assert.ok(
      Math.acos(
        Math.min(1, (centre.dir[0] * toT[0] + centre.dir[1] * toT[1] + centre.dir[2] * toT[2]) / l),
      ) < 1e-9,
    );
  }
  assert.ok(mul4 && FOV > 0);
});

test('math3d does not export a general 4x4 inverse', async () => {
  const math3d = await import('../dist/math3d.js');
  assert.equal(math3d.invert4, undefined);
});

test('nearFar: close-range near scale applies below closeRange, the base scale above farRange, log-interpolated between', () => {
  const metre = 1 / 6378137;
  const policy = {
    nearScale: 0.25,
    nearMin: 1 * metre,
    closeNearScale: 0.05,
    closeRange: 100 * metre,
    farRange: 1000 * metre,
  };
  assert.ok(
    Math.abs(nearFar(19 * metre, policy).near / metre - 1) < 1e-9,
    '19 m: 0.95 m floors at nearMin 1 m',
  );
  assert.ok(Math.abs(nearFar(60 * metre, policy).near / metre - 3) < 1e-9, '60 m: 0.05 × 60');
  assert.ok(
    Math.abs(nearFar(100 * metre, policy).near / metre - 5) < 1e-9,
    '100 m: still the close scale',
  );
  const mid = nearFar(316.2278 * metre, policy).near / metre; // geometric midpoint of 100..1000 → scale 0.15
  assert.ok(Math.abs(mid - 316.2278 * 0.15) < 1e-3, `316 m: interpolated scale 0.15 → ${mid}`);
  assert.ok(Math.abs(nearFar(1000 * metre, policy).near / metre - 250) < 1e-9, '1 km: base scale');
  assert.ok(
    Math.abs(nearFar(3000 * metre, policy).near / metre - 750) < 1e-9,
    '3 km: base scale (= core default)',
  );
  // without the close fields the policy is unchanged
  assert.ok(
    Math.abs(nearFar(60 * metre, { nearScale: 0.25, nearMin: 1 * metre }).near / metre - 15) < 1e-9,
  );
});

test('cameraLimits accepts and validates the optional close-range near regime', () => {
  const metre = 1 / 6378137;
  const limits = GlobeEngine.resolveCameraLimits({
    nearMin: metre,
    closeNearScale: 0.05,
    closeRange: 100 * metre,
    farRange: 1000 * metre,
  });
  assert.equal(limits.closeNearScale, 0.05);
  assert.equal(limits.nearScale, CAMERA_LIMITS.nearScale);
  assert.equal(GlobeEngine.resolveCameraLimits({}).closeNearScale, undefined);
  assert.throws(() => GlobeEngine.resolveCameraLimits({ closeNearScale: 0.05 }), /closeRange/);
  assert.throws(
    () =>
      GlobeEngine.resolveCameraLimits({
        closeNearScale: 0.05,
        closeRange: 100 * metre,
        farRange: 10 * metre,
      }),
    /farRange/,
  );
});

test('view bounds grow continuously as the camera pulls back past the horizon', () => {
  // Low zoom with the horizon in view (Munich, pitch -66°): the sampled rays
  // near the limb alternately hit and miss the globe as range grows. The
  // bounds must not jump back and forth with them.
  const engine = Object.create(GlobeEngine.prototype);
  Object.assign(engine, {
    canvas: { width: 1280, height: 800 },
    cameraLimits: GlobeEngine.resolveCameraLimits(),
  });
  const spans = [];
  for (let range = 0.7; range <= 2.0; range *= 1.05) {
    const b = engine.boundsAt(
      { lon: 11.575, lat: 48.137, range, heading: 0.25, pitch: -1.15, roll: 0 },
      0,
    );
    spans.push({ range, lon: (((b.east - b.west) % 360) + 360) % 360, lat: b.north - b.south });
  }
  // The horizon point of a ray drifts by a fraction of a degree as the eye
  // rises; anything larger is a sample switching between hit and ignored.
  for (let i = 1; i < spans.length; i++) {
    assert.ok(
      spans[i].lon >= spans[i - 1].lon - 0.5,
      `lon span shrank at range ${spans[i].range.toFixed(3)}: ${spans[i - 1].lon.toFixed(2)} → ${spans[i].lon.toFixed(2)}`,
    );
    assert.ok(
      spans[i].lat >= spans[i - 1].lat - 0.5,
      `lat span shrank at range ${spans[i].range.toFixed(3)}: ${spans[i - 1].lat.toFixed(2)} → ${spans[i].lat.toFixed(2)}`,
    );
  }
});

test('previewFrame builds a frame for a target camera without moving the live one', () => {
  const engine = Object.create(GlobeEngine.prototype);
  const camera = { lon: 10, lat: 20, range: 0.5, heading: 0.1, pitch: -0.9, roll: 0 };
  Object.assign(engine, {
    destroyed: false,
    camera,
    camTargetAlt: 0,
    canvas: { width: 800, height: 400 },
    dpr: 2,
    frameNumber: 7,
    cameraLimits: GlobeEngine.resolveCameraLimits(),
    viewChanged: () => {
      throw new Error('preview must not touch the bbox cache');
    },
    viewBBoxCache: null,
  });

  const preview = engine.previewFrame({ lon: 12, lat: 48 });
  assert.deepEqual(preview.camera, { ...camera, lon: 12, lat: 48 });
  // The live camera, the frame counter and the bbox cache stay as they were.
  assert.deepEqual(engine.camera, camera);
  assert.equal(engine.frameNumber, 7);
  assert.equal(preview.frameNumber, 7);
  assert.equal(engine.viewBBoxCache, null);
  assert.deepEqual(preview.viewportPx, { width: 800, height: 400, dpr: 2 });
  assert.equal(preview.fovYRad, FOV);

  // The matrix and eye are the target's, not the live camera's.
  const expected = cameraViewProj(preview.camera, 2, 0, engine.cameraLimits);
  assert.deepEqual(Array.from(preview.vp64), Array.from(expected));
  assert.deepEqual(Array.from(preview.cameraPosWorld), Array.from(cameraEye(preview.camera, 0)));
  assert.notDeepEqual(
    Array.from(preview.vp64),
    Array.from(cameraViewProj(camera, 2, 0, engine.cameraLimits)),
  );

  // Bounds follow the target, so a consumer can judge tiles before flying.
  const here = engine.previewFrame({});
  assert.deepEqual(here.camera, camera);
  assert.ok(preview.viewBBox && here.viewBBox);
  assert.notEqual(preview.viewBBox.west, here.viewBBox.west);
});

test('previewFrame clamps the target the way flyTo does and rejects non-finite input', () => {
  const engine = Object.create(GlobeEngine.prototype);
  const limits = GlobeEngine.resolveCameraLimits();
  Object.assign(engine, {
    destroyed: false,
    camera: { lon: 0, lat: 0, range: 0.5, heading: 0, pitch: -1, roll: 0 },
    camTargetAlt: 0,
    canvas: { width: 640, height: 480 },
    dpr: 1,
    frameNumber: 0,
    cameraLimits: limits,
    viewChanged: changeDetector(),
    viewBBoxCache: null,
  });

  const clamped = engine.previewFrame({
    lat: 95,
    range: limits.rangeMax * 10,
    pitch: limits.pitchMin - 1,
  });
  assert.equal(clamped.camera.lat, 85);
  assert.equal(clamped.camera.range, limits.rangeMax);
  assert.equal(clamped.camera.pitch, limits.pitchMin);
  assert.equal(engine.previewFrame({ lat: -95 }).camera.lat, -85);

  assert.throws(() => engine.previewFrame({ lon: Number.NaN }), TypeError);
  assert.throws(() => engine.previewFrame({ range: Infinity }), TypeError);
  assert.throws(() => engine.previewFrame({}, Number.NaN), TypeError);

  // A ground-altitude argument shifts the look-at point without touching state.
  const raised = engine.previewFrame({}, 0.01);
  assert.notDeepEqual(Array.from(raised.vp64), Array.from(engine.previewFrame({}).vp64));
  assert.equal(engine.camTargetAlt, 0);

  engine.destroyed = true;
  assert.throws(() => engine.previewFrame({}), /destroyed/);
});
