/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { FrameState } from 'teluala';
import { viewProjectionAt } from 'teluala';
import type { LineVectorMesh } from './types.js';
/** Project segment-quad vertices to cumulative CSS-pixel path distances. */
export function screenLineDistances(
  mesh: LineVectorMesh,
  positions: Float32Array,
  origin: readonly number[],
  frame: FrameState,
): Float32Array<ArrayBuffer> {
  const matrix = new Float32Array(16);
  viewProjectionAt(matrix, frame.vp, frame.vp64, origin[0], origin[1], origin[2]);
  const result = new Float32Array(positions.length / 3);
  const starts = new Set(mesh.pathStarts ?? []);
  const dpr = frame.viewportPx.dpr || 1;
  const project = (i: number) => {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    if (w <= 0) return null;
    return [
      (((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w) *
        frame.viewportPx.width) /
        dpr /
        2,
      (((matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w) *
        frame.viewportPx.height) /
        dpr /
        2,
    ];
  };
  let distance = 0;
  for (let i = 0; i + 3 < result.length; i += 4) {
    if (starts.has(i) || !mesh.pathStarts) distance = 0;
    const a = project(i),
      b = project(i + 2);
    result[i] = result[i + 1] = distance;
    if (a && b) distance += Math.min(1e6, Math.hypot(b[0] - a[0], b[1] - a[1]));
    result[i + 2] = result[i + 3] = distance;
  }
  return result;
}

export function validateDashArray(dash: readonly number[] | undefined): void {
  if (
    dash !== undefined &&
    (!Array.isArray(dash) ||
      dash.length < 2 ||
      dash.length > 8 ||
      dash.length % 2 !== 0 ||
      !dash.every((v) => Number.isFinite(v) && v > 0))
  ) {
    throw new RangeError('dashArray requires 2, 4, 6, or 8 positive CSS-pixel lengths');
  }
}
