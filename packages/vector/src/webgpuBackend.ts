/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { screenLineDistances } from './lineLayout.js';
import type { VectorSpriteAtlas } from './sprites.js';
import type { FrameState, GlobeRenderPass, LayerContext } from 'teluala';
import {
  BoundedCache,
  depthBiasForStratum,
  depthBiasSlopeScaleForStratum,
  uploadBuffer,
  viewProjectionAt,
} from 'teluala';

import { LabelBackend } from './labelBackend.js';
import type { VectorLabel } from './types.js';

import type {
  VectorGpuBackend,
  VectorFeaturePickDraw,
  VectorMesh,
  VectorMeshType,
  VectorPickPass,
  VectorRenderEntry,
} from './types.js';
import { prepareWorldMesh, sourceClipBounds } from './worldMesh.js';

// fill / pattern / fill-extrusion share the same body. Only one uniform field
// and the vertex inputs differ, so the shared part lives in one place.
const SHADE_AND_OUTPUT_WGSL = `  // 1 for fill-extrusion: shade faces by orientation (roof / east-west
  // wall / north-south wall) so translucent, unlit blocks still read as
  // shapes. 0 keeps the flat colour (fill).
  shade: f32,
  clipBounds: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct VertexOutput {
  // @invariant: the translucent path draws the same geometry twice (depth
  // prepass, then color with depthCompare 'equal') through two pipelines —
  // their position computations must be bit-identical.
  @builtin(position) @invariant position: vec4<f32>,
  @location(0) localPosition: vec2<f32>,
};
`;

// Fragments outside the source tile's clip bounds are dropped (an unclipped
// native tile draws only its own area) — the same test in every fragment stage.
const CLIP_DISCARD_WGSL = `  if (input.localPosition.x < u.clipBounds.x || input.localPosition.y < u.clipBounds.y
      || input.localPosition.x >= u.clipBounds.z || input.localPosition.y >= u.clipBounds.w) {
    discard;
  }
`;

const FRAGMENT_WGSL = `@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
${CLIP_DISCARD_WGSL}  if (u.shade > 0.5) {
    // Face orientation from screen-space derivatives of the TILE-LOCAL
    // position (0..extent; Float32 world positions are quantised at the
    // 0.4 m level and their derivatives are noise that shows as speckle).
    // A roof varies in two screen directions (non-zero Jacobian); a wall's
    // local position only varies along the wall, so the larger derivative
    // is the wall's tangent and its perpendicular the wall normal (sign
    // unknown, hence |dot|). Tile x runs east and tile y south, so the
    // light (east 0.45, north 0.25) keeps east-west and north-south walls
    // at two distinct tones; roofs stay brightest.
    let dx = dpdx(input.localPosition);
    let dy = dpdy(input.localPosition);
    let area = abs(dx.x * dy.y - dx.y * dy.x);
    let extent = length(dx) * length(dy) + 1e-6;
    var lit = 1.0;
    if (area < 0.1 * extent) {
      let tangent = select(dy, dx, dot(dx, dx) >= dot(dy, dy));
      let normal2 = normalize(vec2<f32>(-tangent.y, tangent.x));
      let light2 = normalize(vec2<f32>(0.45, -0.25));
      lit = 0.55 + 0.4 * abs(dot(normal2, light2));
    }
    return vec4<f32>(u.color.rgb * lit, u.color.a);
  }
  return u.color;
}`;

const SURFACE_WGSL = `
struct Uniforms {
  vp: mat4x4<f32>,
  color: vec4<f32>,
  viewport: vec2<f32>,
  halfWidth: f32,
${SHADE_AND_OUTPUT_WGSL}@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) localPosition: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = u.vp * vec4<f32>(position, 1.0);
  output.localPosition = localPosition;
  return output;
}
${FRAGMENT_WGSL}
`;

const PATTERN_WGSL = SURFACE_WGSL.replace(
  'clipBounds: vec4<f32>,',
  'clipBounds: vec4<f32>, pattern: vec4<f32>,',
)
  .replace(
    'struct VertexOutput',
    '@group(0) @binding(1) var patternTex: texture_2d<f32>;\n@group(0) @binding(2) var patternSampler: sampler;\nstruct VertexOutput',
  )
  .replace(
    '  return u.color;',
    `  let ink = textureSample(patternTex, patternSampler, input.localPosition / u.pattern.x);
  let alpha = ink.a + u.color.a * (1.0 - ink.a);
  return vec4<f32>((ink.rgb * ink.a + u.color.rgb * u.color.a * (1.0 - ink.a)) / max(alpha, 0.000001), alpha);`,
  );

const EXTRUSION_WGSL = `
struct Uniforms {
  vp: mat4x4<f32>,
  color: vec4<f32>,
  viewport: vec2<f32>,
  // fill-extrusion: heights ride as an up-vector attribute scaled here
  // (0..1) per frame — grow-in animation without re-uploading the mesh.
  heightScale: f32,
${SHADE_AND_OUTPUT_WGSL}@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) heightExtrude: vec3<f32>,
  @location(2) localPosition: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = u.vp * vec4<f32>(position + heightExtrude * u.heightScale, 1.0);
  output.localPosition = localPosition;
  return output;
}
${FRAGMENT_WGSL}
`;

