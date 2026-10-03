/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { TileHttpError, assertWebMercatorTile } from 'teluala';
import { abortReason, type RasterTileResponse, type RasterTileSource } from './types.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type DecodeImage = (blob: Blob) => Promise<ImageBitmap>;

export interface XyzRasterTileSourceOptions {
  readonly url: string;
  readonly fetch?: FetchLike;
  readonly decodeImage?: DecodeImage;
}

/** Create a browser XYZ image source without importing the Teluala engine. */
export function createXyzRasterTileSource(options: XyzRasterTileSourceOptions): RasterTileSource {
  if (
    !options ||
    typeof options.url !== 'string' ||
    !['{z}', '{x}', '{y}'].every((token) => options.url.includes(token))
  ) {
    throw new TypeError('XYZ URL must contain {z}, {x}, and {y}');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('fetch is not available');
  const decodeImage =
    options.decodeImage ??
    (typeof createImageBitmap === 'function' ? createImageBitmap.bind(globalThis) : undefined);
  if (!decodeImage) throw new Error('createImageBitmap is not available');

  return {
    async getTile(z, x, y, { signal }): Promise<RasterTileResponse | undefined> {
      assertWebMercatorTile(z, x, y);
      if (signal.aborted) throw abortReason(signal);
      const url = options.url
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const response = await fetchImpl(url, { signal });
      if (response.status === 404 || response.status === 204) return undefined;
      if (!response.ok) {
        throw new TileHttpError(
          response.status,
          url,
          response.headers.get('retry-after') ?? undefined,
        );
      }
      const image = await decodeImage(await response.blob());
      return {
        image,
        cacheControl: response.headers.get('cache-control') ?? undefined,
        expires: response.headers.get('expires') ?? undefined,
      };
    },
  };
}
