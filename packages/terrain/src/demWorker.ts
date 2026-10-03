/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { decodeDemPixels, type DemEncoding } from './demEncoding.js';

interface LoadMessage {
  readonly type: 'load';
  readonly id: number;
  readonly url: string;
  readonly encoding: DemEncoding;
}

interface AbortMessage {
  readonly type: 'abort';
  readonly id: number;
}

const active = new Map<number, AbortController>();

self.onmessage = async (event: MessageEvent<LoadMessage | AbortMessage>): Promise<void> => {
  const message = event.data;
  if (message.type === 'abort') {
    active.get(message.id)?.abort();
    return;
  }
  const abort = new AbortController();
  active.set(message.id, abort);
  const post = (value: unknown, transfer: Transferable[] = []) => {
    (self as unknown as Worker).postMessage(value, transfer);
  };
  try {
    const response = await fetch(message.url, { signal: abort.signal });
    if (!response.ok) {
      post({
        id: message.id,
        ok: false,
        status: response.status,
        retryAfter: response.headers.get('retry-after') ?? undefined,
      });
      return;
    }
    const image = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('DEM worker could not create a 2D canvas context');
    context.drawImage(image, 0, 0);
    image.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const tile = decodeDemPixels(pixels, canvas.width, canvas.height, message.encoding);
    post({ id: message.id, ok: true, size: tile.size, data: tile.data }, [tile.data.buffer]);
  } catch (error) {
    post({
      id: message.id,
      ok: false,
      aborted: abort.signal.aborted,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(message.id);
  }
};
