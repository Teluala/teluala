/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export type ScreenPoint = readonly [number, number];
export interface PathSample {
  x: number;
  y: number;
  angle: number;
}
export function pathLength(points: readonly ScreenPoint[]): number {
  return points
    .slice(1)
    .reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
}
export function samplePath(points: readonly ScreenPoint[], distance: number): PathSample | null {
  if (distance < 0) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    if (distance <= length) {
      const t = distance / length;
      return {
        x: a[0] + t * (b[0] - a[0]),
        y: a[1] + t * (b[1] - a[1]),
        angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
      };
    }
    distance -= length;
  }
  return null;
}
export function repeatedPathSamples(
  points: readonly ScreenPoint[],
  spacing: number,
  limit = 256,
): PathSample[] {
  if (!Number.isFinite(spacing) || spacing <= 0) throw new RangeError('spacing must be positive');
  const length = pathLength(points),
    out: PathSample[] = [];
  for (let distance = spacing / 2; distance < length && out.length < limit; distance += spacing) {
    const p = samplePath(points, distance);
    if (p) out.push(p);
  }
  return out;
}
export function rotatedBox(
  x: number,
  y: number,
  width: number,
  height: number,
  angle: number,
): readonly [number, number, number, number] {
  const w = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
  const h = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2;
  return [x - w - 2, y - h - 2, x + w + 2, y + h + 2];
}
/** Clip tile-buffer paths to a requested tile, preserving disjoint runs. */
export function clipPath(
  points: readonly ScreenPoint[],
  bounds: readonly [number, number, number, number],
): ScreenPoint[][] {
  const out: ScreenPoint[][] = [];
  let run: ScreenPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    let lo = 0,
      hi = 1;
    const ps = [-dx, dx, -dy, dy],
      qs = [a[0] - bounds[0], bounds[2] - a[0], a[1] - bounds[1], bounds[3] - a[1]];
    let valid = true;
    for (let j = 0; j < 4; j++) {
      if (ps[j] === 0) {
        if (qs[j] < 0) valid = false;
      } else {
        const t = qs[j] / ps[j];
        if (ps[j] < 0) lo = Math.max(lo, t);
        else hi = Math.min(hi, t);
      }
    }
    if (!valid || lo >= hi) {
      if (run.length > 1) out.push(run);
      run = [];
      continue;
    }
    const start: ScreenPoint = [a[0] + dx * lo, a[1] + dy * lo],
      end: ScreenPoint = [a[0] + dx * hi, a[1] + dy * hi];
    if (run.length && (run.at(-1)![0] !== start[0] || run.at(-1)![1] !== start[1])) {
      out.push(run);
      run = [];
    }
    if (!run.length) run.push(start);
    run.push(end);
  }
  if (run.length > 1) out.push(run);
  return out;
}

export function graphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
    (part) => part.segment,
  );
}
/** Place graphemes along a line, reversing leftward runs to keep text upright. */
export function lineTextSamples(
  points: readonly ScreenPoint[],
  advances: readonly number[],
  maxAngle = Math.PI / 4,
): PathSample[] {
  const length = pathLength(points),
    textWidth = advances.reduce((a, b) => a + b, 0);
  if (!textWidth || textWidth > length) return [];
  let path = points;
  const middle = samplePath(points, length / 2);
  if (!middle) return [];
  if (Math.cos(middle.angle) < 0) path = [...points].reverse();
  let cursor = (length - textWidth) / 2;
  const out: PathSample[] = [];
  for (const advance of advances) {
    const p = samplePath(path, cursor + advance / 2);
    if (!p) return [];
    if (out.length) {
      let delta = p.angle - out.at(-1)!.angle;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      if (Math.abs(delta) > maxAngle) return [];
    }
    out.push(p);
    cursor += advance;
  }
  return out;
}
