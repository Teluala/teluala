/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = new URL('../', import.meta.url);
const license = await readFile(new URL('LICENSE', packageRoot), 'utf8');
const { version } = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
const banner = `/*! Teluala ${version}
 * SPDX-License-Identifier: MIT
${license
  .split('\n')
  .map((line) => ` * ${line}`)
  .join('\n')}
 */`;

const result = await build({
  absWorkingDir: fileURLToPath(packageRoot),
  entryPoints: ['dist/index.js'],
  outfile: 'dist/teluala.min.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  keepNames: true,
  sourcemap: false,
  // All bundled inputs share the MIT license reproduced in full above.
  legalComments: 'none',
  banner: { js: banner },
  metafile: true,
});

// A CDN consumer must not need an import map or any extra runtime files.
for (const output of Object.values(result.metafile.outputs)) {
  assert.equal(output.imports.length, 0, 'The CDN build must be self-contained.');
}
for (const input of Object.keys(result.metafile.inputs)) {
  assert.ok(input.startsWith('dist/'), 'Only core modules may enter the CDN build.');
}
