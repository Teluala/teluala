/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';
import Protobuf from 'pbf';

import type { ExtrusionVectorMesh, FillVectorMesh, LineVectorMesh, VectorMesh } from './types.js';
import type { MvtTileProcessor, ProcessedMvtTile } from './mvtController.js';

const GEOMETRY_TYPES = { 1: 'point', 2: 'line', 3: 'polygon' } as const;
const PATH_ROLE = { PATH: 0, EXTERIOR: 1, HOLE: 2 } as const;

type GeometryType = 'point' | 'line' | 'polygon';
type Point = readonly [number, number];

interface GeometryPathPoint {
  readonly x: number;
  readonly y: number;
}

interface FeatureEntry {
  readonly featureIndex: number;
  readonly mvtId: number | null;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly paths: readonly (readonly GeometryPathPoint[])[];
}

interface IntermediateBucket {
  readonly layerName: string;
  readonly extent: number;
  readonly type: GeometryType;
  readonly featureCount: number;
  readonly featureIndices: Uint32Array;
  readonly mvtIds: readonly (number | null)[];
  readonly featurePathOffsets: Uint32Array;
  readonly pathOffsets: Uint32Array;
  readonly pathRoles: Uint8Array;
  readonly coordinates: Int32Array;
  readonly properties: readonly Readonly<Record<string, unknown>>[];
}

interface TransferableMesh {
  readonly transferables: readonly ArrayBuffer[];
}

type FillMeshResult = FillVectorMesh & TransferableMesh;
type LineMeshResult = LineVectorMesh & TransferableMesh;
type ExtrusionMeshResult = ExtrusionVectorMesh & TransferableMesh;

export interface MvtExtrusionProfile {
  readonly sourceLayer: string;
  readonly heightProperty?: string;
  readonly minHeightProperty?: string;
  readonly defaultHeight?: number;
  readonly defaultMinHeight?: number;
  readonly heightScale?: number;
}

export interface MvtProcessOptions {
  /** Initial source-layer allowlist. Omitted means all; an empty list means none. */
  readonly sourceLayers?: readonly string[];
  /** Generate paths for line labels (default true). Does not disable line meshes. */
  readonly includeLineFeatures?: boolean;
  readonly extrusionProfiles?: readonly MvtExtrusionProfile[];
}

export interface ProcessedMvtTileWithTransferables extends ProcessedMvtTile {
  readonly fillMeshes: readonly FillMeshResult[];
  readonly lineMeshes: readonly LineMeshResult[];
  readonly extrusionMeshes: readonly ExtrusionMeshResult[];
  readonly transferables: readonly ArrayBuffer[];
}

function arrayBuffer(value: ArrayBufferLike): ArrayBuffer {
  return value as ArrayBuffer;
}

function signedArea(path: readonly GeometryPathPoint[]): number {
  let area = 0;
  for (let index = 0, previous = path.length - 1; index < path.length; previous = index++) {
    const a = path[previous];
    const b = path[index];
    area += (b.x - a.x) * (a.y + b.y);
  }
  return area;
}

function polygonPathRoles(paths: readonly (readonly GeometryPathPoint[])[]): number[] {
  const roles = new Array<number>(paths.length).fill(PATH_ROLE.HOLE);
  let exteriorSign = 0;
  for (let index = 0; index < paths.length; index++) {
    const sign = Math.sign(signedArea(paths[index]));
    if (sign === 0) continue;
    if (exteriorSign === 0) exteriorSign = sign;
    roles[index] = sign === exteriorSign ? PATH_ROLE.EXTERIOR : PATH_ROLE.HOLE;
  }
  return roles;
}

function createBucket(
  layerName: string,
  extent: number,
  type: GeometryType,
  entries: readonly FeatureEntry[],
): IntermediateBucket {
  const coordinates: number[] = [];
  const pathOffsets = [0];
  const featurePathOffsets = [0];
  const pathRoles: number[] = [];
  const featureIndices: number[] = [];
  const mvtIds: Array<number | null> = [];
  const properties: Array<Readonly<Record<string, unknown>>> = [];
  for (const entry of entries) {
    const roles =
      type === 'polygon'
        ? polygonPathRoles(entry.paths)
        : new Array<number>(entry.paths.length).fill(PATH_ROLE.PATH);
    featureIndices.push(entry.featureIndex);
    mvtIds.push(entry.mvtId);
    properties.push(entry.properties);
    entry.paths.forEach((path, pathIndex) => {
      for (const point of path) coordinates.push(point.x, point.y);
      pathOffsets.push(coordinates.length / 2);
      pathRoles.push(roles[pathIndex]);
    });
    featurePathOffsets.push(pathRoles.length);
  }
  return {
    layerName,
    extent,
    type,
    featureCount: entries.length,
    featureIndices: Uint32Array.from(featureIndices),
    mvtIds,
    featurePathOffsets: Uint32Array.from(featurePathOffsets),
    pathOffsets: Uint32Array.from(pathOffsets),
    pathRoles: Uint8Array.from(pathRoles),
    coordinates: Int32Array.from(coordinates),
    properties,
  };
}

