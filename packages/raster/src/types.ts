/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { FrameState, HeightTile, GlobeRenderPass, LayerContext } from 'teluala';

export interface RasterTileCoordinate {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface RasterTileResponse {
  readonly image: ImageBitmap;
  readonly cacheControl?: string;
  readonly expires?: string;
}

export interface RasterTileSource {
  getTile(
    z: number,
    x: number,
    y: number,
    options: { readonly signal: AbortSignal },
  ): Promise<RasterTileResponse | undefined>;
  destroy?(): void;
}

export interface RasterRenderEntry {
  /** Stable render-mesh identity; coverage entries use a `coverage:` prefix. */
  readonly key: string;
  /** Image-bearing tile key. Differs from key while drawing an ancestor fallback. */
  readonly sourceKey: string;
  readonly tile: RasterTileCoordinate;
  readonly sourceTile: RasterTileCoordinate;
  readonly image: ImageBitmap;
  /** DEM samples for this requested mesh tile, when terrain is enabled. */
  readonly height?: HeightTile;
  readonly bounds: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly uv: {
    readonly west: number;
    readonly north: number;
    readonly east: number;
    readonly south: number;
  };
}

export interface RasterControllerUpdate {
  readonly entries?: readonly RasterRenderEntry[];
  readonly needsRender?: boolean;
}

export interface RasterLayerController {
  init?(context: LayerContext): void;
  update(frame: FrameState): RasterControllerUpdate | void;
  attribution?(): readonly string[];
  destroy(): void;
}

export interface RasterGpuBackend {
  init(context: LayerContext): void;
  draw(pass: GlobeRenderPass, frame: FrameState, entries: readonly RasterRenderEntry[]): void;
  destroy(): void;
}

export interface RasterLayerOptions {
  readonly name?: string;
  readonly sortKey?: number;
  readonly controller: RasterLayerController;
  readonly backend: RasterGpuBackend;
}

/** Tiles kept decoded / uploaded beyond the selection, the same default for the controller's records and the backend's GPU resources. */
export const DEFAULT_MAX_CACHE_TILES = 320;
/** The one abort error the raster package rejects with: the signal's own reason, else a DOMException. */
export const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Aborted', 'AbortError');
