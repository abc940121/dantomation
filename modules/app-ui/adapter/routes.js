'use strict';
// All routes of the module: the foundation routes plus every adapter/areas/*.js file
// (sorted by name). An area file is CommonJS and exports an array of
// { method, path, access, handler }; paths are relative to /m/app-ui/ ("api/questions").
// *.mjs files in areas/ are ignored (they are for the browser). A second route with the
// same method and path is refused.
const fs = require('fs');
const path = require('path');
const foundation = require('./snapshot');

const norm = p => '/' + String(p).replace(/^\/+/, '');
const key = r => r.method + ' ' + r.path.replace(/:[^/]+/g, ':').replace(/\/$/, '');

function load(dir = path.join(__dirname, 'areas'), base = foundation) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : [];
  const out = [], seen = new Map();
  const add = (r, from) => {
    if (!r || typeof r !== 'object' || typeof r.method !== 'string' || typeof r.path !== 'string' || typeof r.handler !== 'function') throw new Error(`app-ui: bad route in ${from}`);
    const route = { method: r.method.toUpperCase(), path: norm(r.path), access: r.access || 'owner', handler: r.handler };
    if (r.description) route.description = r.description;
    const k = key(route);
    if (seen.has(k)) throw new Error(`app-ui: duplicate route ${route.method} ${route.path} (${from} and ${seen.get(k)})`);
    seen.set(k, from); out.push(route);
  };
  for (const r of base) add(r, 'snapshot.js');
  for (const f of files) {
    const mod = require(path.join(dir, f));
    if (!Array.isArray(mod)) throw new Error(`app-ui: areas/${f} must export an array of routes`);
    for (const r of mod) add(r, 'areas/' + f);
  }
  return out;
}

module.exports = { load };
