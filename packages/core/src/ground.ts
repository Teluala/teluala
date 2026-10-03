/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/** Format-independent source of ground height in metres above WGS84. */
export interface GroundSurface {
  heightAt(lon: number, lat: number): number;
  /** Notify the engine when newly available samples may change heightAt(). */
  subscribe?(listener: () => void): () => void;
}

/** Read-only shared square grid in metres above WGS84, matching GroundSurface.
 * Samples are row-major, west to east and north to south across the tile.
 * Consumers must not mutate or transfer data, including after cache eviction.
 * No height-datum conversion is performed by this contract.
 */
export interface HeightTile {
  readonly size: number;
  readonly data: Float32Array;
}

/** Optional Web Mercator XYZ grid access for surface-draped layers.
 * Acquiring a tile is asynchronous; heightAt() only samples cached data.
 * A missing tile resolves undefined, an unavailable heightAt() sample is NaN.
 * The application owns this service; consumers must not destroy it.
 */
export interface TiledGroundSurface extends GroundSurface {
  fetchHeights(z: number, x: number, y: number): Promise<HeightTile | undefined>;
  attribution(): readonly string[];
}
