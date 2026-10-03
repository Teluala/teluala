/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { WORLD_PER_METER, assertWebMercatorTile } from 'teluala';

import type { VectorMesh } from './types.js';

const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

export interface PreparedWorldMesh {
  /**
   * The mesh origin in world units (double precision): the source tile's
   * centre on the surface datum. `positions` are Float32 offsets from it, so
   * the backend places the mesh with vp × translate(origin) formed from the
   * frame's vp64 (teluala `viewProjectionAt`) — Float32 world positions carry
   * a 0.2-0.4 m quantum that made coplanar surfaces of neighbouring tiles
   * and layers swap depth winners as the camera moved.
   */
  readonly origin: readonly [number, number, number];
  /** Float32 offsets from `origin` (world units), three per vertex. */
  readonly positions: Float32Array;
  readonly localPositions: Float32Array;
  readonly lineExtrudes?: Float32Array;
  /**
   * fill-extrusion only: per-vertex up-vector × height (world units). The
   * positions sit on the surface datum; the backend adds heightExtrudes ×
   * its height scale in the vertex shader, so heights can be animated
   * without re-preparing or re-uploading the mesh.
   */
  readonly heightExtrudes?: Float32Array;
}

export interface SourceTileCoordinate {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export function parseSourceTileKey(key: string): SourceTileCoordinate {
  if (typeof key !== 'string') throw new TypeError('source tile key must be a string');
  const values = key.split('/').map(Number);
  if (values.length !== 3 || !values.every(Number.isInteger)) {
    throw new TypeError(`invalid source tile key: ${key}`);
  }
  const [z, x, y] = values;
  assertWebMercatorTile(z, x, y);
  return { z, x, y };
}

export function sourceClipBounds(
  sourceTileKey: string,
  requestedTileKey: string | undefined,
  extent: number,
): readonly [number, number, number, number] {
  if (!Number.isFinite(extent) || extent <= 0) throw new RangeError('mesh extent must be positive');
  const source = parseSourceTileKey(sourceTileKey);
  const requested = requestedTileKey ? parseSourceTileKey(requestedTileKey) : source;
  const delta = requested.z - source.z;
  if (delta < 0) throw new RangeError('requested tile cannot be an ancestor of its source tile');
  const scale = 2 ** delta;
  if (
    Math.floor(requested.x / scale) !== source.x ||
    Math.floor(requested.y / scale) !== source.y
  ) {
    throw new RangeError('requested tile is not a descendant of its source tile');
  }
  // A native tile (no overzoom) is not clipped: features are drawn whole by
  // the tile that owns them (membership by representative point), so a
  // building straddling the tile edge must keep the part beyond the extent.
  // Clipping it at the extent would cut the far walls off straddling
  // buildings, leaving a missing front wall that shows the interior.
  if (delta === 0) return [-Infinity, -Infinity, Infinity, Infinity];
  const childX = requested.x - source.x * scale;
  const childY = requested.y - source.y * scale;
  const size = extent / scale;
  return [childX * size, childY * size, (childX + 1) * size, (childY + 1) * size];
}

function vertexWorld(
  tile: SourceTileCoordinate,
  localX: number,
  localY: number,
  extent: number,
  altitudeMeters: number,
) {
  const scale = 2 ** tile.z;
  const mercatorX = (tile.x + localX / extent) / scale;
  const mercatorY = (tile.y + localY / extent) / scale;
  const lon = mercatorX * Math.PI * 2 - Math.PI;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY)));
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const n = 1 / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const altitude = altitudeMeters * WORLD_PER_METER;
  return {
    position: [
      (n + altitude) * cosLat * cosLon,
      (n + altitude) * cosLat * sinLon,
      (n * (1 - WGS84_E2) + altitude) * sinLat,
    ],
    east: [-sinLon, cosLon, 0],
    south: [sinLat * cosLon, sinLat * sinLon, -cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

/** Convert tile-local MVT vertices into WGS84 ECEF offsets from the tile centre. */
export function prepareWorldMesh(
  mesh: VectorMesh,
  sourceTileKey: string,
  surfaceOffsetMeters = 1,
): PreparedWorldMesh {
  if (!Number.isFinite(mesh.extent) || mesh.extent <= 0) {
    throw new RangeError('mesh extent must be positive');
  }
  if (mesh.positions.length % 2 !== 0) throw new RangeError('mesh positions must contain XY pairs');
  if (!Number.isFinite(surfaceOffsetMeters)) {
    throw new TypeError('surfaceOffsetMeters must be finite');
  }
  const vertexCount = mesh.positions.length / 2;
  if (mesh.type === 'line' && mesh.extrudes.length !== mesh.positions.length) {
    throw new RangeError('line extrudes must match position XY pairs');
  }
  if (mesh.type === 'fill-extrusion' && mesh.heights.length !== vertexCount) {
    throw new RangeError('extrusion heights must match vertex count');
  }

  const tile = parseSourceTileKey(sourceTileKey);
  const origin = vertexWorld(
    tile,
    mesh.extent / 2,
    mesh.extent / 2,
    mesh.extent,
    surfaceOffsetMeters,
  ).position;
  const positions = new Float32Array(vertexCount * 3);
  const localPositions = new Float32Array(mesh.positions);
  const lineExtrudes = mesh.type === 'line' ? new Float32Array(vertexCount * 3) : undefined;
  const heightExtrudes =
    mesh.type === 'fill-extrusion' ? new Float32Array(vertexCount * 3) : undefined;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const world = vertexWorld(
      tile,
      mesh.positions[vertex * 2],
      mesh.positions[vertex * 2 + 1],
      mesh.extent,
      surfaceOffsetMeters,
    );
    positions[vertex * 3] = world.position[0] - origin[0];
    positions[vertex * 3 + 1] = world.position[1] - origin[1];
    positions[vertex * 3 + 2] = world.position[2] - origin[2];
    if (heightExtrudes && mesh.type === 'fill-extrusion') {
      const height = mesh.heights[vertex] * WORLD_PER_METER;
      heightExtrudes.set(
        [world.up[0] * height, world.up[1] * height, world.up[2] * height],
        vertex * 3,
      );
    }
    if (lineExtrudes && mesh.type === 'line') {
      const x = mesh.extrudes[vertex * 2];
      const y = mesh.extrudes[vertex * 2 + 1];
      lineExtrudes.set(
        [
          world.east[0] * x + world.south[0] * y,
          world.east[1] * x + world.south[1] * y,
          world.east[2] * x + world.south[2] * y,
        ],
        vertex * 3,
      );
    }
  }
  return {
    origin: [origin[0], origin[1], origin[2]],
    positions,
    localPositions,
    lineExtrudes,
    heightExtrudes,
  };
}
