/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { FrameState, GlobeRenderPass, LayerContext } from 'teluala';

export type VectorMeshType = 'fill' | 'line' | 'fill-extrusion';

export interface VectorMeshBase {
  readonly type: VectorMeshType;
  readonly sourceGeometryType: 'polygon' | 'line';
  readonly layerName: string;
  readonly extent: number;
  readonly positions: Int32Array;
  readonly indices: Uint32Array;
  readonly triangleFeatureIndices: Uint32Array;
}

export interface FillVectorMesh extends VectorMeshBase {
  readonly type: 'fill';
  readonly sourceGeometryType: 'polygon';
}

export interface LineVectorMesh extends VectorMeshBase {
  /** Vertex offsets of independent paths in segment-quad meshes. */
  readonly pathStarts?: Uint32Array;
  readonly type: 'line';
  readonly sourceGeometryType: 'line';
  readonly extrudes: Float32Array;
}

export interface ExtrusionVectorMesh extends VectorMeshBase {
  readonly type: 'fill-extrusion';
  readonly sourceGeometryType: 'polygon';
  /** Per-vertex height in metres above the ellipsoid. */
  readonly heights: Float32Array;
}

export type VectorMesh = FillVectorMesh | LineVectorMesh | ExtrusionVectorMesh;

export interface VectorStyleLayer {
  readonly id: string;
  readonly type: VectorMeshType;
  readonly paint: {
    readonly color: readonly [number, number, number, number];
    readonly width?: number;
    readonly dashArray?: readonly number[];
    /** Sprite name, tiled in source-tile coordinates. */
    readonly pattern?: string;
    readonly patternSize?: number;
  };
}

export interface VectorStyleBatch {
  readonly styleLayer: VectorStyleLayer;
  readonly indices: Uint32Array;
  readonly triangleFeatureIndices: Uint32Array;
}

/** Render-ready unit produced by the vector controller and consumed by a GPU backend. */
export interface VectorRenderEntry {
  readonly sourceId: string;
  readonly sourceTileKey: string;
  readonly requestedTileKey?: string;
  readonly mesh: VectorMesh;
  readonly batch: VectorStyleBatch;
  readonly featureTable?: unknown;
}

export interface VectorFeaturePickRecord {
  readonly localId: number;
  readonly sourceId: string;
  readonly sourceTileKey: string;
  readonly layerName: string;
  readonly featureIndex: number;
  readonly mvtId: unknown;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly requestedTileKeys: readonly string[];
  readonly geometryTypes: readonly VectorMeshType[];
  readonly styleLayerIds: readonly string[];
}

export interface VectorFeaturePickDraw {
  readonly triangleLocalIds: Uint32Array;
  readonly triangleCount: number;
  readonly styleLayerId: string;
  readonly geometryType: VectorMeshType;
}

export interface VectorFeaturePickCatalog {
  readonly draws: readonly VectorFeaturePickDraw[];
  readonly records: readonly VectorFeaturePickRecord[];
  readonly count: number;
}

export interface VectorPickPass {
  readonly idBase: number;
  readonly entries: readonly VectorRenderEntry[];
  readonly draws: readonly VectorFeaturePickDraw[];
}

/** Screen-facing text at a point feature. Sizes and offsets are CSS pixels. */
export interface VectorLabel {
  readonly key: string;
  /** Shared collision/budget unit for separately positioned parts of one label. */
  readonly collisionGroup?: string;
  /** Style layer that produced this label. */
  readonly styleId?: string;
  /** Tile stage that actually supplied the feature, including stale and
   * overzoomed tiles. This is the zoom at which the datum is recorded, which
   * is not always the zoom being displayed. */
  readonly sourceZoom?: number;
  /** Style layers this label may overlap. Use for a pairing that belongs
   * together, such as a facility icon and its name on one anchor. */
  readonly ignoreCollisionWith?: readonly string[];
  readonly text: string;
  readonly icon?: string;
  readonly iconSize?: number;
  readonly iconTextFit?: 'none' | 'both';
  readonly iconPadding?: readonly [number, number];
  readonly textOffset?: readonly [number, number];
  readonly path?: readonly (readonly [number, number])[];
  readonly repeatDistance?: number;
  readonly rotation?: number;
  readonly lon: number;
  readonly lat: number;
  readonly size: number;
  readonly fontFamily: string;
  readonly color: string;
  readonly haloColor: string;
  readonly haloWidth: number;
  readonly offset: readonly [number, number];
  readonly allowOverlap: boolean;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface VectorControllerUpdate {
  readonly labels?: readonly VectorLabel[];
  readonly entries?: readonly VectorRenderEntry[];
  readonly needsRender?: boolean;
}

/** Tile selection, fetching, worker processing, and cache ownership boundary. */
export interface VectorLayerController {
  init?(context: LayerContext): void;
  update(frame: FrameState): VectorControllerUpdate | void;
  attribution?(): readonly string[];
  destroy(): void;
}

/** WebGPU resource and draw-command boundary. It has no access to the engine instance. */
export interface VectorGpuBackend {
  init(context: LayerContext): void;
  draw(pass: GlobeRenderPass, frame: FrameState, entries: readonly VectorRenderEntry[]): void;
  drawLabels?(pass: GlobeRenderPass, frame: FrameState, labels: readonly VectorLabel[]): void;
  pickDraw?(pass: GlobeRenderPass, frame: FrameState, pick: VectorPickPass): void;
  destroy(): void;
}

export interface VectorLayerOptions {
  readonly name?: string;
  readonly sortKey?: number;
  readonly controller: VectorLayerController;
  readonly backend: VectorGpuBackend;
  /**
   * Draw the map labels in their own layer at this sortKey instead of with the
   * geometry. Set it when another layer is drawn above the vector geometry
   * but must stay below the labels (for example a translucent fill);
   * the geometry keeps `sortKey`, the text gets `labelSortKey`. The layer is
   * exposed as `layer.labelLayer` and has to be attached to the engine too.
   */
  readonly labelSortKey?: number;
}
