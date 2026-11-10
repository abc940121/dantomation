#!/usr/bin/env node
'use strict';
// bin/taskmote-mcp.js, Taskmote's own MCP stdio server (ask_owner, queue_task, task_status, undo_task,
// digest, search_journal). Spawns the real server against temp dirs and the fake engine:
//   a. initialize, ping, tools/list (all six tools with no flag; --allow-write / --no-ask / env flag are accepted no-ops), unknown tool / method errors
//   b. happy paths: queue_task -> task_status -> search_journal -> digest -> undo_task;
//      ask_owner answered through `taskmote ask answer`, and ask_owner timing out as {answered:false}
//   c. undo_task undoes at once then posts an info card (en + zh-TW), cards off still undoes; executor lock held: blocked, nothing changed
//   d. modules off: each module-backed tool answers with text naming the module to enable; no crash
//   f. task family cap: from inside a task (env HARNESS_TASK_ID) queue_task refuses past depth 2 and past 5 children; undo_task only reaches itself and its descendants
//   e. tools a module provides (roles): listed next to the six only while the module is on, run, errors are tool errors
// Runs in any mode: it writes its own configs in a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tmcp-'));
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkEnv(name, modules) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules }));
  const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(d, 'state'), HARNESS_LOG_DIR: path.join(d, 'logs'), HARNESS_WORK_DIR: path.join(d, 'work'),
    HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_GUARD: '1', HARNESS_NO_SERVER: '1', HARNESS_MCP_POLL_MS: '50',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR; delete env.HARNESS_OWNER;
  return { d, env };
}

// One server process; call(method, params) -> the JSON-RPC response (rejects after 30 s).
function startServer(env, args = []) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskmote-mcp.js'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let buf = '', nextId = 1;
  child.stdout.on('data', c => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
  });
  const call = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => { waiting.delete(id); rej(new Error('timeout waiting for ' + method)); }, 30000);
    waiting.set(id, m => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    const text = r.result && r.result.content && r.result.content[0].text;
    let json = null; try { json = JSON.parse(text); } catch { /* error text */ }
    return { err: !!(r.result && r.result.isError), text, json, raw: r };
  };
  return { child, call, tool, stop: () => { child.stdin.end(); } };
}

