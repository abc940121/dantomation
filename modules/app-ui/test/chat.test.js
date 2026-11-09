#!/usr/bin/env node
'use strict';
// app-ui chat package: the history route, its helper, string parity, headers and provenance rows.
// Made-up text only; scratch state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'modules', 'app-ui');
const CHAT = path.join(APP, 'web', 'src', 'areas', 'chat');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'appui-chat-'));
process.env.HARNESS_STATE_DIR = path.join(base, 'state');
fs.mkdirSync(process.env.HARNESS_STATE_DIR, { recursive: true });

const check = (label, ok, info) => console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`);

const J = require(path.join(ROOT, 'lib', 'journal'));
const mod = require(APP);
const stateDir = path.join(base, 'mod');
fs.mkdirSync(stateDir, { recursive: true });
const cfg = { bots: [{ id: 'alpha', name: 'Alpha', engine: 'claude' }] };
const ctx = (over = {}) => ({ config: cfg, query: {}, params: {}, body: {}, state: { dir: stateDir }, ...over });
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

(async () => {
  // ---- route
  const route = mod.routes.find(r => r.method === 'GET' && r.path === '/api/bots/:id/history');
  check('history route registered, owner only', !!route && route.access === 'owner');
  check('foundation messages route kept', mod.routes.some(r => r.method === 'GET' && r.path === '/api/bots/:id/messages'));

  for (let i = 0; i < 7; i++) {
    J.append({ type: 'queue_add', task_id: 'c' + i, bot: 'alpha', prompt: 'question ' + i });
    J.append({ type: 'reply', task_id: 'c' + i, bot: 'alpha', text: 'answer ' + i });
  }
  const miss = await route.handler(ctx({ params: { id: 'nobody' } }));
  check('unknown bot is a 404', miss.status === 404);

  const first = await route.handler(ctx({ params: { id: 'alpha' }, query: { limit: '5' } }));
  check('first page: 5 newest, hasMore', first.status === 200 && first.json.messages.length === 5 && first.json.hasMore === true && first.json.threadId === 'main:alpha', JSON.stringify(first.json).slice(0, 200));
  check('first page ends with the newest reply', first.json.messages[4].id === 'c6:alpha:a' && first.json.messages[4].text === 'answer 6');
  const second = await route.handler(ctx({ params: { id: 'alpha' }, query: { limit: '5', before: first.json.messages[0].id } }));
  check('second page continues before the first', second.json.messages.length === 5 && second.json.messages[4].id !== first.json.messages[0].id && second.json.hasMore === true);
  const third = await route.handler(ctx({ params: { id: 'alpha' }, query: { limit: '5', before: second.json.messages[0].id } }));
  check('last page: 4 left, hasMore false', third.json.messages.length === 4 && third.json.hasMore === false, JSON.stringify(third.json.messages.map(m => m.id)));
  const bad = await route.handler(ctx({ params: { id: 'alpha' }, query: { limit: 'zzz' } }));
  check('bad limit falls back to the default', bad.status === 200 && bad.json.messages.length === 14 && bad.json.hasMore === false);

  // ---- helper
  const h = await import(require('url').pathToFileURL(path.join(APP, 'adapter', 'areas', 'chat-history.mjs')).href);
  check('pageOf trims the extra row from the front', JSON.stringify(h.pageOf([1, 2, 3], 2)) === JSON.stringify({ messages: [2, 3], hasMore: true }));
  check('pageOf with room to spare', JSON.stringify(h.pageOf([1], 2)) === JSON.stringify({ messages: [1], hasMore: false }) && h.pageOf(null, 2).messages.length === 0);
  check('taskOfMessageId', h.taskOfMessageId('t1:u') === 't1' && h.taskOfMessageId('t2:alpha:a') === 't2' && h.taskOfMessageId('') === null && h.taskOfMessageId(5) === null);

  // ---- strings
  const strings = fs.readFileSync(path.join(CHAT, 'strings.ts'), 'utf8');
  const [enBlock, zhBlock] = strings.split('export const zhTw');
  const keys = b => (b.match(/"dchat\.[A-Za-z]+"/g) || []).sort().join(',');
  check('strings: en and zh-tw have the same keys', keys(enBlock).length > 0 && keys(enBlock) === keys(zhBlock));
  const used = new Set();
  for (const f of walk(CHAT).filter(f => /\.tsx?$/.test(f))) for (const m of fs.readFileSync(f, 'utf8').matchAll(/"(dchat\.[A-Za-z]+)"/g)) used.add(m[1]);
  const defined = new Set(enBlock.match(/"dchat\.[A-Za-z]+"/g).map(s => s.slice(1, -1)));
  const missing = [...used].filter(k => !defined.has(k) && k !== undefined);
  check('strings: every dchat key used is defined', missing.length === 0, missing.join(','));

  // ---- views and cuts
  const reg = fs.readFileSync(path.join(CHAT, 'register.ts'), 'utf8');
  check('register: thread and composer views above the foundation default', /slot: "thread"[^}]*priority: 10/.test(reg) && /slot: "composer"[^}]*priority: 10/.test(reg));
  const all = walk(CHAT).filter(f => /\.tsx?$/.test(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  check('no wasm grammar, no mermaid, no desktop bridge', !/shiki\/langs\/wasm|from \"mermaid|import\(\"mermaid|window\.ogb\?/.test(all));
  check('shiki uses the JS regex engine', /shiki\/engine\/javascript/.test(all) && !/oniguruma/.test(all));
  check('drafts and stop are wired', /readDraft/.test(all) && /\/api\/tasks\/\$\{encodeURIComponent\(task\)\}\/stop/.test(all));

  // ---- headers and provenance
  const prov = fs.readFileSync(path.join(APP, 'provenance', 'chat.md'), 'utf8');
  const rows = [...prov.matchAll(/^\| (modules\/app-ui\/[^ ]+) \| OpenMausBot \| ([^ ]+) \| b63bceb \| (copied|derived) \|$/gm)];
  const listed = new Set(rows.map(r => r[1]));
  const apache = f => /Licensed under the Apache License, Version 2\.0/.test(fs.readFileSync(f, 'utf8'));
  const ported = walk(CHAT).filter(f => /\.tsx?$/.test(f)).filter(f => apache(f));
  const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
  check('provenance: every Apache-headed file has a row', ported.every(f => listed.has(rel(f))), ported.filter(f => !listed.has(rel(f))).map(rel).join(','));
  check('provenance: every row names a file with the header', rows.every(r => fs.existsSync(path.join(ROOT, r[1])) && apache(path.join(ROOT, r[1]))));
  const ours = walk(CHAT).filter(f => /\.tsx?$/.test(f)).filter(f => !apache(f));
  check('own files say so', ours.length > 0 && ours.every(f => /Our own file \(MIT\)|Our own/.test(fs.readFileSync(f, 'utf8').slice(0, 600))), ours.filter(f => !/Our own/.test(fs.readFileSync(f, 'utf8').slice(0, 600))).map(rel).join(','));
})().catch(e => { console.log('FAIL chat test crashed: ' + (e && e.stack || e)); });
