/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import {
  BoundedCache,
  assertWebMercatorTile,
  type HeightTile,
  type TiledGroundSurface,
} from 'teluala';

export interface HeightTileSource {
  getHeightTile(
    z: number,
    x: number,
    y: number,
    options: { readonly signal: AbortSignal },
  ): Promise<HeightTile | undefined>;
  destroy?(): void;
}

export interface TerrainSurfaceOptions {
  readonly source: HeightTileSource;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly maxCacheTiles?: number;
  readonly attribution?: readonly string[];
}

export interface TerrainSurfaceSnapshot {
  readonly requested: number;
  readonly cacheHits: number;
  readonly derived: number;
  readonly ready: number;
  readonly loading: number;
  readonly evicted: number;
}

export interface TerrainSurface extends TiledGroundSurface {
  readonly minZoom: number;
  readonly maxZoom: number;
  fetchHeights(z: number, x: number, y: number): Promise<HeightTile | undefined>;
  attribution(): readonly string[];
  snapshot(): TerrainSurfaceSnapshot;
  destroy(): void;
}

export type { HeightTile } from 'teluala';

interface CacheRecord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly tile: HeightTile;
}

interface InflightRecord {
  readonly abort: AbortController;
  readonly promise: Promise<HeightTile | undefined>;
}

const MAX_MERCATOR_LATITUDE = 85.0511287798066;

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

function validateTile(tile: HeightTile): void {
  if (
    !Number.isInteger(tile?.size) ||
    tile.size < 2 ||
    !(tile.data instanceof Float32Array) ||
    tile.data.length !== tile.size * tile.size
  ) {
    throw new TypeError('height tile must contain a square Float32Array with size >= 2');
  }
}

export function sampleTerrainHeight(tile: HeightTile, u: number, v: number): number {
  validateTile(tile);
  const maximum = tile.size - 1;
  const fx = Math.min(1, Math.max(0, u)) * maximum;
  const fy = Math.min(1, Math.max(0, v)) * maximum;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(maximum, x0 + 1);
  const y1 = Math.min(maximum, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number): number => {
    const value = tile.data[y * tile.size + x];
    return Number.isFinite(value) ? value : 0;
  };
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
  return top + (bottom - top) * ty;
}

export function cropHeightTile(
  parent: HeightTile,
  zoomDelta: number,
  subX: number,
  subY: number,
): HeightTile {
  validateTile(parent);
  if (!Number.isInteger(zoomDelta) || zoomDelta < 1 || zoomDelta > 30) {
    throw new RangeError('height tile crop zoomDelta must be within 1..30');
  }
  const scale = 2 ** zoomDelta;
  if (
    ![subX, subY].every(Number.isInteger) ||
    subX < 0 ||
    subX >= scale ||
    subY < 0 ||
    subY >= scale
  ) {
    throw new RangeError('height tile crop offset is outside the parent');
  }
  // Keep the parent's sample spacing instead of upsampling the crop to the parent's
  // size. Consumers difference heights over one sample to shade the surface; an
  // upsampled crop would make that span a fraction of a native texel, so the gradient
  // would be constant inside each texel and hillshade would show texel-sized steps
  // past maxZoom.
  // One sample per native texel keeps the difference span equal to the native spacing,
  // as it is at maxZoom.
  const size = Math.max(2, Math.ceil((parent.size - 1) / scale) + 1);
  const data = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    const v = (subY + row / (size - 1)) / scale;
    for (let column = 0; column < size; column++) {
      const u = (subX + column / (size - 1)) / scale;
      data[row * size + column] = sampleTerrainHeight(parent, u, v);
    }
  }
  return { size, data };
}

