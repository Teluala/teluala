/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import {
  ControllerLayer,
  LAYER_SPEC,
  type FrameState,
  type GlobeLayer,
  type GlobeRenderPass,
  type LayerContext,
} from 'teluala';

import type {
  VectorControllerUpdate,
  VectorGpuBackend,
  VectorLayerController,
  VectorLayerOptions,
  VectorRenderEntry,
  VectorLabel,
} from './types.js';
import { buildFeaturePickCatalog, resolveFeaturePick } from './pickCatalog.js';
import type { VectorFeaturePickCatalog, VectorFeaturePickRecord } from './types.js';

export interface VectorLayer extends GlobeLayer {
  attribution(): string[];
  pickResolve(localId: number): VectorFeaturePickRecord | null;
  /**
   * The labels as their own layer when `labelSortKey` was given, else null.
   * Attach it to the engine next to this layer; it draws the same frame's
   * labels (the engine runs every update() before any draw()), owns no GPU
   * resources and is not part of picking.
   */
  readonly labelLayer: GlobeLayer | null;
}

const EMPTY_PICK_CATALOG: VectorFeaturePickCatalog = { draws: [], records: [], count: 0 };

// On the shared controller + backend shell (core ControllerLayer) a vector
// layer adds two things: the controller's labels, drawn after the geometry,
// and feature picking through a catalog built from the entries.
class TelualaVectorLayer
  extends ControllerLayer<
    VectorRenderEntry,
    VectorControllerUpdate,
    VectorLayerController,
    VectorGpuBackend
  >
  implements VectorLayer
{
  #labels: readonly VectorLabel[] = [];
  #pickCatalog: VectorFeaturePickCatalog = EMPTY_PICK_CATALOG;
  // The catalog is only read by pickDraw / pickResolve (on demand from the
  // engine's pick), so it is rebuilt lazily: rebuilding it on every entries
  // change would take 25-30% of main-thread time while the camera moves with
  // ~30 tiles in view.
  #pickDirty = false;

  // Null unless the caller asked for labels at their own sortKey. Decided
  // once here: there is no runtime switch between the two arrangements.
  readonly labelLayer: GlobeLayer | null;

  constructor(options: VectorLayerOptions) {
    super('vector', options, { name: 'vector', sortKey: 150 });
    this.labelLayer =
      options.labelSortKey === undefined
        ? null
        : new VectorLabelLayer(`${this.name}-labels`, options.labelSortKey, (pass, frame) => {
            this.requireInitialized();
            this.backend.drawLabels?.(pass, frame, this.#labels);
          });
  }

  protected override onUpdate(update: VectorControllerUpdate | void): void {
    if (update?.labels !== undefined) this.#labels = update.labels;
    if (update?.entries !== undefined) this.#pickDirty = true;
  }

  protected override onDraw(pass: GlobeRenderPass, frame: FrameState): void {
    // With a label layer the text is drawn there, at its own sortKey.
    if (this.labelLayer) return;
    this.backend.drawLabels?.(pass, frame, this.#labels);
  }

  pickDraw(pass: GlobeRenderPass, frame: FrameState, idBase: number): number {
    this.requireInitialized();
    if (!Number.isInteger(idBase) || idBase < 0) {
      throw new RangeError('idBase must be a non-negative integer');
    }
    if (!this.backend.pickDraw || this.#catalog().count === 0) return 0;
    if (idBase + this.#pickCatalog.count - 1 > 0xffffffff) {
      throw new RangeError('pick id allocation exceeds uint32 range');
    }
    this.backend.pickDraw(pass, frame, {
      idBase,
      entries: this.entries,
      draws: this.#pickCatalog.draws,
    });
    return this.#pickCatalog.count;
  }

  pickResolve(localId: number): VectorFeaturePickRecord | null {
    this.requireInitialized();
    return resolveFeaturePick(this.#catalog(), localId);
  }

  #catalog(): VectorFeaturePickCatalog {
    if (this.#pickDirty) {
      this.#pickCatalog = this.backend.pickDraw
        ? buildFeaturePickCatalog(this.entries)
        : EMPTY_PICK_CATALOG;
      this.#pickDirty = false;
    }
    return this.#pickCatalog;
  }

  protected override onDestroy(): void {
    this.#pickDirty = false;
    this.#labels = [];
    this.#pickCatalog = EMPTY_PICK_CATALOG;
  }
}

// The labels of a vector layer, as a layer of their own: no controller, no
// backend, no GPU resources — it asks the vector layer to draw its current
// labels. Two ControllerLayers cannot share a controller and a backend (each
// would init and destroy both), so this stays outside that shell.
class VectorLabelLayer implements GlobeLayer {
  readonly layerSpec = LAYER_SPEC;
  readonly name: string;
  readonly sortKey: number;
  readonly #drawLabels: (pass: GlobeRenderPass, frame: FrameState) => void;
  #destroyed = false;

  constructor(
    name: string,
    sortKey: number,
    drawLabels: (pass: GlobeRenderPass, frame: FrameState) => void,
  ) {
    if (!Number.isFinite(sortKey)) throw new TypeError('labelSortKey must be finite');
    this.name = name;
    this.sortKey = sortKey;
    this.#drawLabels = drawLabels;
  }

  init(context: LayerContext): void {
    // Nothing of its own to set up; the vector layer's backend is already
    // initialized. Checked so a bad context fails here as it would elsewhere.
    if (!context || typeof context.invalidate !== 'function') {
      throw new TypeError('LayerContext.invalidate is required');
    }
  }

  draw(pass: GlobeRenderPass, frame: FrameState): void {
    if (this.#destroyed) return;
    this.#drawLabels(pass, frame);
  }

  /** Releases nothing: the vector layer owns the controller and the backend. */
  destroy(): void {
    this.#destroyed = true;
  }
}

/** Create an optional vector layer without importing or owning the Teluala engine. */
export function createVectorLayer(options: VectorLayerOptions): VectorLayer {
  if (!options) throw new TypeError('vector layer options are required');
  return new TelualaVectorLayer(options);
}
