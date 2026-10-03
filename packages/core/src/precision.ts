/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/**
 * Placement of Float32 geometry at double precision.
 *
 * World coordinates are normalized to the WGS84 semi-major axis, so a Float32
 * position on the surface carries a 0.2–0.4 m quantum. Layers therefore keep
 * their vertices as small Float32 offsets from a per-mesh origin (a tile
 * centre, a model anchor) and upload vp × placement, formed here from the
 * frame's double-precision `vp64` and rounded to Float32 once, at the write.
 * The same functions serve the pick pass with `pickVp` / `pickVp64`.
 */

/**
 * Writes vp × translate(origin) into `out` (16 floats, column-major). Only the
 * fourth column depends on the origin. Without `vp64` the Float32 `vp` is used
 * and the placement keeps the Float32 quantum.
 */
export function viewProjectionAt(
  out: Float32Array,
  vp: Float32Array,
  vp64: Float64Array | undefined,
  originX: number,
  originY: number,
  originZ: number,
): Float32Array {
  const a: ArrayLike<number> = vp64 !== undefined && vp64.length === 16 ? vp64 : vp;
  for (let i = 0; i < 12; i++) out[i] = a[i];
  for (let row = 0; row < 4; row++) {
    out[12 + row] = a[row] * originX + a[4 + row] * originY + a[8 + row] * originZ + a[12 + row];
  }
  return out;
}

/**
 * Writes vp × model into `out` (16 floats, column-major) for a general model
 * matrix (rotation and translation, e.g. a local east-north-up frame), or vp
 * itself when `model` is undefined.
 */
export function composeViewProjection(
  out: Float32Array,
  vp: Float32Array,
  vp64: Float64Array | undefined,
  model: ArrayLike<number> | undefined,
): Float32Array {
  if (model === undefined) {
    out.set(vp);
    return out;
  }
  const a: ArrayLike<number> = vp64 !== undefined && vp64.length === 16 ? vp64 : vp;
  for (let column = 0; column < 4; column++) {
    const b0 = model[column * 4],
      b1 = model[column * 4 + 1];
    const b2 = model[column * 4 + 2],
      b3 = model[column * 4 + 3];
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b0 + a[4 + row] * b1 + a[8 + row] * b2 + a[12 + row] * b3;
    }
  }
  return out;
}