/** Cache and share one DEM source between independent consumers and engine ground height. */
export function createTerrainSurface(options: TerrainSurfaceOptions): TerrainSurface {
  if (!options?.source || typeof options.source.getHeightTile !== 'function') {
    throw new TypeError('height tile source.getHeightTile is required');
  }
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 15;
  const maxCacheTiles = options.maxCacheTiles ?? 256;
  if (
    ![minZoom, maxZoom].every(Number.isInteger) ||
    minZoom < 0 ||
    maxZoom > 30 ||
    minZoom > maxZoom
  ) {
    throw new RangeError('height tile zoom range must be within 0..30');
  }
  if (!Number.isInteger(maxCacheTiles) || maxCacheTiles < 1) {
    throw new RangeError('maxCacheTiles must be a positive integer');
  }

  // Recency is the cache's insertion order; get() touches.
  const cache = new BoundedCache<string, CacheRecord>({ limit: maxCacheTiles });
  const inflight = new Map<string, InflightRecord>();
  const listeners = new Set<() => void>();
  let destroyed = false;
  let requested = 0;
  let cacheHits = 0;
  let derived = 0;
  let evicted = 0;

  const put = (key: string, z: number, x: number, y: number, tile: HeightTile): HeightTile => {
    validateTile(tile);
    cache.set(key, { z, x, y, tile });
    evicted += cache.prune().length;
    for (const listener of listeners) listener();
    return tile;
  };

  const fetchHeights = async (z: number, x: number, y: number): Promise<HeightTile | undefined> => {
    if (destroyed) throw new Error('terrain surface is destroyed');
    assertWebMercatorTile(z, x, y);
    if (z < minZoom) return undefined;
    const key = tileKey(z, x, y);
    const cached = cache.get(key);
    if (cached) {
      cacheHits++;
      return cached.tile;
    }
    const active = inflight.get(key);
    if (active) {
      cacheHits++;
      return active.promise;
    }

    const abort = new AbortController();
    requested++;
    const promise = (async () => {
      let tile: HeightTile | undefined;
      if (z > maxZoom) {
        const zoomDelta = z - maxZoom;
        const scale = 2 ** zoomDelta;
        const parentX = Math.floor(x / scale);
        const parentY = Math.floor(y / scale);
        const parent = await fetchHeights(maxZoom, parentX, parentY);
        if (parent) {
          tile = cropHeightTile(parent, zoomDelta, x - parentX * scale, y - parentY * scale);
          derived++;
        }
      } else {
        tile = await options.source.getHeightTile(z, x, y, { signal: abort.signal });
      }
      if (!tile || destroyed || abort.signal.aborted) return undefined;
      return put(key, z, x, y, tile);
    })().finally(() => inflight.delete(key));
    inflight.set(key, { abort, promise });
    return promise;
  };

  return {
    minZoom,
    maxZoom,
    fetchHeights,
    heightAt(lon: number, lat: number): number {
      if (destroyed || !Number.isFinite(lon) || !Number.isFinite(lat)) return Number.NaN;
      const wrappedLongitude = ((((lon + 180) % 360) + 360) % 360) / 360;
      const clampedLatitude = Math.max(
        -MAX_MERCATOR_LATITUDE,
        Math.min(MAX_MERCATOR_LATITUDE, lat),
      );
      const radians = (clampedLatitude * Math.PI) / 180;
      const mercator = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
      let best: CacheRecord | undefined;
      let bestKey = '';
      let u = 0;
      let v = 0;
      for (const [key, record] of cache) {
        if (best && record.z <= best.z) continue;
        const width = 2 ** record.z;
        const fx = wrappedLongitude * width;
        const fy = mercator * width;
        if (Math.floor(fx) !== record.x || Math.floor(fy) !== record.y) continue;
        best = record;
        bestKey = key;
        u = fx - record.x;
        v = fy - record.y;
      }
      if (!best) return Number.NaN;
      cache.get(bestKey); // touch: sampled this frame
      return sampleTerrainHeight(best.tile, u, v);
    },
    subscribe(listener: () => void): () => void {
      if (destroyed) throw new Error('terrain surface is destroyed');
      if (typeof listener !== 'function') throw new TypeError('ground listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attribution(): readonly string[] {
      return [...new Set(options.attribution ?? [])];
    },
    snapshot(): TerrainSurfaceSnapshot {
      return {
        requested,
        cacheHits,
        derived,
        ready: cache.size,
        loading: inflight.size,
        evicted,
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const record of inflight.values()) record.abort.abort();
      inflight.clear();
      cache.clear();
      listeners.clear();
      options.source.destroy?.();
    },
  };
}