function decodeMvt(
  data: ArrayBuffer | Uint8Array,
  sourceLayers?: ReadonlySet<string>,
): IntermediateBucket[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const tile = new VectorTile(new Protobuf(bytes));
  const buckets: IntermediateBucket[] = [];
  for (const [layerName, layer] of Object.entries(tile.layers)) {
    if (sourceLayers && !sourceLayers.has(layerName)) continue;
    const byType: Record<GeometryType, FeatureEntry[]> = { point: [], line: [], polygon: [] };
    for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
      const feature = layer.feature(featureIndex);
      const type = GEOMETRY_TYPES[feature.type as keyof typeof GEOMETRY_TYPES];
      if (!type) continue;
      byType[type].push({
        featureIndex,
        mvtId: feature.id ?? null,
        properties: { ...feature.properties },
        paths: feature.loadGeometry(),
      });
    }
    (['point', 'line', 'polygon'] as const).forEach((type) => {
      if (byType[type].length > 0) {
        buckets.push(createBucket(layerName, layer.extent, type, byType[type]));
      }
    });
  }
  return buckets;
}

function readPath(bucket: IntermediateBucket, pathIndex: number): Point[] {
  const points: Point[] = [];
  for (
    let vertex = bucket.pathOffsets[pathIndex];
    vertex < bucket.pathOffsets[pathIndex + 1];
    vertex++
  ) {
    points.push([bucket.coordinates[vertex * 2], bucket.coordinates[vertex * 2 + 1]]);
  }
  return points;
}

function readPolygonPath(bucket: IntermediateBucket, pathIndex: number): Point[] {
  const points = readPath(bucket, pathIndex);
  if (
    points.length > 1 &&
    points[0][0] === points.at(-1)?.[0] &&
    points[0][1] === points.at(-1)?.[1]
  ) {
    points.pop();
  }
  return points;
}

function triangulatePolygon(rings: readonly (readonly Point[])[]) {
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) holes.push(flat.length / 2);
    ring.forEach((point) => flat.push(point[0], point[1]));
  });
  return { flat, indices: earcut(flat, holes, 2) };
}

function buildFillMesh(bucket: IntermediateBucket): FillMeshResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexFeatureIndices: number[] = [];
  const triangleFeatureIndices: number[] = [];
  for (let feature = 0; feature < bucket.featureCount; feature++) {
    const firstPath = bucket.featurePathOffsets[feature];
    const endPath = bucket.featurePathOffsets[feature + 1];
    let rings: Point[][] = [];
    const flush = () => {
      const valid = rings.filter((ring) => ring.length >= 3);
      rings = [];
      if (valid.length === 0) return;
      const result = triangulatePolygon(valid);
      const base = positions.length / 2;
      positions.push(...result.flat);
      indices.push(...result.indices.map((index) => base + index));
      vertexFeatureIndices.push(
        ...new Array(result.flat.length / 2).fill(bucket.featureIndices[feature]),
      );
      triangleFeatureIndices.push(
        ...new Array(result.indices.length / 3).fill(bucket.featureIndices[feature]),
      );
    };
    for (let path = firstPath; path < endPath; path++) {
      const role = bucket.pathRoles[path];
      if (role === PATH_ROLE.EXTERIOR && rings.length > 0) flush();
      const points = readPolygonPath(bucket, path);
      if (role === PATH_ROLE.EXTERIOR || rings.length > 0) rings.push(points);
    }
    flush();
  }
  const positionArray = Int32Array.from(positions);
  const indexArray = Uint32Array.from(indices);
  const vertexFeatures = Uint32Array.from(vertexFeatureIndices);
  const triangleFeatures = Uint32Array.from(triangleFeatureIndices);
  return {
    type: 'fill',
    sourceGeometryType: 'polygon',
    layerName: bucket.layerName,
    extent: bucket.extent,
    positions: positionArray,
    indices: indexArray,
    triangleFeatureIndices: triangleFeatures,
    transferables: [
      positionArray.buffer,
      indexArray.buffer,
      vertexFeatures.buffer,
      triangleFeatures.buffer,
    ].map(arrayBuffer),
  };
}