const LINE_WGSL = `
struct Uniforms {
  vp: mat4x4<f32>,
  color: vec4<f32>,
  viewport: vec2<f32>,
  halfWidth: f32,
  padding: f32,
  clipBounds: vec4<f32>,
  dash: array<vec4<f32>, 2>,
  dashInfo: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec2<f32>,
  @location(2) @interpolate(linear) distance: f32,
};
@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) worldExtrude: vec3<f32>,
  @location(2) localPosition: vec2<f32>,
  @location(3) distance: f32,
) -> VertexOutput {
  let clip = u.vp * vec4<f32>(position, 1.0);
  let tangentClip = u.vp * vec4<f32>(position + worldExtrude * 0.000001, 1.0);
  let screen = clip.xy / clip.w;
  let tangentScreen = tangentClip.xy / tangentClip.w;
  let delta = tangentScreen - screen;
  var direction = vec2<f32>(0.0);
  if (length(delta) > 0.0000001) { direction = normalize(delta); }
  let pixelOffset = direction * u.halfWidth * 2.0 / u.viewport;
  var output: VertexOutput;
  output.position = vec4<f32>(clip.xy + pixelOffset * clip.w, clip.z, clip.w);
  output.localPosition = localPosition;
  output.distance = distance;
  return output;
}
@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
${CLIP_DISCARD_WGSL}  if (u.dashInfo.x > 0.0) {
    var phase = input.distance % u.dashInfo.x;
    for (var i=0u; i<u32(u.dashInfo.y); i++) {
      let segment=u.dash[i/4u][i%4u];
      if (phase < segment) { if (i%2u==1u) { discard; } break; }
      phase -= segment;
    }
  }
  return u.color;
}
`;

// The pick pass shares the render pass's vertex inputs and writes the
// feature's pick id instead of a colour: uniform tail, vertex output and
// fragment stage are the same for surfaces and extrusions.
const PICK_TAIL_WGSL = `  clipBounds: vec4<f32>,
  idBase: u32,
  padding2: vec3<u32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec2<f32>,
  @location(1) @interpolate(flat) pickId: u32,
};
`;
const PICK_FRAGMENT_WGSL = `@fragment fn fs(input: VertexOutput) -> @location(0) u32 {
${CLIP_DISCARD_WGSL}  return input.pickId;
}
`;

const PICK_SURFACE_WGSL = `
struct Uniforms {
  vp: mat4x4<f32>,
  pickVp: mat4x4<f32>,
  viewport: vec2<f32>,
  halfWidth: f32,
  padding: f32,
${PICK_TAIL_WGSL}@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) localPosition: vec2<f32>,
  @location(2) localId: u32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = u.pickVp * vec4<f32>(position, 1.0);
  output.localPosition = localPosition;
  output.pickId = u.idBase + localId;
  return output;
}
${PICK_FRAGMENT_WGSL}`;

const PICK_EXTRUSION_WGSL = `
struct Uniforms {
  vp: mat4x4<f32>,
  pickVp: mat4x4<f32>,
  viewport: vec2<f32>,
  heightScale: f32,
  padding: f32,
${PICK_TAIL_WGSL}@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) heightExtrude: vec3<f32>,
  @location(2) localPosition: vec2<f32>,
  @location(3) localId: u32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = u.pickVp * vec4<f32>(position + heightExtrude * u.heightScale, 1.0);
  output.localPosition = localPosition;
  output.pickId = u.idBase + localId;
  return output;
}
${PICK_FRAGMENT_WGSL}`;

const PICK_LINE_WGSL = `
struct Uniforms {
  vp: mat4x4<f32>,
  pickVp: mat4x4<f32>,
  viewport: vec2<f32>,
  halfWidth: f32,
  padding: f32,
  clipBounds: vec4<f32>,
  idBase: u32,
  padding2: vec3<u32>,
  dash: array<vec4<f32>, 2>,
  dashInfo: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec2<f32>,
  @location(1) @interpolate(flat) pickId: u32,
  @location(2) @interpolate(linear) distance: f32,
};
@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) worldExtrude: vec3<f32>,
  @location(2) localPosition: vec2<f32>,
  @location(3) localId: u32,
  @location(4) distance: f32,
) -> VertexOutput {
  let clip = u.vp * vec4<f32>(position, 1.0);
  let tangentClip = u.vp * vec4<f32>(position + worldExtrude * 0.000001, 1.0);
  let delta = tangentClip.xy / tangentClip.w - clip.xy / clip.w;
  var direction = vec2<f32>(0.0);
  if (length(delta) > 0.0000001) { direction = normalize(delta); }
  var picked = u.pickVp * vec4<f32>(position, 1.0);
  picked = vec4<f32>(picked.xy + direction * u.halfWidth * 2.0 * picked.w, picked.z, picked.w);
  var output: VertexOutput;
  output.position = picked;
  output.localPosition = localPosition;
  output.distance = distance;
  output.pickId = u.idBase + localId;
  return output;
}
@fragment fn fs(input: VertexOutput) -> @location(0) u32 {
${CLIP_DISCARD_WGSL}  if (u.dashInfo.x > 0.0) {
    var phase = input.distance % u.dashInfo.x;
    for (var i=0u; i<u32(u.dashInfo.y); i++) {
      let segment=u.dash[i/4u][i%4u];
      if (phase < segment) { if (i%2u==1u) { discard; } break; }
      phase -= segment;
    }
  }
  return input.pickId;
}
`;

