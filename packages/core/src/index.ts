/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export {
  GlobeEngine,
  CAMERA_LIMITS,
  type GlobeCameraLimits,
  type GlobeCameraState,
  type GlobeEngineOptions,
  type GlobeStats,
} from './engine.js';
export {
  DEPTH_BIAS_PER_STRATUM,
  depthBiasForStratum,
  DEPTH_BIAS_SLOPE_PER_STRATUM,
  depthBiasSlopeScaleForStratum,
  LAYER_SPEC,
  WORLD_PER_METER,
  type FrameState,
  type GlobeLayer,
  type GlobePickResult,
  type GlobeRenderPass,
  type LayerContext,
} from './layer.js';
export {
  D2R,
  WGS84_A,
  WGS84_E2,
  WGS84_F,
  ecef,
  geodeticNormal,
  rayEllipsoid,
  type Mat4,
  type Vec3,
} from './math3d.js';
export {
  WEB_MERCATOR_MAX_LATITUDE,
  assertWebMercatorTile,
  resolveWebMercatorTileOptions,
  selectWebMercatorTiles,
  webMercatorRangeForZoom,
  webMercatorY,
  webMercatorZoom,
  worldPerCssPixel,
  type ResolvedWebMercatorTileOptions,
  type WebMercatorTile,
  type WebMercatorTileOptions,
} from './webMercatorTiles.js';
export { BoundedCache, type BoundedCacheOptions } from './boundedCache.js';
export { uploadBuffer } from './gpuBuffer.js';
export {
  ControllerLayer,
  type ControllerLayerOptions,
  type ControllerLayerUpdate,
  type LayerBackend,
  type LayerController,
} from './controllerLayer.js';
export {
  TileHttpError,
  isRetryableError,
  parseRetryAfter,
  retryDelay,
  type RetryDelayOptions,
} from './http.js';
export { pickViewProjection } from './pick.js';
export { composeViewProjection, viewProjectionAt } from './precision.js';
export { type GroundSurface, type HeightTile, type TiledGroundSurface } from './ground.js';
export {
  HOST_API,
  usePlugins,
  type GlobePlugin,
  type GlobePluginContext,
  type GlobeEngineLike,
  type MutableCamera,
} from './plugin.js';
