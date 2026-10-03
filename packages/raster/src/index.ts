/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export { createRasterLayer, type RasterLayer } from './rasterLayer.js';
export {
  createRasterController,
  type RasterController,
  type RasterControllerOptions,
  type RasterControllerSnapshot,
} from './rasterController.js';
// The HTTP failure shape and retry policy are the engine's (teluala:
// TileHttpError, isRetryableError, retryDelay); this package throws and asks them.
export {
  selectWebMercatorRasterTiles,
  type WebMercatorRasterSelectorOptions,
} from './tileSelector.js';
export { createXyzRasterTileSource, type XyzRasterTileSourceOptions } from './xyzSource.js';
// The stratum unit is defined in core and re-exported for convenience.
export { DEPTH_BIAS_PER_STRATUM, DEPTH_BIAS_SLOPE_PER_STRATUM } from 'teluala';
export {
  createWebGpuRasterBackend,
  type WebGpuRasterBackend,
  type WebGpuRasterBackendOptions,
  type WebGpuRasterBackendSnapshot,
} from './webgpuBackend.js';
export type {
  RasterControllerUpdate,
  RasterGpuBackend,
  RasterLayerController,
  RasterLayerOptions,
  RasterRenderEntry,
  RasterTileCoordinate,
  RasterTileResponse,
  RasterTileSource,
} from './types.js';
