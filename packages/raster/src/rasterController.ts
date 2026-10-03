/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import {
  BoundedCache,
  isRetryableError,
  retryDelay,
  type FrameState,
  type LayerContext,
  type HeightTile,
  type TiledGroundSurface,
} from 'teluala';

import { selectWebMercatorRasterTiles } from './tileSelector.js';
import { DEFAULT_MAX_CACHE_TILES, abortReason } from './types.js';
import type { WebMercatorRasterSelectorOptions } from './tileSelector.js';
import type {
  RasterLayerController,
  RasterRenderEntry,
  RasterTileCoordinate,
  RasterTileResponse,
  RasterTileSource,
} from './types.js';

export interface RasterControllerOptions extends WebMercatorRasterSelectorOptions {
  readonly source: RasterTileSource;
  readonly groundSurface?: TiledGroundSurface;
  readonly maxCacheTiles?: number;
  readonly fallbackMinZoom?: number;
  readonly retries?: number;
  readonly retryDelay?: (attempt: number, error: unknown) => number;
  readonly shouldRetry?: (error: unknown) => boolean;
  readonly attribution?: readonly string[];
  readonly selectTiles?: (frame: FrameState) => readonly RasterTileCoordinate[];
  readonly onError?: (error: Error) => void;
}

export interface RasterControllerSnapshot {
  readonly requested: number;
  readonly attempts: number;
  readonly retried: number;
  readonly selected: number;
  readonly fallbacks: number;
  readonly loading: number;
  readonly ready: number;
  readonly missing: number;
  readonly failed: number;
  readonly aborted: number;
  readonly evicted: number;
}

export interface RasterController extends RasterLayerController {
  snapshot(): RasterControllerSnapshot;
}

interface TileRecord {
  readonly tile: RasterTileCoordinate;
  readonly abort: AbortController;
  status: 'loading' | 'ready' | 'missing' | 'error';
  response?: RasterTileResponse;
  height?: HeightTile;
}

function tileKey(tile: RasterTileCoordinate): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function tileBounds(tile: RasterTileCoordinate): RasterRenderEntry['bounds'] {
  const width = 2 ** tile.z;
  const latitude = (y: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / width))) * 180) / Math.PI;
  return {
    west: (tile.x / width) * 360 - 180,
    east: ((tile.x + 1) / width) * 360 - 180,
    north: latitude(tile.y),
    south: latitude(tile.y + 1),
  };
}

function ancestor(tile: RasterTileCoordinate, zoom: number): RasterTileCoordinate {
  const scale = 2 ** (tile.z - zoom);
  return { z: zoom, x: Math.floor(tile.x / scale), y: Math.floor(tile.y / scale) };
}

type ReadyRecord = TileRecord & { readonly response: RasterTileResponse };
function isReady(record: TileRecord | undefined): record is ReadyRecord {
  return record?.status === 'ready' && record.response !== undefined;
}
function children(tile: RasterTileCoordinate): RasterTileCoordinate[] {
  return [0, 1, 2, 3].map((i) => ({
    z: tile.z + 1,
    x: tile.x * 2 + (i & 1),
    y: tile.y * 2 + (i >> 1),
  }));
}

