/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/**
 * One GPU buffer holding a typed array's bytes. Every backend uploads tile
 * geometry this way (create, write, destroy on a failed write); one copy of
 * the four-line dance instead of one per package. The size floor of 4 bytes
 * keeps an empty array a valid buffer.
 */
export function uploadBuffer(
  device: GPUDevice,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage });
  try {
    if (data.byteLength > 0) {
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    return buffer;
  } catch (error) {
    buffer.destroy();
    throw error;
  }
}
