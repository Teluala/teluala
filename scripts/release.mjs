/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = ['core', 'terrain', 'raster', 'vector'];
const names = ['teluala', '@teluala/terrain', '@teluala/raster', '@teluala/vector'];
const repository = 'git+https://github.com/Teluala/teluala.git';
const hash = (data, algorithm, encoding) => createHash(algorithm).update(data).digest(encoding);
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function checkFiles(files, name) {
  for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
    assert.ok(files.includes(file), `${name}: missing ${file}`);
  }
  const extra = { teluala: ['dist/teluala.min.js'], '@teluala/terrain': ['dist/demWorker.js'], '@teluala/vector': ['dist/mvtWorkerEntry.js', 'THIRD_PARTY_NOTICES.txt'] };
  for (const file of extra[name] ?? []) assert.ok(files.includes(file), `${name}: missing ${file}`);
  for (const file of files) {
    assert.ok(file === 'package.json' || file === 'README.md' || file === 'LICENSE' || file === 'THIRD_PARTY_NOTICES.txt' || /^dist\/[\w.-]+\.(?:js|ts)$/.test(file), `${name}: unexpected file`);
  }
}

export function checkExisting(metadata, entry) {
  assert.equal(metadata.name, entry.name, 'Registry name mismatch');
  assert.equal(metadata.version, entry.version, 'Registry version mismatch');
  assert.equal(metadata.dist?.integrity, entry.integrity, 'Registry artifact differs: do not skip or overwrite');
}

export async function registry(path) {
  const response = await fetch(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (response.status === 404) return null;
  assert.ok(response.ok, `Registry lookup failed (HTTP ${response.status}); stopping`);
  return response.json();
}

export async function waitForPublication(entry, {
  lookup = registry,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  attempts = 8,
  delayMs = 2000,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const metadata = await lookup(`${encodeURIComponent(entry.name)}/${entry.version}`);
    if (metadata) {
      // A different artifact is never treated as propagation delay.
      checkExisting(metadata, entry);
      const document = await lookup(encodeURIComponent(entry.name));
      if (document?.['dist-tags']?.beta === entry.version) return;
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw new Error('Publication accepted but registry visibility timed out; verify saved artifacts before resuming');
}

function validateEntry(dir, entry) {
  assert.equal(basename(entry.filename), entry.filename, 'Unsafe artifact filename');
  const file = resolve(dir, entry.filename);
  const bytes = readFileSync(file);
  assert.equal(hash(bytes, 'sha256', 'hex'), entry.sha256, 'SHA256 mismatch');
  assert.equal(`sha512-${hash(bytes, 'sha512', 'base64')}`, entry.integrity, 'Integrity mismatch');
  const files = run('tar', ['-tzf', file]).split('\n');
  assert.ok(files.every((path) => path.startsWith('package/') && !path.includes('..')), 'Unsafe archive member');
  checkFiles(files.map((path) => path.slice(8)), entry.name);
  const metadata = JSON.parse(run('tar', ['-xOf', file, 'package/package.json']));
  assert.equal(metadata.name, entry.name);
  assert.equal(metadata.version, entry.version);
  assert.equal(metadata.repository.url, repository);
  assert.equal(metadata.publishConfig.tag, 'beta');
  assert.equal(metadata.publishConfig.access, 'public');
  assert.ok(!metadata.private);
  // Inspect every archived file without unpacking or printing matching values.
  for (const path of files) {
    const content = run('tar', ['-xOf', file, path]);
    assert.ok(!/\/(?:Users|home)\/[^\s/]+|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(content), 'Artifact contains a private path or credential pattern');
  }
}

async function main() {
  const [mode, directory] = process.argv.slice(2);
  assert.ok(['pack', 'verify', 'publish'].includes(mode) && directory, 'Usage: node scripts/release.mjs pack|verify|publish ARTIFACT_DIRECTORY');
  const dir = resolve(directory);
  if (mode === 'pack') {
    mkdirSync(dir, { recursive: true });
    assert.equal(readdirSync(dir).length, 0, 'Use an empty artifact directory');
    const commit = run('git', ['rev-parse', 'HEAD']);
    const entries = [];
    let version;
    for (const [index, pkg] of packages.entries()) {
      const metadata = JSON.parse(readFileSync(resolve(root, 'packages', pkg, 'package.json'), 'utf8'));
      assert.equal(metadata.name, names[index]);
      version ??= metadata.version;
      assert.equal(metadata.version, version, 'All release versions must match');
      assert.ok(!metadata.private);
      assert.equal(metadata.publishConfig.tag, 'beta');
      assert.equal(metadata.publishConfig.access, 'public');
      assert.equal(metadata.repository.url, repository);
      // The workflow has already built and tested every package. Do not rebuild
      // during packing or change the artifact after its review.
      const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--workspace', metadata.name, '--pack-destination', dir]));
      const bytes = readFileSync(resolve(dir, packed.filename));
      const entry = { name: metadata.name, version, filename: packed.filename, integrity: packed.integrity, sha256: hash(bytes, 'sha256', 'hex') };
      validateEntry(dir, entry);
      entries.push(entry);
    }
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ commit, version, packages: entries }, null, 2) + '\n');
  }
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.commit, run('git', ['rev-parse', 'HEAD']), 'Artifacts must match checked-out source commit');
  if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'Tag/version mismatch');
  assert.deepEqual(manifest.packages.map((entry) => entry.name), names, 'Exactly four packages in release order required');
  for (const entry of manifest.packages) {
    assert.equal(entry.version, manifest.version);
    validateEntry(dir, entry);
  }
  console.log(`Verified four tarballs for ${manifest.version} at ${manifest.commit}`);
  if (mode !== 'publish') return;
  // Preflight all four lookups before publishing the first package.
  const published = [];
  for (const entry of manifest.packages) {
    const metadata = await registry(`${encodeURIComponent(entry.name)}/${entry.version}`);
    if (metadata) {
      checkExisting(metadata, entry);
      const document = await registry(encodeURIComponent(entry.name));
      assert.equal(document?.['dist-tags']?.beta, entry.version, 'Existing version lacks expected beta tag; review manually');
    }
    published.push(Boolean(metadata));
  }
  for (const [index, entry] of manifest.packages.entries()) {
    if (published[index]) {
      console.log(`Verified existing ${entry.name}@${entry.version}; skipping`);
      continue;
    }
    const result = spawnSync('npm', ['publish', resolve(dir, entry.filename), '--ignore-scripts', '--tag', 'beta', '--access', 'public', '--provenance', '--registry', 'https://registry.npmjs.org/'], { cwd: root, stdio: 'inherit' });
    assert.equal(result.status, 0, `Publish failed for ${entry.name}; original artifacts are preserved`);
    await waitForPublication(entry);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error.code === 'ERR_ASSERTION' || error.message.startsWith('Publication accepted')) {
      console.error(error.message.split('\n')[0]);
    }
    console.error('Release validation/publication stopped. Inspect the failing step; never overwrite a published version.');
    process.exitCode = 1;
  });
}