const UNIFORM_BYTES = 160;
// Per-frame uniform staging, reused across entries (the draw loop allocates nothing).
const uniformStaging = new Float32Array(UNIFORM_BYTES / 4);
// idBase (u32, offset 160) is followed by padding2: vec3<u32>, whose 16-byte
// alignment places it at offset 176 and rounds the WGSL struct size up to 192.
const PICK_UNIFORM_BYTES = 240;
const pickUniformStaging = new ArrayBuffer(PICK_UNIFORM_BYTES);
const pickUniformFloats = new Float32Array(pickUniformStaging);
const pickUniformInts = new Uint32Array(pickUniformStaging);

/** The GPU side of one decoded mesh: shared by every batch (style layer)
 * drawn from it, so a mesh styled by N layers is uploaded once. Freed when
 * the last batch using it goes. */
interface GpuGeometry {
  /** Mesh origin (world units, double): positions are Float32 offsets from it. */
  readonly origin: readonly [number, number, number];
  readonly position: GPUBuffer;
  readonly localPosition: GPUBuffer;
  readonly lineExtrude?: GPUBuffer;
  readonly lineDistance?: GPUBuffer;
  readonly meshPositions: Float32Array;
  readonly byteLength: number;
  users: number;
  destroy(): void;
}

interface GpuEntryResource {
  readonly type: VectorMeshType;
  readonly geometry: GpuGeometry;
  readonly indices: GPUBuffer;
  readonly uniform: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly pipeline: GPURenderPipeline;
  readonly prepassPipeline?: GPURenderPipeline;
  readonly prepassBindGroup?: GPUBindGroup;
  readonly opaque: boolean;
  readonly indexCount: number;
  readonly byteLength: number;
  destroy(): void;
}

interface PickGpuEntryResource {
  readonly draw: VectorFeaturePickDraw;
  readonly origin: readonly [number, number, number];
  readonly position: GPUBuffer;
  readonly localPosition: GPUBuffer;
  readonly lineExtrude?: GPUBuffer;
  readonly lineDistance?: GPUBuffer;
  readonly meshPositions: Float32Array;
  readonly localIds: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly uniform: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly pipeline: GPURenderPipeline;
  readonly indexCount: number;
  destroy(): void;
}

export interface WebGpuVectorBackendSnapshot {
  readonly resources: number;
  readonly bytes: number;
  readonly uploaded: number;
  readonly reused: number;
  readonly destroyed: number;
  readonly draws: number;
}

export interface WebGpuVectorBackend extends VectorGpuBackend {
  setSpriteAtlas(atlas: VectorSpriteAtlas | null): void;
  snapshot(): WebGpuVectorBackendSnapshot;
  /** 0..1 multiplier on fill-extrusion heights, applied in the shader per frame (0 skips them). */
  extrusionHeightScale: number;
}

export interface WebGpuVectorBackendOptions {
  readonly surfaceOffsetMeters?: number;
  /** Stacking order among layers on the same datum (integer >= 0, default 0 = base; each step draws nearer). */
  readonly stratum?: number;
  /** Entries kept uploaded after they stop being drawn (least recently drawn
   *  first; default 0 = destroy on the next draw). Set it to about a screenful
   *  of tiles when the tile selection flips tiles in and out while the camera
   *  moves, so those tiles are not re-uploaded. */
  readonly retainResources?: number;
}

type SurfacePassMode = 'opaque' | 'blend' | 'prepass' | 'equal';

function pipelineDescriptor(
  context: LayerContext,
  code: string,
  line: boolean,
  mode: SurfacePassMode,
  depthBias: number,
  depthBiasSlopeScale: number,
): GPURenderPipelineDescriptor {
  const module = context.device.createShaderModule({ code });
  return {
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
        ...(line
          ? [
              {
                arrayStride: 12,
                attributes: [
                  { shaderLocation: 1, offset: 0, format: 'float32x3' as GPUVertexFormat },
                ],
              },
            ]
          : []),
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: line ? 2 : 1, offset: 0, format: 'float32x2' }],
        },
        ...(code === LINE_WGSL
          ? [
              {
                arrayStride: 4,
                attributes: [
                  { shaderLocation: 3, offset: 0, format: 'float32' as GPUVertexFormat },
                ],
              },
            ]
          : []),
      ],
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format: context.colorFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
          // The depth prepass renders the translucent silhouette into the
          // depth buffer only.
          writeMask: mode === 'prepass' ? 0 : GPUColorWrite.ALL,
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: context.depthFormat,
      depthWriteEnabled: mode === 'opaque' || mode === 'prepass',
      // The colour pass of the translucent pair only shades fragments on the
      // prepass-resolved front surface, so each pixel blends exactly once.
      depthCompare: mode === 'equal' ? 'equal' : 'less-equal',
      depthBias,
      depthBiasSlopeScale,
      depthBiasClamp: 0,
    },
    multisample: { count: context.samples },
  };
}

