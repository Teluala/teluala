/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { clipPath } from './symbolLayout.js';
import { validateDashArray } from './lineLayout.js';
import { BoundedCache, type FrameState, type LayerContext } from 'teluala';
import {
  assertWebMercatorTile,
  resolveWebMercatorTileOptions,
  selectWebMercatorTiles as selectCoreWebMercatorTiles,
  webMercatorZoom,
  type ResolvedWebMercatorTileOptions,
  type WebMercatorTileOptions,
} from 'teluala';

const MAX_ERROR_LOG = 100;

import type {
  VectorLayerController,
  VectorLabel,
  VectorMesh,
  VectorRenderEntry,
  VectorStyleBatch,
  VectorStyleLayer,
} from './types.js';

export interface MvtTileCoordinate {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface MvtTileResponse {
  readonly data: ArrayBuffer | Uint8Array;
  readonly cacheControl?: string;
  readonly expires?: string;
}

export interface MvtTileSource {
  getTile(
    z: number,
    x: number,
    y: number,
    options: { readonly signal: AbortSignal },
  ): Promise<MvtTileResponse | undefined>;
  destroy?(): void;
}

export interface MvtFeatureTable {
  readonly layerName: string;
  readonly type: 'polygon' | 'line' | 'point';
  readonly featureIndices: readonly number[] | Uint32Array;
  readonly properties: readonly Readonly<Record<string, unknown>>[];
  readonly mvtIds?: readonly unknown[];
}

export interface MvtPointFeature {
  readonly layerName: string;
  readonly extent: number;
  readonly x: number;
  readonly y: number;
  readonly featureIndex: number;
  readonly mvtId: unknown;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface MvtLineFeature {
  readonly layerName: string;
  readonly extent: number;
  readonly featureIndex: number;
  readonly mvtId: unknown;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly path: readonly (readonly [number, number])[];
}

/** Provider-independent point layout, resolved on the main thread after decoding. */
export interface MvtPointLabelLayout {
  /** Clockwise screen degrees; zero keeps the baseline upright. */
  readonly rotation?: number;
  /** Stable identity across tiles; the controller scopes it to source and style. */
  readonly collisionGroup?: string;
}

export interface MvtLabelStyle {
  readonly id: string;
  readonly sourceLayer: string;
  /** Name of the string or numeric feature property to display. */
  readonly textField?: string | readonly string[];
  /** Optional numeric feature threshold in screen zoom. Missing/invalid values use minZoom. */
  readonly minZoomField?: string;
  /** Style layers a label of this style may overlap. For a pairing that
   * belongs together, such as a facility icon and its name on one anchor. */
  readonly ignoreCollisionWith?: readonly string[];
  readonly icon?: string;
  readonly iconField?: string;
  readonly iconMap?: Readonly<Record<string, string>>;
  /** Multiplier of sprite CSS dimensions, defaults to 1. */
  readonly iconSize?: number;
  readonly iconTextFit?: 'none' | 'both';
  readonly iconPadding?: readonly [number, number];
  readonly textOffset?: readonly [number, number];
  readonly placement?: 'point' | 'line';
  readonly repeatDistance?: number;
  readonly rotation?: number;
  readonly rotationField?: string;
  /** Pure, synchronous point-layout resolver. Omitted values use style defaults.
   * Not sent to the tile worker; do not mutate the original properties.
   * Line placement derives orientation from its path and does not use this hook.
   */
  readonly resolvePointLayout?: (
    properties: Readonly<Record<string, unknown>>,
  ) => MvtPointLabelLayout;
  readonly filter?: readonly unknown[];
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly size?: number;
  readonly fontFamily?: string;
  readonly color?: string;
  readonly haloColor?: string;
  readonly haloWidth?: number;
  readonly offset?: readonly [number, number];
  readonly allowOverlap?: boolean;
}

export interface ProcessedMvtTile {
  readonly pointFeatures?: readonly MvtPointFeature[];
  readonly lineFeatures?: readonly MvtLineFeature[];
  readonly fillMeshes: readonly VectorMesh[];
  readonly lineMeshes: readonly VectorMesh[];
  readonly extrusionMeshes: readonly VectorMesh[];
  readonly featureTables: readonly MvtFeatureTable[];
}

export interface MvtTileProcessor {
  process(
    data: ArrayBuffer | Uint8Array,
    options: { readonly signal: AbortSignal; readonly options?: unknown },
  ): Promise<ProcessedMvtTile>;
  destroy?(): void;
}

export interface MvtStyleLayerDefinition {
  readonly id: string;
  readonly sourceLayer: string;
  readonly type: VectorStyleLayer['type'];
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly filter?: readonly unknown[];
  readonly paint: {
    readonly color: string;
    readonly opacity?: number;
    readonly width?: number;
    readonly dashArray?: readonly number[];
    /** Sprite name, tiled in source-tile coordinates. */
    readonly pattern?: string;
    readonly patternSize?: number;
  };
}

export interface MvtStyleDocument {
  readonly version: 1;
  readonly layers: readonly MvtStyleLayerDefinition[];
}

export type WebMercatorTileSelectorOptions = WebMercatorTileOptions;

export interface MvtVectorControllerOptions extends WebMercatorTileSelectorOptions {
  readonly sourceId: string;
  readonly source: MvtTileSource;
  readonly processor: MvtTileProcessor;
  readonly style: MvtStyleDocument;
  readonly labels?: readonly MvtLabelStyle[];
  readonly maxNativeZoom?: number;
  readonly processorOptions?: unknown;
  readonly attribution?: readonly string[];
  readonly selectTiles?: (frame: FrameState) => readonly MvtTileCoordinate[];
  readonly onError?: (error: Error) => void;
}

export interface MvtVectorControllerSnapshot {
  readonly requestedTiles: number;
  readonly sourceTiles: number;
  readonly loading: number;
  readonly ready: number;
  readonly missing: number;
  readonly errors: readonly string[];
  readonly loadsStarted: number;
  readonly loadsCompleted: number;
  readonly loadsAborted: number;
  readonly loadsFailed: number;
  /** Style batches built (tile × style layer) and the main-thread time they took, cumulative. */
  readonly batchesBuilt: number;
  readonly batchMs: number;
}

export interface MvtVectorController extends VectorLayerController {
  snapshot(): MvtVectorControllerSnapshot;
  /** Toggle a geometry or label style by its unique id; no tile reload is needed. */
  setLayerVisibility(id: string, visible: boolean): void;
  /** Replace the geometry style (layers, filters, paint). Decoded tiles are
   * kept and re-batched on the next update — no tile reload, no re-decode.
   * Label styles are unchanged; a style layer may not take a label's id. */
  setStyle(style: MvtStyleDocument): void;
  /** Decoded labels of the current and in-transition tiles, before screen
   * collision and without viewport filtering. Changes no state. */
  queryLabels(options?: { readonly includeHidden?: boolean }): readonly VectorLabel[];
  isLayerVisible(id: string): boolean;
}

type FeatureFilter = (properties: Readonly<Record<string, unknown>>) => boolean;

interface CompiledStyleLayer {
  readonly sourceLayer: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly filter: FeatureFilter;
  readonly styleLayer: VectorStyleLayer;
  readonly order: number;
}

interface RequestedTile extends MvtTileCoordinate {
  readonly key: string;
  readonly source: MvtTileCoordinate;
  readonly sourceKey: string;
}

interface SourceRecord {
  readonly coordinate: MvtTileCoordinate;
  readonly abort: AbortController;
  status: 'loading' | 'ready' | 'missing' | 'error';
  processed?: ProcessedMvtTile;
}
// 'ready' and a processed tile are set together (#load); one predicate reads both.
const isReady = (
  record: SourceRecord | undefined,
): record is SourceRecord & { processed: ProcessedMvtTile } =>
  record?.status === 'ready' && record.processed !== undefined;

interface CachedEntries {
  readonly processed: ProcessedMvtTile;
  readonly entries: readonly { readonly order: number; readonly entry: VectorRenderEntry }[];
}

// Deselected-but-ready source records and their style batches kept for
// instant reuse BEYOND the tiles in use (see #pruneCaches); enough for a
// screenful of tiles plus a margin.
const RETAINED_READY_RECORDS = 32;

/** The zoom scale label thresholds are written in: 256-pixel tiles, CSS pixels. */
const LABEL_ZOOM = { tileSize: 256, detail: 0 } as const;

function tileKey(tile: MvtTileCoordinate): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** Strict area overlap between two tiles, possibly at different zooms. */
function tilesOverlap(a: MvtTileCoordinate, b: MvtTileCoordinate): boolean {
  const aSize = 1 / 2 ** a.z;
  const bSize = 1 / 2 ** b.z;
  return (
    a.x * aSize < (b.x + 1) * bSize &&
    (a.x + 1) * aSize > b.x * bSize &&
    a.y * aSize < (b.y + 1) * bSize &&
    (a.y + 1) * aSize > b.y * bSize
  );
}

function assertTile(tile: MvtTileCoordinate): void {
  assertWebMercatorTile(tile.z, tile.x, tile.y);
}

/** Select visible Web Mercator tiles from Teluala's public FrameState.
 * The algorithm lives in core; this keeps the package's name and tile type. */
export function selectWebMercatorTiles(
  frame: FrameState,
  options: WebMercatorTileSelectorOptions = {},
): MvtTileCoordinate[] {
  return selectCoreWebMercatorTiles(frame, options);
}

function parseColor(value: string): [number, number, number, number] {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    throw new TypeError(`color must be #RRGGBB or #RRGGBBAA: ${value}`);
  }
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
    value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1,
  ];
}

