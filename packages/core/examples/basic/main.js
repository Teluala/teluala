/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { GlobeEngine } from '../../dist/index.js';

const canvas = document.querySelector('#globe');
const status = document.querySelector('#status');

if (!GlobeEngine.supported()) {
  status.textContent = 'WebGPU is not available in this browser.';
  status.dataset.state = 'unsupported';
} else {
  try {
    const globe = await GlobeEngine.create(canvas);
    globe.onPick = ({ lon, lat }) => {
      status.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    };
    window.telualaExample = globe;
    status.textContent = 'Ready — drag, scroll, or click the globe.';
    status.dataset.state = 'ready';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.state = 'error';
  }
}
