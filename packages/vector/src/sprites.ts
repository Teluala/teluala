/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/** Mapbox-compatible sprite rectangles; all source measurements are image pixels. */
export interface SpriteRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}
export interface VectorSpriteAtlas {
  readonly image: ImageBitmap;
  readonly entries: Readonly<Record<string, SpriteRectangle>>;
}

export function validateSpriteEntries(
  value: unknown,
  width: number,
  height: number,
): Readonly<Record<string, SpriteRectangle>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sprite metadata must be an object');
  }
  const result: Record<string, SpriteRectangle> = Object.create(null);
  for (const [name, raw] of Object.entries(value)) {
    const r = raw as SpriteRectangle;
    if (
      !r ||
      ![r.x, r.y, r.width, r.height].every(Number.isInteger) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x + r.width > width ||
      r.y + r.height > height ||
      !Number.isFinite(r.pixelRatio) ||
      r.pixelRatio <= 0
    ) {
      throw new RangeError(`invalid sprite rectangle: ${name}`);
    }
    result[name] = { x: r.x, y: r.y, width: r.width, height: r.height, pixelRatio: r.pixelRatio };
  }
  return Object.freeze(result);
}

/** Caller owns the returned ImageBitmap and closes it after all backends detach it. */
export async function loadVectorSpriteAtlas(
  jsonUrl: string,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<VectorSpriteAtlas> {
  const [metadata, response] = await Promise.all([
    fetch(jsonUrl, { signal }),
    fetch(imageUrl, { signal }),
  ]);
  if (!metadata.ok || !response.ok) {
    throw new Error(`sprite fetch failed: ${metadata.status}/${response.status}`);
  }
  const [json, blob] = await Promise.all([metadata.json(), response.blob()]);
  signal?.throwIfAborted();
  const image = await createImageBitmap(blob);
  try {
    signal?.throwIfAborted();
    return { image, entries: validateSpriteEntries(json, image.width, image.height) };
  } catch (error) {
    image.close();
    throw error;
  }
}
