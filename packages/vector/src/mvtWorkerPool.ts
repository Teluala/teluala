/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { MvtTileProcessor, ProcessedMvtTile } from './mvtController.js';

export interface MvtWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void | Promise<number>;
  addEventListener?(
    type: 'message' | 'error',
    listener: (event: MessageEvent | ErrorEvent) => void,
  ): void;
  removeEventListener?(
    type: 'message' | 'error',
    listener: (event: MessageEvent | ErrorEvent) => void,
  ): void;
  on?(type: 'message' | 'error', listener: (value: unknown) => void): void;
  off?(type: 'message' | 'error', listener: (value: unknown) => void): void;
}

export interface MvtWorkerPoolOptions {
  readonly size?: number;
  readonly workerFactory: (index: number) => MvtWorkerLike;
}

export interface MvtWorkerPoolSnapshot {
  readonly size: number;
  readonly active: number;
  readonly queued: number;
  readonly spawned: number;
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  readonly terminated: number;
}

export interface MvtWorkerPoolProcessor extends MvtTileProcessor {
  snapshot(): MvtWorkerPoolSnapshot;
}

export interface DefaultMvtWorkerProcessorOptions {
  readonly size?: number;
  readonly workerOptions?: Omit<WorkerOptions, 'type'>;
}

interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly result: ProcessedMvtTile;
}

interface WorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly error?: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

interface Job {
  readonly id: number;
  readonly data: ArrayBuffer | Uint8Array;
  readonly options: unknown;
  readonly signal: AbortSignal;
  readonly resolve: (value: ProcessedMvtTile) => void;
  readonly reject: (reason: unknown) => void;
  abortListener: () => void;
  slot: WorkerSlot | null;
  settled: boolean;
}

interface WorkerSlot {
  readonly index: number;
  worker: MvtWorkerLike;
  job: Job | null;
  unlisten: Array<() => void>;
}

function abortError(message = 'MVT worker request was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function listen(
  worker: MvtWorkerLike,
  type: 'message' | 'error',
  listener: (value: unknown) => void,
): () => void {
  if (
    typeof worker.addEventListener === 'function' &&
    typeof worker.removeEventListener === 'function'
  ) {
    const wrapped =
      type === 'message'
        ? (event: MessageEvent | ErrorEvent) => listener((event as MessageEvent).data)
        : (event: MessageEvent | ErrorEvent) => listener(event);
    worker.addEventListener(type, wrapped);
    return () => worker.removeEventListener?.(type, wrapped);
  }
  if (typeof worker.on === 'function') {
    worker.on(type, listener);
    return () => worker.off?.(type, listener);
  }
  throw new TypeError('worker must support addEventListener or on');
}

class DefaultMvtWorkerPoolProcessor implements MvtWorkerPoolProcessor {
  #factory: (index: number) => MvtWorkerLike;
  #slots: WorkerSlot[];
  #queue: Job[] = [];
  #nextId = 1;
  #destroyed = false;
  #metrics = { spawned: 0, completed: 0, failed: 0, aborted: 0, terminated: 0 };

  constructor(options: MvtWorkerPoolOptions) {
    const size = options?.size ?? 2;
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('worker pool size must be a positive integer');
    }
    if (typeof options?.workerFactory !== 'function') {
      throw new TypeError('workerFactory is required');
    }
    this.#factory = options.workerFactory;
    this.#slots = new Array<WorkerSlot>(size);
    try {
      for (let index = 0; index < size; index++) this.#spawn(index);
    } catch (error) {
      for (const slot of this.#slots) if (slot) this.#terminate(slot);
      throw error;
    }
  }