function validateFilter(filter: readonly unknown[] | undefined): void {
  if (filter === undefined) return;
  if (!Array.isArray(filter) || typeof filter[0] !== 'string') {
    throw new TypeError('filter must be an expression array');
  }
  const [operator, ...args] = filter;
  if (operator === 'all' || operator === 'any') {
    if (args.length === 0) throw new TypeError(`${operator} filter requires children`);
    args.forEach((child) => validateFilter(child as readonly unknown[]));
  } else if (operator === '!') {
    if (args.length !== 1) throw new TypeError('! filter requires one child');
    validateFilter(args[0] as readonly unknown[]);
  } else if (operator === 'has') {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new TypeError('has filter requires a property name');
    }
  } else if (operator === '==' || operator === '!=' || operator === 'in') {
    if (args.length < 2 || typeof args[0] !== 'string') {
      throw new TypeError(`${operator} filter requires property and value`);
    }
  } else throw new TypeError(`unsupported filter operator: ${operator}`);
}

function labelText(
  properties: Readonly<Record<string, unknown>>,
  field: MvtLabelStyle['textField'],
): string {
  for (const key of typeof field === 'string' ? [field] : (field ?? [])) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** Turn a validated filter expression into a predicate; `in` lists become a
 * set so a large id list costs one lookup per feature. */
function compileFilter(filter: readonly unknown[] | null | undefined): FeatureFilter {
  if (filter === null || filter === undefined) return () => true;
  const [operator, ...args] = filter;
  if (operator === 'all') {
    const children = args.map((child) => compileFilter(child as readonly unknown[]));
    return (properties) => children.every((child) => child(properties));
  }
  if (operator === 'any') {
    const children = args.map((child) => compileFilter(child as readonly unknown[]));
    return (properties) => children.some((child) => child(properties));
  }
  if (operator === '!') {
    const child = compileFilter(args[0] as readonly unknown[]);
    return (properties) => !child(properties);
  }
  const name = args[0] as string;
  if (operator === 'has') return (properties) => Object.hasOwn(properties, name);
  if (operator === '==') return (properties) => properties[name] === args[1];
  if (operator === '!=') return (properties) => properties[name] !== args[1];
  if (operator === 'in') {
    const values = new Set(args.slice(1));
    return (properties) => values.has(properties[name]);
  }
  return () => false;
}

function compileStyle(document: MvtStyleDocument): CompiledStyleLayer[] {
  if (!document || document.version !== 1 || !Array.isArray(document.layers)) {
    throw new TypeError('MVT style version 1 with layers is required');
  }
  const ids = new Set<string>();
  return document.layers.map((layer, order) => {
    if (!layer || typeof layer.id !== 'string' || layer.id.length === 0) {
      throw new TypeError('style layer id is required');
    }
    if (ids.has(layer.id)) throw new TypeError(`duplicate style layer id: ${layer.id}`);
    ids.add(layer.id);
    if (typeof layer.sourceLayer !== 'string' || layer.sourceLayer.length === 0) {
      throw new TypeError(`${layer.id}: sourceLayer is required`);
    }
    if (!['fill', 'line', 'fill-extrusion'].includes(layer.type)) {
      throw new TypeError(`${layer.id}: unsupported geometry type`);
    }
    validateFilter(layer.filter);
    const minZoom = layer.minZoom ?? 0;
    const maxZoom = layer.maxZoom ?? 24;
    if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom) || minZoom > maxZoom) {
      throw new RangeError(`${layer.id}: invalid zoom range`);
    }
    const opacity = layer.paint?.opacity ?? 1;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new RangeError(`${layer.id}: opacity must be 0..1`);
    }
    const color = parseColor(layer.paint?.color);
    color[3] *= opacity;
    if (layer.paint.pattern && layer.type !== 'fill') {
      throw new TypeError('pattern requires a fill style');
    }
    if (!Number.isFinite(layer.paint.patternSize ?? 128) || (layer.paint.patternSize ?? 128) <= 0) {
      throw new RangeError('invalid patternSize');
    }
    validateDashArray(layer.paint?.dashArray);
    if (layer.paint.dashArray && layer.type !== 'line') {
      throw new TypeError('dashArray requires a line style');
    }
    const width = layer.type === 'line' ? (layer.paint.width ?? 1) : undefined;
    if (width !== undefined && (!Number.isFinite(width) || width < 0)) {
      throw new RangeError(`${layer.id}: width must be non-negative`);
    }
    return {
      sourceLayer: layer.sourceLayer,
      minZoom,
      maxZoom,
      filter: compileFilter(layer.filter),
      order,
      styleLayer: {
        id: layer.id,
        type: layer.type,
        paint: {
          color,
          width,
          dashArray: layer.paint.dashArray,
          pattern: layer.paint.pattern,
          patternSize: layer.paint.patternSize,
        },
      },
    };
  });
}

