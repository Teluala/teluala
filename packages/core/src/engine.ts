/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import {
  type Mat4,
  type Vec3,
  ecef,
  geodeticNormal,
  rayEllipsoid,
  rayEllipsoidNearest,
} from './math3d.js';
import { createRenderPass } from './pass.js';
import {
  cameraViewProj,
  cameraEye,
  FOV,
  regionScreenPixels,
  cameraRay,
  cameraRayCaster,
  DEFAULT_NEAR_POLICY,
} from './cameraMath.js';
import {
  LAYER_SPEC,
  WORLD_PER_METER,
  type FrameState,
  type GlobeLayer,
  type GlobePickResult,
  type GlobeRenderPass,
  type LayerContext,
} from './layer.js';
import { pickViewProjection } from './pick.js';
import type { GroundSurface } from './ground.js';
export type GlobeEngineOptions = {
  initial?: Partial<GlobeCameraState>;
  background?: {
    r: number;
    g: number;
    b: number;
  };
  earthColor?: [number, number, number];
  noControls?: boolean;
  /**
   * Per-engine camera limits (defaults = `CAMERA_LIMITS`). Apps that want a
   * street-level viewpoint lower `rangeMin` (orbit distance, world units =
   * Earth radii), raise `pitchMax` towards 0 (horizontal), give
   * `eyeAltitudeMin` (world units above the ground under the look-at point, as a
   * floor independent of pitch) and shrink the near plane (`nearScale`,
   * `nearMin`: near = max(range * nearScale, nearMin), world units).
   */
  cameraLimits?: Partial<GlobeCameraLimits>;
};
export type GlobeCameraLimits = {
  rangeMin: number;
  rangeMax: number;
  pitchMin: number;
  pitchMax: number;
  eyeAltitudeMin: number;
  nearScale: number;
  nearMin: number;
  /** Optional close-range near regime (see `NearPolicy` in cameraMath): scale below `closeRange`, log-interpolated up to `farRange`. */
  closeNearScale?: number;
  closeRange?: number;
  farRange?: number;
};
export type GlobeCameraState = {
  lon: number;
  lat: number;
  range: number;
  heading: number;
  pitch: number;
  roll: number;
};
export type GlobeStats = {
  fps: number;
  drawsPerSec: number;
  drawCalls: number;
  setPipelines: number;
};
const SAMPLES = 4;
const PITCH_MIN = -Math.PI / 2 + 0.001,
  PITCH_MAX = -0.08;
const RANGE_MIN = 3e-5,
  RANGE_MAX = 5;
export const CAMERA_LIMITS = {
  rangeMin: RANGE_MIN,
  rangeMax: RANGE_MAX,
  pitchMin: PITCH_MIN,
  pitchMax: PITCH_MAX,
  // Eye floor above the ground under the look-at point (world units); the
  // pitch-dependent floor sin(-pitch) * rangeMin always applies as well.
  eyeAltitudeMin: 0,
  ...DEFAULT_NEAR_POLICY,
} as const satisfies GlobeCameraLimits;
const EARTH_ALT = -4e-4;
const WGS84_A_M = 1 / WORLD_PER_METER;
/** Change detection over a list of values: true when they differ from the
 * previous call. `reset()` makes the next call report a change, which is how
 * an input the values do not cover (terrain height, exaggeration) is signalled. */