function pickPipelineDescriptor(
  context: LayerContext,
  type: VectorMeshType,
): GPURenderPipelineDescriptor {
  const line = type !== 'fill'; // lines and extrusions both carry a vec3 extrude attribute at location 1
  const module = context.device.createShaderModule({
    code:
      type === 'line'
        ? PICK_LINE_WGSL
        : type === 'fill-extrusion'
          ? PICK_EXTRUSION_WGSL
          : PICK_SURFACE_WGSL,
  });
  return {
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ...(line
          ? [
              {
                arrayStride: 12,
                attributes: [
                  { shaderLocation: 1, offset: 0, format: 'float32x3' as GPUVertexFormat },
                ],
              },
            ]
          : []),
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: line ? 2 : 1, offset: 0, format: 'float32x2' }],
        },
        {
          arrayStride: 4,
          attributes: [{ shaderLocation: line ? 3 : 2, offset: 0, format: 'uint32' }],
        },
        ...(type === 'line'
          ? [
              {
                arrayStride: 4,
                attributes: [
                  { shaderLocation: 4, offset: 0, format: 'float32' as GPUVertexFormat },
                ],
              },
            ]
          : []),
      ],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: context.depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
    },
  };
}

class DefaultWebGpuVectorBackend implements WebGpuVectorBackend {
  #context: LayerContext | null = null;
  #pipelines = new Map<string, GPURenderPipeline>();
  // LRU by last draw (core BoundedCache): a get() in draw() marks the entry as used.
  #resources = new BoundedCache<VectorRenderEntry, GpuEntryResource>({ limit: 0 });
  #geometries = new Map<VectorMesh, GpuGeometry>();
  #pickResources = new Map<VectorRenderEntry, PickGpuEntryResource>();
  #destroyed = false;
  #surfaceOffsetMeters: number;
  #retainResources: number;
  #depthBias: number;
  #depthBiasSlopeScale: number;
  #labels: LabelBackend | null = null;
  #spriteAtlas: VectorSpriteAtlas | null = null;
  #patterns = new Map<string, { texture: GPUTexture; sampler: GPUSampler }>();
  #extrusionHeightScale = 1;
  #metrics = { uploaded: 0, reused: 0, destroyed: 0, draws: 0 };