// featureIndex → properties, built once per feature table (tables never
// change after decoding) instead of once per style layer per rebatch.
const propertiesByTable = new WeakMap<
  MvtFeatureTable,
  Map<number, Readonly<Record<string, unknown>>>
>();
const EMPTY_PROPERTIES: Readonly<Record<string, unknown>> = {};
function propertiesOf(table: MvtFeatureTable): Map<number, Readonly<Record<string, unknown>>> {
  let properties = propertiesByTable.get(table);
  if (!properties) {
    properties = new Map();
    table.featureIndices.forEach((featureIndex, index) => {
      properties!.set(featureIndex, table.properties[index] ?? EMPTY_PROPERTIES);
    });
    propertiesByTable.set(table, properties);
  }
  return properties;
}

function buildBatch(
  mesh: VectorMesh,
  table: MvtFeatureTable,
  layer: CompiledStyleLayer,
): VectorStyleBatch | undefined {
  const properties = propertiesOf(table);
  // The filter is a per-FEATURE fact; evaluate it once per feature, not once
  // per triangle (a building footprint is many triangles), and size the
  // typed arrays from a count instead of growing JS arrays.
  const passes = new Map<number, boolean>();
  const triangleFeatures = mesh.triangleFeatureIndices;
  let kept = 0;
  for (let triangle = 0; triangle < triangleFeatures.length; triangle++) {
    const featureIndex = triangleFeatures[triangle];
    let pass = passes.get(featureIndex);
    if (pass === undefined) {
      pass = layer.filter(properties.get(featureIndex) ?? EMPTY_PROPERTIES);
      passes.set(featureIndex, pass);
    }
    if (pass) kept++;
  }
  if (kept === 0) return undefined;
  const indices = new Uint32Array(kept * 3);
  const features = new Uint32Array(kept);
  let out = 0;
  for (let triangle = 0; triangle < triangleFeatures.length; triangle++) {
    const featureIndex = triangleFeatures[triangle];
    if (!passes.get(featureIndex)) continue;
    indices[out * 3] = mesh.indices[triangle * 3];
    indices[out * 3 + 1] = mesh.indices[triangle * 3 + 1];
    indices[out * 3 + 2] = mesh.indices[triangle * 3 + 2];
    features[out] = featureIndex;
    out++;
  }
  return { styleLayer: layer.styleLayer, indices, triangleFeatureIndices: features };
}

