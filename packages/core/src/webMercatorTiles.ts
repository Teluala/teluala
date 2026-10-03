/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/**
 * Tile selection from a FrameState.
 *
 * The policy is scheme-independent: pick the level that matches the on-screen
 * resolution, cover the visible bounds at that level, coarsen while the cover
 * exceeds the budget, then take the cells nearest the look-at point. What a
 * "level" or a "cell" is belongs to a TileScheme. Web Mercator XYZ is the one
 * scheme shipped here; the contract stays internal until a second scheme has
 * a consumer.
 *
 * Resolution has one definition, world units per CSS pixel at the look-at
 * point (worldPerCssPixel), which is the scale data conventions are written
 * in (a map zoom, a per-feature min_zoom, a dataset's zoom levels). How
 * finely to sample it is a separate policy input, `detail`: the log2 of the
 * texels placed on one CSS pixel. The selection defaults to log2(dpr), one
 * texel per device pixel, so a high-DPR display picks a finer level than its
 * CSS size alone would; that default is recorded in the golden test and
 * changes only deliberately.
 */
import type { FrameState } from './layer.js';

export interface GeoBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** A candidate cell with its scheme-defined distance from the look-at point. */
export interface TileCandidate<Cell> {
  readonly cell: Cell;
  readonly distance: number;
}

/** The cells of one level that cover a bounds. `count` must be cheap: the
 * policy asks for it once per level while coarsening. */
export interface TileCover<Cell> {
  readonly count: number;
  cells(): Iterable<TileCandidate<Cell>>;
}

/** What the selection policy needs from a tiling scheme.
 *
 * A level is an index into the scheme's ordered list of resolutions, coarser
 * first, so the policy can coarsen with `level - 1` whatever the ratio between
 * neighbouring levels is. Everything geographic — longitude wrapping, latitude
 * limits, the shape and size of a cell, the distance metric — lives in the
 * scheme. The policy holds no branch on which scheme it is given.
 */
export interface TileScheme<Cell> {
  /** The level whose cells best match this many world units per sampled
   * pixel. May fall outside the selectable range; the policy clamps it. */
  levelFor(worldPerSample: number): number;
  /** Cover the bounds at a level. `lookAt` is the frame's camera target; a
   * scheme uses it to unwrap longitudes and to measure candidate distance. */
  cover(
    bounds: GeoBounds,
    lookAt: { readonly lon: number; readonly lat: number },
    level: number,
  ): TileCover<Cell>;
}

export interface TileSelectionOptions {
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly maxCells: number;
  /** log2 of the texels per CSS pixel to aim for. Default log2(dpr). */
  readonly detail?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** World units per CSS pixel at the look-at point: the frustum height at the
 * camera target divided by the viewport's CSS height. */
export function worldPerCssPixel(frame: FrameState): number {
  return (
    (2 * frame.camera.range * Math.tan(frame.fovYRad / 2)) /
    (frame.viewportPx.height / (frame.viewportPx.dpr || 1))
  );
}

/** World units per sampled pixel: the CSS resolution refined by `detail`. */
function worldPerSampleOf(frame: FrameState, detail: number | undefined): number {
  const resolved = detail ?? Math.log2(frame.viewportPx.dpr || 1);
  if (!Number.isFinite(resolved)) throw new RangeError('detail must be finite');
  return worldPerCssPixel(frame) / 2 ** resolved;
}

/** Select the visible cells of a scheme for a frame, nearest to the look-at point first. */
export function selectTiles<Cell>(
  frame: FrameState,
  scheme: TileScheme<Cell>,
  options: TileSelectionOptions,
): Cell[] {
  const { minLevel, maxLevel, maxCells, detail } = options;
  const bbox = frame.viewBBox;
  if (!bbox) return [];
  if (
    !Number.isFinite(frame.camera?.lon) ||
    !Number.isFinite(frame.camera?.lat) ||
    !Number.isFinite(frame.camera?.range) ||
    frame.camera.range <= 0
  ) {
    throw new RangeError('FrameState camera must contain a positive range and finite coordinates');
  }
  if (!Number.isFinite(frame.fovYRad) || frame.fovYRad <= 0 || frame.fovYRad >= Math.PI) {
    throw new RangeError('FrameState fovYRad must be within 0..PI');
  }
  if (!Number.isFinite(frame.viewportPx?.height) || frame.viewportPx.height <= 0) {
    throw new RangeError('FrameState viewport height must be positive');
  }
  const lookAt = { lon: frame.camera.lon, lat: frame.camera.lat };
  let level = clamp(scheme.levelFor(worldPerSampleOf(frame, detail)), minLevel, maxLevel);
  while (level > minLevel && scheme.cover(bbox, lookAt, level).count > maxCells) level--;
  const candidates = [...scheme.cover(bbox, lookAt, level).cells()];
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, maxCells).map(({ cell }) => cell);
}

