/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/**
 * The shell every controller + backend layer shares: a controller decides
 * WHAT to draw (its update() yields render entries), a backend owns the GPU
 * resources that draw them, and this class binds the two to the engine's
 * GlobeLayer contract — validation, init with rollback, the entries copy,
 * attribution, idempotent destroy. Packages subclass it and add what is
 * theirs (labels, picking) through the protected hooks.
 */
import {
  LAYER_SPEC,
  type FrameState,
  type GlobeLayer,
  type GlobeRenderPass,
  type LayerContext,
} from './layer.js';

export interface ControllerLayerUpdate<Entry> {
  readonly entries?: readonly Entry[];
  readonly needsRender?: boolean;
}
export interface LayerController<
  Entry,
  Update extends ControllerLayerUpdate<Entry> = ControllerLayerUpdate<Entry>,
> {
  init?(context: LayerContext): void;
  update(frame: FrameState): Update | void;
  attribution?(): readonly string[];
  destroy(): void;
}
export interface LayerBackend<Entry> {
  init(context: LayerContext): void;
  draw(pass: GlobeRenderPass, frame: FrameState, entries: readonly Entry[]): void;
  destroy(): void;
}
export interface ControllerLayerOptions<Controller, Backend> {
  readonly name?: string;
  readonly sortKey?: number;
  readonly controller: Controller;
  readonly backend: Backend;
}

function requireMethod(value: unknown, method: string, label: string): void {
  if (!value || typeof (value as Record<string, unknown>)[method] !== 'function') {
    throw new TypeError(`${label}.${method} is required`);
  }
}

export abstract class ControllerLayer<
  Entry,
  Update extends ControllerLayerUpdate<Entry>,
  Controller extends LayerController<Entry, Update>,
  Backend extends LayerBackend<Entry>,
> implements GlobeLayer
{
  readonly layerSpec = LAYER_SPEC;
  readonly name: string;
  readonly sortKey: number;
  protected readonly controller: Controller;
  protected readonly backend: Backend;
  #context: LayerContext | null = null;
  #entries: readonly Entry[] = [];
  // The controller's own array behind #entries: handed the same array again,
  // the layer keeps its copy, so a backend that compares array identity can
  // skip its per-frame diff.
  #sourceEntries: readonly Entry[] | null = null;
  #destroyed = false;

  /** `kind` names the layer in errors ('vector layer is destroyed'). */
  protected constructor(
    kind: string,
    options: ControllerLayerOptions<Controller, Backend>,
    defaults: { readonly name: string; readonly sortKey: number },
  ) {
    const name = options.name ?? defaults.name;
    const sortKey = options.sortKey ?? defaults.sortKey;
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`${kind} layer name is required`);
    }
    if (!Number.isFinite(sortKey)) throw new TypeError('sortKey must be finite');
    requireMethod(options.controller, 'update', 'controller');
    requireMethod(options.controller, 'destroy', 'controller');
    requireMethod(options.backend, 'init', 'backend');
    requireMethod(options.backend, 'draw', 'backend');
    requireMethod(options.backend, 'destroy', 'backend');
    this.#kind = kind;
    this.name = name;
    this.sortKey = sortKey;
    this.controller = options.controller;
    this.backend = options.backend;
  }
  readonly #kind: string;

  /** The entries of the last update (a copy; empty after destroy). */
  get entries(): readonly Entry[] {
    return this.#entries;
  }
  protected get destroyed(): boolean {
    return this.#destroyed;
  }

  init(context: LayerContext): void {
    if (this.#destroyed) throw new Error(`${this.#kind} layer is destroyed`);
    if (this.#context) throw new Error(`${this.#kind} layer is already initialized`);
    if (!context || typeof context.invalidate !== 'function') {
      throw new TypeError('LayerContext.invalidate is required');
    }
    this.#context = context;
    try {
      this.backend.init(context);
      this.controller.init?.(context);
    } catch (error) {
      try {
        this.controller.destroy();
      } catch {
        /* Preserve the initialization error. */
      }
      try {
        this.backend.destroy();
      } catch {
        /* Preserve the initialization error. */
      }
      this.#context = null;
      throw error;
    }
  }

  update(frame: FrameState): boolean {
    this.requireInitialized();
    const update = this.controller.update(frame);
    if (update?.entries !== undefined) {
      if (!Array.isArray(update.entries)) {
        throw new TypeError('controller update entries must be an array');
      }
      if (update.entries !== this.#sourceEntries) {
        this.#sourceEntries = update.entries;
        this.#entries = [...update.entries];
      }
    }
    this.onUpdate?.(update);
    return Boolean(update?.needsRender);
  }

  draw(pass: GlobeRenderPass, frame: FrameState): void {
    this.requireInitialized();
    this.backend.draw(pass, frame, this.#entries);
    this.onDraw?.(pass, frame);
  }

  attribution(): string[] {
    this.requireInitialized();
    const values = this.controller.attribution?.() ?? [];
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
      throw new TypeError('controller attribution must return strings');
    }
    return [...new Set(values)];
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#entries = [];
    this.#sourceEntries = null;
    this.onDestroy?.();
    try {
      this.backend.destroy();
    } finally {
      // A caller-supplied backend may throw; the controller must still stop
      // its worker, abort in-flight fetches, and clear retry timers.
      this.controller.destroy();
      this.#context = null;
    }
  }

  protected requireInitialized(): void {
    if (this.#destroyed) throw new Error(`${this.#kind} layer is destroyed`);
    if (!this.#context) throw new Error(`${this.#kind} layer is not initialized`);
  }

  /** After the entries of an update were taken (labels, pick invalidation). */
  protected onUpdate?(update: Update | void): void;
  /** After the backend drew the entries (labels). */
  protected onDraw?(pass: GlobeRenderPass, frame: FrameState): void;
  /** Before the parts are destroyed (release what the subclass holds). */
  protected onDestroy?(): void;
}