function tileUv(
  tile: RasterTileCoordinate,
  sourceTile: RasterTileCoordinate,
): RasterRenderEntry['uv'] {
  const scale = 2 ** (tile.z - sourceTile.z);
  const offsetX = tile.x - sourceTile.x * scale;
  const offsetY = tile.y - sourceTile.y * scale;
  return {
    west: offsetX / scale,
    north: offsetY / scale,
    east: (offsetX + 1) / scale,
    south: (offsetY + 1) / scale,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(
        error &&
          typeof error === 'object' &&
          'name' in error &&
          (error as { name?: unknown }).name === 'AbortError',
      );
}

/** The current selection and everything derived from it, replaced as one value
 * so the tiles, their coverage ancestors and the change signature cannot drift apart. */
interface Selection {
  readonly tiles: readonly RasterTileCoordinate[];
  readonly coverage: readonly RasterTileCoordinate[];
  /** Everything the publish step may read for these tiles — the tiles, their
   * coverage and every ancestor in between — coarsest first. One definition
   * drives loading, cancellation and eviction, so a fallback the publish step
   * could use is requested early and never thrown away first. */
  readonly wanted: ReadonlyMap<string, RasterTileCoordinate>;
  readonly signature: string;
}

const EMPTY_SELECTION: Selection = { tiles: [], coverage: [], wanted: new Map(), signature: '' };

function resolveSelection(
  tiles: readonly RasterTileCoordinate[],
  signature: string,
  fallbackMinZoom: number,
): Selection {
  const coverage = new Map<string, RasterTileCoordinate>();
  const byZoom = new Map<number, Map<string, RasterTileCoordinate>>();
  const want = (tile: RasterTileCoordinate): void => {
    let level = byZoom.get(tile.z);
    if (!level) byZoom.set(tile.z, (level = new Map()));
    level.set(tileKey(tile), tile);
  };
  for (const tile of tiles) {
    want(tile);
    if (tile.z <= fallbackMinZoom) continue;
    const value = ancestor(tile, fallbackMinZoom);
    coverage.set(tileKey(value), value);
    for (let zoom = fallbackMinZoom; zoom < tile.z; zoom++) want(ancestor(tile, zoom));
  }
  const wanted = new Map<string, RasterTileCoordinate>();
  for (const zoom of [...byZoom.keys()].sort((a, b) => a - b)) {
    for (const [key, tile] of byZoom.get(zoom)!) wanted.set(key, tile);
  }
  return { tiles: [...tiles], coverage: [...coverage.values()], wanted, signature };
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, delay),
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Own viewport-driven XYZ requests and ImageBitmap lifetimes. */
export function createRasterController(options: RasterControllerOptions): RasterController {
  if (!options?.source || typeof options.source.getTile !== 'function') {
    throw new TypeError('raster source.getTile is required');
  }
  if (
    options.groundSurface &&
    (typeof options.groundSurface.heightAt !== 'function' ||
      typeof options.groundSurface.fetchHeights !== 'function' ||
      typeof options.groundSurface.attribution !== 'function')
  ) {
    throw new TypeError(
      'groundSurface.heightAt, groundSurface.fetchHeights, and groundSurface.attribution are required',
    );
  }
  const selectorOptions: WebMercatorRasterSelectorOptions = {
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    tileSize: options.tileSize,
    maxTiles: options.maxTiles,
  };
  const maxSelectedTiles = options.maxTiles ?? 160;
  const maxCacheTiles = options.maxCacheTiles ?? DEFAULT_MAX_CACHE_TILES;
  const fallbackMinZoom = options.fallbackMinZoom ?? options.minZoom ?? 2;
  const retries = options.retries ?? 2;
  if (!Number.isInteger(maxCacheTiles) || maxCacheTiles < maxSelectedTiles) {
    throw new RangeError('maxCacheTiles must be an integer not smaller than maxTiles');
  }
  if (!Number.isInteger(fallbackMinZoom) || fallbackMinZoom < 0 || fallbackMinZoom > 30) {
    throw new RangeError('fallbackMinZoom must be an integer within 0..30');
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError('retries must be a non-negative integer');
  }
  if (options.retryDelay !== undefined && typeof options.retryDelay !== 'function') {
    throw new TypeError('retryDelay must be a function');
  }
  if (options.shouldRetry !== undefined && typeof options.shouldRetry !== 'function') {
    throw new TypeError('shouldRetry must be a function');
  }
  // Recency is the cache's insertion order: get() touches, peek() does not.
  const records = new BoundedCache<string, TileRecord>({ limit: maxCacheTiles });
  let context: LayerContext | null = null;
  let destroyed = false;
  let requested = 0;
  let attempts = 0;
  let retried = 0;
  let failed = 0;
  let aborted = 0;
  let evicted = 0;
  let selection = EMPTY_SELECTION;
  let entriesDirty = true;
  let fallbacks = 0;

  const release = (record: TileRecord): void => {
    if (record.status === 'loading' && !record.abort.signal.aborted) aborted++;
    record.abort.abort();
    record.response?.image.close();
  };

  const start = (tile: RasterTileCoordinate): void => {
    const key = tileKey(tile);
    const record: TileRecord = {
      tile,
      abort: new AbortController(),
      status: 'loading',
    };
    records.set(key, record);
    requested++;
    const load = async (): Promise<RasterTileResponse | undefined> => {
      let attempt = 0;
      while (true) {
        attempt++;
        attempts++;
        try {
          return await options.source.getTile(tile.z, tile.x, tile.y, {
            signal: record.abort.signal,
          });
        } catch (error) {
          if (record.abort.signal.aborted || isAbort(error)) throw error;
          const retryable = options.shouldRetry?.(error) ?? isRetryableError(error);
          if (attempt > retries || !retryable) throw error;
          retried++;
          const delay = options.retryDelay?.(attempt, error) ?? retryDelay(attempt, error);
          await waitForRetry(delay, record.abort.signal);
        }
      }
    };
    const height = options.groundSurface
      ? options.groundSurface.fetchHeights(tile.z, tile.x, tile.y).catch((error: unknown) => {
          if (!destroyed && records.peek(key) === record && !isAbort(error)) {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
          return undefined;
        })
      : Promise.resolve(undefined);
    void Promise.all([load(), height])
      .then(([response, heightTile]) => {
        if (destroyed || records.peek(key) !== record) {
          response?.image.close();
          return;
        }
        record.response = response;
        record.height = heightTile;
        record.status = response ? 'ready' : 'missing';
        entriesDirty = true;
        context?.invalidate();
      })
      .catch((error: unknown) => {
        if (destroyed || records.peek(key) !== record) return;
        if (isAbort(error)) {
          aborted++;
          records.delete(key);
          return;
        }
        record.status = 'error';
        entriesDirty = true;
        failed++;
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        context?.invalidate();
      });
  };

  return {
    init(value): void {
      if (destroyed) throw new Error('raster controller is destroyed');
      if (context) throw new Error('raster controller is already initialized');
      context = value;
    },
    update(frame) {
      if (destroyed) throw new Error('raster controller is destroyed');
      if (!context) throw new Error('raster controller is not initialized');
      // Selection is cheap (<= 0.01 ms for 96 tiles),
      // so it runs every update and only the resulting tile list gates the work below.
      const nextTiles =
        options.selectTiles?.(frame) ?? selectWebMercatorRasterTiles(frame, selectorOptions);
      const nextSignature = nextTiles.map(tileKey).join(',');
      if (nextSignature !== selection.signature) {
        selection = resolveSelection(nextTiles, nextSignature, fallbackMinZoom);
        entriesDirty = true;
        for (const [key, record] of records) {
          if (!selection.wanted.has(key) && record.status === 'loading') {
            release(record);
            records.delete(key);
          }
        }
        // Touch in wanted order (that order is what survives once they leave the selection).
        for (const [key, tile] of selection.wanted) {
          if (!records.get(key)) start(tile);
        }
        for (const [, record] of records.prune((key) => selection.wanted.has(key))) {
          release(record);
          evicted++;
        }
      }
      if (!entriesDirty) return {};
      const entries: RasterRenderEntry[] = [];
      fallbacks = 0;
      const coverageKeys = new Set(selection.coverage.map(tileKey));
      // One rule for what draws in a selected tile's footprint: the tile itself
      // when ready; else, if any child is ready, each quadrant resolved the
      // same way (quadrants without a ready child cut their piece out of the
      // nearest ready ancestor); else the nearest ready ancestor. Quadrants
      // never overlap, and the recursion only descends through cached tiles.
      // Entry keys stay the tile's own, so the backend reuses meshes across
      // zoom levels; `selected` is the tile the entry stands in for.
      const publish = (
        record: ReadyRecord,
        tile: RasterTileCoordinate,
        selected: RasterTileCoordinate,
      ): void => {
        records.get(tileKey(record.tile));
        entries.push({
          key: tileKey(tile),
          sourceKey: tileKey(record.tile),
          tile,
          sourceTile: record.tile,
          image: record.response.image,
          height: record.height,
          bounds: tileBounds(tile),
          uv: tileUv(tile, record.tile),
        });
        if (record.tile.z !== selected.z) fallbacks++;
      };
      const resolve = (tile: RasterTileCoordinate, selected: RasterTileCoordinate): void => {
        const own = records.peek(tileKey(tile));
        if (isReady(own)) {
          publish(own, tile, selected);
          return;
        }
        const quadrants = children(tile);
        if (quadrants.some((child) => isReady(records.peek(tileKey(child))))) {
          for (const child of quadrants) resolve(child, selected);
          return;
        }
        for (let zoom = tile.z - 1; zoom >= fallbackMinZoom; zoom--) {
          const candidateTile = ancestor(tile, zoom);
          if (zoom === fallbackMinZoom && coverageKeys.has(tileKey(candidateTile))) {
            // The full parent coverage mesh published below already fills this region.
            fallbacks++;
            return;
          }
          const candidate = records.peek(tileKey(candidateTile));
          if (!isReady(candidate)) continue;
          publish(candidate, tile, selected);
          return;
        }
      };
      for (const tile of selection.tiles) resolve(tile, tile);
      const selectedKeys = new Set(selection.tiles.map(tileKey));
      for (const tile of selection.coverage) {
        const sourceKey = tileKey(tile);
        if (selectedKeys.has(sourceKey)) continue;
        const record = records.peek(sourceKey);
        if (record?.status !== 'ready' || !record.response) continue;
        records.get(sourceKey);
        entries.push({
          key: `coverage:${sourceKey}`,
          sourceKey,
          tile,
          sourceTile: tile,
          image: record.response.image,
          height: record.height,
          bounds: tileBounds(tile),
          uv: tileUv(tile, tile),
        });
      }
      entriesDirty = false;
      return { entries };
    },
    attribution(): readonly string[] {
      return [
        ...new Set([
          ...(options.attribution ?? []),
          ...(options.groundSurface?.attribution() ?? []),
        ]),
      ];
    },
    snapshot(): RasterControllerSnapshot {
      const values = [...records.values()];
      return {
        requested,
        attempts,
        retried,
        selected: selection.tiles.length,
        fallbacks,
        loading: values.filter((record) => record.status === 'loading').length,
        ready: values.filter((record) => record.status === 'ready').length,
        missing: values.filter((record) => record.status === 'missing').length,
        failed,
        aborted,
        evicted,
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const record of records.values()) release(record);
      records.clear();
      selection = EMPTY_SELECTION;
      options.source.destroy?.();
      context = null;
    },
  };
}
