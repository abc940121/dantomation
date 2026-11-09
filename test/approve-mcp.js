#!/usr/bin/env node
'use strict';
// bin/approve-mcp.js, the full profile's permission-prompt tool:
//   a. an ordinary call is allowed at once, input unchanged, no card
//   b. a red line raises a live card (no deadline) plus needs_you; yes -> allow (+ card_used), no -> deny
//   c. no deny however long nobody answers (fake clock: 48 hours); reminders at 10 min, then hourly
//   d. a stopped task (task_done) ends the wait with a deny; a hard block is denied without a card
//   e. the MCP stdio server: initialize, tools/list, tools/call allow and red line -> card -> approve;
//      notifications/cancelled and a closed stdin each close the waiting card as a system no
//   f. prompt-tool mode: an approval-cards rule is an "ask" (hook and server), not a timed card;
//      closeLive closes a task's live cards and leaves timed ones alone
// Runs in any mode: it writes its own config (approval-cards and guard-base on) in a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-approve-'));
const STATE = path.join(tmp, 'state');
const CFG = path.join(tmp, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ owner_name: 'Tester', modules: { 'approval-cards': true, 'guard-base': true } }));
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
process.env.HARNESS_LOG_DIR = path.join(tmp, 'logs');
process.env.HARNESS_CONFIG = CFG;
delete process.env.HARNESS_TASK_ID; delete process.env.HARNESS_NOW;
const ROOT = path.resolve(__dirname, '..');
const J = require(path.join(ROOT, 'lib', 'journal'));
const K = require(path.join(ROOT, 'modules', 'approval-cards', 'cards'));
const A = require(path.join(ROOT, 'bin', 'approve-mcp'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''}`); };
const recs = () => J.readAll().records;
const io = { J, settings: {}, emit: async () => {}, state: { get dir() { const d = path.join(STATE, 'm', 'approval-cards'); fs.mkdirSync(d, { recursive: true }); return d; }, append: r => J.append({ ...r, module: 'approval-cards' }) } };
const cardOf = task => recs().filter(r => r.type === 'card' && r.task_id === task).pop();
const answer = (task, a) => { const c = K.fold(recs()).get(cardOf(task).card_id); return K.answered(io, c, a, undefined, K.source({ where: 'cli' })); };
const RED = 'npm install -g some-tool';
const sysNo = id => recs().some(x => x.type === 'card_answer' && x.card_id === id && x.answer === 'no' && x.who === 'system');
const tick = () => new Promise(r => setImmediate(r));

// A fake clock: each poll moves time on by step ms; at a chosen poll, act (answer, stop).
function clock(step, at, act) {
  let t = Date.parse('2030-01-01T00:00:00Z'), polls = 0;
  return { now: () => t, sleep: async () => { polls++; t += step; if (polls === at) await act(); await tick(); }, get polls() { return polls; } };
}

async function main() {
  // a. auto-allow
  {
    const input = { command: 'ls -la', description: 'list' };
    const before = recs().length;
    const r = await A.decide({ tool_name: 'Bash', input, tool_use_id: 'tu1' }, { io, task_id: 'ta' });
    check('auto-allow: an ordinary call is allowed at once with its input unchanged', r.behavior === 'allow' && JSON.stringify(r.updatedInput) === JSON.stringify(input), r);
    const r2 = await A.decide({ tool_name: 'Write', input: { file_path: path.join(tmp, 'w', 'x.txt'), content: 'x' } }, { io, task_id: 'ta' });
    check('auto-allow: a tool outside any allow list (Write in a work folder) is allowed too', r2.behavior === 'allow', r2);
    check('auto-allow: nothing is journaled, no card', recs().length === before, recs().slice(before));
  }

  // b. red line -> card -> approve
  {
    const c = clock(1000, 3, () => answer('tb', 'yes'));
    const r = await A.decide({ tool_name: 'Bash', input: { command: RED } }, { io, task_id: 'tb', now: c.now, sleep: c.sleep });
    const card = cardOf('tb');
    check('red line: a live card is raised with no deadline', !!card && card.live === true && card.expires_at === null && /^redline:install$/.test(card.rule) && card.input.command === RED, card);
    check('red line: a needs_you record names the card', recs().some(x => x.type === 'needs_you' && x.task_id === 'tb' && x.card_id === card.card_id && x.kind === 'install'));
    check('red line -> approve: allowed with the same input, card_used journaled', r.behavior === 'allow' && r.updatedInput.command === RED && recs().some(x => x.type === 'card_used' && x.card_id === card.card_id), r);
  }

  // b. a yes already marked used by someone else still releases the waiter
  {
    const c = clock(1000, 2, async () => { await answer('tu', 'yes'); const k = cardOf('tu'); J.append({ type: 'card_used', module: 'approval-cards', card_id: k.card_id, task_id: 'tu' }); });
    const r = await A.decide({ tool_name: 'Bash', input: { command: 'npm install -g used-tool' } }, { io, task_id: 'tu', now: c.now, sleep: c.sleep });
    check('red line -> approved card already used: the waiter still allows, no second card_used', r.behavior === 'allow' && !!cardOf('tu') && recs().filter(x => x.type === 'card_used' && x.card_id === cardOf('tu').card_id).length === 1, r);
  }

  // b. red line -> card -> deny
  {
    const c = clock(1000, 2, () => answer('tc', 'no'));
    const r = await A.decide({ tool_name: 'Bash', input: { command: 'pip install requests' } }, { io, task_id: 'tc', now: c.now, sleep: c.sleep });
    check('red line -> deny: denied with the card\'s message', r.behavior === 'deny' && /DENIED/.test(r.message) && r.message.includes(cardOf('tc').card_id), r);
  }

  // c. no deny after a long wait; reminders at 10 min, then hourly
  {
    const H = 3600e3, STEP = 5 * 60e3;
    const c = clock(STEP, (48 * H) / STEP, () => answer('td', 'yes'));
    const p = A.decide({ tool_name: 'Bash', input: { command: 'gh auth login' } }, { io, task_id: 'td', now: c.now, sleep: c.sleep });
    const r = await p;
    const card = cardOf('td');
    const answers = recs().filter(x => x.type === 'card_answer' && x.card_id === card.card_id).map(x => x.answer);
    check('no deny after 48 hours unanswered: the only answer is the owner\'s yes, and it allows', r.behavior === 'allow' && JSON.stringify(answers) === '["yes"]', { r, answers });
    const rem = recs().filter(x => x.type === 'card_reminder' && x.card_id === card.card_id);
    check('reminders: the first at 10 minutes, the next an hour later', rem.length >= 2 && rem[0].n === 1 && rem[0].waited_min >= 10 && rem[0].waited_min < 15 && rem[1].waited_min >= 70 && rem[1].waited_min < 75, rem.slice(0, 2));
    check('reminders: hourly after that (48 over 48 hours), each naming the task and card', rem.length === 48 && rem.every((x, i) => x.n === i + 1 && x.task_id === 'td' && (i === 0 || x.waited_min - rem[i - 1].waited_min === 60)), rem.map(x => x.waited_min));
    process.env.HARNESS_NOW = '2099-01-01T00:00:00Z';
    const live = { ...card, state: 'pending' };
    const swept = await K.sweep(io);
    check('a live card never expires: isExpired is false and sweep leaves it alone, even years later', !K.isExpired(live) && !swept.length, swept);
    delete process.env.HARNESS_NOW;
  }

  // d. stop, hard block
  {
    const c = clock(1000, 2, () => { J.append({ type: 'task_done', task_id: 'te', stopped: true }); });
    const r = await A.decide({ tool_name: 'Bash', input: { command: 'brew install jq' } }, { io, task_id: 'te', now: c.now, sleep: c.sleep });
    check('stop: a stopped task ends the wait with a deny', r.behavior === 'deny' && /stopped/.test(r.message), r);
    check('stop: the card is closed as a system no, not left pending', sysNo(cardOf('te').card_id));
    const before = recs().length;
    const b = await A.decide({ tool_name: 'Bash', input: { command: 'echo x > guards/guard.js' } }, { io, task_id: 'tf' });
    check('hard block: denied at once, no card', b.behavior === 'deny' && /self_modify/.test(b.message) && !recs().slice(before).some(x => x.type === 'card'), b);
  }

  // e. the stdio server end to end
  {
    const env = { ...process.env, HARNESS_TASK_ID: 'tg', HARNESS_PROMPT_TOOL: '1', HARNESS_APPROVE_POLL_MS: '20' }; // as approveMcpFile writes it
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'approve-mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    let buf = '';
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
    let n = 0;
    const call = (method, params) => new Promise((res, rej) => { const id = ++n; waiting.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => rej(new Error('timeout ' + method)), 20000).unref(); });
    try {
      const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      check('stdio: initialize answers with tools capability', init.result && init.result.capabilities && init.result.capabilities.tools && init.result.serverInfo.name === 'taskmote', init);
      const list = await call('tools/list', {});
      check('stdio: tools/list has exactly the approve tool', list.result && list.result.tools.length === 1 && list.result.tools[0].name === 'approve', list);
      const parse = m => JSON.parse(m.result.content[0].text);
      const ok = parse(await call('tools/call', { name: 'approve', arguments: { tool_name: 'Read', input: { file_path: 'a.txt' }, tool_use_id: 'u1' } }));
      check('stdio: an ordinary call comes back allow with updatedInput', ok.behavior === 'allow' && ok.updatedInput.file_path === 'a.txt', ok);
      const pend = call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'winget install foo' }, tool_use_id: 'u2' } });
      let card = null;
      for (let i = 0; i < 200 && !card; i++) { await new Promise(r => setTimeout(r, 25)); card = cardOf('tg'); }
      check('stdio: a red line raises a live card and needs_you through the approval-cards module', !!card && card.live && recs().some(x => x.type === 'needs_you' && x.card_id === card.card_id));
      let settled = false; pend.then(() => { settled = true; });
      await new Promise(r => setTimeout(r, 200));
      check('stdio: the call waits while the card is open', !settled);
      await answer('tg', 'yes');
      const yes = parse(await pend);
      check('stdio: approving the card answers allow', yes.behavior === 'allow' && yes.updatedInput.command === 'winget install foo', yes);
      const newCard = async seen => { for (let i = 0; i < 200; i++) { const c = cardOf('tg'); if (c && c.card_id !== seen) return c; await new Promise(r => setTimeout(r, 25)); } return null; };
      const id = n + 1;
      const pc = call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'winget install bar' }, tool_use_id: 'u3' } });
      const c2 = await newCard(card.card_id);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'interrupted' } }) + '\n');
      const cx = parse(await pc);
      check('stdio: notifications/cancelled ends the wait with a deny', cx.behavior === 'deny' && /cancelled/.test(cx.message), cx);
      check('stdio: the cancelled card is closed as a system no', !!c2 && sysNo(c2.card_id));
      call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'winget install baz' }, tool_use_id: 'u4' } }).catch(() => {});
      const c3 = await newCard(c2 && c2.card_id);
      const gone = new Promise(r => child.on('exit', r));
      child.stdin.end();
      await Promise.race([gone, new Promise(r => setTimeout(r, 10000))]);
      check('stdio: stdin closed (engine gone) closes the waiting card as a system no', !!c3 && sysNo(c3.card_id));
    } catch (e) { check('stdio: server answered', false, e.message); }
    child.stdin.end(); child.kill();
  }

  // f. prompt-tool mode and closeLive
  {
    process.env.HARNESS_TASK_ID = 'ti'; process.env.HARNESS_PROMPT_TOOL = '1';
    const before = recs().length;
    const c = await A.classify('Bash', { command: 'winget install qux' }, tmp);
    check('prompt-tool mode: an approval-cards rule asks through the module chain, no timed card', c && c[0] === 'ask' && !recs().slice(before).some(x => x.type === 'card'), c);
    const { spawnSync } = require('child_process');
    const hook = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'winget install qux' }, cwd: tmp, session_id: 's' }), env: process.env, encoding: 'utf8' });
    let out = null; try { out = JSON.parse(hook.stdout); } catch { /* checked below */ }
    check('prompt-tool mode: the guard hook answers permissionDecision ask (exit 0), so the prompt tool decides', hook.status === 0 && out && out.hookSpecificOutput.permissionDecision === 'ask', { status: hook.status, out: hook.stdout, err: hook.stderr });
    delete process.env.HARNESS_TASK_ID; delete process.env.HARNESS_PROMPT_TOOL;
    const live = await K.create(io, { task_id: 'tj', tool: 'Bash', input: { command: 'a' }, rule: 'redline:install', summary: 's' }, {}, { live: true });
    const timed = await K.create(io, { task_id: 'tj', tool: 'Bash', input: { command: 'b' }, rule: 'r', summary: 's' }, {});
    const closed = K.closeLive(J.append, recs(), 'tj', 'the task was stopped');
    const f = K.fold(recs());
    check('closeLive: the live card is closed as a system no; the timed card stays pending', JSON.stringify(closed) === JSON.stringify([live.card_id]) && f.get(live.card_id).state === 'denied' && f.get(live.card_id).decided.who === 'system' && f.get(timed.card_id).state === 'pending', closed);
  }

  // g. locked profile (no prompt tool): a guard-base red line that is not an approval-cards rule still gets a card
  {
    const { spawnSync } = require('child_process');
    const env = { ...process.env, HARNESS_TASK_ID: 'tk' }; delete env.HARNESS_PROMPT_TOOL;
    const run = command => spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: tmp, session_id: 's' }), env, encoding: 'utf8' });
    const CMD = 'crontab -e';
    const cards = () => recs().filter(r => r.type === 'card' && r.task_id === 'tk');
    const h1 = run(CMD);
    check('locked: a guard-base ask becomes an approval card and the call is blocked while it waits', h1.status === 2 && cards().length === 1 && /approval card/.test(h1.stderr), { status: h1.status, err: h1.stderr, n: cards().length });
    const h2 = run(CMD);
    check('locked: retrying the same call reuses the waiting card', h2.status === 2 && cards().length === 1, { status: h2.status, n: cards().length });
    await answer('tk', 'yes');
    const h3 = run(CMD);
    let o3 = null; try { o3 = JSON.parse(h3.stdout); } catch { /* none: a plain allow */ }
    check('locked: after the owner says yes the exact call passes, with no second ask', h3.status === 0 && !o3 && recs().some(r => r.type === 'card_used' && r.card_id === cards()[0].card_id), { status: h3.status, out: h3.stdout, err: h3.stderr });
    const h4 = run(CMD);
    check('locked: the yes is used once; the next identical call needs a new card', h4.status === 2 && cards().length === 2, { status: h4.status, n: cards().length });
    // two hooks racing on one yes: exactly one passes
    const RACE = 'crontab -l | crontab -';
    run(RACE); const rc = cards().pop(); await answer('tk', 'yes');
    const { spawn: sp } = require('child_process');    const race = () => new Promise(res => { const ch = sp(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { env, stdio: ['pipe', 'ignore', 'ignore'] }); ch.on('exit', c => res(c)); ch.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: RACE }, cwd: tmp, session_id: 's' })); });
    const codes = await Promise.all([race(), race(), race(), race()]);
    check('locked: hooks racing on one approved card: exactly one passes', codes.filter(c => c === 0).length === 1 && recs().filter(r => r.type === 'card_used' && r.card_id === rc.card_id).length === 1, codes);
    const h5 = run('crontab -e && echo other');
    check('locked: the yes covers only that exact call', h5.status === 2 && cards().length >= 5 && cards().pop().input.command === 'crontab -e && echo other', { status: h5.status, n: cards().length });
    // the yes is bound to the directory: the same call from another directory needs its own card
    const DIR = 'crontab -r', other = fs.mkdtempSync(path.join(require('os').tmpdir(), 'amcp-other-'));
    run(DIR); await answer('tk', 'yes');
    const n6 = cards().length;
    const h6 = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: DIR }, cwd: other, session_id: 's' }), env, encoding: 'utf8' });
    check('locked: a yes in one directory does not pass the same call in another', h6.status === 2 && cards().length === n6 + 1 && cards().pop().cwd === path.resolve(other), { status: h6.status, err: h6.stderr });
    const h7 = run(DIR);
    check('locked: the same call back in the approved directory still passes', h7.status === 0, { status: h7.status, err: h7.stderr });
    fs.rmSync(other, { recursive: true, force: true });
  }

  // h. the journal cannot be written from the shell, and the prompt tool keeps the hook's ask and directory
  {
    const { spawnSync } = require('child_process');
    const hook = (command, extra) => spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: tmp, session_id: 's', ...extra }), env: { ...process.env, ...(extra && extra.env) }, encoding: 'utf8' });
    const forge = hook(`printf '{"type":"card_answer"}\\n' >> ${path.join(STATE, 'journal.jsonl')}`);
    check('journal: a shell write to the state dir journal is blocked', forge.status === 2 && /journal or state/.test(forge.stderr), { status: forge.status, err: forge.stderr });
    const bash = hook(`echo x >> /${STATE.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, l) => l.toLowerCase())}/x.txt`);
    check('journal: the Git Bash spelling of the state dir is blocked too', bash.status === 2, { status: bash.status, err: bash.stderr });
    const rel = hook('cat x >> state/journal.jsonl');
    check('journal: a relative journal.jsonl write is blocked', rel.status === 2, { status: rel.status, err: rel.stderr });
    const dd = hook(`printf x | dd of=state/journal.jsonl oflag=append conv=notrunc`);
    check('journal: a dd append is blocked', dd.status === 2, { status: dd.status, err: dd.stderr });
    const read = hook(`cat ${path.join(STATE, 'journal.jsonl')}`);
    check('journal: any shell command on it is blocked (bots read it through taskmote)', read.status === 2, { status: read.status, err: read.stderr });
    const other = hook('cat README.md');
    check('journal: other shell reads are fine', other.status === 0, { status: other.status, err: other.stderr });
    process.env.HARNESS_TASK_ID = 'tm'; process.env.HARNESS_PROMPT_TOOL = '1';
    const asked = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'winget install hk' }, tool_use_id: 'tuh1', cwd: tmp, session_id: 's' }), env: process.env, encoding: 'utf8' });
    const rec = recs().filter(r => r.type === 'hook_ask' && r.tool_use_id === 'tuh1').pop();
    check('prompt tool: the hook writes down its ask with the call\'s directory', asked.status === 0 && rec && rec.cwd === tmp && rec.task_id === 'tm', { status: asked.status, rec });
    const r = await A.decide({ tool_name: 'Bash', input: { command: 'winget install hk' }, tool_use_id: 'tuh1' }, { io, task_id: 'tm', classify: async () => null, cancelled: () => true, sleep: async () => {} });
    const card = recs().filter(x => x.type === 'card' && x.task_id === 'tm').pop();
    check('prompt tool: a re-check that passes does not undo the hook\'s ask; the live card names the directory', r.behavior === 'deny' && card && card.live && card.cwd === path.resolve(tmp) && card.summary.includes(path.resolve(tmp).slice(-20)), { r, card });
    const free = await A.decide({ tool_name: 'Bash', input: { command: 'winget install hk' }, tool_use_id: 'tuh2' }, { io, task_id: 'tm', classify: async () => null });
    check('prompt tool: with no hook ask and a clean re-check the call is allowed', free.behavior === 'allow', free);
    delete process.env.HARNESS_TASK_ID; delete process.env.HARNESS_PROMPT_TOOL;
  }

  // i. card ids are unique, and a second card under a live card's id never answers for it
  {
    const ids = await Promise.all(Array.from({ length: 200 }, () => K.create(io, { task_id: 'tid', tool: 'Bash', input: { command: 'x' }, summary: 's', rule: 'r' }, {}, { live: true }).then(c => c.card_id)));
    check('ids: 200 cards get 200 different ids, each reserved', new Set(ids).size === 200 && ids.every(i => fs.existsSync(path.join(io.state.dir, 'ids', i))), ids.length);
    // a card from before reservations: in the journal, no ids/ file. With randomness pinned to its id, a new card must not reuse it.
    const crypto = require('crypto'), real = crypto.randomBytes;
    io.state.append({ type: 'card', card_id: 'card-abcdef', task_id: 'told', tool: 'Bash', input: { command: 'old' }, sha256: 'old' });
    let draws = 0;
    crypto.randomBytes = n => (draws++ < 3 ? Buffer.from('abcdef', 'hex') : real(n));
    let fresh;
    try { fresh = await K.create(io, { task_id: 'tnew', tool: 'Bash', input: { command: 'new' }, summary: 's', rule: 'r' }, {}, { live: true }); }
    finally { crypto.randomBytes = real; }
    check('ids: an id already in the journal (made before reservations) is never drawn again', fresh.card_id !== 'card-abcdef' && draws > 3, { id: fresh.card_id, draws });
    const f = K.fold([{ type: 'card', card_id: 'card-dup', sha256: 'a' }, { type: 'card', card_id: 'card-dup', sha256: 'b' }]).get('card-dup');
    check('ids: the fold keeps the first card under an id', f.sha256 === 'a', f);
    let polls = 0, seen = null;
    const r = await A.decide({ tool_name: 'Bash', input: { command: 'winget install dup' } }, { io, task_id: 'tdup', classify: async () => ['ask', 'install', 'red line'],
      sleep: async () => {
        polls++;
        if (polls === 1) {
          // a second card record under the live card's id, for another call: the owner still sees (and answers) the first
          const live = cardOf('tdup');
          io.state.append({ type: 'card', card_id: live.card_id, task_id: 'tdup', tool: 'Bash', input: { command: 'other' }, sha256: 'other', created_at: new Date().toISOString(), live: true });
          seen = K.fold(recs()).get(live.card_id);
        }
      },
      cancelled: () => polls >= 2 });
    check('ids: a second card under a live card\'s id never replaces it', seen && seen.input.command === 'winget install dup' && r.behavior === 'deny', { seen, r });
    // a long id (drawn after repeated collisions) is accepted by taskmote do, with other cards pending
    const AC = require(path.join(ROOT, 'modules', 'approval-cards'));
    io.state.append({ type: 'card', card_id: 'card-0123456789ab', task_id: 'tlong', tool: 'Bash', input: { command: 'long' }, sha256: 'long', summary: 's', rule: 'r', created_at: new Date().toISOString(), expires_at: null, live: true });
    const out = await AC.commands.answer(['yes', 'card-0123456789ab'], { J, state: io.state, emit: async () => {} });
    check('ids: taskmote do accepts a 12-digit card id', out.code === 0 && K.fold(recs()).get('card-0123456789ab').state === 'approved', out);
  }

  // j. a stop or a cancel that lands with a yes in the same poll wins: the call is denied
  {
    for (const [label, task, stop] of [['cancel', 'tjc', null], ['stop', 'tjs', 'tjs']]) {
      let polls = 0;
      const r = await A.decide({ tool_name: 'Bash', input: { command: 'winget install race' } }, { io, task_id: task, classify: async () => ['ask', 'install', 'red line'],
        sleep: async () => { polls++; if (polls === 1) { await answer(task, 'yes'); if (stop) J.append({ type: 'task_done', task_id: stop, stopped: true }); } },
        cancelled: () => !stop && polls >= 1 });
      check(`race: a ${label} with a yes in the same poll denies the call, and the yes is not used`, r.behavior === 'deny' && !recs().some(x => x.type === 'card_used' && x.card_id === cardOf(task).card_id), r);
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  const pass = results.filter(Boolean).length;
  console.log(`result: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