function sourceCoordinate(requested: MvtTileCoordinate, maxNativeZoom: number): MvtTileCoordinate {
  const z = Math.min(requested.z, maxNativeZoom);
  const scale = 2 ** (requested.z - z);
  return { z, x: Math.floor(requested.x / scale), y: Math.floor(requested.y / scale) };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class DefaultMvtVectorController implements MvtVectorController {
  #options: MvtVectorControllerOptions;
  #style: readonly CompiledStyleLayer[];
  #selectorOptions: ResolvedWebMercatorTileOptions;
  #maxNativeZoom: number;
  #context: LayerContext | null = null;
  #destroyed = false;
  // The current selection lives only here; update() compares against its keys.
  #requested: readonly RequestedTile[] = [];
  #stale: readonly RequestedTile[] = [];
  // Both caches are LRU (core BoundedCache): a get() marks a record as used.
  #records = new BoundedCache<string, SourceRecord>({ limit: RETAINED_READY_RECORDS });
  #entryCache = new BoundedCache<string, CachedEntries>({ limit: RETAINED_READY_RECORDS });
  #entries: readonly VectorRenderEntry[] = [];
  #labels: readonly VectorLabel[] = [];
  #labelZoom = '';
  #lastZoom = Number.NaN;
  #labelZoomMin = -Infinity;
  #labelZoomMax = Infinity;
  // Every id setLayerVisibility() accepts, and which of the two catalogs it
  // belongs to: only a hidden style layer changes the geometry entries.
  #layerKinds: ReadonlyMap<string, 'style' | 'label'>;
  #labelFilters: readonly FeatureFilter[];
  #hiddenLayers = new Set<string>();
  #dirty = false;
  // Most recent failures only: an offline session must not grow this per tile.
  #errors: string[] = [];
  #metrics = {
    loadsStarted: 0,
    loadsCompleted: 0,
    loadsAborted: 0,
    loadsFailed: 0,
    batchesBuilt: 0,
    batchMs: 0,
  };

  constructor(options: MvtVectorControllerOptions) {
    if (!options || typeof options.sourceId !== 'string' || options.sourceId.length === 0) {
      throw new TypeError('sourceId is required');
    }
    if (!options.source || typeof options.source.getTile !== 'function') {
      throw new TypeError('source.getTile is required');
    }
    if (!options.processor || typeof options.processor.process !== 'function') {
      throw new TypeError('processor.process is required');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.#options = options;
    this.#style = compileStyle(options.style);
    const layerKinds = new Map<string, 'style' | 'label'>(
      this.#style.map((layer) => [layer.styleLayer.id, 'style']),
    );
    for (const label of options.labels ?? []) {
      if (
        !label.id ||
        layerKinds.has(label.id) ||
        !label.sourceLayer ||
        !(label.textField || label.icon || label.iconField)
      ) {
        throw new TypeError('label requires unique id, sourceLayer, and textField');
      }
      layerKinds.set(label.id, 'label');
      if (
        !Number.isFinite(label.iconSize ?? 1) ||
        (label.iconSize ?? 1) <= 0 ||
        (label.iconSize ?? 1) > 16
      ) {
        throw new RangeError('invalid iconSize');
      }
      if (label.placement !== undefined && !['point', 'line'].includes(label.placement)) {
        throw new TypeError('invalid label placement');
      }
      if (!Number.isFinite(label.repeatDistance ?? 100) || (label.repeatDistance ?? 100) < 8) {
        throw new RangeError('repeatDistance must be at least 8 CSS pixels');
      }
      if (!Number.isFinite(label.rotation ?? 0)) throw new RangeError('invalid label rotation');
      if (label.iconTextFit !== undefined && !['none', 'both'].includes(label.iconTextFit)) {
        throw new TypeError('invalid iconTextFit');
      }
      for (const pair of [label.iconPadding, label.textOffset]) {
        if (pair && (pair.length !== 2 || !pair.every(Number.isFinite))) {
          throw new RangeError('invalid icon/text dimensions');
        }
      }
      if (label.iconPadding?.some((v) => v < 0)) {
        throw new RangeError('iconPadding must be non-negative');
      }
      if (
        label.textField !== undefined &&
        ((typeof label.textField !== 'string' && !Array.isArray(label.textField)) ||
          (Array.isArray(label.textField) ? label.textField : [label.textField]).some(
            (field) => typeof field !== 'string' || !field,
          ))
      ) {
        throw new TypeError('textField requires property names');
      }
      if (
        label.resolvePointLayout !== undefined &&
        typeof label.resolvePointLayout !== 'function'
      ) {
        throw new TypeError('resolvePointLayout must be a function');
      }
      if (
        label.minZoomField !== undefined &&
        (typeof label.minZoomField !== 'string' || !label.minZoomField.trim())
      ) {
        throw new TypeError('minZoomField requires a property name');
      }
      if (
        label.ignoreCollisionWith !== undefined &&
        (!Array.isArray(label.ignoreCollisionWith) ||
          label.ignoreCollisionWith.some((id) => typeof id !== 'string' || !id.trim()))
      ) {
        throw new TypeError('ignoreCollisionWith requires style layer ids');
      }
      validateFilter(label.filter);
      parseColor(label.color ?? '#ffffff');
      parseColor(label.haloColor ?? '#152532');
      if (
        !Number.isFinite(label.size ?? 14) ||
        (label.size ?? 14) <= 0 ||
        (label.size ?? 14) > 128 ||
        !Number.isFinite(label.haloWidth ?? 2) ||
        (label.haloWidth ?? 2) < 0 ||
        (label.haloWidth ?? 2) > 16 ||
        !Number.isFinite(label.minZoom ?? 0) ||
        !Number.isFinite(label.maxZoom ?? 24) ||
        (label.minZoom ?? 0) > (label.maxZoom ?? 24) ||
        (label.offset !== undefined &&
          (label.offset.length !== 2 || !label.offset.every(Number.isFinite)))
      ) {
        throw new RangeError('invalid label size, halo, zoom, or offset');
      }
    }
    this.#layerKinds = layerKinds;
    this.#labelFilters = (options.labels ?? []).map((label) => compileFilter(label.filter));
    this.#selectorOptions = resolveWebMercatorTileOptions(options);
    this.#maxNativeZoom = options.maxNativeZoom ?? this.#selectorOptions.maxZoom;
    if (
      !Number.isInteger(this.#maxNativeZoom) ||
      this.#maxNativeZoom < this.#selectorOptions.minZoom ||
      this.#maxNativeZoom > this.#selectorOptions.maxZoom
    ) {
      throw new RangeError('maxNativeZoom must be within the controller zoom range');
    }
  }

  init(context: LayerContext): void {
    if (this.#destroyed) throw new Error('MVT controller is destroyed');
    if (this.#context) throw new Error('MVT controller is already initialized');
    if (!context || typeof context.invalidate !== 'function') {
      throw new TypeError('LayerContext.invalidate is required');
    }
    this.#context = context;
  }

  update(frame: FrameState) {
    if (this.#destroyed) throw new Error('MVT controller is destroyed');
    if (!this.#context) throw new Error('MVT controller is not initialized');
    const selected = this.#options.selectTiles
      ? [...this.#options.selectTiles(frame)]
      : selectWebMercatorTiles(frame, this.#selectorOptions);
    selected.forEach(assertTile);
    const keys = selected.map(tileKey);
    if (new Set(keys).size !== keys.length) throw new Error('selected tile keys must be unique');
    const unchanged =
      keys.length === this.#requested.length &&
      keys.every((key, index) => key === this.#requested[index].key);
    if (!unchanged) this.#syncRequested(selected, keys);
    // Label thresholds (style min/maxZoom, the per-feature minZoomField) are
    // evaluated on the 256-tile map zoom in CSS pixels, whatever detail the
    // tile selection samples at. Switching the convention is this one line.
    const zoom = webMercatorZoom(frame, LABEL_ZOOM);
    this.#lastZoom = zoom;
    const labelStyles = this.#options.labels ?? [];
    const labelZoom = labelStyles.map(
      (l) => !this.#hiddenLayers.has(l.id) && zoom >= (l.minZoom ?? 0) && zoom <= (l.maxZoom ?? 24),
    );
    const zoomMask = labelZoom.join(',');
    const entriesChanged = this.#dirty;
    const labelsChanged =
      entriesChanged ||
      zoomMask !== this.#labelZoom ||
      zoom < this.#labelZoomMin ||
      zoom >= this.#labelZoomMax;
    if (!entriesChanged && !labelsChanged) return undefined;
    if (entriesChanged) this.#rebuildEntries();
    if (labelsChanged) this.#rebuildLabels(labelZoom, zoom);
    // Commit invalidation state only after label callbacks have succeeded.
    this.#dirty = false;
    this.#labelZoom = zoomMask;
    // Omitted fields retain their previous value in VectorLayer. Label-only
    // changes must not rebuild geometry entries or the feature pick catalog.
    return {
      ...(entriesChanged ? { entries: this.#entries } : {}),
      ...(labelsChanged && this.#options.labels ? { labels: this.#labels } : {}),
      needsRender: false,
    };
  }

  /** Labels decoded from the current and in-transition tiles, before screen
   * collision and without viewport filtering, for lookups such as search.
   *
   * Fetches nothing, decodes nothing and changes no state: the drawn labels,
   * the zoom interval and the visibility flags are untouched. Off-screen labels
   * of the requested tiles are included; `includeHidden` also returns the
   * labels of style layers hidden with setLayerVisibility().
   */
  queryLabels(options: { readonly includeHidden?: boolean } = {}): readonly VectorLabel[] {
    if (this.#destroyed) throw new Error('MVT controller is destroyed');
    if (options.includeHidden !== undefined && typeof options.includeHidden !== 'boolean') {
      throw new TypeError('includeHidden must be a boolean');
    }
    const styles = this.#options.labels ?? [];
    if (!styles.length || !Number.isFinite(this.#lastZoom)) return [];
    const zoom = this.#lastZoom;
    const active = styles.map(
      (style) =>
        (options.includeHidden || !this.#hiddenLayers.has(style.id)) &&
        zoom >= (style.minZoom ?? 0) &&
        zoom <= (style.maxZoom ?? 24),
    );
    return this.#buildLabels(active, zoom).labels;
  }

  isLayerVisible(id: string): boolean {
    if (this.#destroyed) throw new Error('MVT controller is destroyed');
    if (!this.#layerKinds.has(id)) throw new RangeError(`unknown style layer: ${id}`);
    return !this.#hiddenLayers.has(id);
  }

  setStyle(style: MvtStyleDocument): void {
    const compiled = compileStyle(style);
    const layerKinds = new Map([...this.#layerKinds].filter(([, kind]) => kind === 'label'));
    for (const layer of compiled) {
      if (layerKinds.has(layer.styleLayer.id)) {
        throw new TypeError(`style layer id is taken by a label: ${layer.styleLayer.id}`);
      }
      layerKinds.set(layer.styleLayer.id, 'style');
    }
    this.#style = compiled;
    this.#layerKinds = layerKinds;
    for (const id of [...this.#hiddenLayers]) {
      if (!layerKinds.has(id)) this.#hiddenLayers.delete(id);
    }
    this.#entryCache.clear();
    this.#dirty = true;
    this.#context?.invalidate();
  }

  setLayerVisibility(id: string, visible: boolean): void {
    const current = this.isLayerVisible(id);
    if (typeof visible !== 'boolean') throw new TypeError('visible must be a boolean');
    if (current === visible) return;
    if (visible) this.#hiddenLayers.delete(id);
    else this.#hiddenLayers.add(id);
    if (this.#layerKinds.get(id) === 'style') this.#dirty = true;
    this.#context?.invalidate();
  }

  attribution(): string[] {
    return [...new Set(this.#options.attribution ?? [])];
  }

  snapshot(): MvtVectorControllerSnapshot {
    const values = [...this.#records.values()];
    return {
      requestedTiles: this.#requested.length,
      sourceTiles: values.length,
      loading: values.filter((record) => record.status === 'loading').length,
      ready: values.filter((record) => record.status === 'ready').length,
      missing: values.filter((record) => record.status === 'missing').length,
      errors: [...this.#errors],
      ...this.#metrics,
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#errors = [];
    this.#labels = [];
    for (const record of this.#records.values()) {
      if (record.status === 'loading') {
        record.abort.abort();
        this.#metrics.loadsAborted++;
      }
    }
    this.#records.clear();
    this.#entryCache.clear();
    this.#entries = [];
    this.#requested = [];
    this.#stale = [];
    this.#options.processor.destroy?.();
    this.#options.source.destroy?.();
    this.#context = null;
  }

  #syncRequested(selected: readonly MvtTileCoordinate[], keys: readonly string[]): void {
    const previous = [...this.#requested, ...this.#stale];
    this.#requested = selected.map((requested, index) => {
      const source = sourceCoordinate(requested, this.#maxNativeZoom);
      return { ...requested, key: keys[index], source, sourceKey: tileKey(source) };
    });
    const requestedKeys = new Set(this.#requested.map(({ key }) => key));
    // Retain previously READY tiles as stale until their replacements settle:
    // dropping them immediately blanks the layer for the frames between a
    // zoom-level switch and the first completed loads.
    this.#stale = previous.filter(
      ({ key, sourceKey }) => !requestedKeys.has(key) && isReady(this.#records.get(sourceKey)),
    );
    for (const request of this.#requested) {
      if (!this.#records.has(request.sourceKey)) this.#load(request.source, request.sourceKey);
    }
    this.#retireStale();
    this.#pruneCaches();
    this.#dirty = true;
  }

  #load(coordinate: MvtTileCoordinate, key: string): void {
    const abort = new AbortController();
    const record: SourceRecord = { coordinate, abort, status: 'loading' };
    this.#records.set(key, record);
    this.#metrics.loadsStarted++;
    void this.#options.source
      .getTile(coordinate.z, coordinate.x, coordinate.y, { signal: abort.signal })
      .then(async (tile) => {
        if (!tile) return undefined;
        return this.#options.processor.process(tile.data, {
          signal: abort.signal,
          options: this.#options.processorOptions,
        });
      })
      .then((processed) => {
        if (this.#destroyed || this.#records.get(key) !== record) return;
        if (processed) {
          record.processed = processed;
          record.status = 'ready';
          this.#metrics.loadsCompleted++;
        } else record.status = 'missing';
        this.#markChanged();
      })
      .catch((error: unknown) => {
        if (this.#destroyed || this.#records.get(key) !== record) return;
        // Only our own abort is silent. An AbortError raised upstream while
        // this tile is still wanted (a shared parse cancelled by another
        // tile) must surface as an error, or the record stays 'loading'
        // forever and the tile never draws.
        if (abort.signal.aborted) return;
        record.status = 'error';
        const value = toError(error);
        this.#metrics.loadsFailed++;
        this.#errors.push(`${key}: ${value.message}`);
        if (this.#errors.length > MAX_ERROR_LOG) {
          this.#errors.splice(0, this.#errors.length - MAX_ERROR_LOG);
        }
        this.#options.onError?.(value);
        this.#markChanged();
      });
  }

  #markChanged(): void {
    this.#retireStale();
    this.#pruneCaches();
    this.#dirty = true;
    this.#context?.invalidate();
  }

  #settled(request: RequestedTile): boolean {
    const status = this.#records.get(request.sourceKey)?.status;
    return status === 'ready' || status === 'missing' || status === 'error';
  }

  // Per-area atomic handover instead of one global settle (the MapLibre
  // "exactly one tile covers a pixel" idea, adapted to unclipped geometry):
  // a stale tile WITH replacements retires the moment every requested tile
  // overlapping it has settled, and #rebuildEntries suppresses ready
  // requested tiles that still overlap a retained stale — old and new tiles
  // for the same area are never drawn together, so a translucent style does
  // not darken during swaps. A stale tile with NO overlapping request
  // (same-zoom churn at the selection edge) instead survives until the
  // whole selection settles: retiring those immediately would pop tiles out
  // at the screen edge on every camera step, flashing while the camera
  // crosses a zoom-level boundary.
  #retireStale(): void {
    if (this.#stale.length === 0) return;
    const globallySettled = this.#requested.every((request) => this.#settled(request));
    const remaining = this.#stale.filter((stale) => {
      const overlapping = this.#requested.filter((request) => tilesOverlap(stale, request));
      if (overlapping.length > 0) return overlapping.some((request) => !this.#settled(request));
      return this.#requested.length > 0 && !globallySettled;
    });
    if (remaining.length !== this.#stale.length) {
      this.#stale = remaining;
      this.#dirty = true;
    }
  }

  #pruneCaches(): void {
    // Built entries (style batches) linger past deselection like ready records
    // do (bounded, least recently used first): a tile that flips out and back
    // in while the camera moves then reuses its batches instead of
    // re-filtering every triangle (batch building and filter evaluation take
    // 15-20% of main-thread time during a 9 s pan). The bound applies beyond
    // the tiles in use, which are protected.
    const wantedKeys = new Set([...this.#requested, ...this.#stale].map(({ key }) => key));
    const inUse = (cache: Iterable<string>, wanted: Set<string>) =>
      [...cache].filter((key) => wanted.has(key)).length;
    this.#entryCache.prune(
      (key) => wantedKeys.has(key),
      inUse(this.#entryCache.keys(), wantedKeys) + RETAINED_READY_RECORDS,
    );
    const desiredSources = new Set(
      [...this.#requested, ...this.#stale].map(({ sourceKey }) => sourceKey),
    );
    // Undesired records still loading or failed go at once; ready records
    // linger past deselection (bounded): re-selecting a tile after a boundary
    // crossing then reuses the processed tile instead of a reload, whose
    // few-frame gap would flash around a zoom-level edge.
    for (const [key, record] of this.#records) {
      if (desiredSources.has(key) || record.status === 'ready') continue;
      if (record.status === 'loading') {
        record.abort.abort();
        this.#metrics.loadsAborted++;
      }
      this.#records.delete(key);
    }
    this.#records.prune(
      (key) => desiredSources.has(key),
      inUse(this.#records.keys(), desiredSources) + RETAINED_READY_RECORDS,
    );
  }

  #cachedEntries(request: RequestedTile, processed: ProcessedMvtTile): CachedEntries {
    const cached = this.#entryCache.get(request.key);
    if (cached?.processed === processed) return cached;
    const meshes = [...processed.fillMeshes, ...processed.lineMeshes, ...processed.extrusionMeshes];
    const entries: Array<{ order: number; entry: VectorRenderEntry }> = [];
    const batchStartedAt = performance.now();
    for (const layer of this.#style) {
      if (request.z < layer.minZoom || request.z > layer.maxZoom) continue;
      for (const mesh of meshes) {
        if (mesh.layerName !== layer.sourceLayer || mesh.type !== layer.styleLayer.type) continue;
        const table = processed.featureTables.find(
          (candidate) =>
            candidate.layerName === mesh.layerName && candidate.type === mesh.sourceGeometryType,
        );
        if (!table) continue;
        const batch = buildBatch(mesh, table, layer);
        if (!batch) continue;
        entries.push({
          order: layer.order,
          entry: {
            sourceId: this.#options.sourceId,
            sourceTileKey: request.sourceKey,
            requestedTileKey: request.key,
            mesh,
            batch,
            featureTable: table,
          },
        });
      }
    }
    this.#metrics.batchesBuilt += entries.length;
    this.#metrics.batchMs += performance.now() - batchStartedAt;
    const value = { processed, entries };
    this.#entryCache.set(request.key, value);
    return value;
  }

  #rebuildLabels(activeStyles: readonly boolean[], zoom: number): void {
    const built = this.#buildLabels(activeStyles, zoom);
    this.#labels = built.labels;
    this.#labelZoomMin = built.min;
    this.#labelZoomMax = built.max;
  }
  /** Build labels for a style mask without touching any cached state. */
  #buildLabels(
    activeStyles: readonly boolean[],
    zoom: number,
  ): { labels: readonly VectorLabel[]; min: number; max: number } {
    // Candidate membership stays constant in [min, max). Track only the two
    // neighboring feature thresholds while evaluating visible, active styles.
    let min = -Infinity,
      max = Infinity;
    const allowed = (
      properties: Readonly<Record<string, unknown>>,
      style: MvtLabelStyle,
    ): boolean => {
      const value = style.minZoomField ? properties[style.minZoomField] : undefined;
      if (typeof value !== 'number' || !Number.isFinite(value)) return true;
      if (zoom >= value) {
        min = Math.max(min, value);
        return true;
      }
      max = Math.min(max, value);
      return false;
    };
    const labels: VectorLabel[] = [];
    const seen = new Set<string>();
    const requests = [
      ...this.#stale,
      ...this.#requested.filter((r) => !this.#stale.some((s) => tilesOverlap(s, r))),
    ];
    for (const [styleIndex, style] of (this.#options.labels ?? []).entries()) {
      const matches = this.#labelFilters[styleIndex];
      // Visibility is folded into activeStyles by the caller, so queryLabels can
      // ask for hidden layers without changing any state.
      if (!activeStyles[styleIndex]) continue;
      for (const request of requests) {
        const processed = this.#records.get(request.sourceKey)?.processed;
        const n = 2 ** request.source.z;
        const convert = (x: number, y: number, extent: number): readonly [number, number] => [
          ((request.source.x + x / extent) / n) * 360 - 180,
          (Math.atan(Math.sinh(Math.PI * (1 - (2 * (request.source.y + y / extent)) / n))) * 180) /
            Math.PI,
        ];
        if (style.placement === 'line') {
          for (const [pathIndex, line] of (processed?.lineFeatures ?? []).entries()) {
            if (
              line.layerName !== style.sourceLayer ||
              !matches(line.properties) ||
              !allowed(line.properties, style)
            ) {
              continue;
            }
            const text = labelText(line.properties, style.textField);
            const code = style.iconField ? String(line.properties[style.iconField] ?? '') : '';
            const icon =
              style.icon ??
              (style.iconMap
                ? Object.hasOwn(style.iconMap, code)
                  ? style.iconMap[code]
                  : undefined
                : code || undefined);
            if (!text && !icon) continue;
            const scale = 2 ** (request.z - request.source.z),
              size = line.extent / scale;
            const x = (request.x - request.source.x * scale) * size,
              y = (request.y - request.source.y * scale) * size;
            for (const [part, path] of clipPath(line.path, [x, y, x + size, y + size]).entries()) {
              const coordinates = path.map((p) => convert(p[0], p[1], line.extent));
              labels.push({
                key: `${style.id}/${request.key}/${pathIndex}/${part}`,
                styleId: style.id,
                sourceZoom: request.source.z,
                ignoreCollisionWith: style.ignoreCollisionWith,
                text,
                icon,
                iconSize: style.iconSize ?? 1,
                iconTextFit: style.iconTextFit,
                iconPadding: style.iconPadding,
                textOffset: style.textOffset,
                lon: coordinates[0][0],
                lat: coordinates[0][1],
                path: coordinates,
                repeatDistance: style.repeatDistance ?? 100,
                size: style.size ?? 14,
                fontFamily: style.fontFamily ?? 'sans-serif',
                color: style.color ?? '#ffffff',
                haloColor: style.haloColor ?? '#152532',
                haloWidth: style.haloWidth ?? 2,
                offset: style.offset ?? [0, 0],
                allowOverlap: style.allowOverlap ?? false,
                properties: line.properties,
              });
            }
          }
          continue;
        }
        const points = processed?.pointFeatures ?? [];
        for (const point of points) {
          if (
            point.layerName !== style.sourceLayer ||
            !matches(point.properties) ||
            !allowed(point.properties, style)
          ) {
            continue;
          }
          const text = labelText(point.properties, style.textField);
          const fieldIcon = style.iconField ? String(point.properties[style.iconField] ?? '') : '';
          const icon =
            style.icon ??
            (style.iconMap
              ? Object.hasOwn(style.iconMap, fieldIcon)
                ? style.iconMap[fieldIcon]
                : undefined
              : fieldIcon || undefined);
          if (!text && !icon) continue;
          const n = 2 ** request.source.z;
          const x = (request.source.x + point.x / point.extent) / n;
          const y = (request.source.y + point.y / point.extent) / n;
          const rn = 2 ** request.z;
          // Half-open ownership excludes MVT buffers and duplicate overzoom children.
          if (
            x < request.x / rn ||
            x >= (request.x + 1) / rn ||
            y < request.y / rn ||
            y >= (request.y + 1) / rn
          ) {
            continue;
          }
          const key = `${style.id}/${request.sourceKey}/${point.featureIndex}/${point.x}/${point.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rawRotation = style.rotationField
            ? point.properties[style.rotationField]
            : (style.rotation ?? 0);
          const layout = style.resolvePointLayout?.(point.properties) ?? {};
          const angle =
            layout.rotation ??
            (typeof rawRotation === 'number' && Number.isFinite(rawRotation)
              ? rawRotation
              : (style.rotation ?? 0));
          if (!Number.isFinite(angle)) {
            throw new RangeError('resolved label rotation must be finite');
          }
          if (
            layout.collisionGroup !== undefined &&
            (typeof layout.collisionGroup !== 'string' || !layout.collisionGroup.length)
          ) {
            throw new TypeError('resolved collisionGroup must be a non-empty string');
          }
          const rotation = ((((angle + 180) % 360) + 360) % 360) - 180;
          const collisionGroup =
            layout.collisionGroup === undefined
              ? undefined
              : JSON.stringify([this.#options.sourceId, style.id, layout.collisionGroup]);
          labels.push({
            key,
            collisionGroup,
            styleId: style.id,
            sourceZoom: request.source.z,
            ignoreCollisionWith: style.ignoreCollisionWith,
            text,
            rotation,
            icon,
            iconTextFit: style.iconTextFit,
            iconPadding: style.iconPadding,
            textOffset: style.textOffset,
            iconSize: style.iconSize ?? 1,
            lon: x * 360 - 180,
            lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
            size: style.size ?? 14,
            fontFamily: style.fontFamily ?? 'sans-serif',
            color: style.color ?? '#ffffff',
            haloColor: style.haloColor ?? '#152532',
            haloWidth: style.haloWidth ?? 2,
            offset: style.offset ?? [0, 0],
            allowOverlap: style.allowOverlap ?? false,
            properties: point.properties,
          });
        }
      }
    }
    return { labels, min, max };
  }

  #rebuildEntries(): void {
    const entries: Array<{ order: number; requestOrder: number; entry: VectorRenderEntry }> = [];
    this.#stale.forEach((request, staleOrder) => {
      const record = this.#records.get(request.sourceKey);
      if (!isReady(record)) return;
      for (const cached of this.#cachedEntries(request, record.processed).entries) {
        entries.push({ ...cached, requestOrder: staleOrder - this.#stale.length });
      }
    });
    this.#requested.forEach((request, requestOrder) => {
      const record = this.#records.get(request.sourceKey);
      if (!isReady(record)) return;
      // Atomic handover: a fresh tile stays hidden while any retained stale
      // tile overlaps it, so a screen area is never covered twice.
      if (this.#stale.some((stale) => tilesOverlap(stale, request))) return;
      for (const cached of this.#cachedEntries(request, record.processed).entries) {
        entries.push({ ...cached, requestOrder });
      }
    });
    entries.sort((a, b) => a.order - b.order || a.requestOrder - b.requestOrder);
    this.#entries = entries
      .map(({ entry }) => entry)
      .filter((entry) => !this.#hiddenLayers.has(entry.batch.styleLayer.id));
  }
}

export function createMvtVectorController(
  options: MvtVectorControllerOptions,
): MvtVectorController {
  return new DefaultMvtVectorController(options);
}
