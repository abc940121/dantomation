'use strict';
// App settings routes for app-ui (written by us, MIT):
//   GET  api/config            language, appearance, onboarded, profile (any paired device)
//   POST api/config            partial merge, validated
//   GET  api/instances         engines synthesized from the roster
//   POST api/bots/:id/settings per-bot display overrides (owner only; devices are not allowed this path)
const path = require('path');
const { pathToFileURL } = require('url');
const L = require('../lib');

let validate; // the pure ESM module, loaded once on first use
async function V() { return validate || (validate = await import(pathToFileURL(path.join(__dirname, 'settings-validate.mjs')).href)); }

async function getConfig(ctx) {
  const v = await V();
  return { status: 200, json: v.normalizeConfig(L.getState(ctx, 'config', {})) };
}

async function postConfig(ctx) {
  const v = await V();
  const r = v.mergeConfig(L.getState(ctx, 'config', {}), ctx.body);
  if (!r.ok) return { status: 400, json: { error: r.error } };
  L.setState(ctx, 'config', r.config);
  return { status: 200, json: r.config };
}

async function instances(ctx) {
  const v = await V();
  return { status: 200, json: v.synthesizeInstances(L.roster(ctx)) };
}

async function botSettings(ctx) {
  const id = ctx.params.id;
  if (!L.roster(ctx).some(b => b.id === id)) return { status: 404, json: { error: 'unknown bot' } };
  const v = await V();
  const all = L.getState(ctx, 'botOverrides', {}) || {};
  const r = v.mergeBotOverride(all[id], ctx.body);
  if (!r.ok) return { status: 400, json: { error: r.error } };
  const next = { ...all };
  if (Object.keys(r.override).length) next[id] = r.override; else delete next[id];
  L.setState(ctx, 'botOverrides', next);
  return { status: 200, json: { bot: L.bots(ctx).find(b => b.id === id) } };
}

module.exports = [
  { method: 'GET', path: 'api/config', access: 'owner', handler: getConfig },
  { method: 'POST', path: 'api/config', access: 'owner', handler: postConfig },
  { method: 'GET', path: 'api/instances', access: 'owner', handler: instances },
  { method: 'POST', path: 'api/bots/:id/settings', access: 'owner', handler: botSettings },
];
