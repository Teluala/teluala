/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export {
  createTerrainSurface,
  sampleTerrainHeight,
  cropHeightTile,
  type TerrainSurface,
  type TerrainSurfaceOptions,
  type TerrainSurfaceSnapshot,
  type HeightTileSource,
} from './groundSurface.js';
export {
  createWorkerXyzDemTileSource,
  type WorkerXyzDemTileSourceOptions,
} from './xyzDemSource.js';
export {
  decodeTerrainRgbHeight,
  decodeTerrariumHeight,
  decodeDemPixels,
  demDecoder,
  type DemEncoding,
} from './demEncoding.js';
export type { HeightTile, TiledGroundSurface } from 'teluala';