function segmentNormal(a: Point, b: Point): Point | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return length > 0 ? [-dy / length, dx / length] : null;
}

function buildLineMesh(bucket: IntermediateBucket): LineMeshResult {
  const pathStarts: number[] = [];
  const positions: number[] = [];
  const extrudes: number[] = [];
  const indices: number[] = [];
  const vertexFeatureIndices: number[] = [];
  const triangleFeatureIndices: number[] = [];
  const addVertex = (point: Point, extrude: Point, featureIndex: number) => {
    const index = positions.length / 2;
    positions.push(...point);
    extrudes.push(...extrude);
    vertexFeatureIndices.push(featureIndex);
    return index;
  };
  for (let feature = 0; feature < bucket.featureCount; feature++) {
    const featureIndex = bucket.featureIndices[feature];
    for (
      let path = bucket.featurePathOffsets[feature];
      path < bucket.featurePathOffsets[feature + 1];
      path++
    ) {
      const points = readPath(bucket, path).filter(
        (point, index, values) =>
          index === 0 || point[0] !== values[index - 1][0] || point[1] !== values[index - 1][1],
      );
      pathStarts.push(positions.length / 2);
      for (let segment = 0; segment < points.length - 1; segment++) {
        const normal = segmentNormal(points[segment], points[segment + 1]);
        if (!normal) continue;
        const inverse: Point = [-normal[0], -normal[1]];
        const aLeft = addVertex(points[segment], normal, featureIndex);
        const aRight = addVertex(points[segment], inverse, featureIndex);
        const bLeft = addVertex(points[segment + 1], normal, featureIndex);
        const bRight = addVertex(points[segment + 1], inverse, featureIndex);
        indices.push(aLeft, aRight, bLeft, bLeft, aRight, bRight);
        triangleFeatureIndices.push(featureIndex, featureIndex);
      }
    }
  }
  const positionArray = Int32Array.from(positions);
  const extrudeArray = Float32Array.from(extrudes);
  const indexArray = Uint32Array.from(indices);
  const vertexFeatures = Uint32Array.from(vertexFeatureIndices);
  const triangleFeatures = Uint32Array.from(triangleFeatureIndices);
  return {
    pathStarts: Uint32Array.from(pathStarts),
    type: 'line',
    sourceGeometryType: 'line',
    layerName: bucket.layerName,
    extent: bucket.extent,
    positions: positionArray,
    extrudes: extrudeArray,
    indices: indexArray,
    triangleFeatureIndices: triangleFeatures,
    transferables: [
      positionArray.buffer,
      extrudeArray.buffer,
      indexArray.buffer,
      vertexFeatures.buffer,
      triangleFeatures.buffer,
    ].map(arrayBuffer),
  };
}

function nonNegative(value: unknown): number | null {
  const normalized = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof normalized === 'number' && Number.isFinite(normalized) && normalized >= 0
    ? normalized
    : null;
}

function profileValues(profile: MvtExtrusionProfile) {
  const heightProperty = profile.heightProperty ?? 'height';
  const minHeightProperty = profile.minHeightProperty ?? 'min_height';
  const defaultHeight = nonNegative(profile.defaultHeight ?? 0);
  const defaultMinHeight = nonNegative(profile.defaultMinHeight ?? 0);
  const heightScale = profile.heightScale ?? 1;
  if (!heightProperty || !minHeightProperty) {
    throw new TypeError('extrusion height properties are required');
  }
  if (defaultHeight === null || defaultMinHeight === null || defaultHeight < defaultMinHeight) {
    throw new RangeError('extrusion default heights must be a valid non-negative range');
  }
  if (!Number.isFinite(heightScale) || heightScale <= 0) {
    throw new RangeError('heightScale must be positive');
  }
  return { heightProperty, minHeightProperty, defaultHeight, defaultMinHeight, heightScale };
}

function cleanRing(points: readonly Point[]): Point[] {
  const clean = points.filter(
    (point, index, values) =>
      index === 0 || point[0] !== values[index - 1][0] || point[1] !== values[index - 1][1],
  );
  if (clean.length > 1 && clean[0][0] === clean.at(-1)?.[0] && clean[0][1] === clean.at(-1)?.[1]) {
    clean.pop();
  }
  return clean;
}

