/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import type { GlobeRenderPass } from './layer.js';

export type RenderPassCounters = { drawCalls: number; setPipelines: number };

/**
 * Wraps a GPURenderPassEncoder for the layer contract. Layers set their full
 * state before every draw, so consecutive draws of the same material re-issue
 * the same pipeline, bind groups and vertex buffers. The wrapper
 * drops a re-issue when the value at that slot is unchanged since the last
 * call in this pass, and counts only what reaches the encoder.
 */
function sameOffsets(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function createRenderPass(
  gpuPass: Pick<
    GPURenderPassEncoder,
    | 'setPipeline'
    | 'setBindGroup'
    | 'setVertexBuffer'
    | 'setIndexBuffer'
    | 'setStencilReference'
    | 'drawIndexed'
    | 'end'
  >,
  counters: RenderPassCounters,
): GlobeRenderPass & { end(): void } {
  let pipeline: GPURenderPipeline | null = null;
  const groups: (GPUBindGroup | undefined)[] = [];
  const groupOffsets: (readonly number[] | undefined)[] = [];
  const vertexBuffers: (GPUBuffer | undefined)[] = [];
  let indexBuffer: GPUBuffer | null = null,
    indexFormat: GPUIndexFormat | null = null;
  let stencil: number | null = null;
  return {
    setPipeline: (p) => {
      if (p === pipeline) return;
      pipeline = p;
      counters.setPipelines++;
      gpuPass.setPipeline(p);
    },
    setBindGroup: (i, g, dynamicOffsets) => {
      if (groups[i] === g && sameOffsets(groupOffsets[i], dynamicOffsets)) return;
      groups[i] = g;
      groupOffsets[i] = dynamicOffsets ? [...dynamicOffsets] : undefined;
      if (dynamicOffsets) gpuPass.setBindGroup(i, g, dynamicOffsets as number[]);
      else gpuPass.setBindGroup(i, g);
    },
    setVertexBuffer: (i, b) => {
      if (vertexBuffers[i] === b) return;
      vertexBuffers[i] = b;
      gpuPass.setVertexBuffer(i, b);
    },
    setIndexBuffer: (b, f) => {
      if (b === indexBuffer && f === indexFormat) return;
      indexBuffer = b;
      indexFormat = f;
      gpuPass.setIndexBuffer(b, f);
    },
    setStencilReference: (r) => {
      if (r === stencil) return;
      stencil = r;
      gpuPass.setStencilReference(r);
    },
    drawIndexed: (n, inst, first) => {
      counters.drawCalls++;
      gpuPass.drawIndexed(n, inst, first);
    },
    end: () => {
      gpuPass.end();
    },
  };
}
