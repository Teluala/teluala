/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type {
  VectorFeaturePickCatalog,
  VectorFeaturePickRecord,
  VectorMeshType,
  VectorRenderEntry,
} from './types.js';

interface FeatureTableLike {
  readonly layerName: string;
  readonly featureIndices: readonly number[] | Uint32Array;
  readonly properties: readonly Readonly<Record<string, unknown>>[];
  readonly mvtIds?: readonly unknown[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

// A feature table never changes after the tile is processed, so the index map
// is built once per table object instead of once per catalog rebuild (rebuilds
// happen on every selection change while the camera moves).
const featureMapCache = new WeakMap<
  object,
  Map<number, { properties: Readonly<Record<string, unknown>>; mvtId: unknown }>
>();

function featureTableMap(value: unknown, layerName: string) {
  const table = value as FeatureTableLike | undefined;
  if (!table || table.layerName !== layerName) {
    throw new TypeError(`feature table does not match mesh layer: ${layerName}`);
  }
  const cached = featureMapCache.get(table);
  if (cached) return cached;
  if (
    (!Array.isArray(table.featureIndices) && !(table.featureIndices instanceof Uint32Array)) ||
    !Array.isArray(table.properties)
  ) {
    throw new TypeError('feature table requires featureIndices and properties arrays');
  }
  if (table.featureIndices.length !== table.properties.length) {
    throw new RangeError('feature table indices and properties must have the same length');
  }
  if (table.mvtIds && table.mvtIds.length !== table.featureIndices.length) {
    throw new RangeError('feature table mvtIds must match featureIndices length');
  }
  const map = new Map(
    Array.from(
      table.featureIndices,
      (featureIndex, index) =>
        [
          featureIndex,
          {
            properties: table.properties[index],
            mvtId: table.mvtIds?.[index] ?? null,
          },
        ] as const,
    ),
  );
  featureMapCache.set(table, map);
  return map;
}

function appendUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function identityKey(entry: VectorRenderEntry, featureIndex: number): string {
  return JSON.stringify([entry.sourceId, entry.sourceTileKey, entry.mesh.layerName, featureIndex]);
}

/** Assign one local pick ID per source-tile feature and map draw triangles to it. */
export function buildFeaturePickCatalog(
  entries: readonly VectorRenderEntry[],
): VectorFeaturePickCatalog {
  if (!Array.isArray(entries)) throw new TypeError('pick entries must be an array');
  const records: Array<{
    localId: number;
    sourceId: string;
    sourceTileKey: string;
    layerName: string;
    featureIndex: number;
    mvtId: unknown;
    properties: Readonly<Record<string, unknown>>;
    requestedTileKeys: string[];
    geometryTypes: VectorMeshType[];
    styleLayerIds: string[];
  }> = [];
  const localIdByIdentity = new Map<string, number>();
  const draws = entries.map((entry) => {
    requiredString(entry?.sourceId, 'sourceId');
    requiredString(entry?.sourceTileKey, 'sourceTileKey');
    const requestedTileKey = requiredString(
      entry.requestedTileKey ?? entry.sourceTileKey,
      'requestedTileKey',
    );
    const { mesh, batch } = entry;
    if (!mesh || typeof mesh.layerName !== 'string' || typeof mesh.type !== 'string') {
      throw new TypeError('pick entry requires a typed mesh');
    }
    if (
      !batch?.styleLayer ||
      !(batch.indices instanceof Uint32Array) ||
      !(batch.triangleFeatureIndices instanceof Uint32Array)
    ) {
      throw new TypeError('pick entry requires a compiled style batch');
    }
    if (batch.indices.length !== batch.triangleFeatureIndices.length * 3) {
      throw new RangeError('style batch must have one feature index per triangle');
    }
    const features = featureTableMap(entry.featureTable, mesh.layerName);
    const triangleLocalIds = new Uint32Array(batch.triangleFeatureIndices.length);
    // Resolve each feature once per entry, not once per triangle: the identity
    // key (JSON.stringify) and the per-entry record fields (requested tile,
    // geometry type, style layer) are the same for every triangle of a feature.
    // With ~30 tiles in view the per-triangle form would take 60-70% of
    // main-thread time while the camera moves.
    const localIdByFeature = new Map<number, number>();
    for (let triangle = 0; triangle < batch.triangleFeatureIndices.length; triangle++) {
      const featureIndex = batch.triangleFeatureIndices[triangle];
      let localId = localIdByFeature.get(featureIndex);
      if (localId === undefined) {
        const feature = features.get(featureIndex);
        if (!feature) {
          throw new RangeError(`feature ${featureIndex} is missing from ${mesh.layerName} table`);
        }
        const key = identityKey(entry, featureIndex);
        localId = localIdByIdentity.get(key);
        if (localId === undefined) {
          localId = records.length;
          localIdByIdentity.set(key, localId);
          records.push({
            localId,
            sourceId: entry.sourceId,
            sourceTileKey: entry.sourceTileKey,
            layerName: mesh.layerName,
            featureIndex,
            mvtId: feature.mvtId,
            properties: feature.properties,
            requestedTileKeys: [],
            geometryTypes: [],
            styleLayerIds: [],
          });
        }
        const record = records[localId];
        appendUnique(record.requestedTileKeys, requestedTileKey);
        appendUnique(record.geometryTypes, mesh.type);
        appendUnique(record.styleLayerIds, batch.styleLayer.id);
        localIdByFeature.set(featureIndex, localId);
      }
      triangleLocalIds[triangle] = localId;
    }
    return {
      triangleLocalIds,
      triangleCount: triangleLocalIds.length,
      styleLayerId: batch.styleLayer.id,
      geometryType: mesh.type,
    };
  });
  return { draws, records, count: records.length };
}

export function resolveFeaturePick(
  catalog: VectorFeaturePickCatalog,
  localId: number,
): VectorFeaturePickRecord | null {
  if (!catalog || !Array.isArray(catalog.records)) throw new TypeError('pick catalog is required');
  if (!Number.isInteger(localId) || localId < 0) return null;
  return catalog.records[localId] ?? null;
}
