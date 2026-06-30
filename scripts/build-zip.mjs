#!/usr/bin/env node
/**
 * build-zip.mjs — compile this omadia plugin and produce an uploadable ZIP.
 *
 *     npm run build        # → out/<id>-<version>.zip
 *
 * Why esbuild and not plain `tsc`?
 *   The omadia host resolves a plugin's bare imports against ITS OWN
 *   node_modules. We esbuild-bundle `src/plugin.ts` → `dist/plugin.js` (ESM)
 *   so every local module is inlined into one entry file. Host-provided peers
 *   are kept EXTERNAL (see `external` below) — in particular `zod`: bundling a
 *   second zod copy would break the host's zod→tool-schema bridge, which
 *   relies on a single zod instance for its `instanceof` checks.
 *
 * Run `npm run typecheck` separately for the tsc gate.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

const pkgRoot = process.cwd();

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: "name" and "version" are required');
}

// --- 1) esbuild bundle -----------------------------------------------------
console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/plugin.ts')],
  outfile: join(pkgRoot, 'dist/plugin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  external: [
    // Host-provided peers — NEVER bundle these; the omadia host supplies them.
    '@omadia/plugin-api',
    '@omadia/channel-sdk',
    'zod',
    'express',
    // `pg` is a type-only import (the Pool instance comes from the graphPool
    // service); kept external so it's never pulled into the bundle.
    'pg',
  ],
});

// --- 2) verify entry -------------------------------------------------------
const entryRel = pkg.main ?? 'dist/plugin.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after bundle: ${entryRel}`);
}

// --- 3) stage runtime artefacts -------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const INCLUDE = ['manifest.yaml', 'package.json', 'dist', 'assets', 'skills', 'README.md'];
const RENAME = { LICENSE: 'LICENSE.txt', NOTICE: 'NOTICE.txt' };
for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}
for (const [src, dest] of Object.entries(RENAME)) {
  const srcAbs = join(pkgRoot, src);
  if (!existsSync(srcAbs)) continue;
  cpSync(srcAbs, join(stageDir, dest));
}

// --- 4) zip ----------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  throw new Error('zip CLI failed — on Windows use `7z a` or PowerShell `Compress-Archive`');
}

console.log(`✓ built ${zipPath}`);
