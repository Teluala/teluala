/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { DemEncoding } from './demEncoding.js';
import type { HeightTileSource } from './groundSurface.js';
import { TileHttpError, assertWebMercatorTile } from 'teluala';

export interface WorkerXyzDemTileSourceOptions {
  readonly url: string;
  readonly encoding: DemEncoding;
  readonly workerFactory?: () => Worker;
}

interface PendingRequest {
  readonly url: string;
  readonly resolve: (tile: { size: number; data: Float32Array } | undefined) => void;
  readonly reject: (error: unknown) => void;
  readonly detachAbort: () => void;
}

function abortError(reason?: unknown): unknown {
  return reason ?? new DOMException('Aborted', 'AbortError');
}

/** Fetch and decode XYZ DEM images in one package-owned module worker. */
export function createWorkerXyzDemTileSource(
  options: WorkerXyzDemTileSourceOptions,
): HeightTileSource {
  if (
    !options ||
    typeof options.url !== 'string' ||
    !['{z}', '{x}', '{y}'].every((token) => options.url.includes(token))
  ) {
    throw new TypeError('DEM XYZ URL must contain {z}, {x}, and {y}');
  }
  const encodings: readonly string[] = ['terrarium', 'terrainrgb'];
  if (!encodings.includes(options.encoding)) {
    throw new RangeError('unsupported raster DEM encoding');
  }
  const workerFactory =
    options.workerFactory ??
    (() => {
      if (typeof Worker === 'undefined') throw new Error('Worker is not available');
      return new Worker(new URL('./demWorker.js', import.meta.url), { type: 'module' });
    });
  let worker: Worker | null = null;
  let destroyed = false;
  let requestId = 0;
  const pending = new Map<number, PendingRequest>();

  const failAll = (error: unknown): void => {
    for (const request of pending.values()) {
      request.detachAbort();
      request.reject(error);
    }
    pending.clear();
  };

  const getWorker = (): Worker => {
    if (worker) return worker;
    worker = workerFactory();
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        id?: unknown;
        ok?: unknown;
        size?: unknown;
        data?: unknown;
        status?: unknown;
        retryAfter?: unknown;
        aborted?: unknown;
        message?: unknown;
      };
      if (!Number.isInteger(message.id)) return;
      const id = message.id as number;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      request.detachAbort();
      if (
        message.ok === true &&
        Number.isInteger(message.size) &&
        message.data instanceof Float32Array &&
        message.data.length === (message.size as number) ** 2
      ) {
        request.resolve({ size: message.size as number, data: message.data });
      } else if (message.status === 404 || message.status === 204) {
        request.resolve(undefined);
      } else if (typeof message.status === 'number') {
        request.reject(
          new TileHttpError(
            message.status,
            request.url,
            typeof message.retryAfter === 'string' ? message.retryAfter : undefined,
          ),
        );
      } else if (message.aborted === true) {
        request.reject(abortError());
      } else {
        request.reject(
          new Error(
            typeof message.message === 'string' ? message.message : 'DEM worker decode failed',
          ),
        );
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      failAll(new Error(event.message || 'DEM worker failed'));
    };
    return worker;
  };

  return {
    async getHeightTile(z, x, y, { signal }) {
      if (destroyed) return Promise.reject(new Error('DEM tile source is destroyed'));
      assertWebMercatorTile(z, x, y);
      if (signal.aborted) return Promise.reject(abortError(signal.reason));
      const url = options.url
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const id = ++requestId;
      const activeWorker = getWorker();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!pending.delete(id)) return;
          activeWorker.postMessage({ type: 'abort', id });
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          url,
          resolve,
          reject,
          detachAbort: () => signal.removeEventListener('abort', onAbort),
        });
        activeWorker.postMessage({
          type: 'load',
          id,
          url,
          encoding: options.encoding,
        });
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      failAll(abortError());
      worker?.terminate();
      worker = null;
    },
  };
}
