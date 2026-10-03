/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { TileHttpError, assertWebMercatorTile } from 'teluala';
import type { MvtTileResponse, MvtTileSource } from './mvtController.js';

export interface XyzMvtTileSourceOptions {
  readonly urlTemplate: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestInit?: RequestInit;
  readonly maxZoom?: number;
}

export interface PmtilesHeaderLike {
  readonly specVersion: number;
  /** Official pmtiles TileType.Mvt enum value is 1. */
  readonly tileType: number;
}

export interface PmtilesArchiveLike {
  getHeader(): Promise<PmtilesHeaderLike> | PmtilesHeaderLike;
  getZxy(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<MvtTileResponse | undefined>;
  destroy?(): void;
}

function headerValue(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}

class DefaultXyzMvtTileSource implements MvtTileSource {
  #urlTemplate: string;
  #fetch: typeof globalThis.fetch;
  #requestInit: RequestInit;
  #maxZoom: number;

  constructor(options: XyzMvtTileSourceOptions) {
    if (!options || typeof options.urlTemplate !== 'string' || options.urlTemplate.length === 0) {
      throw new TypeError('urlTemplate is required');
    }
    if (!['{z}', '{x}', '{y}'].every((token) => options.urlTemplate.includes(token))) {
      throw new TypeError('urlTemplate must include {z}, {x}, and {y}');
    }
    // Bind browser fetch to its global receiver to avoid illegal invocation.
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.#maxZoom = options.maxZoom ?? 30;
    if (!Number.isInteger(this.#maxZoom) || this.#maxZoom < 0 || this.#maxZoom > 30) {
      throw new RangeError('maxZoom must be an integer within 0..30');
    }
    this.#urlTemplate = options.urlTemplate;
    this.#fetch = fetchImpl;
    this.#requestInit = options.requestInit ?? {};
  }

  urlFor(z: number, x: number, y: number): string {
    assertWebMercatorTile(z, x, y, this.#maxZoom);
    return this.#urlTemplate
      .replaceAll('{z}', String(z))
      .replaceAll('{x}', String(x))
      .replaceAll('{y}', String(y));
  }

  async getTile(
    z: number,
    x: number,
    y: number,
    options: { readonly signal: AbortSignal },
  ): Promise<MvtTileResponse | undefined> {
    options.signal.throwIfAborted();
    const response = await this.#fetch(this.urlFor(z, x, y), {
      ...this.#requestInit,
      signal: options.signal,
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new TileHttpError(
        response.status,
        response.url || this.urlFor(z, x, y),
        headerValue(response.headers, 'retry-after'),
      );
    }
    return {
      data: await response.arrayBuffer(),
      cacheControl: headerValue(response.headers, 'cache-control'),
      expires: headerValue(response.headers, 'expires'),
    };
  }
}

class DefaultPmtilesMvtTileSource implements MvtTileSource {
  #archive: PmtilesArchiveLike;
  #header?: Promise<PmtilesHeaderLike>;

  constructor(archive: PmtilesArchiveLike) {
    if (
      !archive ||
      typeof archive.getHeader !== 'function' ||
      typeof archive.getZxy !== 'function'
    ) {
      throw new TypeError('PMTiles archive must provide getHeader and getZxy');
    }
    this.#archive = archive;
  }

  #mvtHeader(): Promise<PmtilesHeaderLike> {
    this.#header ??= Promise.resolve(this.#archive.getHeader()).then((header) => {
      if (header.specVersion !== 3) {
        throw new Error(`unsupported PMTiles spec version: ${header.specVersion}`);
      }
      if (header.tileType !== 1) throw new TypeError('PMTiles archive does not contain MVT tiles');
      return header;
    });
    return this.#header;
  }

  async getTile(
    z: number,
    x: number,
    y: number,
    options: { readonly signal: AbortSignal },
  ): Promise<MvtTileResponse | undefined> {
    assertWebMercatorTile(z, x, y, 26);
    options.signal.throwIfAborted();
    await this.#mvtHeader();
    options.signal.throwIfAborted();
    return this.#archive.getZxy(z, x, y, options.signal);
  }

  destroy(): void {
    this.#archive.destroy?.();
  }
}

export function createXyzMvtTileSource(options: XyzMvtTileSourceOptions): MvtTileSource & {
  urlFor(z: number, x: number, y: number): string;
} {
  return new DefaultXyzMvtTileSource(options);
}

/** Adapt an official `pmtiles` PMTiles instance without making PMTiles mandatory for XYZ users. */
export function createPmtilesMvtTileSource(archive: PmtilesArchiveLike): MvtTileSource {
  return new DefaultPmtilesMvtTileSource(archive);
}
