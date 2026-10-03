/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { HeightTile } from './groundSurface.js';

export type DemEncoding = 'terrarium' | 'terrainrgb';

export function decodeTerrariumHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export function decodeTerrainRgbHeight(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

export function demDecoder(encoding: DemEncoding): (r: number, g: number, b: number) => number {
  if (encoding === 'terrarium') return decodeTerrariumHeight;
  if (encoding === 'terrainrgb') return decodeTerrainRgbHeight;
  throw new RangeError(`unsupported raster DEM encoding: ${String(encoding)}`);
}

export function decodeDemPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  encoding: DemEncoding,
  maximumGridSize = 128,
): HeightTile {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height !== width ||
    pixels.length !== width * height * 4
  ) {
    throw new RangeError('raster DEM pixels must describe a square RGBA image of size >= 2');
  }
  if (!Number.isInteger(maximumGridSize) || maximumGridSize < 2) {
    throw new RangeError('maximumGridSize must be an integer >= 2');
  }
  const decode = demDecoder(encoding);
  const step = Math.max(1, Math.ceil((width - 1) / (maximumGridSize - 1)));
  const size = Math.floor((width - 1) / step) + 1;
  const data = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    const sourceY = Math.min(row * step, height - 1);
    for (let column = 0; column < size; column++) {
      const sourceX = Math.min(column * step, width - 1);
      const offset = (sourceY * width + sourceX) * 4;
      const heightMeters = decode(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      data[row * size + column] = heightMeters;
    }
  }
  return { size, data };
}