const journal = env => { try { return fs.readFileSync(path.join(env.HARNESS_STATE_DIR, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } }

async function main() {
  const ON = { 'guard-base': true, checkpoint: true, 'question-cards': true, digest: true, search: true };
  const { env } = mkEnv('on', ON);
  const s = startServer(env, ['--allow-write']); // the flag is a no-op; the other servers below run without it

  // a. protocol
  const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  check('initialize: protocol and tools capability', init.result && init.result.protocolVersion === '2024-11-05' && init.result.capabilities.tools && init.result.serverInfo.name === 'taskmote', init);
  check('ping answers', (await s.call('ping', {})).result !== undefined);
  const list = await s.call('tools/list', {});
  const names = (list.result.tools || []).map(t => t.name).sort();
  check('tools/list: the six tools, each with an inputSchema', JSON.stringify(names) === JSON.stringify(['ask_owner', 'digest', 'queue_task', 'search_journal', 'task_status', 'undo_task']) && list.result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object' && t.description), names);
  const unk = await s.call('tools/call', { name: 'nope', arguments: {} });
  check('unknown tool: JSON-RPC error -32602', unk.error && unk.error.code === -32602, unk);
  const unm = await s.call('nope', {});
  check('unknown method: JSON-RPC error -32601', unm.error && unm.error.code === -32601, unm);

  // no flag, old flags: every tool is always listed
  const ALL = ['ask_owner', 'digest', 'queue_task', 'search_journal', 'task_status', 'undo_task'];
  const ro = startServer(env);
  const roNames = ((await ro.call('tools/list', {})).result.tools || []).map(t => t.name).sort();
  check('no flag: all six tools listed', JSON.stringify(roNames) === JSON.stringify(ALL), roNames);
  ro.stop();
  for (const [label, argv, e2] of [['--no-ask', ['--no-ask'], env], ['env TASKMOTE_MCP_WRITE=1', [], { ...env, TASKMOTE_MCP_WRITE: '1' }]]) {
    const x = startServer(e2, argv);
    const xn = ((await x.call('tools/list', {})).result.tools || []).map(t => t.name).sort();
    check(`${label} is accepted and changes nothing: all six tools`, JSON.stringify(xn) === JSON.stringify(ALL), xn);
    x.stop();
  }

  // b. queue_task -> task_status -> search -> digest -> undo
  const wd = path.join(tmp, 'on', 'wd');
  const REQ = 'write the zebra report';
  const q = await s.tool('queue_task', { request: REQ, cwd: wd });
  check('queue_task: returns a task id', !q.err && q.json && q.json.queued === true && /^t[\w-]+$/.test(q.json.task_id), q);
  const tid = q.json && q.json.task_id;
  const finished = await until(() => journal(env).some(r => r.type === 'task_done' && r.task_id === tid));
  check('queue_task: the task ran to done through the CLI path', !!finished);
  const st = await s.tool('task_status', { task_id: tid });
  check('task_status: one task, done, with its request', !st.err && st.json.state === 'done' && st.json.task_id === tid && st.json.request === REQ, st);
  const recent = await s.tool('task_status', {});
  check('task_status: recent tasks, newest first', !recent.err && Array.isArray(recent.json.tasks) && recent.json.tasks[0].task_id === tid, recent);
  const bad = await s.tool('task_status', { task_id: 'tnope' });
  check('task_status: unknown task is a clear error', bad.err && /no task/.test(bad.text), bad);
  const empty = await s.tool('queue_task', { request: '   ' });
  check('queue_task: empty request is a clear error', empty.err && /request is required/.test(empty.text), empty);

  const se = await s.tool('search_journal', { query: 'zebra', limit: 5 });
  check('search_journal: finds the task by its request', !se.err && se.json.total >= 1 && se.json.results.length >= 1, se);
  const se2 = await s.tool('search_journal', { query: '' });
  check('search_journal: empty query is a clear error', se2.err && /q required/.test(se2.text), se2);

  const dg = await s.tool('digest', { since: '1d' });
  check('digest: summary JSON', !dg.err && dg.json && typeof dg.json === 'object', dg);
  const dg2 = await s.tool('digest', { since: 'whenever' });
  check('digest: bad since is a clear error', dg2.err && /since/.test(dg2.text), dg2);

  // c. undo_task: blocked while the executor lock is held (taken from a child so the pid is alive and not the server's), then works
  const holder = spawn(process.execPath, ['-e', [
    `process.env.HARNESS_STATE_DIR=${JSON.stringify(env.HARNESS_STATE_DIR)};`,
    `const J=require(${JSON.stringify(path.join(ROOT, 'lib', 'journal'))});`,
    `const l=J.lock(require('path').join(J.STATE,'executor.lock'),{pids:[process.pid],task_id:${JSON.stringify(tid)}});`,
    `console.log(l.held?'held':'no'); setInterval(()=>{},1000);`].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => holder.stdout.once('data', r));
  const undoCount = () => journal(env).filter(r => r.type === 'undo').length;
  const cardCount = () => journal(env).filter(r => r.type === 'question').length;
  const cardText = id => { try { return JSON.parse(fs.readFileSync(path.join(env.HARNESS_STATE_DIR, 'm', 'question-cards', 'vault.json'), 'utf8'))[id].text; } catch { return ''; } };
  const u0 = undoCount();
  const c0 = cardCount();
  const blocked = await s.tool('undo_task', { task_id: tid });
  check('undo_task: a running task blocks it, no card is sent, nothing changes', !blocked.err && blocked.json.blocked === true && blocked.json.undone === false && undoCount() === u0 && cardCount() === c0, blocked);
  holder.kill();
  await sleep(300);
  const un = await s.tool('undo_task', { task_id: tid });
  check('undo_task: undoes at once with no owner answer, with removed_files and an undo_ref', !un.err && un.json.undone === true && typeof un.json.removed_files === 'number' && un.json.undo_ref && undoCount() === u0 + 1, un);
  const info = await until(() => { const c = journal(env).filter(r => r.type === 'question'); return c.length > c0 ? c[c.length - 1] : null; });
  check('undo_task: an info card is posted afterwards, naming the task', info && cardText(info.question_id).startsWith(`Task ${tid} ("write the zebra report") was undone`), info);
  const cardLoc = id => { try { return JSON.parse(fs.readFileSync(path.join(env.HARNESS_STATE_DIR, 'm', 'question-cards', 'vault.json'), 'utf8'))[id].locales['zh-TW']; } catch { return null; } };
  const zhc = info && cardLoc(info.question_id);
  check('undo_task: the info card also carries zh-TW text', zhc && zhc.text.startsWith(`任務 ${tid}（「write the zebra report」）已復原`) && zhc.options.length === 2, zhc);
  check('undo_task: the notice is journaled and no undo_card question was asked', journal(env).some(r => r.type === 'undo_notice' && r.task_id === tid) && !journal(env).some(r => r.type === 'undo_card'));
  const unx = await s.tool('undo_task', { task_id: 'tnope' });
  check('undo_task: unknown task is a clear error', unx.err && /no task/.test(unx.text), unx);

  // ask_owner
  const seenQ = cardCount();
  const askP = s.tool('ask_owner', { question: 'Ship it?', choices: ['yes', 'no'], timeout_s: 30 });
  const qrec = await until(() => journal(env).filter(r => r.type === 'question')[seenQ]);
  check('ask_owner: a question card is raised and the call waits', !!qrec);
  const ans = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'ask', 'answer', qrec.question_id, '2'], { env, encoding: 'utf8' });
  const ar = await askP;
  check('ask_owner: the owner\'s answer comes back', ans.status === 0 && !ar.err && ar.json.answered === true && ar.json.choice === 2 && ar.json.option === 'no', { ans: ans.stderr, ar });
  const to = await s.tool('ask_owner', { question: 'Anyone there?', choices: ['a', 'b'], timeout_s: 0.4 });
  check('ask_owner: no answer in time is {answered:false}, not an error', !to.err && to.json.answered === false, to);
  const badAsk = await s.tool('ask_owner', { question: 'one choice', choices: ['a'] });
  check('ask_owner: bad input is a clear error', badAsk.err && /options/.test(badAsk.text), badAsk);
  s.stop();

  // d. modules off
  const nc = mkEnv('nocards', { 'guard-base': true, checkpoint: true, 'question-cards': false });
  const ncs = startServer(nc.env, ['--allow-write']);
  const ncr = await ncs.tool('undo_task', { task_id: 't1' });
  check('undo_task: question-cards off no longer blocks it (only the owner notice needs cards); it gets as far as the task lookup', ncr.err && /no task/.test(ncr.text) && !ncr.text.includes('"question-cards"'), ncr);
  ncs.stop();
  const off = mkEnv('off', { 'guard-base': true, checkpoint: false });
  const o = startServer(off.env, ['--allow-write']);
  await o.call('initialize', {});
  const cases = [['ask_owner', { question: 'q', choices: ['a', 'b'] }, 'question-cards'], ['undo_task', { task_id: 't1' }, 'checkpoint'], ['digest', {}, 'digest'], ['search_journal', { query: 'x' }, 'search']];
  for (const [name, args, mod] of cases) {
    const r = await o.tool(name, args);
    check(`${name}: ${mod} off -> error text says to enable it`, r.err && r.text.includes(`"${mod}"`) && /Enable it/.test(r.text), r);
  }
  const ost = await o.tool('task_status', {});
  check('task_status needs no module: works with them off', !ost.err && Array.isArray(ost.json.tasks), ost);
  const oq = await o.tool('queue_task', { request: 'hello off' });
  check('queue_task needs no module: works with them off', !oq.err && oq.json.queued === true, oq);
  await until(() => journal(off.env).some(r => r.type === 'task_done'));
  o.stop();

  // e. module-provided tools: the roles module is on
  const rl = mkEnv('roles', { roles: true });
  const rs = startServer(rl.env);
  const rnames = ((await rs.call('tools/list', {})).result.tools || []).map(t => t.name).sort();
  check('module tools: the six plus the four role tools, each with a schema', JSON.stringify(rnames) === JSON.stringify([...ALL, 'role_create', 'role_list', 'role_remove', 'role_update'].sort()), rnames);
  const rcr = await rs.tool('role_create', { name: 'Captain', persona: 'You are a calm ship captain.' });
  check('role_create: returns the role', !rcr.err && rcr.json && /^r-[0-9a-f]{8}$/.test(rcr.json.id) && rcr.json.name === 'Captain', rcr);
  const rfile = path.join(rl.env.HARNESS_STATE_DIR, 'm', 'roles', 'roles.json');
  check('role_create: the role is in the roles state file at once', (() => { try { return JSON.parse(fs.readFileSync(rfile, 'utf8')).roles.some(r => r.id === rcr.json.id); } catch { return false; } })());
  const rdup = await rs.tool('role_create', { name: 'captain', persona: 'x' });
  check('role_create: a refused input is a tool error, not a crash', rdup.err && /already exists/.test(rdup.text), rdup);
  const rup = await rs.tool('role_update', { role: 'Captain', persona: 'You are a loud pirate.' });
  check('role_update: by name', !rup.err && rup.json.id === rcr.json.id && /pirate/.test(rup.json.persona), rup);
  const rls = await rs.tool('role_list', {});
  check('role_list: shows the role', !rls.err && rls.json.roles.length === 1 && rls.json.roles[0].id === rcr.json.id, rls);
  const rrm = await rs.tool('role_remove', { role: rcr.json.id });
  check('role_remove: archives it', !rrm.err && rrm.json.archived === true && (await rs.tool('role_list', {})).json.roles.length === 0, rrm);
  check('core tools still run next to module tools', (await rs.tool('task_status', {})).json.tasks !== undefined);
  rs.stop();
  const x2 = startServer(env);
  const noRole = await x2.call('tools/call', { name: 'role_create', arguments: { name: 'a', persona: 'b' } });
  check('module tool of a module that is off: unknown tool (-32602)', noRole.error && noRole.error.code === -32602, noRole);
  x2.stop();

  // f. task family: a chain tA > tB > tC (tA started by the owner), and tP with five children
  const fam = mkEnv('fam', ON);
  fs.mkdirSync(fam.env.HARNESS_STATE_DIR, { recursive: true });
  const par = (task_id, parent_task_id) => JSON.stringify({ id: 'p' + task_id, ts: new Date().toISOString(), type: 'task_parent', task_id, parent_task_id });
  fs.writeFileSync(path.join(fam.env.HARNESS_STATE_DIR, 'journal.jsonl'), [par('tB', 'tA'), par('tC', 'tB'), ...['k1', 'k2', 'k3', 'k4', 'k5'].map(k => par(k, 'tP'))].join('\n') + '\n');
  const asTask = id => startServer({ ...fam.env, HARNESS_TASK_ID: id });
  const deep = asTask('tC');
  const qd = await deep.tool('queue_task', { request: 'one level too deep' });
  check('queue_task: a great-grandchild (depth 3 from an owner task) is refused, naming the depth cap 2', qd.err && /task family cap/.test(qd.text) && /depth limit 2/.test(qd.text), qd);
  deep.stop();
  const wide = asTask('tP');
  const qw = await wide.tool('queue_task', { request: 'a sixth child' });
  check('queue_task: a task that already queued 5 tasks is refused, naming the cap 5', qw.err && /task family cap/.test(qw.text) && /limit 5/.test(qw.text), qw);
  wide.stop();
  const fm = asTask('tB');
  const ux = await fm.tool('undo_task', { task_id: 'tA' });
  check('undo_task: from inside a task, its parent (outside its family) is refused', ux.err && /undo refused/.test(ux.text), ux);
  const uo = await fm.tool('undo_task', { task_id: 'tZ' });
  check('undo_task: from inside a task, an unrelated task is refused', uo.err && /undo refused/.test(uo.text), uo);
  const ud = await fm.tool('undo_task', { task_id: 'tC' });
  const us = await fm.tool('undo_task', { task_id: 'tB' });
  check('undo_task: itself and its descendants pass the family check (they go on to the task lookup)', ud.err && /no task/.test(ud.text) && us.err && /no task/.test(us.text), [ud.text, us.text]);
  fm.stop();

  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  const pass = results.filter(Boolean).length;
  console.log(`result: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
