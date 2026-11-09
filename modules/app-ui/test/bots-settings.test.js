#!/usr/bin/env node
'use strict';
// app-ui bots area: config, instances, per-bot settings, the snapshot override, the import boundary
// and the area files' wiring. Made-up text only; scratch state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'modules', 'app-ui');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'appui-bots-'));
process.env.HARNESS_STATE_DIR = path.join(base, 'state');
fs.mkdirSync(process.env.HARNESS_STATE_DIR, { recursive: true });

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };

const mod = require(APP);
const stateDir = path.join(base, 'mod');
fs.mkdirSync(stateDir, { recursive: true });
const cfg = { bots: [{ id: 'alpha', name: 'Alpha', engine: 'claude' }, { id: 'beta', name: 'Beta', engine: 'codex' }, { id: 'gamma', name: 'Gamma', engine: 'claude' }] };
const ctx = (over = {}) => ({ config: cfg, query: {}, params: {}, body: {}, state: { dir: stateDir }, tasks: {}, ...over });
const route = (method, p) => mod.routes.find(r => r.method === method && r.path === p);

(async () => {
  const getCfg = route('GET', '/api/config');
  const postCfg = route('POST', '/api/config');
  const inst = route('GET', '/api/instances');
  const botSet = route('POST', '/api/bots/:id/settings');
  check('routes: config, instances and bot settings are registered, owner only', [getCfg, postCfg, inst, botSet].every(r => r && r.access === 'owner'));

  // ---- config
  const d = (await getCfg.handler(ctx())).json;
  check('config: defaults', d.language === 'auto' && d.appearance === 'system' && d.onboarded === false && JSON.stringify(d.profile) === '{}');
  const m1 = await postCfg.handler(ctx({ body: { language: 'zh-tw' } }));
  check('config: partial merge keeps the rest and returns the full config', m1.status === 200 && m1.json.language === 'zh-tw' && m1.json.appearance === 'system' && m1.json.onboarded === false);
  check('config: merge persisted', (await getCfg.handler(ctx())).json.language === 'zh-tw');
  const m2 = await postCfg.handler(ctx({ body: { appearance: 'dark', onboarded: true, profile: { displayName: 'Test Person' } } }));
  check('config: several keys and a display name', m2.json.appearance === 'dark' && m2.json.onboarded === true && m2.json.profile.displayName === 'Test Person' && m2.json.language === 'zh-tw');
  const m3 = await postCfg.handler(ctx({ body: { profile: { displayName: null } } }));
  check('config: null clears the display name', m3.status === 200 && m3.json.profile.displayName === undefined);
  const bad = async (body) => (await postCfg.handler(ctx({ body }))).status;
  check('config: bad language 400', await bad({ language: 'fr' }) === 400);
  check('config: bad appearance 400', await bad({ appearance: 'blue' }) === 400);
  check('config: non-boolean onboarded 400', await bad({ onboarded: 'yes' }) === 400);
  check('config: display name over 60 characters 400', await bad({ profile: { displayName: 'x'.repeat(61) } }) === 400);
  check('config: 60 characters pass', await bad({ profile: { displayName: 'x'.repeat(60) } }) === 200);
  check('config: control characters in the display name 400', await bad({ profile: { displayName: 'a\nb' } }) === 400 && await bad({ profile: { displayName: 'a\u0007b' } }) === 400);
  check('config: unknown key 400', await bad({ theme: 'x' }) === 400);
  check('config: unknown profile key 400', await bad({ profile: { avatar: 'x' } }) === 400);
  check('config: non-object body 400', await bad([1]) === 400 && await bad('x') === 400);
  const after = (await getCfg.handler(ctx())).json;
  check('config: a refused write changes nothing', after.language === 'zh-tw' && after.appearance === 'dark' && after.profile.displayName === 'x'.repeat(60));

  // ---- instances
  const list = (await inst.handler(ctx())).json;
  check('instances: one row per engine with a bot count', list.length === 2 && list[0].id === 'claude' && list[0].botCount === 2 && list[1].id === 'codex' && list[1].botCount === 1 && list.every(r => r.available === true && r.name === r.id));
  check('instances: no extra fields leak', list.every(r => Object.keys(r).sort().join() === 'available,botCount,id,name'));

  // ---- bot settings
  const set = (id, body) => botSet.handler(ctx({ params: { id }, body }));
  const s1 = await set('alpha', { name: '  Renamed  ', color: '#AABBCC', description: 'made up words', hidden: false });
  check('bot: valid write returns the bot', s1.status === 200 && s1.json.bot.id === 'alpha' && s1.json.bot.name === 'Renamed' && s1.json.bot.color === '#aabbcc' && s1.json.bot.description === 'made up words');
  const snapRoute = route('GET', '/api/snapshot');
  const snap = snapRoute.handler(ctx()).json;
  const sa = snap.bots.find(b => b.id === 'alpha');
  check('bot: the override shows in the snapshot', sa && sa.name === 'Renamed' && sa.color === '#aabbcc' && sa.description === 'made up words');
  const s2 = await set('alpha', { hidden: true });
  check('bot: hidden is stored and the bot name survives', s2.status === 200 && s2.json.bot.hidden === true && s2.json.bot.name === 'Renamed');
  check('bot: hidden shows in the snapshot', snapRoute.handler(ctx()).json.bots.find(b => b.id === 'alpha').hidden === true);
  const s3 = await set('alpha', { name: null, color: null, description: null, hidden: null });
  const sb = s3.json.bot;
  check('bot: null clears every field back to the roster value', s3.status === 200 && sb.name === 'Alpha' && !sb.hidden && sb.description !== 'made up words' && sb.color !== '#aabbcc');
  const ov = require(path.join(APP, 'adapter', 'lib')).getState(ctx(), 'botOverrides', {});
  check('bot: an emptied override is removed from the state', !('alpha' in ov));
  const badBot = async (body) => (await set('beta', body)).status;
  check('bot: empty name 400', await badBot({ name: '   ' }) === 400 && await badBot({ name: '' }) === 400);
  check('bot: name over 40 characters 400', await badBot({ name: 'n'.repeat(41) }) === 400);
  check('bot: 40 characters pass', await badBot({ name: 'n'.repeat(40) }) === 200);
  check('bot: bad colors 400', await badBot({ color: 'red' }) === 400 && await badBot({ color: '#abc' }) === 400 && await badBot({ color: '#gggggg' }) === 400 && await badBot({ color: 5 }) === 400);
  check('bot: description over 280 characters 400', await badBot({ description: 'd'.repeat(281) }) === 400);
  check('bot: 280 characters pass', await badBot({ description: 'd'.repeat(280) }) === 200);
  check('bot: non-boolean hidden 400', await badBot({ hidden: 'true' }) === 400 && await badBot({ hidden: 1 }) === 400);
  check('bot: unknown key 400', await badBot({ engine: 'codex' }) === 400);
  check('bot: a bad field refuses the whole write', (await set('gamma', { name: 'Fine', color: 'nope' })).status === 400 && snapRoute.handler(ctx()).json.bots.find(b => b.id === 'gamma').name === 'Gamma');
  const unknown = await set('nobody', { name: 'x' });
  check('bot: unknown bot 404', unknown.status === 404 && !/nobody/.test(JSON.stringify(unknown.json)) || unknown.status === 404);

  // ---- import boundary: nothing in the bots area pulls in cloud, billing, telemetry or avatar generation
  const dir = path.join(APP, 'web', 'src', 'areas', 'bots');
  const files = fs.readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f));
  const banned = /(cloud|billing|telemetry|posthog|whop|usage|avatar-?generat|avatar-?edit|AvatarImageGenerator|CursorAvatar|CarvedAvatar|Blob\s?Studio|novnc|electron|window\.ogb)/i;
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) if (banned.test(m[1])) hits.push(f + ' imports ' + m[1]);
  }
  check('boundary: no bots-area file imports cloud, billing, telemetry or avatar-generation modules', files.length >= 8 && !hits.length, hits.join('; '));
  const external = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const s = m[1];
      if (s.startsWith('./') || ['react', '@/lib/i18n', '@/lib/cn', '@shared/wire'].includes(s) || s.startsWith('@/areas/') || s.startsWith('@/shell/') || s === '@/store') continue;
      if (s.endsWith('package.json')) continue;
      external.push(f + ': ' + s);
    }
  }
  check('boundary: imports stay inside the area, the foundation and react', !external.length, external.join('; '));

  // ---- licensing of the files this area copied or derived
  const HEADER = ['Copyright 2026 Milind Soni and OpenMausBot contributors', 'Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)', 'Modified by taskmote contributors'];
  const prov = fs.readFileSync(path.join(APP, 'provenance', 'bots-settings.md'), 'utf8');
  const listed = [...prov.matchAll(/^\| (modules\/app-ui\/web\/[^ |]+) \|/gm)].map(m => m[1]);
  const wrong = listed.filter(f => !HEADER.every(h => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).slice(0, 3).join('\n').includes(h)));
  check('provenance: every listed bots file exists and starts with the Apache header', listed.length >= 6 && !wrong.length, wrong.join('; '));
  const headed = files.filter(f => fs.readFileSync(path.join(dir, f), 'utf8').includes(HEADER[0]));
  check('provenance: every bots file with the header is listed', headed.every(f => listed.includes('modules/app-ui/web/src/areas/bots/' + f)), headed.filter(f => !listed.includes('modules/app-ui/web/src/areas/bots/' + f)).join('; '));

  // ---- the area registers what the brief names
  const reg = fs.readFileSync(path.join(dir, 'register.ts'), 'utf8');
  const need = ['"header-action", id: "settings"', '"header-action", id: "bot-settings"', '"overlay", id: "settings"', '"overlay", id: "bot-settings"', '"settings-page", id: "general"', '"settings-page", id: "about"', '"gate", id: "onboarding"', 'config:'];
  check('register: header actions, overlays, settings pages, the gate and the config slice', need.every(n => reg.includes(n)), need.filter(n => !reg.includes(n)).join('; '));

  fs.rmSync(base, { recursive: true, force: true });
  const failed = results.filter(r => !r).length;
  console.log(`result: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL test crashed: ' + (e && e.stack || e)); process.exit(1); });
