/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const entryTypes = resolve(dist, 'index.d.ts');
const reference = '/// <reference types="@webgpu/types" />\n';
const licenseHeader =
  '/*!\n * Copyright (c) 2026 The Teluala Authors\n * SPDX-License-Identifier: MIT\n */\n';

for (const filename of readdirSync(dist)) {
  if (filename.endsWith('.map')) rmSync(resolve(dist, filename));
}

// Type-only modules may lose their comments during emission. Keep the notice
// on every distributed module, including otherwise empty JavaScript files.
for (const filename of readdirSync(dist)) {
  if (!filename.endsWith('.js') && !filename.endsWith('.d.ts')) continue;
  const path = resolve(dist, filename);
  const source = readFileSync(path, 'utf8');
  if (!source.includes('SPDX-License-Identifier: MIT')) {
    writeFileSync(path, licenseHeader + source, 'utf8');
  }
}

const declarations = readFileSync(entryTypes, 'utf8');
if (!declarations.startsWith(reference)) {
  writeFileSync(entryTypes, reference + declarations, 'utf8');
}
