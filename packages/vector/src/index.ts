/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export { createVectorLayer, type VectorLayer } from './vectorLayer.js';
export { buildFeaturePickCatalog, resolveFeaturePick } from './pickCatalog.js';
export {
  createMvtVectorController,
  selectWebMercatorTiles,
  type MvtFeatureTable,
  type MvtPointFeature,
  type MvtLineFeature,
  type MvtLabelStyle,
  type MvtPointLabelLayout,
  type MvtStyleDocument,
  type MvtStyleLayerDefinition,
  type MvtTileCoordinate,
  type MvtTileProcessor,
  type MvtTileResponse,
  type MvtTileSource,
  type MvtVectorController,
  type MvtVectorControllerOptions,
  type MvtVectorControllerSnapshot,
  type ProcessedMvtTile,
  type WebMercatorTileSelectorOptions,
} from './mvtController.js';
export {
  createInlineMvtProcessor,
  handleMvtWorkerRequest,
  processMvt,
  type MvtExtrusionProfile,
  type MvtProcessOptions,
  type MvtWorkerRequest,
  type ProcessedMvtTileWithTransferables,
} from './mvtDecode.js';
export {
  createPmtilesMvtTileSource,
  createXyzMvtTileSource,
  type PmtilesArchiveLike,
  type PmtilesHeaderLike,
  type XyzMvtTileSourceOptions,
} from './mvtSources.js';
export {
  createDefaultMvtWorkerProcessor,
  createMvtWorkerPoolProcessor,
  type DefaultMvtWorkerProcessorOptions,
  type MvtWorkerLike,
  type MvtWorkerPoolOptions,
  type MvtWorkerPoolProcessor,
  type MvtWorkerPoolSnapshot,
} from './mvtWorkerPool.js';
// The stratum unit is defined in core and re-exported for convenience.
export { DEPTH_BIAS_PER_STRATUM, DEPTH_BIAS_SLOPE_PER_STRATUM } from 'teluala';
export {
  createWebGpuVectorBackend,
  type WebGpuVectorBackend,
  type WebGpuVectorBackendOptions,
  type WebGpuVectorBackendSnapshot,
} from './webgpuBackend.js';
export {
  parseSourceTileKey,
  prepareWorldMesh,
  sourceClipBounds,
  type PreparedWorldMesh,
  type SourceTileCoordinate,
} from './worldMesh.js';
export type {
  ExtrusionVectorMesh,
  FillVectorMesh,
  LineVectorMesh,
  VectorControllerUpdate,
  VectorLabel,
  VectorGpuBackend,
  VectorFeaturePickCatalog,
  VectorFeaturePickDraw,
  VectorFeaturePickRecord,
  VectorLayerController,
  VectorLayerOptions,
  VectorMesh,
  VectorMeshBase,
  VectorMeshType,
  VectorRenderEntry,
  VectorPickPass,
  VectorStyleBatch,
  VectorStyleLayer,
} from './types.js';

export {
  loadVectorSpriteAtlas,
  validateSpriteEntries,
  type VectorSpriteAtlas,
  type SpriteRectangle,
} from './sprites.js';
