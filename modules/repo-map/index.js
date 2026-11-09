'use strict';
// repo-map: a compact, budgeted map of a code repository (ranked files and top-level symbols),
// built with lightweight regex extraction. Off by default; prepareTurn injects the map only
// when the `inject` setting is true. See README.md and DECISIONS.md.
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const CACHE_FILE = 'cache.json';

function loadCache(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
    if (c && c.version === E.CACHE_VERSION && c.files && typeof c.files === 'object') return c;
  } catch { /* none or corrupt: start empty */ }
  return { version: E.CACHE_VERSION, files: {} };
}
function saveCache(dir, cache) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, CACHE_FILE + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, path.join(dir, CACHE_FILE));
  } catch { /* the cache is only an optimisation */ }
}

function make(ctx, root, sub) {
  const cache = loadCache(ctx.state.dir);
  const res = E.build(root, { ...ctx.settings, sub, cache });
  saveCache(ctx.state.dir, res.cache);
  return { ...E.render(res, ctx.settings), stats: res.stats };
}

const baseRoot = (ctx, fallback) => ctx.settings.root || fallback || process.cwd();

function prepareTurn(ctx) {
  try {
    if (!ctx.settings.inject) return null;
    const r = make(ctx, baseRoot(ctx, ctx.workdir));
    return r.shown ? { context: [r.text] } : null;
  } catch { return null; }
}

function mapRoute(ctx) {
  try {
    const q = ctx.query || {};
    const p = Array.isArray(q.path) ? q.path[0] : q.path;
    const root = fs.realpathSync(baseRoot(ctx));
    let sub = '';
    if (p !== undefined && p !== '') {
      if (typeof p !== 'string' || p.length > 500 || p.includes('\0')) return { status: 400, json: { error: 'bad path' } };
      let real;
      try { real = fs.realpathSync(path.resolve(root, p)); } catch { return { status: 404, json: { error: 'no such path' } }; }
      if (!E.inside(root, real)) return { status: 400, json: { error: 'path must be inside the repo root' } };
      sub = path.relative(root, real).split(path.sep).join('/');
    }
    const r = make(ctx, root, sub);
    return { status: 200, json: { map: r.text, shown: r.shown, total: r.total, stats: r.stats } };
  } catch {
    return { status: 500, json: { error: 'could not build the map' } };
  }
}

async function repoMapCmd(args, ctx) {
  const target = Array.isArray(args) && args[0] ? String(args[0]) : baseRoot(ctx);
  try {
    console.log(make(ctx, target).text);
    return { ok: true };
  } catch (e) {
    console.error(`repo-map: cannot map that folder (${e && e.code ? e.code : 'error'})`);
    process.exitCode = 3;
    return { ok: false };
  }
}

module.exports = {
  contract: 2,
  name: 'repo-map',
  description: 'Compact map of a code repository (ranked files and top-level symbols) for the engine prompt; off by default.',
  runsOn: 'main',
  priority: 60,
  prepareTurn,
  commands: { 'repo-map': repoMapCmd },
  routes: [
    { method: 'GET', path: '/map', handler: mapRoute, description: 'the repo map as text; optional ?path=<subfolder inside the root>' },
  ],
  api: { build: E.build, render: E.render, extractSymbols: E.extractSymbols },
  settings: {
    inject: { type: 'boolean', default: false, description: 'add the map to each turn prompt' },
    root: { type: 'string', default: '', description: 'folder to map; empty means the task workdir' },
    max_chars: { type: 'integer', default: 4000, min: 200, max: 7500, description: 'size budget of the map text' },
    max_files: { type: 'integer', default: 2000, min: 1, max: 20000, description: 'most files scanned' },
    max_bytes_total: { type: 'integer', default: 8388608, min: 1024, max: 268435456, description: 'most bytes read from files in one build' },
    max_file_bytes: { type: 'integer', default: 204800, min: 1024, max: 4194304, description: 'bytes read from the start of any one file' },
    max_symbols_per_file: { type: 'integer', default: 12, min: 1, max: 100, description: 'top-level symbols listed per file' },
    cache_entries: { type: 'integer', default: 5000, min: 10, max: 100000, description: 'most files kept in the mtime cache' },
    use_git: { type: 'boolean', default: true, description: 'use git ls-files (respects .gitignore) and git log recency when git is available' },
  },
};