  process(
    data: ArrayBuffer | Uint8Array,
    options: { readonly signal: AbortSignal; readonly options?: unknown },
  ): Promise<ProcessedMvtTile> {
    if (this.#destroyed) return Promise.reject(new Error('MVT worker pool is destroyed'));
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError('MVT worker input must be ArrayBuffer or Uint8Array'));
    }
    if (!options?.signal) return Promise.reject(new TypeError('AbortSignal is required'));
    if (options.signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: this.#nextId++,
        data,
        options: options.options,
        signal: options.signal,
        resolve,
        reject,
        abortListener: () => {},
        slot: null,
        settled: false,
      };
      job.abortListener = () => this.#abort(job);
      job.signal.addEventListener('abort', job.abortListener, { once: true });
      this.#queue.push(job);
      this.#drain();
    });
  }

  snapshot(): MvtWorkerPoolSnapshot {
    return {
      size: this.#slots.length,
      active: this.#slots.filter((slot) => slot.job).length,
      queued: this.#queue.length,
      ...this.#metrics,
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const job of this.#queue.splice(0)) {
      this.#settle(job, 'reject', abortError('MVT worker pool was destroyed'));
    }
    for (const slot of this.#slots) {
      if (slot.job) {
        this.#settle(slot.job, 'reject', abortError('MVT worker pool was destroyed'));
        slot.job = null;
      }
      this.#terminate(slot);
    }
  }

  #spawn(index: number): void {
    const worker = this.#factory(index);
    if (
      !worker ||
      typeof worker.postMessage !== 'function' ||
      typeof worker.terminate !== 'function'
    ) {
      throw new TypeError('workerFactory must return a Worker-compatible object');
    }
    const slot: WorkerSlot = { index, worker, job: null, unlisten: [] };
    slot.unlisten.push(
      listen(worker, 'message', (message) => this.#message(slot, message as WorkerResponse)),
      listen(worker, 'error', (error) => this.#workerError(slot, error)),
    );
    this.#slots[index] = slot;
    this.#metrics.spawned++;
  }

  #terminate(slot: WorkerSlot): void {
    slot.unlisten.forEach((unlisten) => unlisten());
    slot.unlisten = [];
    void slot.worker.terminate();
    this.#metrics.terminated++;
  }

  #replace(slot: WorkerSlot): void {
    const { index } = slot;
    this.#terminate(slot);
    if (!this.#destroyed) this.#spawn(index);
  }

  #drain(): void {
    if (this.#destroyed) return;
    for (const slot of this.#slots) {
      if (slot.job || this.#queue.length === 0) continue;
      const job = this.#queue.shift();
      if (!job || job.settled) continue;
      slot.job = job;
      job.slot = slot;
      const transfer = job.data instanceof Uint8Array ? job.data.buffer : job.data;
      try {
        slot.worker.postMessage(
          {
            id: job.id,
            type: 'process-mvt',
            data: job.data,
            options: job.options,
          },
          [transfer],
        );
      } catch (error) {
        slot.job = null;
        job.slot = null;
        this.#metrics.failed++;
        this.#settle(job, 'reject', error);
        this.#replace(slot);
        queueMicrotask(() => this.#drain());
      }
    }
  }

  #message(slot: WorkerSlot, message: WorkerResponse): void {
    if (this.#destroyed || this.#slots[slot.index] !== slot) return;
    const job = slot.job;
    if (!job || message?.id !== job.id) return;
    slot.job = null;
    job.slot = null;
    if (message.ok) {
      this.#metrics.completed++;
      this.#settle(job, 'resolve', message.result);
    } else {
      this.#metrics.failed++;
      this.#settle(job, 'reject', new Error(message.error ?? 'MVT worker failed'));
    }
    this.#drain();
  }

  #workerError(slot: WorkerSlot, error: unknown): void {
    if (this.#destroyed || this.#slots[slot.index] !== slot) return;
    const job = slot.job;
    slot.job = null;
    if (job) {
      job.slot = null;
      this.#metrics.failed++;
      this.#settle(job, 'reject', new Error(errorMessage(error)));
    }
    this.#replace(slot);
    this.#drain();
  }

  #abort(job: Job): void {
    if (job.settled) return;
    const queuedIndex = this.#queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      this.#metrics.aborted++;
      this.#settle(job, 'reject', abortError());
      return;
    }
    const slot = job.slot;
    if (!slot || slot.job !== job) return;
    slot.job = null;
    job.slot = null;
    this.#metrics.aborted++;
    this.#settle(job, 'reject', abortError());
    this.#replace(slot);
    this.#drain();
  }

  #settle(job: Job, method: 'resolve' | 'reject', value: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.signal.removeEventListener('abort', job.abortListener);
    if (method === 'resolve') job.resolve(value as ProcessedMvtTile);
    else job.reject(value);
  }
}

/** Reusable worker processor for the `{ type: 'process-mvt' }` protocol. */
export function createMvtWorkerPoolProcessor(
  options: MvtWorkerPoolOptions,
): MvtWorkerPoolProcessor {
  return new DefaultMvtWorkerPoolProcessor(options);
}

/** Create package-owned module workers that load the self-hosted decoder entry. */
export function createDefaultMvtWorkerProcessor(
  options: DefaultMvtWorkerProcessorOptions = {},
): MvtWorkerPoolProcessor {
  return createMvtWorkerPoolProcessor({
    size: options.size,
    workerFactory: () =>
      new Worker(new URL('./mvtWorkerEntry.js', import.meta.url), {
        ...options.workerOptions,
        type: 'module',
      }),
  });
}
