/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export const LAYER_SPEC = 1;
export const WORLD_PER_METER = 1 / 6378137;
/**
 * Depth-buffer units per stratum. Layers that share one datum (fills, lines,
 * draped imagery on the same surface) declare their stacking order
 * as an integer stratum; a backend turns it into a constant depth bias
 * (negative = nearer) on every draw pipeline, so coplanar layers resolve by
 * declaration instead of by the ulp-level differences of their interpolated
 * depths (which flip while the camera moves). The unit belongs to the
 * engine's depth buffer, so the number lives here and every backend reads it.
 *
 * A constant bias alone loses to the CHORD error between two tessellations
 * of the same curved datum (a flat triangle of span L sits L² / 8R below the
 * sphere: 1.8 mm for a 300 m span, ~0.1 m for a 2.4 km span) because b
 * units move depth by only ~b · 2⁻²⁴ · z² / near metres — next to nothing in
 * the foreground near the near plane. The slope-scaled term below handles
 * close range and grazing angles; the constant handles ulp-level ties.
 */
export const DEPTH_BIAS_PER_STRATUM = 8;
/**
 * Slope-scaled depth bias per stratum, for DATUM-COPLANAR draws only (fills,
 * lines, draped rasters — never extrusions, whose walls have their own
 * slopes). It scales with the surface's screen-space depth gradient, which is
 * exactly where a constant bias runs out: close range and grazing angles.
 * Coplanar layers share the gradient, so the stacking order still follows
 * the stratum. One unit per stratum is sufficient in practice.
 */
export const DEPTH_BIAS_SLOPE_PER_STRATUM = 1;
export function depthBiasSlopeScaleForStratum(stratum: number | undefined = 0): number {
  if (!Number.isInteger(stratum) || stratum < 0) {
    throw new RangeError('stratum must be a non-negative integer');
  }
  return 0 - stratum * DEPTH_BIAS_SLOPE_PER_STRATUM;
}
/** The pipeline depth bias for a declared stratum (0 = on the datum, under everything that shares it). */
export function depthBiasForStratum(stratum: number | undefined = 0): number {
  if (!Number.isInteger(stratum) || stratum < 0) {
    throw new RangeError('stratum must be a non-negative integer');
  }
  return 0 - stratum * DEPTH_BIAS_PER_STRATUM;
}
export interface GlobeRenderPass {
  setPipeline(pipeline: GPURenderPipeline): void;
  /** `dynamicOffsets` (optional, additive to layer-spec v1) lets a layer bind one uniform buffer for many draws. */
  setBindGroup(index: number, group: GPUBindGroup, dynamicOffsets?: readonly number[]): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer): void;
  setIndexBuffer(buffer: GPUBuffer, format: GPUIndexFormat): void;
  setStencilReference(ref: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number): void;
}
export interface LayerContext {
  device: GPUDevice;
  colorFormat: GPUTextureFormat;
  depthFormat: 'depth24plus' | 'depth24plus-stencil8';
  samples: number;
  invalidate(): void;
}
export interface FrameState {
  vp: Float32Array;
  /**
   * The same view-projection in double precision (optional, additive).
   * Float32 world coordinates carry a 0.2-0.4 m quantum at Earth-radius
   * scale, so layers keep vertices as Float32 offsets from a per-mesh
   * origin and upload vp × placement formed from this matrix
   * (`viewProjectionAt` / `composeViewProjection`), rounded once at upload.
   */
  vp64?: Float64Array;
  /** View-projection matrix for the engine-owned 1x1 picking pass. */
  pickVp?: Float32Array;
  /** Double-precision counterpart of pickVp (optional, additive). */
  pickVp64?: Float64Array;
  camera: {
    lon: number;
    lat: number;
    range: number;
    heading: number;
    pitch: number;
    roll: number;
  };
  cameraPosWorld: [number, number, number];
  viewBBox: {
    west: number;
    south: number;
    east: number;
    north: number;
  } | null;
  fovYRad: number;
  viewportPx: {
    width: number;
    height: number;
    dpr: number;
  };
  frameNumber: number;
}
export interface GlobeLayer {
  readonly name: string;
  readonly layerSpec: 1;
  readonly sortKey: number;
  init(ctx: LayerContext): void;
  update?(frame: FrameState): boolean;
  draw(pass: GlobeRenderPass, frame: FrameState): void;
  /** Draw selectable geometry and return the number of local IDs consumed. */
  pickDraw?(pass: GlobeRenderPass, frame: FrameState, idBase: number): number;
  /** Resolve the zero-based local ID previously emitted by pickDraw. */
  pickResolve?(localId: number): unknown;
  /** Optional coarse rejection before a picking pass. */
  rayBounds?(originWorld: [number, number, number], dirWorld: [number, number, number]): boolean;
  destroy(): void;
}

export interface GlobePickResult {
  layer: string;
  result: unknown;
}