interface ChangeDetector {
  (...values: readonly (string | number)[]): boolean;
  reset(): void;
}
export function changeDetector(): ChangeDetector {
  let previous = '';
  const detect = ((...values: readonly (string | number)[]): boolean => {
    const signature = values.join('|');
    if (signature === previous) return false;
    previous = signature;
    return true;
  }) as ChangeDetector;
  detect.reset = () => {
    previous = '';
  };
  return detect;
}
function lonDelta(lon: number, ref: number): number {
  const d = ((lon % 360) - (ref % 360)) % 360;
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
}
const EARTH_WGSL = `
struct U { vp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct P { color: vec4<f32> };
@group(1) @binding(0) var<uniform> p: P;
struct O { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32> };
@vertex fn vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>) -> O {
  var o: O; o.pos = u.vp * vec4<f32>(pos, 1.0); o.n = nrm; return o;
}
@fragment fn fs(@location(0) n: vec3<f32>) -> @location(0) vec4<f32> {
  let L = normalize(vec3<f32>(0.5, 0.3, 0.8));
  let s = 0.35 + 0.65 * max(dot(normalize(n), L), 0.0);
  return vec4<f32>(p.color.rgb * s, 1.0);
}`;
const EARTH_PICK_WGSL = `
struct U { vp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.vp * vec4<f32>(pos, 1.0);
}
@fragment fn fs() -> @location(0) u32 { return 0u; }
`;
export class GlobeEngine {
  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }
  readonly camera: GlobeCameraState;
  onStats: ((s: GlobeStats) => void) | null = null;
  onPick: ((p: { lon: number; lat: number; x: number; y: number }) => void) | null = null;
  private canvas: HTMLCanvasElement;
  private device: GPUDevice;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private depthTex: GPUTexture | null = null;
  private msaaTex: GPUTexture | null = null;
  private dpr = 1;
  private earthPipe: GPURenderPipeline;
  private earthPickPipe: GPURenderPipeline;
  private vpU: GPUBuffer;
  private earthColorU: GPUBuffer;
  private earthBind0: GPUBindGroup;
  private earthBind1: GPUBindGroup;
  private earthPickBind0: GPUBindGroup;
  private earthVB: GPUBuffer;
  private earthIB: GPUBuffer;
  private earthIndexCount: number;
  private pickColorTex: GPUTexture;
  private pickDepthTex: GPUTexture;
  private pickReadback: GPUBuffer;
  private pickVpU: GPUBuffer;
  private pickTail: Promise<void> = Promise.resolve();
  private groundSurface: GroundSurface | null = null;
  private detachGroundSurface: (() => void) | null = null;
  // The pending terrain-changed notification; null = none scheduled.
  private terrainChangedTimer: ReturnType<typeof setTimeout> | null = null;
  onTerrainTilesChanged: (() => void) | null = null;
  private exaggeration = 1;
  private background: {
    r: number;
    g: number;
    b: number;
  };
  private layers: GlobeLayer[] = [];
  private frameNumber = 0;
  private needsRender = true;
  private rafId = 0;
  private flyRaf = 0;
  private destroyed = false;
  private detachControls: (() => void) | null = null;
  private resizeObs: ResizeObserver | null = null;
  private drawTimes: number[] = [];
  private lastFrameAt = 0;
  /** Effective camera limits of this engine (`CAMERA_LIMITS` overlaid with `options.cameraLimits`). */
  readonly cameraLimits: GlobeCameraLimits;
  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, opts: GlobeEngineOptions) {
    this.canvas = canvas;
    this.device = device;
    this.cameraLimits = GlobeEngine.resolveCameraLimits(opts.cameraLimits);
    this.background = opts.background ?? { r: 0.93, g: 0.94, b: 0.95 };
    this.camera = {
      lon: 0,
      lat: 20,
      range: 2.4,
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    };
    for (const key of ['lon', 'lat', 'range', 'heading', 'pitch', 'roll'] as const) {
      const value = opts.initial?.[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || (key === 'range' && value <= 0)) {
        throw new RangeError(
          `Initial camera ${key} must be finite${key === 'range' ? ' and positive' : ''}.`,
        );
      }
      this.camera[key] = value;
    }
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Unable to acquire a WebGPU canvas context.');
    this.ctx = ctx;
    this.format = navigator.gpu!.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    device.lost.then((info) => {
      if (info.reason !== 'destroyed') console.error('[teluala] GPU device lost:', info.message);
    });
    device.addEventListener?.('uncapturederror', (e: Event) =>
      console.error('[teluala]', (e as GPUUncapturedErrorEvent).error),
    );
    const LATN = 64,
      LONN = 128;
    const ev: number[] = [],
      ei: number[] = [];
    for (let i = 0; i <= LATN; i++) {
      const lat = (i / LATN) * 180 - 90;
      for (let j = 0; j <= LONN; j++) {
        const lon = (j / LONN) * 360;
        const p = ecef(lon, lat, EARTH_ALT),
          n = geodeticNormal(lon, lat);
        ev.push(p[0], p[1], p[2], n[0], n[1], n[2]);
      }
    }
    for (let i = 0; i < LATN; i++) {
      for (let j = 0; j < LONN; j++) {
        const a = i * (LONN + 1) + j,
          b = a + LONN + 1;
        ei.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    this.earthVB = this.makeBuffer(new Float32Array(ev), GPUBufferUsage.VERTEX);
    this.earthIB = this.makeBuffer(new Uint32Array(ei), GPUBufferUsage.INDEX);
    this.earthIndexCount = ei.length;
    const depth: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };
    const earthMod = device.createShaderModule({ code: EARTH_WGSL });
    this.earthPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: earthMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: earthMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: depth,
      multisample: { count: SAMPLES },
    });
    const earthPickMod = device.createShaderModule({ code: EARTH_PICK_WGSL });
    this.earthPickPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: earthPickMod,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: earthPickMod, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });
    this.vpU = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pickVpU = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.earthColorU = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const ec = opts.earthColor ?? [0.145, 0.196, 0.376];
    device.queue.writeBuffer(this.earthColorU, 0, new Float32Array([ec[0], ec[1], ec[2], 1]));
    this.earthBind0 = device.createBindGroup({
      layout: this.earthPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.vpU } }],
    });
    this.earthBind1 = device.createBindGroup({
      layout: this.earthPipe.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.earthColorU } }],
    });
    this.earthPickBind0 = device.createBindGroup({
      layout: this.earthPickPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.pickVpU } }],
    });
    this.pickColorTex = device.createTexture({
      size: [1, 1],
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.pickDepthTex = device.createTexture({
      size: [1, 1],
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.pickReadback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.resizeObs = new ResizeObserver(() => {
      this.resize();
      this.invalidate();
    });
    this.resizeObs.observe(canvas);
    this.resize();
    if (!opts.noControls) this.detachControls = this.attachControls();
    const loop = () => {
      if (this.destroyed) return;
      const now = performance.now();
      while (this.drawTimes.length && this.drawTimes[0] < now - 1000) this.drawTimes.shift();
      if (this.needsRender) {
        this.needsRender = false;
        this.draw(now);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }
  static resolveCameraLimits(override?: Partial<GlobeCameraLimits>): GlobeCameraLimits {
    const l: GlobeCameraLimits = { ...CAMERA_LIMITS };
    for (const key of Object.keys(l) as Array<keyof GlobeCameraLimits>) {
      const v = override?.[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`[teluala] cameraLimits.${key} must be a finite number`);
      }
      l[key] = v;
    }
    if (!(l.rangeMin > 0) || !(l.rangeMax >= l.rangeMin)) {
      throw new Error('[teluala] cameraLimits: need 0 < rangeMin <= rangeMax');
    }
    if (
      !(l.pitchMin >= -Math.PI / 2) ||
      !(l.pitchMax >= l.pitchMin) ||
      !(l.pitchMax <= Math.PI / 2)
    ) {
      throw new Error('[teluala] cameraLimits: need -π/2 <= pitchMin <= pitchMax <= π/2');
    }
    if (!(l.eyeAltitudeMin >= 0) || !(l.nearScale > 0) || !(l.nearMin > 0)) {
      throw new Error(
        '[teluala] cameraLimits: need eyeAltitudeMin >= 0, nearScale > 0, nearMin > 0',
      );
    }
    // Optional close-range regime: not in CAMERA_LIMITS, so copy it explicitly.
    for (const key of ['closeNearScale', 'closeRange', 'farRange'] as const) {
      const v = override?.[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`[teluala] cameraLimits.${key} must be a finite number`);
      }
      l[key] = v;
    }
    if (l.closeNearScale !== undefined || l.closeRange !== undefined || l.farRange !== undefined) {
      const closeNearScale = l.closeNearScale ?? 0,
        closeRange = l.closeRange ?? 0,
        farRange = l.farRange ?? closeRange * 10;
      if (!(closeNearScale > 0) || !(closeRange > 0) || !(farRange >= closeRange)) {
        throw new Error(
          '[teluala] cameraLimits: closeNearScale > 0, closeRange > 0 and farRange >= closeRange are required together',
        );
      }
      l.farRange = farRange;
    }
    return l;
  }
  static async create(
    canvas: HTMLCanvasElement,
    opts: GlobeEngineOptions = {},
  ): Promise<GlobeEngine> {
    if (!GlobeEngine.supported()) throw new Error('WebGPU is not available in this environment.');
    const adapter = await navigator.gpu!.requestAdapter();
    if (!adapter) throw new Error('Unable to acquire a WebGPU adapter.');
    const device = await adapter.requestDevice();
    try {
      return new GlobeEngine(canvas, device, opts);
    } catch (error) {
      try {
        device.destroy();
      } catch {
        /* Preserve the initialization error. */
      }
      throw error;
    }
  }
  invalidate(): void {
    this.needsRender = true;
  }
  attachLayer(layer: GlobeLayer): void {
    if (this.destroyed) throw new Error('GlobeEngine is destroyed.');
    if (layer.layerSpec !== LAYER_SPEC) {
      throw new Error(
        `[teluala] Layer spec mismatch: engine=${LAYER_SPEC} layer(${layer.name})=${layer.layerSpec}`,
      );
    }
    if (this.layers.some((l) => l.name === layer.name)) {
      throw new Error(`[teluala] Duplicate layer name: ${layer.name}`);
    }
    const ctx: LayerContext = {
      device: this.device,
      colorFormat: this.format,
      depthFormat: 'depth24plus-stencil8',
      samples: SAMPLES,
      invalidate: () => this.invalidate(),
    };
    layer.init(ctx);
    let i = this.layers.length;
    while (i > 0 && this.layers[i - 1].sortKey > layer.sortKey) i--;
    this.layers.splice(i, 0, layer);
    this.invalidate();
  }
  detachLayer(name: string): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i < 0) return;
    const [layer] = this.layers.splice(i, 1);
    try {
      layer.destroy();
    } finally {
      this.invalidate();
    }
  }
  flyTo(target: Partial<GlobeCameraState>, durationMs = 700): void {
    if (this.destroyed) throw new Error('GlobeEngine is destroyed.');
    for (const key of ['lon', 'lat', 'range', 'heading', 'pitch', 'roll'] as const) {
      if (target[key] !== undefined && !Number.isFinite(target[key])) {
        throw new TypeError(`flyTo.${key} must be finite`);
      }
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError('flyTo duration must be finite and non-negative');
    }
    this.cancelFly();
    const c = this.camera;
    const from = {
      lon: c.lon,
      lat: c.lat,
      range: c.range,
      heading: c.heading,
      pitch: c.pitch,
      roll: c.roll,
    };
    const L = this.cameraLimits;
    const toRange = Math.max(L.rangeMin, Math.min(L.rangeMax, target.range ?? from.range));
    const toLat = Math.max(-85, Math.min(85, target.lat ?? from.lat));
    const toHeading = target.heading ?? from.heading;
    const toPitch = Math.max(L.pitchMin, Math.min(L.pitchMax, target.pitch ?? from.pitch));
    const toRoll = target.roll ?? from.roll;
    const dLon = lonDelta(target.lon ?? from.lon, from.lon);
    let dHead = ((toHeading % (2 * Math.PI)) - (from.heading % (2 * Math.PI))) % (2 * Math.PI);
    if (dHead > Math.PI) dHead -= 2 * Math.PI;
    else if (dHead < -Math.PI) dHead += 2 * Math.PI;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / Math.max(1, durationMs));
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      c.lon = from.lon + dLon * e;
      c.lat = from.lat + (toLat - from.lat) * e;
      c.range = from.range * Math.pow(toRange / from.range, e);
      c.heading = from.heading + dHead * e;
      c.pitch = from.pitch + (toPitch - from.pitch) * e;
      c.roll = from.roll + (toRoll - from.roll) * e;
      this.invalidate();
      this.flyRaf = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.flyRaf = requestAnimationFrame(step);
  }
  cancelFly(): void {
    if (this.flyRaf) {
      cancelAnimationFrame(this.flyRaf);
      this.flyRaf = 0;
    }
  }
  setStyle(s: { exaggeration?: number }): void {
    const exagChanged = s.exaggeration !== undefined && s.exaggeration !== this.exaggeration;
    if (s.exaggeration !== undefined) this.exaggeration = s.exaggeration;
    if (exagChanged) this.terrainInputChanged();
    else this.invalidate();
  }
  altitudeToWorld(altitudeMeters: number): number {
    return (altitudeMeters * this.exaggeration) / WGS84_A_M;
  }
  private readonly viewChanged = changeDetector();
  private viewBBoxCache: {
    west: number;
    south: number;
    east: number;
    north: number;
  } | null = null;
  viewBBox(): {
    west: number;
    south: number;
    east: number;
    north: number;
  } | null {
    const c = this.camera;
    // Tile-oriented consumers do not need a new 7x7 ray sample for sub-pixel
    // camera changes, so independent tile layers do not pay this cost every frame.
    if (
      this.viewChanged(
        c.lon.toFixed(3),
        c.lat.toFixed(3),
        c.range.toExponential(2),
        c.heading.toFixed(2),
        c.pitch.toFixed(2),
        c.roll.toFixed(2),
        this.canvas.width,
        this.canvas.height,
        this.camTargetAlt.toExponential(2),
      )
    ) {
      this.viewBBoxCache = this.boundsAt(c, this.camTargetAlt);
    }
    return this.viewBBoxCache;
  }
  /** Ground bounds for any camera and look-at altitude. Reads no cached frame
   * state and writes none, so previewFrame() can use it for a camera the
   * engine is not at. */
  private boundsAt(
    camera: GlobeCameraState,
    targetAltitudeWorld: number,
  ): { west: number; south: number; east: number; north: number } | null {
    const cast = cameraRayCaster(camera, this.aspect(), targetAltitudeWorld);
    let dLonMin = 0,
      dLonMax = 0,
      latMin = camera.lat,
      latMax = camera.lat,
      any = false;
    const GRID = 6;
    for (let gi = 0; gi <= GRID; gi++) {
      const nx = -1 + (2 * gi) / GRID;
      for (let gj = 0; gj <= GRID; gj++) {
        const ray = cast(nx, -1 + (2 * gj) / GRID);
        // A ray past the globe bounds the view at the horizon in its
        // direction, so the bounds move continuously as rays cross the limb.
        const hit = rayEllipsoidNearest(ray.origin, ray.dir);
        const p = { lon: hit[0], lat: hit[1] };
        any = true;
        const d = lonDelta(p.lon, camera.lon);
        if (d < dLonMin) dLonMin = d;
        if (d > dLonMax) dLonMax = d;
        if (p.lat < latMin) latMin = p.lat;
        if (p.lat > latMax) latMax = p.lat;
      }
    }
    const wrap180 = (lon: number): number => (((lon % 360) + 540) % 360) - 180;
    return !any
      ? null
      : {
          west: wrap180(camera.lon + Math.max(-80, dLonMin)),
          east: wrap180(camera.lon + Math.min(80, dLonMax)),
          south: Math.max(-85, Math.max(camera.lat - 80, latMin)),
          north: Math.min(85, Math.min(camera.lat + 80, latMax)),
        };
  }
  /** Build the FrameState of a camera the engine is not at.
   *
   * Nothing is moved, drawn or cached: the live camera, the frame counter and
   * the view-bbox cache are untouched, so a consumer can judge what a target
   * view would cover (which tiles, which bounds) before deciding to fly there.
   * Unspecified fields keep their current value, and the target is clamped the
   * way flyTo() clamps it. frameNumber repeats the last drawn frame, because
   * this call draws nothing.
   */
  previewFrame(
    target: Partial<GlobeCameraState>,
    targetAltitudeWorld: number = this.camTargetAlt,
  ): FrameState {
    if (this.destroyed) throw new Error('GlobeEngine is destroyed.');
    for (const key of ['lon', 'lat', 'range', 'heading', 'pitch', 'roll'] as const) {
      if (target[key] !== undefined && !Number.isFinite(target[key])) {
        throw new TypeError(`previewFrame.${key} must be finite`);
      }
    }
    if (!Number.isFinite(targetAltitudeWorld)) {
      throw new TypeError('previewFrame targetAltitudeWorld must be finite');
    }
    const c = this.camera;
    const L = this.cameraLimits;
    const camera: GlobeCameraState = {
      lon: target.lon ?? c.lon,
      lat: Math.max(-85, Math.min(85, target.lat ?? c.lat)),
      range: Math.max(L.rangeMin, Math.min(L.rangeMax, target.range ?? c.range)),
      heading: target.heading ?? c.heading,
      pitch: Math.max(L.pitchMin, Math.min(L.pitchMax, target.pitch ?? c.pitch)),
      roll: target.roll ?? c.roll,
    };
    const vp = cameraViewProj(camera, this.aspect(), targetAltitudeWorld, L);
    return {
      vp: new Float32Array(vp),
      vp64: new Float64Array(vp),
      camera,
      cameraPosWorld: cameraEye(camera, targetAltitudeWorld),
      viewBBox: this.boundsAt(camera, targetAltitudeWorld),
      fovYRad: FOV,
      viewportPx: { width: this.canvas.width, height: this.canvas.height, dpr: this.dpr },
      frameNumber: this.frameNumber,
    };
  }
  projectBBoxPixels(west: number, south: number, east: number, north: number): number | null {
    return regionScreenPixels(
      this.viewProj(),
      this.canvas.width,
      this.canvas.height,
      this.dpr,
      west,
      south,
      east,
      north,
    );
  }
  projectToScreen(
    lon: number,
    lat: number,
    altMeters = 0,
  ): {
    x: number;
    y: number;
  } | null {
    const vp = this.viewProj();
    const p = ecef(lon, lat, this.altitudeToWorld(altMeters));
    const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw <= 1e-6) return null;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((cx / cw) * 0.5 + 0.5) * rect.width + rect.left,
      y: (0.5 - (cy / cw) * 0.5) * rect.height + rect.top,
    };
  }
  pickGround(
    clientX: number,
    clientY: number,
  ): {
    lon: number;
    lat: number;
  } | null {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    return this.pickNdc(nx, ny);
  }
  pickRay(
    clientX: number,
    clientY: number,
  ): {
    origin: Vec3;
    dir: Vec3;
  } | null {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    return cameraRay(this.camera, this.aspect(), nx, ny, this.camTargetAlt);
  }
  /** Pick the nearest selectable layer feature at a client-coordinate point. */
  pick(clientX: number, clientY: number): Promise<GlobePickResult | null> {
    const result = this.pickTail.then(
      () => this.performPick(clientX, clientY),
      () => this.performPick(clientX, clientY),
    );
    this.pickTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async performPick(clientX: number, clientY: number): Promise<GlobePickResult | null> {
    if (this.destroyed) throw new Error('GlobeEngine is destroyed.');
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      throw new TypeError('pick coordinates must be finite');
    }
    const rect = this.canvas.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX >= rect.right ||
      clientY < rect.top ||
      clientY >= rect.bottom
    ) {
      return null;
    }
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const vp = this.viewProj();
    const pickVp = pickViewProjection(
      new Float32Array(vp),
      nx,
      ny,
      this.canvas.width,
      this.canvas.height,
    );
    const frame = this.buildFrameState(vp);
    frame.pickVp = pickVp;
    frame.pickVp64 = pickViewProjection(
      new Float64Array(vp),
      nx,
      ny,
      this.canvas.width,
      this.canvas.height,
    );
    this.device.queue.writeBuffer(this.pickVpU, 0, new Float32Array(pickVp));
    const encoder = this.device.createCommandEncoder();
    const gpuPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.pickColorTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.pickDepthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });
    const pass: GlobeRenderPass = createRenderPass(gpuPass, { drawCalls: 0, setPipelines: 0 });
    pass.setPipeline(this.earthPickPipe);
    pass.setBindGroup(0, this.earthPickBind0);
    pass.setVertexBuffer(0, this.earthVB);
    pass.setIndexBuffer(this.earthIB, 'uint32');
    pass.drawIndexed(this.earthIndexCount);
    const ray = this.pickRay(clientX, clientY);
    const ranges: Array<{ start: number; end: number; layer: GlobeLayer }> = [];
    let idBase = 1;
    try {
      for (const layer of this.layers) {
        if (!layer.pickDraw || !layer.pickResolve) continue;
        if (ray && layer.rayBounds && !layer.rayBounds(ray.origin, ray.dir)) continue;
        const count = layer.pickDraw(pass, frame, idBase);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new RangeError(`Layer ${layer.name} returned an invalid pick ID count.`);
        }
        if (count > 0xffffffff - idBase + 1) {
          throw new RangeError('Picking pass exhausted the uint32 ID range.');
        }
        ranges.push({ start: idBase, end: idBase + count, layer });
        idBase += count;
      }
    } finally {
      gpuPass.end();
    }
    encoder.copyTextureToBuffer(
      { texture: this.pickColorTex },
      { buffer: this.pickReadback, bytesPerRow: 256 },
      [1, 1],
    );
    this.device.queue.submit([encoder.finish()]);
    await this.pickReadback.mapAsync(GPUMapMode.READ);
    let pickedId: number;
    try {
      pickedId = new Uint32Array(this.pickReadback.getMappedRange(), 0, 1)[0];
    } finally {
      this.pickReadback.unmap();
    }
    if (pickedId === 0) return null;
    const range = ranges.find(({ start, end }) => pickedId >= start && pickedId < end);
    return range
      ? { layer: range.layer.name, result: range.layer.pickResolve!(pickedId - range.start) }
      : null;
  }
  private pickNdc(
    nx: number,
    ny: number,
  ): {
    lon: number;
    lat: number;
  } | null {
    const ray = cameraRay(this.camera, this.aspect(), nx, ny, this.camTargetAlt);
    const hit = rayEllipsoid(ray.origin, ray.dir);
    return hit ? { lon: hit[0], lat: hit[1] } : null;
  }
  get hasGroundSurface(): boolean {
    return this.groundSurface !== null;
  }
  setGroundSurface(surface: GroundSurface | null): void {
    if (this.destroyed) throw new Error('GlobeEngine is destroyed.');
    if (surface === this.groundSurface) return;
    if (surface !== null && typeof surface.heightAt !== 'function') {
      throw new TypeError('GroundSurface.heightAt is required.');
    }
    let detach: (() => void) | null = null;
    if (surface?.subscribe) {
      if (typeof surface.subscribe !== 'function') {
        throw new TypeError('GroundSurface.subscribe must be a function.');
      }
      detach = surface.subscribe(() => {
        if (this.destroyed || this.groundSurface !== surface) return;
        this.terrainInputChanged();
        this.scheduleTerrainChanged();
      });
      if (typeof detach !== 'function') {
        throw new TypeError('GroundSurface.subscribe must return an unsubscribe function.');
      }
    }
    try {
      this.detachGroundSurface?.();
    } catch (error) {
      // The replacement is not installed yet. Release its subscription before
      // returning the old provider's error to the application.
      try {
        detach?.();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Ground surface replacement cleanup failed.',
        );
      }
      throw error;
    }
    this.detachGroundSurface = detach;
    this.groundSurface = surface;
    this.terrainInputChanged();
    this.scheduleTerrainChanged();
  }
  terrainHeightMeters(lon: number, lat: number): number {
    const h = this.groundSurface ? this.groundSurface.heightAt(lon, lat) : NaN;
    return Number.isFinite(h) ? h : 0;
  }
  private scheduleTerrainChanged(): void {
    if (this.terrainChangedTimer !== null || !this.onTerrainTilesChanged) return;
    this.terrainChangedTimer = setTimeout(() => {
      this.terrainChangedTimer = null;
      if (!this.destroyed) this.onTerrainTilesChanged?.();
    }, 250);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const errors: unknown[] = [];
    const cleanup = (action: () => void) => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };
    cleanup(() => cancelAnimationFrame(this.rafId));
    cleanup(() => this.cancelFly());
    if (this.terrainChangedTimer !== null) clearTimeout(this.terrainChangedTimer);
    this.terrainChangedTimer = null;
    this.onTerrainTilesChanged = null;
    this.onPick = null;
    this.onStats = null;
    cleanup(() => this.detachGroundSurface?.());
    this.detachGroundSurface = null;
    this.groundSurface = null;
    cleanup(() => this.detachControls?.());
    cleanup(() => this.resizeObs?.disconnect());
    const layers = this.layers;
    this.layers = [];
    for (const layer of layers) cleanup(() => layer.destroy());
    for (const resource of [
      this.depthTex,
      this.msaaTex,
      this.pickColorTex,
      this.pickDepthTex,
      this.pickReadback,
      this.pickVpU,
      this.vpU,
      this.earthColorU,
      this.earthVB,
      this.earthIB,
    ]) {
      cleanup(() => resource?.destroy());
    }
    cleanup(() => this.ctx?.unconfigure());
    cleanup(() => this.device.destroy());
    if (errors.length) throw new AggregateError(errors, 'GlobeEngine cleanup failed.');
  }
  private makeBuffer(
    data: Float32Array | Uint16Array | Uint32Array,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer {
    const size = Math.ceil(data.byteLength / 4) * 4;
    const b = this.device.createBuffer({ size, usage, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    b.unmap();
    return b;
  }
  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const lim = this.device.limits.maxTextureDimension2D;
    const w = Math.min(lim, Math.max(1, Math.round(this.canvas.clientWidth * this.dpr)));
    const h = Math.min(lim, Math.max(1, Math.round(this.canvas.clientHeight * this.dpr)));
    if (this.canvas.width === w && this.canvas.height === h && this.depthTex) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.depthTex?.destroy();
    this.msaaTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus-stencil8',
      sampleCount: SAMPLES,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaaTex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: SAMPLES,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  private camTargetAlt = 0;
  private readonly cameraMoved = changeDetector();
  private camAltQuietAt = 0;
  private static readonly CAM_FREEZE_MS = 250;
  private static readonly ALT_BLEND = 0.1;
  private static readonly ALT_EPS = 1.6e-8;
  private updateCamTargetAlt(now: number): void {
    const c = this.camera;
    const hNow = this.altitudeToWorld(this.terrainHeightMeters(c.lon, c.lat));
    if (this.cameraMoved(c.lon, c.lat, c.range, c.heading, c.pitch, c.roll)) {
      this.camAltQuietAt = now + GlobeEngine.CAM_FREEZE_MS;
    }
    // A newly supplied height must keep the on-demand loop alive until
    // the quiet interval elapses, even if the camera is stationary.
    if (now < this.camAltQuietAt && Math.abs(hNow - this.camTargetAlt) > GlobeEngine.ALT_EPS) {
      this.needsRender = true;
    }
    if (now >= this.camAltQuietAt) {
      const diff = hNow - this.camTargetAlt;
      if (Math.abs(diff) > GlobeEngine.ALT_EPS) {
        this.camTargetAlt += diff * GlobeEngine.ALT_BLEND;
        this.needsRender = true;
      } else {
        this.camTargetAlt = hNow;
      }
    }
    // Keep the eye at least max(sin(-pitch) * rangeMin, eyeAltitudeMin)
    // above the ground under the look-at point by lifting the look-at point.
    const L = this.cameraLimits;
    const sp = -Math.sin(c.pitch);
    const eyeFloor = Math.max(sp * L.rangeMin, L.eyeAltitudeMin);
    const deficit = hNow + eyeFloor - (this.camTargetAlt + sp * c.range);
    if (deficit > 0) this.camTargetAlt += deficit;
  }
  /** The ground height under the camera may differ now even though the camera
   * did not move: restart the freeze interval so the look-at altitude re-settles. */
  private terrainInputChanged(): void {
    this.cameraMoved.reset();
    this.invalidate();
  }
  private aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }
  private viewProj(): Mat4 {
    return cameraViewProj(this.camera, this.aspect(), this.camTargetAlt, this.cameraLimits);
  }
  private buildFrameState(vp: Mat4): FrameState {
    const c = this.camera;
    return {
      vp: new Float32Array(vp),
      vp64: new Float64Array(vp),
      camera: {
        lon: c.lon,
        lat: c.lat,
        range: c.range,
        heading: c.heading,
        pitch: c.pitch,
        roll: c.roll,
      },
      cameraPosWorld: cameraEye(c, this.camTargetAlt),
      viewBBox: this.viewBBox(),
      fovYRad: FOV,
      viewportPx: { width: this.canvas.width, height: this.canvas.height, dpr: this.dpr },
      frameNumber: ++this.frameNumber,
    };
  }
  private draw(now: number): void {
    this.updateCamTargetAlt(now);
    const vp = this.viewProj();
    let frame: FrameState | null = null;
    let layersWantFrame = false;
    if (this.layers.length) {
      frame = this.buildFrameState(vp);
      for (const l of this.layers) if (l.update?.(frame)) layersWantFrame = true;
    }
    this.device.queue.writeBuffer(this.vpU, 0, new Float32Array(vp));
    const enc = this.device.createCommandEncoder();
    const gpuPass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaaTex!.createView(),
          resolveTarget: this.ctx.getCurrentTexture().createView(),
          clearValue: { ...this.background, a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex!.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });
    const counters = { drawCalls: 0, setPipelines: 0 };
    const pass = createRenderPass(gpuPass, counters);
    pass.setPipeline(this.earthPipe);
    pass.setBindGroup(0, this.earthBind0);
    pass.setBindGroup(1, this.earthBind1);
    pass.setVertexBuffer(0, this.earthVB);
    pass.setIndexBuffer(this.earthIB, 'uint32');
    pass.drawIndexed(this.earthIndexCount);
    if (frame) for (const l of this.layers) l.draw(pass, frame);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    if (layersWantFrame) this.needsRender = true;
    this.drawTimes.push(now);
    const dt = now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.onStats?.({
      fps: dt > 0 ? 1000 / dt : 0,
      drawsPerSec: this.drawTimes.length,
      drawCalls: counters.drawCalls,
      setPipelines: counters.setPipelines,
    });
  }
  private attachControls(): () => void {
    const cv = this.canvas;
    let drag: {
      x: number;
      y: number;
      sx: number;
      sy: number;
      rot: boolean;
      g: {
        lon: number;
        lat: number;
      } | null;
    } | null = null;
    const CLICK_SLOP = 6;
    const onDown = (e: PointerEvent) => {
      this.cancelFly();
      const rot = e.button === 2 || e.shiftKey || e.ctrlKey;
      drag = {
        x: e.clientX,
        y: e.clientY,
        sx: e.clientX,
        sy: e.clientY,
        rot,
        g: rot ? null : this.pickGround(e.clientX, e.clientY),
      };
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const c = this.camera;
      if (drag.rot) {
        const rect = cv.getBoundingClientRect();
        c.heading += ((e.clientX - drag.x) / rect.width) * Math.PI;
        c.pitch = Math.max(
          this.cameraLimits.pitchMin,
          Math.min(
            this.cameraLimits.pitchMax,
            c.pitch + ((e.clientY - drag.y) / rect.height) * (Math.PI / 2),
          ),
        );
      } else if (drag.g) {
        const p = this.pickGround(e.clientX, e.clientY);
        if (p) {
          let dLon = p.lon - drag.g.lon;
          if (dLon > 180) dLon -= 360;
          else if (dLon < -180) dLon += 360;
          c.lon -= Math.max(-30, Math.min(30, dLon));
          c.lat = Math.max(
            -85,
            Math.min(85, c.lat - Math.max(-30, Math.min(30, p.lat - drag.g.lat))),
          );
        }
      }
      drag = { ...drag, x: e.clientX, y: e.clientY };
      this.invalidate();
    };
    const onUp = (e: PointerEvent) => {
      const d = drag;
      drag = null;
      if (!d || d.rot || !this.onPick) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > CLICK_SLOP) return;
      const p = this.pickGround(e.clientX, e.clientY);
      if (p) this.onPick({ lon: p.lon, lat: p.lat, x: e.clientX, y: e.clientY });
    };
    const onCancel = () => {
      drag = null;
    };
    const onCtx = (e: Event) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cancelFly();
      const c = this.camera;
      const before = this.pickGround(e.clientX, e.clientY);
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      c.range = Math.max(
        this.cameraLimits.rangeMin,
        Math.min(this.cameraLimits.rangeMax, c.range * Math.exp(d * 0.0012)),
      );
      if (before) {
        const after = this.pickGround(e.clientX, e.clientY);
        if (after) {
          let dLon = after.lon - before.lon;
          if (dLon > 180) dLon -= 360;
          else if (dLon < -180) dLon += 360;
          c.lon -= Math.max(-30, Math.min(30, dLon));
          c.lat = Math.max(
            -85,
            Math.min(85, c.lat - Math.max(-30, Math.min(30, after.lat - before.lat))),
          );
        }
      }
      this.invalidate();
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('lostpointercapture', onCancel);
    cv.addEventListener('contextmenu', onCtx);
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onCancel);
      cv.removeEventListener('lostpointercapture', onCancel);
      cv.removeEventListener('contextmenu', onCtx);
      cv.removeEventListener('wheel', onWheel);
    };
  }
}