// ---------------------------------------------------------------------------
// Web Mercator XYZ

export interface WebMercatorTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface WebMercatorTileOptions {
  /** Coarsest zoom to select. Default 0. */
  readonly minZoom?: number;
  /** Finest zoom to select. Default 22. */
  readonly maxZoom?: number;
  /** Tile edge in pixels, used to match zoom to screen resolution. Default 256. */
  readonly tileSize?: number;
  /** Upper bound on selected tiles; the zoom coarsens until the cover fits. Default 64. */
  readonly maxTiles?: number;
  /** log2 of the texels per CSS pixel to aim for: 0 follows the map zoom in
   * CSS pixels, log2(dpr) puts one texel on each device pixel. Default log2(dpr). */
  readonly detail?: number;
}

/** Options with the defaults applied; `detail` stays optional because its
 * default depends on the frame's dpr. */
export type ResolvedWebMercatorTileOptions = Required<Omit<WebMercatorTileOptions, 'detail'>> &
  Pick<WebMercatorTileOptions, 'detail'>;

/** Continuous Web Mercator zoom at which a tile edge of `tileSize` pixels
 * spans that many sampled pixels; the scheme picks the nearest integer. */
function webMercatorZoomOf(worldPerSample: number, tileSize: number): number {
  return Math.log2((2 * Math.PI) / (tileSize * worldPerSample));
}

/** Continuous Web Mercator zoom of a frame under the given tile size and
 * detail (defaults as in selection). `{ detail: 0 }` is the map zoom in CSS
 * pixels that data conventions use; the default is the zoom the selection
 * rounds to pick a level. */
export function webMercatorZoom(frame: FrameState, options: WebMercatorTileOptions = {}): number {
  const { tileSize, detail } = resolveWebMercatorTileOptions(options);
  return webMercatorZoomOf(worldPerSampleOf(frame, detail), tileSize);
}

/** Inverse of webMercatorZoom(): the camera range at which a frame with this
 * viewport, field of view and dpr sits exactly at `zoom`. With the defaults
 * this is the range where selectWebMercatorTiles() picks that level before
 * the maxTiles budget coarsens it. */
export function webMercatorRangeForZoom(
  frame: FrameState,
  zoom: number,
  options: WebMercatorTileOptions = {},
): number {
  if (!Number.isFinite(zoom)) throw new RangeError('zoom must be finite');
  const { tileSize, detail } = resolveWebMercatorTileOptions(options);
  const resolvedDetail = detail ?? Math.log2(frame.viewportPx.dpr || 1);
  const worldPerSample = (2 * Math.PI) / (tileSize * 2 ** zoom);
  const cssHeight = frame.viewportPx.height / (frame.viewportPx.dpr || 1);
  return (worldPerSample * 2 ** resolvedDetail * cssHeight) / (2 * Math.tan(frame.fovYRad / 2));
}

/** Reject a tile address that no XYZ source can serve: non-integer
 * coordinates (TypeError), a zoom outside 0..maxZoom, or x/y outside the
 * 2^z grid (RangeError). One check for every package that names tiles. */
