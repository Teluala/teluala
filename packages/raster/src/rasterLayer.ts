/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { ControllerLayer, type GlobeLayer } from 'teluala';

import type {
  RasterControllerUpdate,
  RasterGpuBackend,
  RasterLayerController,
  RasterLayerOptions,
  RasterRenderEntry,
} from './types.js';

export interface RasterLayer extends GlobeLayer {
  attribution(): string[];
}

// The shared controller + backend shell (core ControllerLayer) is all a
// raster layer needs: tiles in, draped tiles out.
class TelualaRasterLayer
  extends ControllerLayer<
    RasterRenderEntry,
    RasterControllerUpdate,
    RasterLayerController,
    RasterGpuBackend
  >
  implements RasterLayer
{
  constructor(options: RasterLayerOptions) {
    super('raster', options, { name: 'raster', sortKey: 50 });
  }
}

/** Create an optional raster layer without importing or owning the Teluala engine. */
export function createRasterLayer(options: RasterLayerOptions): RasterLayer {
  if (!options) throw new TypeError('raster layer options are required');
  return new TelualaRasterLayer(options);
}
