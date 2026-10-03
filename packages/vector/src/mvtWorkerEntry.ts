/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { handleMvtWorkerRequest, type MvtWorkerRequest } from './mvtDecode.js';

interface MvtWorkerScope {
  onmessage: ((event: MessageEvent<MvtWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

// This emitted module is self-hostable and requires no blob URL or CDN import.
// The build bundles this entry with its dependencies: module workers do not
// inherit the document import map, so bare specifiers would fail to resolve.
const workerScope = globalThis as unknown as MvtWorkerScope;
workerScope.onmessage = (event) => {
  const response = handleMvtWorkerRequest(event.data);
  workerScope.postMessage(response.message, response.transferables);
};
