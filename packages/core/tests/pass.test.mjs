/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRenderPass } from '../dist/pass.js';

function fakeGpuPass() {
  const calls = [];
  return {
    calls,
    setPipeline(p) {
      calls.push(['setPipeline', p]);
    },
    setBindGroup(i, g, offsets) {
      calls.push(['setBindGroup', i, g, offsets]);
    },
    setVertexBuffer(i, b) {
      calls.push(['setVertexBuffer', i, b]);
    },
    setIndexBuffer(b, f) {
      calls.push(['setIndexBuffer', b, f]);
    },
    setStencilReference(r) {
      calls.push(['setStencilReference', r]);
    },
    drawIndexed(n, inst, first) {
      calls.push(['drawIndexed', n, inst, first]);
    },
    end() {
      calls.push(['end']);
    },
  };
}

test('render pass wrapper drops re-issues of identical state and counts what reaches the GPU', () => {
  const gpu = fakeGpuPass();
  const counters = { drawCalls: 0, setPipelines: 0 };
  const pass = createRenderPass(gpu, counters);
  const pipeline = {},
    groupA = {},
    groupB = {},
    vb0 = {},
    vb1 = {},
    ib = {};
  for (let i = 0; i < 3; i++) {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, groupA);
    pass.setBindGroup(1, i === 2 ? groupB : groupA);
    pass.setVertexBuffer(0, vb0);
    pass.setVertexBuffer(1, i === 1 ? vb1 : vb0);
    pass.setIndexBuffer(ib, 'uint32');
    pass.setStencilReference(0);
    pass.drawIndexed(3, 1, 0);
  }
  pass.end();
  const names = gpu.calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === 'setPipeline').length, 1, 'same pipeline set once');
  assert.equal(
    names.filter((n) => n === 'setBindGroup').length,
    3,
    'group0 once, group1 twice (A then B)',
  );
  assert.equal(
    names.filter((n) => n === 'setVertexBuffer').length,
    4,
    'slot0 once; slot1: vb0, vb1, vb0',
  );
  assert.equal(names.filter((n) => n === 'setIndexBuffer').length, 1);
  assert.equal(names.filter((n) => n === 'setStencilReference').length, 1);
  assert.equal(names.filter((n) => n === 'drawIndexed').length, 3);
  assert.deepEqual(counters, { drawCalls: 3, setPipelines: 1 });
  assert.deepEqual(gpu.calls.at(-1), ['end']);
});

test('render pass wrapper re-issues state after a different value and keeps index format changes', () => {
  const gpu = fakeGpuPass();
  const pass = createRenderPass(gpu, { drawCalls: 0, setPipelines: 0 });
  const ib = {};
  pass.setIndexBuffer(ib, 'uint32');
  pass.setIndexBuffer(ib, 'uint16');
  pass.setIndexBuffer(ib, 'uint16');
  const p1 = {},
    p2 = {};
  pass.setPipeline(p1);
  pass.setPipeline(p2);
  pass.setPipeline(p1);
  const names = gpu.calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === 'setIndexBuffer').length, 2);
  assert.equal(names.filter((n) => n === 'setPipeline').length, 3);
});

test('render pass wrapper treats a changed dynamic offset as new state and repeats equal offsets once', () => {
  const gpu = fakeGpuPass();
  const pass = createRenderPass(gpu, { drawCalls: 0, setPipelines: 0 });
  const group = {};
  pass.setBindGroup(0, group, [0]);
  pass.setBindGroup(0, group, [0]);
  pass.setBindGroup(0, group, [256]);
  pass.setBindGroup(0, group, [256]);
  pass.setBindGroup(0, group); // no offsets after offsets: re-issued
  const calls = gpu.calls.filter((c) => c[0] === 'setBindGroup');
  assert.equal(calls.length, 3);
  assert.deepEqual(
    gpu.calls.filter((c) => c[0] === 'setBindGroup').map((c) => c[3]),
    [[0], [256], undefined],
  );
});
