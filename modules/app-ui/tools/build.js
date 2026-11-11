#!/usr/bin/env node
'use strict';
// Builds the web app into modules/app-ui/ui/ and checks the result can be served by core.
//   npm ci (only when node_modules is missing), typecheck, build,
//   every file extension in ui/ must be in UI_TYPES (parsed from lib/server.js),
//   ui/index.html must use relative asset paths. Prints the file count and size.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const WEB = path.join(APP, 'web');
const UI = path.join(APP, 'ui');
const SERVER = path.join(APP, '..', '..', 'lib', 'server.js');

function run(args) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: WEB, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  if (r.status !== 0) { console.error('app-ui build: npm ' + args.join(' ') + ' failed'); process.exit(1); }
}

function uiTypes() {
  const m = /const UI_TYPES = \{([^}]*)\}/.exec(fs.readFileSync(SERVER, 'utf8'));
  if (!m) throw new Error('UI_TYPES not found in lib/server.js');
  return new Set([...m[1].matchAll(/'(\.[a-z0-9]+)'\s*:/gi)].map(x => x[1]));
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function verify() {
  const types = uiTypes();
  const files = walk(UI);
  const bad = files.filter(f => !types.has(path.extname(f).toLowerCase()));
  if (bad.length) throw new Error('ui/ has files core would not serve: ' + bad.map(f => path.relative(UI, f)).join(', '));
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(r => !/^(https?:|data:|#)/.test(r));
  const absolute = refs.filter(r => r.startsWith('/'));
  if (absolute.length) throw new Error('ui/index.html uses absolute asset paths: ' + absolute.join(', '));
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  return { count: files.length, bytes };
}

if (require.main === module) {
  if (!fs.existsSync(path.join(WEB, 'node_modules'))) run(['ci']);
  run(['run', 'typecheck']);
  run(['run', 'build']);
  const r = verify();
  console.log(`app-ui build ok: ${r.count} files, ${(r.bytes / 1024).toFixed(0)} KiB in modules/app-ui/ui/`);
}

module.exports = { uiTypes, verify, walk };
