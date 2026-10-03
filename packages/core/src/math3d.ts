/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
export type Vec3 = [number, number, number];
export type Mat4 = number[];
export const v3 = {
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};
export function perspectiveZ01(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2),
    nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0];
}
export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const z = v3.norm(v3.sub(eye, center)),
    x = v3.norm(v3.cross(up, z)),
    y = v3.cross(z, x);
  return [
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ];
}
export function mul4(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
export const WGS84_A = 1;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const D2R = Math.PI / 180;
export function ecef(lonDeg: number, latDeg: number, alt: number): Vec3 {
  const la = latDeg * D2R,
    lo = lonDeg * D2R;
  const s = Math.sin(la),
    c = Math.cos(la);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  return [
    (N + alt) * c * Math.cos(lo),
    (N + alt) * c * Math.sin(lo),
    (N * (1 - WGS84_E2) + alt) * s,
  ];
}
export function geodeticNormal(lonDeg: number, latDeg: number): Vec3 {
  const la = latDeg * D2R,
    lo = lonDeg * D2R,
    c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}
/** Where a ray meets the ground, or, when it passes the globe, the surface
 * point nearest to it (the horizon in that direction). Continuous across the
 * limb: a grazing ray's intersection is its own nearest point. */
export function rayEllipsoidNearest(o: Vec3, d: Vec3): [number, number] {
  const hit = rayEllipsoid(o, d);
  if (hit) return hit;
  // In the sphere-scaled space the nearest point of the ray to the centre,
  // projected onto the sphere, is the nearest surface point.
  const sc = 1 / Math.sqrt(1 - WGS84_E2);
  const oq = [o[0], o[1], o[2] * sc],
    dq = [d[0], d[1], d[2] * sc];
  const t = Math.max(
    0,
    -(oq[0] * dq[0] + oq[1] * dq[1] + oq[2] * dq[2]) /
      (dq[0] * dq[0] + dq[1] * dq[1] + dq[2] * dq[2]),
  );
  const px = oq[0] + dq[0] * t,
    py = oq[1] + dq[1] * t,
    pz = oq[2] + dq[2] * t;
  const k = WGS84_A / Math.hypot(px, py, pz);
  const hx = px * k,
    hy = py * k,
    hz = (pz * k) / sc;
  return [Math.atan2(hy, hx) / D2R, Math.atan2(hz / (1 - WGS84_E2), Math.hypot(hx, hy)) / D2R];
}

export function rayEllipsoid(o: Vec3, d: Vec3): [number, number] | null {
  const sc = 1 / Math.sqrt(1 - WGS84_E2);
  const oq = [o[0], o[1], o[2] * sc],
    dq = [d[0], d[1], d[2] * sc];
  const A = dq[0] * dq[0] + dq[1] * dq[1] + dq[2] * dq[2];
  const B = 2 * (oq[0] * dq[0] + oq[1] * dq[1] + oq[2] * dq[2]);
  const C = oq[0] * oq[0] + oq[1] * oq[1] + oq[2] * oq[2] - WGS84_A * WGS84_A;
  if (C < 0) return null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  let t = (-B - Math.sqrt(disc)) / (2 * A);
  if (t < 0) t = (-B + Math.sqrt(disc)) / (2 * A);
  if (t < 0) return null;
  const hx = o[0] + d[0] * t,
    hy = o[1] + d[1] * t,
    hz = o[2] + d[2] * t;
  return [Math.atan2(hy, hx) / D2R, Math.atan2(hz / (1 - WGS84_E2), Math.hypot(hx, hy)) / D2R];
}
