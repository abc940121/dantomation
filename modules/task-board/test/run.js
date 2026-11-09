#!/usr/bin/env node
'use strict';
// task-board: store, claims (including a multi-process race), leases, dependencies,
// routes, events, command, api and git worktree workspaces. Fresh temp state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-board-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
delete process.env.HARNESS_TASK_ID;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const S = require('../store');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: 'test' };
const worker = id => ({ kind: 'worker', id });
const P = '/m/task-board';
const boardFile = path.join(process.env.HARNESS_STATE_DIR, 'm', 'task-board', 'board.json');

(async () => {
  try {
    const off = M.registry({ modules: { 'task-board': false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().length && off.settingsFor('task-board') === null);

    // ---- store: clock-driven lease expiry, no sleeping ----
    {
      let t = 1000;
      const st = S.open(path.join(tmp, 'clock'), { now: () => t });
      st.add({ id: 'a', title: 'first' });
      const c = st.claim('w1', { lease_ms: 5000 });
      check('store: claim sets owner and lease', c.id === 'a' && c.owner === 'w1' && c.lease_until === 6000 && c.attempts === 1);
      t = 5999; check('store: lease still held just before expiry', st.get('a').status === 'claimed');
      st.heartbeat('a', 'w1', 5000); t = 9000;
      check('store: heartbeat extends the lease', st.get('a').status === 'claimed');
      t = 11000;
      const g = st.get('a');
      check('store: expired lease reopens the task', g.status === 'open' && g.owner === null && g.expired_count === 1);
      check('store: expiry is reported', st.takeExpired().map(e => e.owner).join() === 'w1' && st.takeExpired().length === 0);
      let code = null; try { st.heartbeat('a', 'w1', 5000); } catch (e) { code = e.code; }
      check('store: late heartbeat is refused', code === 'not_claimed', code);
      const c2 = st.claim('w2', { lease_ms: 5000 });
      check('store: another agent can take over', c2.owner === 'w2' && c2.attempts === 2);
      code = null; try { st.finish('a', 'w1', true); } catch (e) { code = e.code; }
      check('store: the old owner cannot finish', code === 'not_owner', code);
    }

    // ---- store: input checks, dependencies ----
    {
      const st = S.open(path.join(tmp, 'deps'));
      const bad = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
      check('add: empty title refused', bad(() => st.add({ title: '  ' })) === 'bad_input');
      check('add: bad id refused', bad(() => st.add({ id: '../x', title: 't' })) === 'bad_input');
      st.add({ id: 'a', title: 'A' });
      check('add: duplicate id refused', bad(() => st.add({ id: 'a', title: 'A2' })) === 'exists');
      check('add: unknown dep refused', bad(() => st.add({ id: 'b', title: 'B', deps: ['zz'] })) === 'bad_input');
      check('add: self dep refused', bad(() => st.add({ id: 'b', title: 'B', deps: ['b'] })) === 'bad_input');
      st.add({ id: 'b', title: 'B', deps: ['a'] }); st.add({ id: 'c', title: 'C', deps: ['a', 'b'] });
      check('blocked task is not ready', st.get('b').ready === false && st.get('b').blocked_by.join() === 'a');
      check('claim by id of a blocked task refused', bad(() => st.claim('w', { id: 'b', lease_ms: 5000 })) === 'blocked');
      check('auto claim picks the ready task only', st.claim('w', { lease_ms: 5000 }).id === 'a');
      check('auto claim with nothing ready returns null', st.claim('w2', { lease_ms: 5000 }) === null);
      const r = st.finish('a', 'w', true);
      check('done unblocks dependants that are fully free', r.unblocked.join() === 'b', r.unblocked.join());
      check('b is now ready, c still waits for b', st.get('b').ready && !st.get('c').ready);
      st.claim('w', { lease_ms: 5000 }); const f = st.finish('b', 'w', false, 'broke');
      check('failed task does not unblock', f.unblocked.length === 0 && st.get('c').blocked_by.join() === 'b' && f.task.note === 'broke');
      check('claim on a failed task refused', bad(() => st.claim('w', { id: 'b', lease_ms: 5000 })) === 'not_open');
      st.retry('b');
      check('retry reopens a failed task', st.get('b').status === 'open' && st.get('b').note === null);
      check('remove refused while others depend on it', bad(() => st.remove('b')) === 'has_dependants');
      check('remove an unreferenced task', st.remove('c').removed.id === 'c' && st.get('c') === null);
      st.claim('w', { id: 'b', lease_ms: 5000 });
      check('remove refused while claimed', bad(() => st.remove('b')) === 'claimed');
      check('per-owner limit', bad(() => st.claim('w', { lease_ms: 5000, max_per_owner: 1 })) === 'limit');
      const small = S.open(path.join(tmp, 'cap'));
      for (let i = 0; i < 3; i++) { small.add({ id: `t${i}`, title: 'x' }, 3); small.claim('w', { id: `t${i}`, lease_ms: 5000 }); small.finish(`t${i}`, 'w', true); }
      small.add({ id: 't3', title: 'x' }, 3);
      check('cap prunes the oldest done task', small.get('t0') === null && small.get('t3') !== null);
    }

    // ---- store: atomic claim across processes ----
    {
      const dir = path.join(tmp, 'race');
      const st = S.open(dir);
      for (let i = 0; i < 12; i++) st.add({ id: `r${i}`, title: `race ${i}` }, 100);
      const kids = [];
      const code = `const S=require(${JSON.stringify(path.join(__dirname, '..', 'store.js'))});const s=S.open(${JSON.stringify(dir)});const me=process.argv[1];const got=[];for(;;){const t=s.claim(me,{lease_ms:60000});if(!t)break;got.push(t.id);}console.log(JSON.stringify(got));`;
      for (let i = 0; i < 4; i++) kids.push(new Promise(res => {
        const c = require('child_process').spawn(process.execPath, ['-e', code, `p${i}`], { stdio: ['ignore', 'pipe', 'inherit'] });
        let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', () => res(o));
      }));
      const outs = (await Promise.all(kids)).map(o => { try { return JSON.parse(o.trim().split('\n').pop()); } catch { return null; } });
      const all = outs.flat();
      check('race: every process answered', outs.every(Array.isArray), JSON.stringify(outs));
      check('race: 12 tasks claimed exactly once each', all.length === 12 && new Set(all).size === 12, `${all.length} claims, ${new Set(all).size} distinct`);
    }

    // ---- registry: loads, routes, access, events ----
    const reg = M.registry({ modules: { 'task-board': true } }, { tasks: { cancel: async () => {}, enqueue: async () => {}, get: async () => {} } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('settings merged', reg.settingsFor('task-board').lease_seconds === 300 && reg.settingsFor('task-board').workspace_dir === '');
    check('routes, job and command listed', reg.listRoutes().length === 10 && reg.listJobs().length === 1 && reg.listCommands().includes('taskboard'));
    const call = (method, url, actor, body) => reg.callRoute(reg.findRoute(method, url), { actor, body, query: Object.fromEntries(new URL(url, 'http://x').searchParams) });
    const ev = (e, p) => M.emit(reg.mods, e, p);
    // Record emitted events through a journal-free path: wrap deliver by listening via the registry's emit is internal,
    // so the journal records (task_board_*) are the evidence of what fired.
    const rec = type => J.readAll().records.filter(r => r.module === 'task-board' && r.type === type);

    let r = await call('POST', `${P}/tasks`, worker('w1'), { title: 'x' });
    check('worker cannot add tasks (403)', r.status === 403);
    r = await call('POST', `${P}/tasks`, { kind: 'anonymous' }, { title: 'x' });
    check('anonymous refused (403)', r.status === 403);
    r = await call('GET', `${P}/tasks`, { kind: 'anonymous' });
    check('anonymous cannot list (403)', r.status === 403);
    r = await call('POST', `${P}/tasks`, OWNER, { id: 'design', title: 'design it' });
    check('owner adds a task (201)', r.status === 201 && r.json.id === 'design' && r.json.ready === true);
    await call('POST', `${P}/tasks`, OWNER, { id: 'build', title: 'build it', deps: ['design'] });
    await call('POST', `${P}/tasks`, OWNER, { id: 'test', title: 'test it', deps: ['build'] });
    r = await call('POST', `${P}/tasks`, OWNER, { id: 'bogus', title: 'x', deps: ['nope'] });
    check('unknown dep is 400', r.status === 400);
    r = await call('POST', `${P}/tasks`, OWNER, { id: 'design', title: 'again' });
    check('duplicate id is 409', r.status === 409);
    r = await call('GET', `${P}/tasks?ready=1`, worker('w1'));
    check('ready filter lists only ready tasks', r.json.tasks.map(t => t.id).join() === 'design');
    r = await call('GET', `${P}/tasks?status=bogus`, worker('w1'));
    check('bad status filter is 400', r.status === 400);

    r = await call('POST', `${P}/claim`, worker('w1'), { owner: 'someone-else' });
    check('worker claims as itself, not as a spoofed owner', r.status === 200 && r.json.task.id === 'design' && r.json.task.owner === 'w1');
    r = await call('POST', `${P}/claim`, worker('w2'), {});
    check('second worker finds nothing ready', r.status === 200 && r.json.task === null);
    r = await call('POST', `${P}/claim`, worker('w2'), { id: 'design' });
    check('claiming a held task is 409', r.status === 409);
    r = await call('POST', `${P}/tasks/design/done`, worker('w2'), {});
    check('another worker cannot finish it (403)', r.status === 403);
    r = await call('POST', `${P}/tasks/design/heartbeat`, worker('w1'), { lease_seconds: 600 });
    check('heartbeat extends the lease', r.status === 200 && r.json.lease_until > Date.now() + 500000);
    r = await call('POST', `${P}/tasks/design/heartbeat`, worker('w1'), { lease_seconds: 1 });
    check('lease below 5 s is 400', r.status === 400);
    r = await call('POST', `${P}/tasks/design/done`, worker('w1'), { note: 'ok' });
    check('done unblocks the dependant', r.status === 200 && r.json.unblocked.join() === 'build', JSON.stringify(r.json.unblocked));
    check('journal has claimed, done and (no titles)', rec('task_board_claimed').length === 1 && rec('task_board_done').length === 1 && !JSON.stringify(J.readAll().records).includes('design it'));
    check('traversal id matches no route', reg.findRoute('POST', `${P}/tasks/%2e%2e/done`) === null);

    // lease expiry through the real file, seen via the route
    await call('POST', `${P}/claim`, worker('w3'), {});
    const d = JSON.parse(fs.readFileSync(boardFile, 'utf8')); d.tasks.find(t => t.id === 'build').lease_until = Date.now() - 1; fs.writeFileSync(boardFile, JSON.stringify(d));
    r = await call('GET', `${P}/tasks/build`, worker('w3'));
    check('dead agent: expired claim is open again', r.json.status === 'open' && r.json.owner === null && r.json.expired_count === 1);
    check('expiry is journaled', rec('task_board_expired').length === 1 && rec('task_board_expired')[0].owner === 'w3');

    // coordination: task-watchdog stall and task end release linked claims
    await call('POST', `${P}/claim`, worker('w4'), { id: 'build', task_ref: 'harness-task-7' });
    await ev('task-watchdog.stalled', { task_id: 'other', reason: 'repeat_error', detail: '', cancelled: false });
    check('stall event for another task changes nothing', (await call('GET', `${P}/tasks/build`, OWNER)).json.status === 'claimed');
    await ev('task-watchdog.stalled', { task_id: 'harness-task-7', reason: 'no_progress', detail: '', cancelled: false });
    r = await call('GET', `${P}/tasks/build`, OWNER);
    check('stalled harness task releases its claim', r.json.status === 'open' && rec('task_board_released').some(x => x.reason === 'stalled'));
    await call('POST', `${P}/claim`, worker('w4'), { id: 'build', task_ref: 'harness-task-8' });
    await ev('task.end', { task_id: 'harness-task-8', code: 1, workdir: '.' });
    check('task end releases a claim still held', (await call('GET', `${P}/tasks/build`, OWNER)).json.status === 'open');

    // release by owner, failure path, retry
    await call('POST', `${P}/claim`, worker('w5'), { id: 'build' });
    r = await call('POST', `${P}/tasks/build/release`, worker('w6'), {});
    check('release by a non-owner worker is 403', r.status === 403);
    r = await call('POST', `${P}/tasks/build/release`, OWNER, {});
    check('the owner can force a release', r.status === 200 && r.json.status === 'open');
    await call('POST', `${P}/claim`, worker('w5'), { id: 'build' });
    r = await call('POST', `${P}/tasks/build/fail`, worker('w5'), { note: 'compile error' });
    check('fail marks failed, dependants stay blocked', r.json.task.status === 'failed' && (await call('GET', `${P}/tasks/test`, OWNER)).json.ready === false);
    r = await call('POST', `${P}/tasks/build/retry`, worker('w5'));
    check('worker cannot retry (403)', r.status === 403);
    r = await call('POST', `${P}/tasks/build/retry`, OWNER);
    check('owner retries a failed task', r.json.status === 'open');
    r = await call('DELETE', `${P}/tasks/build`, OWNER);
    check('delete with dependants is 409', r.status === 409);
    r = await call('DELETE', `${P}/tasks/test`, OWNER);
    check('delete an unreferenced task', r.status === 200);

    // api for other modules
    const api = reg.api('task-board');
    check('api exposes the operations', ['add', 'list', 'get', 'claim', 'done', 'fail', 'release', 'heartbeat', 'releaseByTask'].every(k => typeof api[k] === 'function'));
    const t = await api.add({ id: 'via-api', title: 'from another module' });
    const cl = await api.claim('agent-x', { id: 'via-api', lease_seconds: 60 });
    check('api: add and claim', t.id === 'via-api' && cl.owner === 'agent-x');
    let apiErr = null; try { await api.done('via-api', 'agent-y'); } catch (e) { apiErr = e.code; }
    check('api: errors carry a code', apiErr === 'not_owner', apiErr);
    check('api: done', (await api.done('via-api', 'agent-x', 'fine')).task.status === 'done');

    // command
    const logs = []; const origLog = console.log, origErr = console.error;
    const cctx = { settings: reg.settingsFor('task-board'), state: { dir: path.join(process.env.HARNESS_STATE_DIR, 'm', 'task-board'), append: () => ({}) }, emit: async () => {}, config: {} };
    const cmd = async (...a) => { console.log = (...x) => logs.push(x.join(' ')); console.error = (...x) => logs.push(x.join(' ')); try { return await reg.mods.find(m => m.name === 'task-board').commands.taskboard(a, cctx); } finally { console.log = origLog; console.error = origErr; } };
    let c = await cmd('add', 'cmd', 'task', '--id', 'cmd1');
    check('command add', c.code === 0 && logs.pop() === 'cmd1');
    c = await cmd('claim');
    const claimed = logs.pop();
    check('command claim takes the first ready task', c.code === 0 && claimed.split('\t')[0] === 'build', claimed);
    c = await cmd('done', 'build', 'all', 'good');
    check('command done', c.code === 0 && (await api.get('build')).status === 'done');
    process.env.HARNESS_TASK_ID = 'tsk-1';
    c = await cmd('add', 'nope');
    check('command add refuses inside a task', c.code === 2);
    c = await cmd('claim');
    check('command claim inside a task owns it as task:<id>', c.code === 0 && (await api.list({ owner: 'task:tsk-1' })).length === 1);
    delete process.env.HARNESS_TASK_ID;
    c = await cmd('bogus');
    check('command usage on unknown verb', c.code === 1);

    // ---- workspaces (real git worktrees) ----
    const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString();
    let haveGit = true; try { git(tmp, '--version'); } catch { haveGit = false; }
    if (!haveGit) console.log('SKIP: workspace checks (git not available)');
    else {
      const repo = path.join(tmp, 'repo'), wsDir = path.join(tmp, 'ws');
      fs.mkdirSync(repo);
      git(repo, 'init', '-q'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
      const mk = cleanup => M.registry({ modules: { 'task-board': true }, task_board: { workspace_dir: wsDir, workspace_repo: repo, workspace_cleanup: cleanup } });
      let rg = mk('done');
      const wcall = (method, url, actor, body) => rg.callRoute(rg.findRoute(method, url), { actor, body, query: {} });
      await wcall('POST', `${P}/tasks`, OWNER, { id: 'ws1', title: 'with workspace' });
      r = await wcall('POST', `${P}/claim`, worker('w1'), {});
      const wp = r.json.task.workspace;
      check('claim creates a worktree under workspace_dir', wp === path.join(wsDir, 'task-ws1') && fs.existsSync(path.join(wp, '.git')), wp);
      check('worktree is on branch task-board/ws1', git(wp, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'task-board/ws1');
      // lease expiry then re-claim reuses the same workspace
      const bf = JSON.parse(fs.readFileSync(boardFile, 'utf8')); bf.tasks.find(x => x.id === 'ws1').lease_until = 1; fs.writeFileSync(boardFile, JSON.stringify(bf));
      r = await wcall('POST', `${P}/claim`, worker('w2'), {});
      check('re-claim after expiry reuses the workspace', r.json.task && r.json.task.owner === 'w2' && r.json.task.workspace === wp);
      r = await wcall('POST', `${P}/tasks/ws1/done`, worker('w2'), {});
      check('cleanup on done removes the worktree, keeps the branch', !fs.existsSync(wp) && r.json.task.workspace === null && git(repo, 'branch', '--list', 'task-board/ws1').includes('task-board/ws1'));
      // failed task keeps its workspace under "done" policy; "finished" removes it
      await wcall('POST', `${P}/tasks`, OWNER, { id: 'ws2', title: 'will fail' });
      r = await wcall('POST', `${P}/claim`, worker('w1'), {});
      const wp2 = r.json.task.workspace;
      await wcall('POST', `${P}/tasks/ws2/fail`, worker('w1'), {});
      check('policy "done" keeps the workspace of a failed task', fs.existsSync(wp2));
      rg = mk('finished');
      await wcall('POST', `${P}/tasks/ws2/retry`, OWNER);
      await wcall('POST', `${P}/claim`, worker('w1'), {});
      await wcall('POST', `${P}/tasks/ws2/fail`, worker('w1'), {});
      check('policy "finished" removes it on failure', !fs.existsSync(wp2));
      rg = mk('never');
      await wcall('POST', `${P}/tasks`, OWNER, { id: 'ws3', title: 'keep' });
      r = await wcall('POST', `${P}/claim`, worker('w1'), {});
      await wcall('POST', `${P}/tasks/ws3/done`, worker('w1'), {});
      check('policy "never" keeps it', fs.existsSync(r.json.task.workspace));
      // a bad repo fails the claim and gives the task back
      const bad = M.registry({ modules: { 'task-board': true }, task_board: { workspace_dir: wsDir, workspace_repo: path.join(tmp, 'not-a-repo') } });
      await bad.callRoute(bad.findRoute('POST', `${P}/tasks`), { actor: OWNER, body: { id: 'ws4', title: 'x' }, query: {} });
      r = await bad.callRoute(bad.findRoute('POST', `${P}/claim`), { actor: worker('w1'), body: { id: 'ws4' }, query: {} });
      const g = await bad.callRoute(bad.findRoute('GET', `${P}/tasks/ws4`), { actor: OWNER, query: {} });
      check('workspace failure: 500 and the task is open again', r.status === 500 && g.json.status === 'open' && g.json.owner === null, `${r.status} ${g.json.status}`);
    }
  } catch (e) {
    results.push(false); console.log('FAIL unexpected error:', e && e.stack || e);
  }
  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed ? 1 : 0);
})();