  /**
   * Per-frame multiplier (0..1) applied to fill-extrusion heights in the
   * vertex shader: heights ride as an up-vector attribute, so animating them
   * (e.g. a grow-in animation) uploads nothing. 0 skips extrusion draws.
   */
  get extrusionHeightScale(): number {
    return this.#extrusionHeightScale;
  }
  set extrusionHeightScale(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('extrusionHeightScale must be within 0..1');
    }
    this.#extrusionHeightScale = value;
  }

  constructor(options: WebGpuVectorBackendOptions) {
    this.#depthBias = depthBiasForStratum(options.stratum);
    this.#depthBiasSlopeScale = depthBiasSlopeScaleForStratum(options.stratum);
    this.#surfaceOffsetMeters = options.surfaceOffsetMeters ?? 1;
    this.#retainResources = options.retainResources ?? 0;
    if (!Number.isInteger(this.#retainResources) || this.#retainResources < 0) {
      throw new RangeError('retainResources must be a non-negative integer');
    }
    if (!Number.isFinite(this.#surfaceOffsetMeters)) {
      throw new TypeError('surfaceOffsetMeters must be finite');
    }
  }

  init(context: LayerContext): void {
    if (this.#destroyed) throw new Error('WebGPU vector backend is destroyed');
    if (this.#context) throw new Error('WebGPU vector backend is already initialized');
    this.#context = context;
  }

  #pipeline(type: VectorMeshType, mode: SurfacePassMode, pattern = false): GPURenderPipeline {
    const context = this.#context;
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    const key = `${type}/${mode}/${pattern}`;
    let value = this.#pipelines.get(key);
    if (value) return value;
    const code =
      type === 'line'
        ? LINE_WGSL
        : type === 'fill-extrusion'
          ? EXTRUSION_WGSL
          : pattern
            ? PATTERN_WGSL
            : SURFACE_WGSL;
    value = context.device.createRenderPipeline(
      // Datum-coplanar draws (fills, lines) take the slope term; extrusion walls have their own slopes.
      pipelineDescriptor(
        context,
        code,
        type !== 'fill',
        mode,
        this.#depthBias,
        type === 'fill-extrusion' ? 0 : this.#depthBiasSlopeScale,
      ),
    );
    this.#pipelines.set(key, value);
    return value;
  }

  #pickPipeline(type: VectorMeshType): GPURenderPipeline {
    const context = this.#context;
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    const key = `pick/${type}`;
    let value = this.#pipelines.get(key);
    if (value) return value;
    value = context.device.createRenderPipeline(pickPipelineDescriptor(context, type));
    this.#pipelines.set(key, value);
    return value;
  }

  // Both are facts of an immutable entry / batch, so they are validated and
  // computed once per object instead of per entry per frame (per frame, at
  // z17.5 with 340 entries, parseSourceTileKey would take 4% and #style 1.2%
  // of the main thread's busy time).
  readonly #styleByBatch = new WeakMap<
    VectorRenderEntry['batch'],
    { color: readonly number[]; width: number; opaque: boolean }
  >();
  readonly #clipBoundsByEntry = new WeakMap<
    VectorRenderEntry,
    readonly [number, number, number, number]
  >();
  #clipBounds(entry: VectorRenderEntry): readonly [number, number, number, number] {
    let bounds = this.#clipBoundsByEntry.get(entry);
    if (!bounds) {
      bounds = sourceClipBounds(entry.sourceTileKey, entry.requestedTileKey, entry.mesh.extent);
      this.#clipBoundsByEntry.set(entry, bounds);
    }
    return bounds;
  }
  #style(entry: VectorRenderEntry) {
    const cached = this.#styleByBatch.get(entry.batch);
    if (cached) return cached;
    const style = this.#validateStyle(entry);
    this.#styleByBatch.set(entry.batch, style);
    return style;
  }
  #validateStyle(entry: VectorRenderEntry) {
    if (entry.batch.styleLayer.type !== entry.mesh.type) {
      throw new TypeError('style layer type must match mesh type');
    }
    const color = entry.batch.styleLayer.paint.color;
    if (
      color.length !== 4 ||
      !color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    ) {
      throw new TypeError('style color must contain four values in the 0..1 range');
    }
    const width = entry.mesh.type === 'line' ? (entry.batch.styleLayer.paint.width ?? 1) : 0;
    if (!Number.isFinite(width) || width < 0) {
      throw new RangeError('line width must be non-negative');
    }
    return { color, width, opaque: color[3] >= 1 };
  }

  // Index checks scan the whole batch, so they run where the batch is read
  // into GPU buffers (once per resource), not per draw: a per-draw scan takes
  // 4.4 ms of a 6.0 ms frame with vector tiles at z10. The resource
  // maps already remember which entries were built, so no extra "validated"
  // state is needed.
  #assertBatchIndices(entry: VectorRenderEntry) {
    if (entry.batch.indices.length % 3 !== 0) {
      throw new RangeError('batch indices must contain triangles');
    }
    const vertexCount = entry.mesh.positions.length / 2;
    if (entry.batch.indices.some((index) => index >= vertexCount)) {
      throw new RangeError('batch index exceeds mesh vertex count');
    }
  }

  #pattern(name: string | undefined): { texture: GPUTexture; sampler: GPUSampler } | null {
    if (!name || !this.#spriteAtlas?.entries[name] || !this.#context) return null;
    const cached = this.#patterns.get(name);
    if (cached) return cached;
    const r = this.#spriteAtlas.entries[name],
      device = this.#context.device;
    const texture = device.createTexture({
      size: [r.width, r.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      device.queue.copyExternalImageToTexture(
        { source: this.#spriteAtlas.image, origin: { x: r.x, y: r.y } },
        { texture },
        [r.width, r.height],
      );
      const sampler = device.createSampler({
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        minFilter: 'linear',
        magFilter: 'linear',
      });
      const value = { texture, sampler };
      this.#patterns.set(name, value);
      return value;
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }

  /** The shared geometry of a mesh, uploading it on first use. */
  #geometry(entry: VectorRenderEntry): GpuGeometry {
    const context = this.#context;
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    const cached = this.#geometries.get(entry.mesh);
    if (cached) {
      cached.users++;
      return cached;
    }
    const prepared = prepareWorldMesh(entry.mesh, entry.sourceTileKey, this.#surfaceOffsetMeters);
    const buffers: GPUBuffer[] = [];
    try {
      const position = uploadBuffer(
        context.device,
        prepared.positions,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(position);
      const localPosition = uploadBuffer(
        context.device,
        prepared.localPositions,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(localPosition);
      const extrudes = prepared.lineExtrudes ?? prepared.heightExtrudes;
      const lineExtrude = extrudes
        ? uploadBuffer(context.device, extrudes, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST)
        : undefined;
      if (lineExtrude) buffers.push(lineExtrude);
      const lineDistance =
        entry.mesh.type === 'line'
          ? uploadBuffer(
              context.device,
              new Float32Array(prepared.positions.length / 3),
              GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            )
          : undefined;
      if (lineDistance) buffers.push(lineDistance);
      const geometry: GpuGeometry = {
        origin: prepared.origin,
        position,
        localPosition,
        lineExtrude,
        lineDistance,
        meshPositions: prepared.positions,
        byteLength:
          prepared.positions.byteLength +
          prepared.localPositions.byteLength +
          (extrudes?.byteLength ?? 0) +
          (entry.mesh.type === 'line' ? (prepared.positions.length / 3) * 4 : 0),
        users: 1,
        destroy: () => buffers.forEach((value) => value.destroy()),
      };
      this.#geometries.set(entry.mesh, geometry);
      return geometry;
    } catch (error) {
      buffers.forEach((value) => value.destroy());
      throw error;
    }
  }

  #releaseGeometry(mesh: VectorMesh): void {
    const geometry = this.#geometries.get(mesh);
    if (!geometry) return;
    geometry.users--;
    if (geometry.users > 0) return;
    geometry.destroy();
    this.#geometries.delete(mesh);
  }

  #upload(entry: VectorRenderEntry, opaque: boolean): GpuEntryResource {
    const context = this.#context;
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    this.#assertBatchIndices(entry);
    const geometry = this.#geometry(entry);
    const buffers: GPUBuffer[] = [];
    try {
      const indices = uploadBuffer(
        context.device,
        entry.batch.indices,
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(indices);
      const uniform = context.device.createBuffer({
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      buffers.push(uniform);
      // Translucent surfaces render as a depth-prepass + depth-equal colour
      // pair (the fill-extrusion-opacity approach); translucent lines keep
      // the single blended draw.
      const pattern = this.#pattern(entry.batch.styleLayer.paint.pattern);
      const surface = entry.mesh.type !== 'line';
      const pipeline = this.#pipeline(
        entry.mesh.type,
        opaque ? 'opaque' : surface ? 'equal' : 'blend',
        Boolean(pattern),
      );
      const bindGroup = context.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          ...(pattern
            ? [
                { binding: 1, resource: pattern.texture.createView() },
                { binding: 2, resource: pattern.sampler },
              ]
            : []),
        ],
      });
      const prepassPipeline =
        !opaque && surface
          ? this.#pipeline(entry.mesh.type, 'prepass', Boolean(pattern))
          : undefined;
      const prepassBindGroup = prepassPipeline
        ? context.device.createBindGroup({
            layout: prepassPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              ...(pattern
                ? [
                    { binding: 1, resource: pattern.texture.createView() },
                    { binding: 2, resource: pattern.sampler },
                  ]
                : []),
            ],
          })
        : undefined;
      const resource: GpuEntryResource = {
        type: entry.mesh.type,
        geometry,
        indices,
        uniform,
        bindGroup,
        pipeline,
        prepassPipeline,
        prepassBindGroup,
        opaque,
        indexCount: entry.batch.indices.length,
        byteLength: entry.batch.indices.byteLength + UNIFORM_BYTES,
        destroy: () => {
          buffers.forEach((value) => value.destroy());
          this.#releaseGeometry(entry.mesh);
        },
      };
      this.#metrics.uploaded++;
      return resource;
    } catch (error) {
      buffers.forEach((value) => value.destroy());
      this.#releaseGeometry(entry.mesh);
      throw error;
    }
  }

  #uploadPick(entry: VectorRenderEntry, draw: VectorFeaturePickDraw): PickGpuEntryResource {
    const context = this.#context;
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    this.#assertBatchIndices(entry);
    if (draw.triangleLocalIds.length * 3 !== entry.batch.indices.length) {
      throw new RangeError('pick draw must have one local ID per triangle');
    }
    const prepared = prepareWorldMesh(entry.mesh, entry.sourceTileKey, this.#surfaceOffsetMeters);
    const vertexCount = entry.batch.indices.length;
    const positions = new Float32Array(vertexCount * 3);
    const localPositions = new Float32Array(vertexCount * 2);
    const sourceExtrudes = prepared.lineExtrudes ?? prepared.heightExtrudes;
    const lineExtrudes = sourceExtrudes ? new Float32Array(vertexCount * 3) : undefined;
    const localIds = new Uint32Array(vertexCount);
    const indices = new Uint32Array(vertexCount);
    for (let output = 0; output < vertexCount; output++) {
      const source = entry.batch.indices[output];
      positions.set(prepared.positions.subarray(source * 3, source * 3 + 3), output * 3);
      localPositions.set(prepared.localPositions.subarray(source * 2, source * 2 + 2), output * 2);
      if (lineExtrudes && sourceExtrudes) {
        lineExtrudes.set(sourceExtrudes.subarray(source * 3, source * 3 + 3), output * 3);
      }
      localIds[output] = draw.triangleLocalIds[Math.floor(output / 3)];
      indices[output] = output;
    }
    const buffers: GPUBuffer[] = [];
    try {
      const position = uploadBuffer(
        context.device,
        positions,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(position);
      const localPosition = uploadBuffer(
        context.device,
        localPositions,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(localPosition);
      const lineExtrude = lineExtrudes
        ? uploadBuffer(
            context.device,
            lineExtrudes,
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          )
        : undefined;
      if (lineExtrude) buffers.push(lineExtrude);
      const lineDistance =
        entry.mesh.type === 'line'
          ? uploadBuffer(
              context.device,
              new Float32Array(vertexCount),
              GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            )
          : undefined;
      if (lineDistance) buffers.push(lineDistance);
      const localIdBuffer = uploadBuffer(
        context.device,
        localIds,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(localIdBuffer);
      const indexBuffer = uploadBuffer(
        context.device,
        indices,
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      );
      buffers.push(indexBuffer);
      const uniform = context.device.createBuffer({
        size: PICK_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      buffers.push(uniform);
      const pipeline = this.#pickPipeline(entry.mesh.type);
      const bindGroup = context.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      });
      return {
        draw,
        origin: prepared.origin,
        position,
        localPosition,
        lineExtrude,
        lineDistance,
        meshPositions: prepared.positions,
        localIds: localIdBuffer,
        indices: indexBuffer,
        uniform,
        bindGroup,
        pipeline,
        indexCount: indices.length,
        destroy: () => buffers.forEach((value) => value.destroy()),
      };
    } catch (error) {
      buffers.forEach((value) => value.destroy());
      throw error;
    }
  }

  draw(pass: GlobeRenderPass, frame: FrameState, entries: readonly VectorRenderEntry[]): void {
    const context = this.#context;
    if (this.#destroyed) throw new Error('WebGPU vector backend is destroyed');
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    if (!(frame.vp instanceof Float32Array) || frame.vp.length !== 16) {
      throw new TypeError('FrameState.vp must be a 16-value Float32Array');
    }
    if (
      !Number.isFinite(frame.viewportPx?.width) ||
      frame.viewportPx.width <= 0 ||
      !Number.isFinite(frame.viewportPx?.height) ||
      frame.viewportPx.height <= 0
    ) {
      throw new RangeError('FrameState viewport must be positive');
    }
    const current = new Set(entries);
    // GPU resources of entries not drawn this frame linger up to
    // retainResources (least recently drawn first) so a tile that flips out
    // and back in while the camera moves is not re-uploaded (world mesh +
    // buffers); vertexWorld / prepareWorldMesh would otherwise take 20-25% of
    // main-thread time during a 9 s pan with ~30 tiles in view.
    let drawnResources = 0;
    for (const entry of this.#resources.keys()) if (current.has(entry)) drawnResources++;
    for (const [, resource] of this.#resources.prune(
      (entry) => current.has(entry),
      drawnResources + this.#retainResources,
    )) {
      resource.destroy();
      this.#metrics.destroyed++;
    }
    for (const [entry, resource] of this.#pickResources) {
      if (current.has(entry)) continue;
      resource.destroy();
      this.#pickResources.delete(entry);
    }
    const drawResource = (resource: GpuEntryResource, prepass: boolean) => {
      pass.setPipeline(
        prepass && resource.prepassPipeline ? resource.prepassPipeline : resource.pipeline,
      );
      pass.setBindGroup(
        0,
        prepass && resource.prepassBindGroup ? resource.prepassBindGroup : resource.bindGroup,
      );
      const { geometry } = resource;
      pass.setVertexBuffer(0, geometry.position);
      if (geometry.lineExtrude) pass.setVertexBuffer(1, geometry.lineExtrude);
      pass.setVertexBuffer(geometry.lineExtrude ? 2 : 1, geometry.localPosition);
      if (geometry.lineDistance) pass.setVertexBuffer(3, geometry.lineDistance);
      pass.setIndexBuffer(resource.indices, 'uint32');
      pass.drawIndexed(resource.indexCount);
      this.#metrics.draws++;
    };
    const translucentSurfaces: GpuEntryResource[] = [];
    for (const entry of entries) {
      const style = this.#style(entry);
      // Scale 0 would put every extrusion on the surface datum, coplanar with
      // the flat fills — skip instead (a caller may use 0 while prefetching).
      if (entry.mesh.type === 'fill-extrusion' && this.#extrusionHeightScale <= 0) continue;
      let resource = this.#resources.get(entry);
      if (resource && resource.opaque !== style.opaque) {
        resource.destroy();
        this.#resources.delete(entry);
        this.#metrics.destroyed++;
        resource = undefined;
      }
      if (resource) this.#metrics.reused++;
      else {
        resource = this.#upload(entry, style.opaque);
        this.#resources.set(entry, resource);
      }
      const uniformValues = uniformStaging;
      const { origin } = resource.geometry;
      viewProjectionAt(uniformValues, frame.vp, frame.vp64, origin[0], origin[1], origin[2]);
      uniformValues.set(style.color, 16);
      uniformValues.set(
        [
          frame.viewportPx.width,
          frame.viewportPx.height,
          entry.mesh.type === 'fill-extrusion' ? this.#extrusionHeightScale : style.width / 2,
          entry.mesh.type === 'fill-extrusion' ? 1 : 0,
        ],
        20,
      );
      uniformValues.set(this.#clipBounds(entry), 24);
      const dash = entry.batch.styleLayer.paint.dashArray ?? [];
      uniformValues.fill(0, 28);
      uniformValues.set(dash, 28);
      uniformValues.set([dash.reduce((a, b) => a + b, 0), dash.length], 36);
      if (entry.mesh.type === 'fill') {
        uniformValues[28] = entry.batch.styleLayer.paint.patternSize ?? 128;
      }
      if (dash.length && resource.geometry.lineDistance && entry.mesh.type === 'line') {
        context.device.queue.writeBuffer(
          resource.geometry.lineDistance,
          0,
          screenLineDistances(entry.mesh, resource.geometry.meshPositions, origin, frame),
        );
      }
      context.device.queue.writeBuffer(resource.uniform, 0, uniformValues);
      if (resource.prepassPipeline) {
        translucentSurfaces.push(resource);
        continue;
      }
      drawResource(resource, false);
    }
    // Translucent surfaces: depth prepass over the whole group resolves the
    // front surface per pixel, then the colour pass blends exactly that
    // surface once (depthCompare 'equal') — face order inside and between
    // buildings does not leak through.
    for (const resource of translucentSurfaces) drawResource(resource, true);
    for (const resource of translucentSurfaces) drawResource(resource, false);
  }

  pickDraw(pass: GlobeRenderPass, frame: FrameState, pick: VectorPickPass): void {
    const context = this.#context;
    if (this.#destroyed) throw new Error('WebGPU vector backend is destroyed');
    if (!context) throw new Error('WebGPU vector backend is not initialized');
    if (
      !(frame.vp instanceof Float32Array) ||
      frame.vp.length !== 16 ||
      !(frame.pickVp instanceof Float32Array) ||
      frame.pickVp.length !== 16
    ) {
      throw new TypeError('picking requires 16-value vp and pickVp matrices');
    }
    if (!Number.isInteger(pick.idBase) || pick.idBase < 0 || pick.idBase > 0xffffffff) {
      throw new RangeError('pick idBase must fit uint32');
    }
    if (pick.entries.length !== pick.draws.length) {
      throw new RangeError('pick entries and draws must have the same length');
    }
    const current = new Set(pick.entries);
    for (const [entry, resource] of this.#pickResources) {
      if (current.has(entry)) continue;
      resource.destroy();
      this.#pickResources.delete(entry);
    }
    for (let index = 0; index < pick.entries.length; index++) {
      const entry = pick.entries[index];
      const draw = pick.draws[index];
      const style = this.#style(entry);
      if (style.color[3] <= 0 || (entry.mesh.type === 'line' && style.width <= 0)) continue;
      if (entry.mesh.type === 'fill-extrusion' && this.#extrusionHeightScale <= 0) continue;
      let resource = this.#pickResources.get(entry);
      if (resource && resource.draw !== draw) {
        resource.destroy();
        this.#pickResources.delete(entry);
        resource = undefined;
      }
      if (!resource) {
        resource = this.#uploadPick(entry, draw);
        this.#pickResources.set(entry, resource);
      }
      const uniformData = pickUniformStaging;
      const floats = pickUniformFloats;
      const [originX, originY, originZ] = resource.origin;
      viewProjectionAt(floats.subarray(0, 16), frame.vp, frame.vp64, originX, originY, originZ);
      viewProjectionAt(
        floats.subarray(16, 32),
        frame.pickVp,
        frame.pickVp64,
        originX,
        originY,
        originZ,
      );
      floats.set(
        [
          frame.viewportPx.width,
          frame.viewportPx.height,
          entry.mesh.type === 'fill-extrusion' ? this.#extrusionHeightScale : style.width / 2,
          0,
        ],
        32,
      );
      floats.set(this.#clipBounds(entry), 36);
      pickUniformInts[40] = pick.idBase;
      const dash = entry.batch.styleLayer.paint.dashArray ?? [];
      floats.fill(0, 48);
      floats.set(dash, 48);
      floats.set([dash.reduce((a, b) => a + b, 0), dash.length], 56);
      if (dash.length && resource.lineDistance && entry.mesh.type === 'line') {
        const distances = screenLineDistances(
          entry.mesh,
          resource.meshPositions,
          resource.origin,
          frame,
        );
        context.device.queue.writeBuffer(
          resource.lineDistance,
          0,
          Float32Array.from(entry.batch.indices, (i) => distances[i]),
        );
      }
      context.device.queue.writeBuffer(resource.uniform, 0, uniformData);
      pass.setPipeline(resource.pipeline);
      pass.setBindGroup(0, resource.bindGroup);
      pass.setVertexBuffer(0, resource.position);
      if (resource.lineExtrude) pass.setVertexBuffer(1, resource.lineExtrude);
      pass.setVertexBuffer(resource.lineExtrude ? 2 : 1, resource.localPosition);
      pass.setVertexBuffer(resource.lineExtrude ? 3 : 2, resource.localIds);
      if (resource.lineDistance) pass.setVertexBuffer(4, resource.lineDistance);
      pass.setIndexBuffer(resource.indices, 'uint32');
      pass.drawIndexed(resource.indexCount);
    }
  }

  setSpriteAtlas(atlas: VectorSpriteAtlas | null): void {
    if (this.#destroyed) throw new Error('WebGPU vector backend is destroyed');
    for (const resource of this.#resources.values()) resource.destroy();
    this.#metrics.destroyed += this.#resources.size;
    this.#resources.clear();
    for (const p of this.#patterns.values()) p.texture.destroy();
    this.#patterns.clear();
    this.#spriteAtlas = atlas;
    this.#labels?.setSpriteAtlas(atlas);
    this.#context?.invalidate();
  }

  drawLabels(pass: GlobeRenderPass, frame: FrameState, labels: readonly VectorLabel[]): void {
    if (!this.#context || this.#destroyed) {
      throw new Error('WebGPU vector backend is not initialized');
    }
    if (!this.#labels && labels.length) {
      this.#labels = new LabelBackend(this.#context, this.#surfaceOffsetMeters);
      this.#labels.setSpriteAtlas(this.#spriteAtlas);
    }
    this.#labels?.draw(pass, frame, labels);
  }

  snapshot(): WebGpuVectorBackendSnapshot {
    return {
      resources: this.#resources.size,
      bytes:
        [...this.#resources.values()].reduce((sum, value) => sum + value.byteLength, 0) +
        [...this.#geometries.values()].reduce((sum, value) => sum + value.byteLength, 0),
      ...this.#metrics,
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#labels?.destroy();
    this.#labels = null;
    this.#spriteAtlas = null;
    for (const p of this.#patterns.values()) p.texture.destroy();
    this.#patterns.clear();
    for (const resource of this.#resources.values()) resource.destroy();
    for (const resource of this.#pickResources.values()) resource.destroy();
    this.#metrics.destroyed += this.#resources.size;
    this.#resources.clear();
    this.#pickResources.clear();
    this.#context = null;
    this.#pipelines.clear();
  }
}

export function createWebGpuVectorBackend(
  options: WebGpuVectorBackendOptions = {},
): WebGpuVectorBackend {
  return new DefaultWebGpuVectorBackend(options);
}