function buildExtrusionMesh(
  bucket: IntermediateBucket,
  sourceProfile: MvtExtrusionProfile,
): ExtrusionMeshResult {
  const profile = profileValues(sourceProfile);
  const positions: number[] = [];
  const heights: number[] = [];
  const indices: number[] = [];
  const vertexFeatureIndices: number[] = [];
  const triangleFeatureIndices: number[] = [];
  const addVertex = (point: Point, height: number, featureIndex: number) => {
    const index = positions.length / 2;
    positions.push(...point);
    heights.push(height);
    vertexFeatureIndices.push(featureIndex);
    return index;
  };
  for (let feature = 0; feature < bucket.featureCount; feature++) {
    const properties = bucket.properties[feature] ?? {};
    let height = nonNegative(properties[profile.heightProperty]) ?? profile.defaultHeight;
    let minHeight = nonNegative(properties[profile.minHeightProperty]) ?? profile.defaultMinHeight;
    if (height < minHeight) {
      height = profile.defaultHeight;
      minHeight = profile.defaultMinHeight;
    }
    height *= profile.heightScale;
    minHeight *= profile.heightScale;
    const featureIndex = bucket.featureIndices[feature];
    let rings: Array<{ points: Point[]; role: number }> = [];
    const flush = () => {
      const valid = rings.filter((ring) => ring.points.length >= 3);
      rings = [];
      if (valid.length === 0) return;
      const top = triangulatePolygon(valid.map(({ points }) => points));
      const base = positions.length / 2;
      for (let index = 0; index < top.flat.length; index += 2) {
        addVertex([top.flat[index], top.flat[index + 1]], height, featureIndex);
      }
      indices.push(...top.indices.map((index) => base + index));
      triangleFeatureIndices.push(...new Array(top.indices.length / 3).fill(featureIndex));
      for (const ring of valid) {
        for (let point = 0; point < ring.points.length; point++) {
          const a = ring.points[point];
          const b = ring.points[(point + 1) % ring.points.length];
          if (a[0] === b[0] && a[1] === b[1]) continue;
          const wall = [
            addVertex(a, minHeight, featureIndex),
            addVertex(b, minHeight, featureIndex),
            addVertex(b, height, featureIndex),
            addVertex(a, height, featureIndex),
          ];
          if (ring.role === PATH_ROLE.HOLE) {
            indices.push(wall[0], wall[2], wall[1], wall[0], wall[3], wall[2]);
          } else indices.push(wall[0], wall[1], wall[2], wall[0], wall[2], wall[3]);
          triangleFeatureIndices.push(featureIndex, featureIndex);
        }
      }
    };
    for (
      let path = bucket.featurePathOffsets[feature];
      path < bucket.featurePathOffsets[feature + 1];
      path++
    ) {
      const role = bucket.pathRoles[path];
      if (role === PATH_ROLE.EXTERIOR && rings.length > 0) flush();
      const points = cleanRing(readPolygonPath(bucket, path));
      if (role === PATH_ROLE.EXTERIOR || rings.length > 0) rings.push({ points, role });
    }
    flush();
  }
  const positionArray = Int32Array.from(positions);
  const heightArray = Float32Array.from(heights);
  const indexArray = Uint32Array.from(indices);
  const vertexFeatures = Uint32Array.from(vertexFeatureIndices);
  const triangleFeatures = Uint32Array.from(triangleFeatureIndices);
  return {
    type: 'fill-extrusion',
    sourceGeometryType: 'polygon',
    layerName: bucket.layerName,
    extent: bucket.extent,
    positions: positionArray,
    heights: heightArray,
    indices: indexArray,
    triangleFeatureIndices: triangleFeatures,
    transferables: [
      positionArray.buffer,
      heightArray.buffer,
      indexArray.buffer,
      vertexFeatures.buffer,
      triangleFeatures.buffer,
    ].map(arrayBuffer),
  };
}

