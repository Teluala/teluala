/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControllerLayer, LAYER_SPEC } from '../dist/index.js';

const context = () => ({ invalidate() {} });
class TestLayer extends ControllerLayer {
  constructor(options, calls = []) {
    super('test', options, { name: 'test', sortKey: 7 });
    this.calls = calls;
  }
  onUpdate(update) {
    this.calls.push(['onUpdate', update]);
  }
  onDraw() {
    this.calls.push('onDraw');
  }
  onDestroy() {
    this.calls.push('onDestroy');
  }
}

test('ControllerLayer validates its parts and takes the defaults it was given', () => {
  const controller = { update() {}, destroy() {} };
  const backend = { init() {}, draw() {}, destroy() {} };
  const layer = new TestLayer({ controller, backend });
  assert.equal(layer.layerSpec, LAYER_SPEC);
  assert.deepEqual([layer.name, layer.sortKey], ['test', 7]);
  assert.deepEqual([new TestLayer({ controller, backend, name: 'n', sortKey: 3 }).name], ['n']);
  assert.throws(
    () => new TestLayer({ controller, backend, name: '' }),
    /test layer name is required/,
  );
  assert.throws(
    () => new TestLayer({ controller, backend, sortKey: NaN }),
    /sortKey must be finite/,
  );
  assert.throws(
    () => new TestLayer({ controller: { update() {} }, backend }),
    /controller\.destroy is required/,
  );
  assert.throws(
    () => new TestLayer({ controller, backend: { init() {}, draw() {} } }),
    /backend\.destroy is required/,
  );
});

test('ControllerLayer init rolls back both parts and keeps the original error', () => {
  const calls = [];
  const controller = {
    init() {
      throw new Error('controller init failed');
    },
    update() {},
    destroy: () => calls.push('controller.destroy'),
  };
  const backend = {
    init: () => calls.push('backend.init'),
    draw() {},
    destroy: () => {
      calls.push('backend.destroy');
      throw new Error('ignored');
    },
  };
  const layer = new TestLayer({ controller, backend });
  assert.throws(() => layer.draw({}, {}), /test layer is not initialized/);
  assert.throws(() => layer.init({}), /LayerContext\.invalidate is required/);
  assert.throws(() => layer.init(context()), /controller init failed/);
  assert.deepEqual(calls, ['backend.init', 'controller.destroy', 'backend.destroy']);
  assert.throws(() => layer.update({}), /not initialized/);
  assert.throws(() => layer.attribution(), /not initialized/);
});

test('ControllerLayer copies entries, hands the update to the hook, draws, and destroys backend then controller', () => {
  const calls = [];
  const entries = [{ id: 1 }];
  let result = { entries, needsRender: true, extra: 'x' };
  const controller = {
    update: () => result,
    attribution: () => ['a', 'a', 'b'],
    destroy: () => calls.push('controller.destroy'),
  };
  const backend = {
    init() {},
    draw: (pass, frame, drawn) => calls.push(['draw', drawn]),
    destroy: () => {
      calls.push('backend.destroy');
      throw new Error('backend boom');
    },
  };
  const layer = new TestLayer({ controller, backend }, calls);
  layer.init(context());
  assert.throws(() => layer.init(context()), /already initialized/);
  assert.equal(layer.update({}), true);
  assert.deepEqual(calls.at(-1), ['onUpdate', result]);
  assert.notEqual(layer.entries, entries, 'entries are copied');
  assert.deepEqual(layer.entries, entries);
  result = { needsRender: false };
  assert.equal(layer.update({}), false);
  assert.deepEqual(layer.entries, entries, 'an update without entries keeps the last ones');
  const copy = layer.entries;
  result = { entries, needsRender: false };
  layer.update({});
  assert.equal(
    layer.entries,
    copy,
    'the same controller array keeps the same copy (backends compare identity)',
  );
  result = { entries: [...entries], needsRender: false };
  layer.update({});
  assert.notEqual(layer.entries, copy, 'a different array is copied afresh');
  result = { entries: 'nope' };
  assert.throws(() => layer.update({}), /controller update entries must be an array/);
  layer.draw({}, {});
  assert.deepEqual(calls.slice(-2), [['draw', entries], 'onDraw']);
  assert.deepEqual(layer.attribution(), ['a', 'b']);
  // A throwing backend must not keep the controller (worker, fetches, timers) alive.
  assert.throws(() => layer.destroy(), /backend boom/);
  assert.deepEqual(calls.slice(-3), ['onDestroy', 'backend.destroy', 'controller.destroy']);
  assert.deepEqual(layer.entries, []);
  layer.destroy(); // idempotent
  assert.throws(() => layer.draw({}, {}), /test layer is destroyed/);
  assert.throws(() => layer.init(context()), /test layer is destroyed/);
});

test('ControllerLayer attribution rejects non-string values', () => {
  const layer = new TestLayer({
    controller: { update() {}, attribution: () => [1], destroy() {} },
    backend: { init() {}, draw() {}, destroy() {} },
  });
  layer.init(context());
  assert.throws(() => layer.attribution(), /controller attribution must return strings/);
});
