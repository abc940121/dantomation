#!/usr/bin/env node
'use strict';
// app-ui foundation: manifest, routes, snapshot, send, frames, device allowlist, provenance,
// licensing files, the built ui/ and repo hygiene. Made-up text only; scratch state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'modules', 'app-ui');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'appui-'));
process.env.HARNESS_STATE_DIR = path.join(base, 'state');
fs.mkdirSync(process.env.HARNESS_STATE_DIR, { recursive: true });

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };

const J = require(path.join(ROOT, 'lib', 'journal'));
const mod = require(APP);
const routes = require(path.join(APP, 'adapter', 'routes'));
const L = require(path.join(APP, 'adapter', 'lib'));
const pairing = require(path.join(ROOT, 'modules', 'device-pairing', 'store'));

const cfg = { bots: [{ id: 'alpha', name: 'Alpha', engine: 'claude' }, { id: 'beta', name: 'Beta', engine: 'codex', runsOn: 'worker' }] };
const stateDir = path.join(base, 'mod');
fs.mkdirSync(stateDir, { recursive: true });
const ctx = (over = {}) => ({ config: cfg, query: {}, params: {}, body: {}, state: { dir: stateDir }, tasks: { enqueue: async (bot, prompt) => ({ id: 'task-' + bot + '-1' }) }, ...over });
const route = (method, p) => mod.routes.find(r => r.method === method && r.path === p);

