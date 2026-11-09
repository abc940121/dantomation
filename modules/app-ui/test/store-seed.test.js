#!/usr/bin/env node
'use strict';
// Regression: area slices must exist in the initial store state (cards components read slices.cards before any dispatch).
// Bundles the web store with the esbuild that ships with vite; skipped when web/node_modules is absent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB = path.resolve(__dirname, '..', 'web');
const check = (label, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); if (!ok) process.exitCode = 1; };

(async () => {
  let esbuild;
  try { esbuild = require(require.resolve('esbuild', { paths: [WEB, path.join(WEB, 'node_modules', 'vite')] })); }
  catch { console.log('PASS skipped: web/node_modules not installed'); return; }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appui-seed-')), 'store.mjs');
  // areas/index.ts uses vite's import.meta.glob, so import each area's register.ts directly
  const areasDir = path.join(WEB, 'src', 'areas');
  const regs = fs.readdirSync(areasDir).filter(d => fs.existsSync(path.join(areasDir, d, 'register.ts')));
  const entry = "import './src/shell/register'; " + regs.map(d => `import './src/areas/${d}/register';`).join(' ') + " export { initialState, createStore } from './src/store';";
  await esbuild.build({
    stdin: { contents: entry, resolveDir: WEB, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    alias: { '@': path.join(WEB, 'src'), '@shared': path.join(WEB, 'shared') },
    loader: { '.css': 'empty', '.json': 'json' },
    jsx: 'automatic',
  });
  const M = await import(pathToFileURL(out).href);
  for (const [label, s] of [['initialState', M.initialState()], ['createStore', M.createStore().getState()]]) {
    check(`${label}: slices.cards defined`, s.slices.cards !== undefined);
    check(`${label}: slices.rooms defined`, s.slices.rooms !== undefined);
  }
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