export function assertWebMercatorTile(z: number, x: number, y: number, maxZoom = 30): void {
  if (![z, x, y].every(Number.isInteger)) throw new TypeError('tile coordinates must be integers');
  if (z < 0 || z > maxZoom) throw new RangeError(`tile zoom must be 0..${maxZoom}`);
  const width = 2 ** z;
  if (x < 0 || y < 0 || x >= width || y >= width) {
    throw new RangeError(`tile is outside zoom ${z}: ${x}/${y}`);
  }
}

/** Latitude where the Web Mercator square ends. */
export const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

/** Normalised Web Mercator y in [0, 1], north to south. */
export function webMercatorY(latitude: number): number {
  const radians =
    (clamp(latitude, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE) * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
}

function unwrapLongitude(longitude: number, center: number): number {
  return center + (((longitude - center + 540) % 360) - 180);
}

/** Web Mercator XYZ as a TileScheme: level is the zoom, a cell is {z, x, y},
 * and candidate distance is measured in tile units at that zoom. */
export function webMercatorScheme(tileSize: number): TileScheme<WebMercatorTile> {
  return {
    levelFor(worldPerSample) {
      return Math.round(webMercatorZoomOf(worldPerSample, tileSize));
    },
    cover(bounds, lookAt, zoom) {
      const west = unwrapLongitude(bounds.west, lookAt.lon);
      let east = unwrapLongitude(bounds.east, lookAt.lon);
      if (east < west) east += 360;
      const south = clamp(bounds.south, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE);
      const north = clamp(bounds.north, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE);
      const width = 2 ** zoom;
      const x0 = Math.floor(((west + 180) / 360) * width);
      const x1 = Math.floor(((east + 180) / 360) * width);
      const y0 = clamp(Math.floor(webMercatorY(north) * width), 0, width - 1);
      const y1 = clamp(Math.floor(webMercatorY(south) * width), 0, width - 1);
      const xCount = Math.min(width, x1 - x0 + 1);
      const xLast = x0 + xCount - 1;
      return {
        count: xCount * (y1 - y0 + 1),
        *cells() {
          const centerX = ((lookAt.lon + 180) / 360) * width;
          const centerY = webMercatorY(lookAt.lat) * width;
          for (let y = y0; y <= y1; y++) {
            for (let rawX = x0; rawX <= xLast; rawX++) {
              yield {
                cell: { z: zoom, x: ((rawX % width) + width) % width, y },
                distance: (rawX + 0.5 - centerX) ** 2 + (y + 0.5 - centerY) ** 2,
              };
            }
          }
        },
      };
    },
  };
}

/** Apply the defaults and reject impossible ranges. Exposed so a layer can
 * fail at construction and derive its own limits from the resolved values. */
export function resolveWebMercatorTileOptions(
  options: WebMercatorTileOptions = {},
): ResolvedWebMercatorTileOptions {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 22;
  const tileSize = options.tileSize ?? 256;
  const maxTiles = options.maxTiles ?? 64;
  if (
    ![minZoom, maxZoom].every(Number.isInteger) ||
    minZoom < 0 ||
    maxZoom > 30 ||
    minZoom > maxZoom
  ) {
    throw new RangeError('tile zoom range must be integer values within 0..30');
  }
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new RangeError('tileSize must be positive');
  }
  if (!Number.isInteger(maxTiles) || maxTiles < 1) {
    throw new RangeError('maxTiles must be a positive integer');
  }
  if (options.detail !== undefined && !Number.isFinite(options.detail)) {
    throw new RangeError('detail must be finite');
  }
  return { minZoom, maxZoom, tileSize, maxTiles, detail: options.detail };
}

/** Select the visible Web Mercator tiles for a frame, nearest to the look-at point first. */
export function selectWebMercatorTiles(
  frame: FrameState,
  options: WebMercatorTileOptions = {},
): WebMercatorTile[] {
  const { minZoom, maxZoom, tileSize, maxTiles, detail } = resolveWebMercatorTileOptions(options);
  return selectTiles(frame, webMercatorScheme(tileSize), {
    minLevel: minZoom,
    maxLevel: maxZoom,
    maxCells: maxTiles,
    detail,
  });
}