(async () => {
  // ---- manifest
  check('manifest: contract, name, runsOn, panel', mod.contract === 2 && mod.name === 'app-ui' && mod.runsOn === 'main' && mod.panels.length === 1 && mod.panels[0].entry === 'ui/panel.js');
  const defaults = require(path.join(ROOT, 'lib', 'config')).DEFAULTS;
  check('default off', !(defaults.modules && defaults.modules['app-ui']));
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'harness.config.json'), 'utf8'));
  check('shipped config has app-ui false', shipped.modules['app-ui'] === false);

  // ---- routes loader
  check('routes: three foundation routes, paths valid', mod.routes.length >= 3 && mod.routes.every(r => /^\/[A-Za-z0-9_\-.:/]*$/.test(r.path)));
  const dir = fs.mkdtempSync(path.join(base, 'areas-'));
  fs.writeFileSync(path.join(dir, 'a.js'), "module.exports=[{method:'GET',path:'api/extra',handler(){return {status:200,json:{}}}}];");
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'export default 1');
  const merged = routes.load(dir);
  check('routes: area file merged, .mjs ignored', merged.some(r => r.path === '/api/extra' && r.access === 'owner') && merged.length === routes.load(fs.mkdtempSync(path.join(base, 'empty-'))).length + 1);
  fs.writeFileSync(path.join(dir, 'c.js'), "module.exports=[{method:'GET',path:'api/snapshot',handler(){}}];");
  let dup = ''; try { routes.load(dir); } catch (e) { dup = e.message; }
  check('routes: duplicate refused', /duplicate route GET \/api\/snapshot/.test(dup), dup);
  fs.writeFileSync(path.join(dir, 'c.js'), "module.exports=[{method:'GET',path:'api/bots/:name/messages',handler(){}}];");
  let dup2 = ''; try { routes.load(dir); } catch (e) { dup2 = e.message; }
  check('routes: duplicate with another param name refused', /duplicate route/.test(dup2), dup2);

  // ---- snapshot
  for (let i = 1; i <= 7; i++) {
    J.append({ type: 'queue_add', task_id: 't' + i, bot: 'alpha', prompt: 'question ' + i });
    J.append({ type: 'reply', task_id: 't' + i, bot: 'alpha', text: 'answer ' + i });
  }
  J.append({ type: 'queue_add', task_id: 'tb', bot: 'beta', prompt: 'beta question' });
  const snap = route('GET', '/api/snapshot').handler(ctx({ query: { messages: '4' } })).json;
  check('snapshot: shape', snap.bots.length === 2 && Array.isArray(snap.groups) && Array.isArray(snap.sections) && snap.threads.alpha === 'main:alpha' && snap.botQueuedMessages && 'computerControl' in snap);
  check('snapshot: bot fields', snap.bots[0].id === 'alpha' && snap.bots[0].threadId === 'main:alpha' && snap.bots[1].runsOn === 'worker' && snap.bots[1].engine === 'codex');
  check('snapshot: status from the journal', snap.bots[1].status === 'busy' && typeof snap.bots[0].status === 'string');
  check('snapshot: limit gives the newest rows, oldest first', snap.messages.alpha.length === 4 && snap.messages.alpha[3].text === 'answer 7' && snap.messages.alpha[0].text === 'question 6');
  const big = route('GET', '/api/snapshot').handler(ctx({ query: { messages: '9999' } })).json;
  check('snapshot: cap at 200 rows', big.messages.alpha.length === 14);
  const none = route('GET', '/api/snapshot').handler(ctx({ query: { messages: '0' } })).json;
  check('snapshot: messages=0 gives empty lists', none.messages.alpha.length === 0);

  // ---- pagination
  const hist = route('GET', '/api/bots/:id/messages');
  const page1 = hist.handler(ctx({ params: { id: 'alpha' }, query: { limit: '5' } })).json;
  const page2 = hist.handler(ctx({ params: { id: 'alpha' }, query: { limit: '5', before: page1.messages[0].id } })).json;
  check('history: page 1 is the newest 5', page1.messages.length === 5 && page1.messages[4].text === 'answer 7' && page1.threadId === 'main:alpha');
  check('history: before gives older rows without overlap', page2.messages.length === 5 && page2.messages[4].id !== page1.messages[0].id && page2.messages[4].text === 'question 5');
  check('history: unknown bot 404', hist.handler(ctx({ params: { id: 'nope' } })).status === 404);

  // ---- botOverrides
  L.setState(ctx(), 'botOverrides', { alpha: { name: 'Renamed', description: 'made up', color: 'teal', hidden: true } });
  const over = route('GET', '/api/snapshot').handler(ctx()).json.bots[0];
  check('snapshot: botOverrides applied', over.name === 'Renamed' && over.description === 'made up' && over.color === 'teal' && over.hidden === true);
  L.setState(ctx(), 'botOverrides', {});

  // ---- send
  const send = route('POST', '/api/bots/:id/messages');
  const ok = await send.handler(ctx({ params: { id: 'alpha' }, body: { text: 'hello there' } }));
  check('send: 201 with a stable user message id', ok.status === 201 && ok.json.message.id === 'task-alpha-1:u' && ok.json.taskId === 'task-alpha-1' && ok.json.threadId === 'main:alpha' && ok.json.message.role === 'user');
  const calls = [];
  const spy = ctx({ params: { id: 'beta' }, body: { text: 'ping' }, tasks: { enqueue: async (b, p) => { calls.push([b, p]); return { id: 'x9' }; } } });
  await send.handler(spy);
  check('send: ctx.tasks.enqueue(bot, text)', calls.length === 1 && calls[0][0] === 'beta' && calls[0][1] === 'ping');
  check('send: empty text 400', (await send.handler(ctx({ params: { id: 'alpha' }, body: { text: '   ' } }))).status === 400);
  check('send: non-string 400', (await send.handler(ctx({ params: { id: 'alpha' }, body: { text: 5 } }))).status === 400);
  check('send: too long 400', (await send.handler(ctx({ params: { id: 'alpha' }, body: { text: 'x'.repeat(8001) } }))).status === 400);
  check('send: unknown bot 404', (await send.handler(ctx({ params: { id: 'nope' }, body: { text: 'hi' } }))).status === 404);
  const failing = await send.handler(ctx({ params: { id: 'alpha' }, body: { text: 'hi' }, tasks: { enqueue: async () => { throw new Error('boom'); } } }));
  check('send: enqueue failure 502 without the cause', failing.status === 502 && !/boom/.test(JSON.stringify(failing.json)));

  // ---- frames
  const F = await import(require('url').pathToFileURL(path.join(APP, 'adapter', 'frames.mjs')).href);
  const st = F.newState();
  const f1 = F.translate({ type: 'task_start', seq: 1, task: 'k1', bot: 'alpha', prompt: 'do it' }, st);
  check('frames: task_start gives the user row and turn.started', f1.length === 2 && f1[0].kind === 'message' && f1[0].message.id === 'k1:u' && f1[0].message.role === 'user' && f1[1].event.type === 'turn.started' && f1[0].threadId === 'main:alpha');
  const again = F.translate({ type: 'task_start', seq: 1, task: 'k1', bot: 'alpha', prompt: 'do it' }, F.newState());
  check('frames: a replayed event gives the same ids', JSON.stringify(again) === JSON.stringify(f1));
  const m1 = F.translate({ type: 'message', task: 'k1', bot: 'alpha', text: 'par', final: false }, st);
  const m2 = F.translate({ type: 'message', task: 'k1', bot: 'alpha', text: 'partial', final: false }, st);
  const m3 = F.translate({ type: 'message', task: 'k1', bot: 'alpha', text: 'partial done', final: true }, st);
  check('frames: streaming reply is a message, then patches, then a final with the same id', m1[0].kind === 'message' && m2[0].kind === 'message.patch' && m3[0].message.id === m1[0].message.id && m3[0].message.id === 'k1:alpha:a' && m3[0].message.streaming === false && m3[1].event.type === 'turn.completed');
  const tc = F.translate({ type: 'tool_call', task: 'k1', bot: 'alpha', callId: 'c1', tool: 'Read', summary: 'a file' }, st);
  const tr = F.translate({ type: 'tool_result', task: 'k1', callId: 'c1', ok: true, summary: 'done' }, st);
  check('frames: tool call and result share one activity id (bot found from the task)', tc[0].kind === 'activity' && tr[0].kind === 'activity' && tc[0].message.id === tr[0].message.id && tr[0].botId === 'alpha' && tr[0].message.tool.running === false && tc[0].message.tool.running === true);
  const bs = F.translate({ type: 'bot_status', bot: 'alpha', status: 'busy' }, st);
  check('frames: bot_status is a partial bot', bs[0].kind === 'bot' && bs[0].bot.partial === true && bs[0].bot.status === 'busy');
  const end = F.translate({ type: 'task_end', task: 'k1', state: 'failed' }, st);
  check('frames: task_end completes the turn', end[0].event.type === 'turn.completed' && end[0].event.state === 'failed');
  check('frames: unknown and malformed events give []', F.translate({ type: 'card_pending', task: 'k1' }, st).length === 0 && F.translate(null, st).length === 0 && F.translate({ type: 5 }, st).length === 0 && F.translate({ type: 'mystery', task: 't' }, st).length === 0);

  // ---- device allowlist
  const A = (m, p) => pairing.allows(m, p);
  check('device: new foundation paths allowed', A('GET', '/m/app-ui/api/snapshot') && A('GET', '/m/app-ui/api/bots/alpha/messages') && A('POST', '/m/app-ui/api/bots/alpha/messages'));
  check('device: bot settings denied', !A('POST', '/m/app-ui/api/bots/x/settings'));
  check('device: creating a question denied', !A('POST', '/m/app-ui/api/questions'));
  check('device: room summary denied', !A('GET', '/m/rooms/rooms/x/summary'));
  check('device: other app-ui paths denied', !A('GET', '/m/app-ui/api/secrets') && !A('DELETE', '/m/app-ui/api/bots/alpha/messages'));

  // ---- provenance and licenses
  const pv = spawnSync(process.execPath, [path.join(APP, 'tools', 'provenance.js'), '--check'], { encoding: 'utf8' });
  check('provenance --check passes', pv.status === 0, pv.stderr);
  const P = require(path.join(APP, 'tools', 'provenance.js'));
  const rows = P.rows();
  const HEADER = ['Copyright 2026 Milind Soni and OpenMausBot contributors', 'Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)', 'Modified by dantomation contributors'];
  const commentable = /\.(ts|tsx|js|mjs|css)$/;
  const missing = [], extra = [];
  for (const [file] of rows) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) { missing.push(file + ' (listed, not on disk)'); continue; }
    if (!commentable.test(file)) continue;
    const head = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 3).join('\n');
    if (!HEADER.every(h => head.includes(h))) missing.push(file + ' (no header)');
  }
  const listed = new Set(rows.map(r => r[0]));
  const walkSrc = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walkSrc(path.join(d, e.name))) : [path.join(d, e.name)]);
  for (const f of walkSrc(path.join(APP, 'web')).concat(walkSrc(path.join(APP, 'adapter')))) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (!commentable.test(rel) || listed.has(rel)) continue;
    if (fs.readFileSync(f, 'utf8').slice(0, 400).includes('OpenMausBot contributors')) extra.push(rel);
  }
  check('provenance: every row has its file and header, every headed file has a row', rows.length >= 9 && !missing.length && !extra.length, missing.concat(extra).join('; '));
  check('LICENSE-APACHE exists', /Apache License/.test(fs.readFileSync(path.join(ROOT, 'LICENSE-APACHE'), 'utf8')));
  check('NOTICE exists and names OpenMausBot', /OpenMausBot/.test(fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8')));

  // ---- dist
  const uiDir = path.join(APP, 'ui');
  check('dist: ui/index.html exists', fs.existsSync(path.join(uiDir, 'index.html')));
  const B = require(path.join(APP, 'tools', 'build.js'));
  let verdict = '';
  try { const v = B.verify(); verdict = v.count > 0 ? '' : 'no files'; } catch (e) { verdict = e.message; }
  check('dist: every extension is served by core, asset paths are relative', !verdict, verdict);

  // ---- hygiene
  const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'modules/app-ui'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(f => f && !f.includes('node_modules/') && fs.existsSync(path.join(ROOT, f)));
  const textExt = /\.(js|mjs|ts|tsx|json|css|html|md|webmanifest|txt)$/;
  const bannedPath = new RegExp('C:' + String.fromCharCode(92) + String.fromCharCode(92) + '?Users', 'i');
  const banned = [['a Windows user path', bannedPath], ['a reference clone name', /omb-ref/i], ['a non-loopback IPv4 address', /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/]];
  const hits = [];
  for (const f of tracked) {
    if (!textExt.test(f) || f.endsWith('package-lock.json') || f.endsWith('foundation.test.js')) continue;
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [label, re] of banned) {
      if (label === 'a non-loopback IPv4 address') {
        // version-like strings (1.2.3.4 in a semver range) are not addresses: only flag when no letter or dash touches it
        const m = text.match(/(?<![\w.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.-])/g) || [];
        if (m.some(a => a !== '127.0.0.1' && a !== '0.0.0.0')) hits.push(`${f}: ${label}`);
      } else if (re.test(text)) hits.push(`${f}: ${label}`);
    }
  }
  check('hygiene: no user paths, reference clone names or non-loopback IPs in tracked files', !hits.length, hits.slice(0, 5).join('; '));

  fs.rmSync(base, { recursive: true, force: true });
  const failed = results.filter(r => !r).length;
  console.log(`result: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL test crashed: ' + (e && e.stack || e)); process.exit(1); });