/** Decode MVT bytes directly into the render meshes consumed by the WebGPU backend. */
export function processMvt(
  data: ArrayBuffer | Uint8Array,
  options: MvtProcessOptions = {},
): ProcessedMvtTileWithTransferables {
  if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
    throw new TypeError('MVT input must be ArrayBuffer or Uint8Array');
  }
  const profiles = options.extrusionProfiles ?? [];
  const byLayer = new Map<string, MvtExtrusionProfile>();
  for (const profile of profiles) {
    if (!profile || typeof profile.sourceLayer !== 'string' || profile.sourceLayer.length === 0) {
      throw new TypeError('extrusion profile sourceLayer is required');
    }
    if (byLayer.has(profile.sourceLayer)) {
      throw new TypeError(`duplicate extrusion profile: ${profile.sourceLayer}`);
    }
    byLayer.set(profile.sourceLayer, profile);
  }
  if (
    options.sourceLayers !== undefined &&
    (!Array.isArray(options.sourceLayers) ||
      options.sourceLayers.some((name) => typeof name !== 'string' || name.length === 0))
  ) {
    throw new TypeError('sourceLayers must be an array of non-empty strings');
  }
  if (
    options.includeLineFeatures !== undefined &&
    typeof options.includeLineFeatures !== 'boolean'
  ) {
    throw new TypeError('includeLineFeatures must be a boolean');
  }
  const buckets = decodeMvt(
    data,
    options.sourceLayers === undefined ? undefined : new Set(options.sourceLayers),
  );
  const fillMeshes = buckets.filter(({ type }) => type === 'polygon').map(buildFillMesh);
  const lineMeshes = buckets.filter(({ type }) => type === 'line').map(buildLineMesh);
  const extrusionMeshes = buckets
    .filter((bucket) => bucket.type === 'polygon' && byLayer.has(bucket.layerName))
    .map((bucket) => buildExtrusionMesh(bucket, byLayer.get(bucket.layerName)!));
  const meshes: readonly (VectorMesh & TransferableMesh)[] = [
    ...fillMeshes,
    ...lineMeshes,
    ...extrusionMeshes,
  ];
  return {
    fillMeshes,
    lineMeshes,
    extrusionMeshes,
    featureTables: buckets.map((bucket) => ({
      layerName: bucket.layerName,
      type: bucket.type,
      featureIndices: bucket.featureIndices,
      mvtIds: bucket.mvtIds,
      properties: bucket.properties,
    })),
    lineFeatures:
      options.includeLineFeatures === false
        ? []
        : buckets
            .filter(({ type }) => type === 'line')
            .flatMap((bucket) => {
              const lines = [];
              for (let i = 0; i < bucket.featureCount; i++) {
                for (
                  let path = bucket.featurePathOffsets[i];
                  path < bucket.featurePathOffsets[i + 1];
                  path++
                ) {
                  lines.push({
                    layerName: bucket.layerName,
                    extent: bucket.extent,
                    featureIndex: bucket.featureIndices[i],
                    mvtId: bucket.mvtIds[i],
                    properties: bucket.properties[i],
                    path: readPath(bucket, path),
                  });
                }
              }
              return lines;
            }),
    pointFeatures: buckets
      .filter(({ type }) => type === 'point')
      .flatMap((bucket) => {
        const points = [];
        for (let i = 0; i < bucket.featureCount; i++) {
          for (
            let path = bucket.featurePathOffsets[i];
            path < bucket.featurePathOffsets[i + 1];
            path++
          ) {
            for (const [x, y] of readPath(bucket, path)) {
              points.push({
                layerName: bucket.layerName,
                extent: bucket.extent,
                featureIndex: bucket.featureIndices[i],
                mvtId: bucket.mvtIds[i],
                properties: bucket.properties[i],
                x,
                y,
              });
            }
          }
        }
        return points;
      }),
    transferables: [...new Set(meshes.flatMap(({ transferables }) => transferables))],
  };
}

export function createInlineMvtProcessor(): MvtTileProcessor {
  let destroyed = false;
  return {
    async process(data, { signal, options }) {
      if (destroyed) throw new Error('inline MVT processor is destroyed');
      signal.throwIfAborted();
      const result = processMvt(data, (options ?? {}) as MvtProcessOptions);
      signal.throwIfAborted();
      return result;
    },
    destroy() {
      destroyed = true;
    },
  };
}

export interface MvtWorkerRequest {
  readonly id: number | string;
  readonly type: string;
  readonly data: ArrayBuffer | Uint8Array;
  readonly options?: MvtProcessOptions;
}

export function handleMvtWorkerRequest(request: MvtWorkerRequest) {
  const id = request?.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    return {
      message: { id: null, ok: false, error: 'worker request requires an id' },
      transferables: [] as ArrayBuffer[],
    };
  }
  if (request.type !== 'process-mvt') {
    return {
      message: { id, ok: false, error: `unknown worker request type: ${request.type}` },
      transferables: [] as ArrayBuffer[],
    };
  }
  try {
    const result = processMvt(request.data, request.options);
    return { message: { id, ok: true, result }, transferables: [...result.transferables] };
  } catch (error) {
    return {
      message: { id, ok: false, error: error instanceof Error ? error.message : String(error) },
      transferables: [] as ArrayBuffer[],
    };
  }
}
