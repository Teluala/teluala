/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
// Fixed frames for the Web Mercator tile selection golden test. Each case
// names the situation it pins so a diff in the golden file reads as a
// behaviour change, not noise.
const frame = (camera, viewBBox, viewportPx = { width: 1000, height: 700, dpr: 1 }) => ({
  camera: { heading: 0, pitch: -1, roll: 0, ...camera },
  viewBBox,
  fovYRad: Math.PI / 4,
  viewportPx,
});

export const cases = [
  {
    name: 'munich near',
    frame: frame(
      { lon: 11.575, lat: 48.137, range: 0.018 },
      { west: 11.0, south: 47.75, east: 12.0, north: 48.55 },
    ),
  },
  {
    name: 'munich near, retina',
    frame: frame(
      { lon: 11.575, lat: 48.137, range: 0.018 },
      { west: 11.0, south: 47.75, east: 12.0, north: 48.55 },
      { width: 2000, height: 1400, dpr: 2 },
    ),
  },
  {
    name: 'whole globe',
    frame: frame({ lon: 0, lat: 20, range: 2.4 }, { west: -80, south: -60, east: 80, north: 85 }),
  },
  {
    name: 'dateline crossing',
    frame: frame(
      { lon: 179.9, lat: -16.5, range: 0.05 },
      { west: 178.5, south: -18, east: -178.7, north: -15 },
    ),
  },
  {
    name: 'high latitude',
    frame: frame({ lon: 25, lat: 80, range: 0.03 }, { west: 10, south: 78, east: 40, north: 84.9 }),
  },
  {
    name: 'polar bbox beyond mercator limit',
    frame: frame({ lon: 0, lat: 84, range: 0.05 }, { west: -30, south: 80, east: 30, north: 89.5 }),
  },
  {
    name: 'budget-limited wide view',
    frame: frame({ lon: 10, lat: 45, range: 0.2 }, { west: -20, south: 30, east: 40, north: 60 }),
    options: { maxTiles: 8 },
  },
  {
    name: 'min zoom clamp',
    frame: frame({ lon: 0, lat: 0, range: 3 }, { west: -90, south: -60, east: 90, north: 60 }),
    options: { minZoom: 3 },
  },
  {
    name: 'max zoom clamp',
    frame: frame(
      { lon: 11.575, lat: 48.137, range: 0.0002 },
      { west: 11.565, south: 48.127, east: 11.585, north: 48.147 },
    ),
    options: { maxZoom: 12 },
  },
  {
    name: 'tile size 512',
    frame: frame(
      { lon: 11.575, lat: 48.137, range: 0.018 },
      { west: 11.0, south: 47.75, east: 12.0, north: 48.55 },
    ),
    options: { tileSize: 512 },
  },
  {
    name: 'raster defaults',
    frame: frame(
      { lon: 11.575, lat: 48.137, range: 0.018 },
      { west: 11.0, south: 47.75, east: 12.0, north: 48.55 },
    ),
    options: { minZoom: 2, maxZoom: 18, maxTiles: 160 },
  },
  {
    name: 'tiny viewport',
    frame: frame(
      { lon: 11.575, lat: 48.137, range: 0.018 },
      { west: 11.0, south: 47.75, east: 12.0, north: 48.55 },
      { width: 64, height: 48, dpr: 1 },
    ),
  },
  { name: 'no bbox', frame: frame({ lon: 0, lat: 0, range: 1 }, null) },
  {
    name: 'non-finite camera',
    frame: frame({ lon: Number.NaN, lat: 0, range: 1 }, { west: -1, south: -1, east: 1, north: 1 }),
  },
];
