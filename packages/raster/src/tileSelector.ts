/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { FrameState } from 'teluala';
import { selectWebMercatorTiles, type WebMercatorTileOptions } from 'teluala';
import type { RasterTileCoordinate } from './types.js';

export type WebMercatorRasterSelectorOptions = WebMercatorTileOptions;

/** Select visible XYZ tiles using only Teluala's public FrameState.
 * The algorithm lives in core; this package keeps its defaults: imagery is
 * not worth fetching below zoom 2, rarely exists above 18, and a screenful
 * of small tiles needs a larger budget than vector data. */
export function selectWebMercatorRasterTiles(
  frame: FrameState,
  options: WebMercatorRasterSelectorOptions = {},
): RasterTileCoordinate[] {
  return selectWebMercatorTiles(frame, {
    minZoom: options.minZoom ?? 2,
    maxZoom: options.maxZoom ?? 18,
    tileSize: options.tileSize,
    maxTiles: options.maxTiles ?? 160,
  });
}
