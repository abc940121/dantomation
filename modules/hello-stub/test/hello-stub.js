#!/usr/bin/env node
'use strict';
// hello-stub: every contract part loads and behaves, in-process. Runs whatever
// the active config enables (it builds its own registry).
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-stub-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

(async () => {
  try {
    const off = M.registry({ modules: { 'hello-stub': false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().length && !off.listPanels().length && !off.listJobs().length && off.settingsFor('hello-stub') === null);
    const cfg = { modules: { 'hello-stub': true }, hello_stub: { greeting: 'hi', block_word: 'zap' } };
    const reg = M.registry(cfg);
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('settings merge config over defaults', JSON.stringify(reg.settingsFor('hello-stub')) === '{"greeting":"hi","block_word":"zap","api_token":"missing"}', JSON.stringify(reg.settingsFor('hello-stub')));
    check('route listed', reg.listRoutes().map(r => `${r.method} ${r.path}`).join() === 'GET /m/hello-stub/hello');
    const r = await reg.callRoute(reg.findRoute('GET', '/m/hello-stub/hello?name=x'), { query: { name: 'x' }, actor: { kind: 'owner', id: 'test' } });
    check('route answers with the setting', r.status === 200 && r.json.greeting === 'hi, x', JSON.stringify(r));
    check('panel listed', reg.listPanels().map(p => `${p.mount}:${p.url}`).join() === 'sidebar:/m/hello-stub/ui/hello.js');
    check('job listed', JSON.stringify(reg.listJobs()) === '[{"module":"hello-stub","id":"tick","kind":"interval","every":60}]');
    check('command listed', reg.listCommands().includes('hello'));
    const out = [];
    const log = console.log; console.log = s => out.push(s);
    try { await M.commands(reg.mods).hello(['you'], {}); } finally { console.log = log; }
    check('command uses the setting', out[0] === 'hi, you', out[0]);
    check('command wrote a module-tagged record through ctx.state', J.readAll().records.some(x => x.type === 'hello_greeted' && x.module === 'hello-stub' && x.name === 'you'));
    check('hook blocks the word', ((await M.beforeTool(reg.mods, { tool: 'Bash', ti: { command: 'echo zap' } })) || [])[0] === 'hello_stub');
    check('hook allows other commands', (await M.beforeTool(reg.mods, { tool: 'Bash', ti: { command: 'echo ok' } })) === null);
    await M.emit(reg.mods, 'task.start', { task_id: 't1' });
    check('on task.start ran', reg.api('hello-stub').tasks() === 1);
    const plain = M.registry({ modules: { 'hello-stub': true } });
    check('default block_word "" blocks nothing', (await M.beforeTool(plain.mods, { tool: 'Bash', ti: { command: 'echo zap' } })) === null);
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
