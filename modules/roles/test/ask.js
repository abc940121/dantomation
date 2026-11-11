#!/usr/bin/env node
'use strict';
// roles: role_ask (asynchronous mailbox), in-process. Tasks are faked with journal records, the way the server and the
// harness write them: queue_add, task_start, reply, task_done, queue_fail, queue_cancel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-ask-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
delete process.env.HARNESS_TASK_ID;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

(async () => {
  try {
    const cfg = { modules: { roles: true } };
    const { mods, meta } = M.load(cfg);
    const settings = {};
    const ctx = { state: meta.get('roles').state, settings, config: {} };
    const mod = mods.find(m => m && m.name === 'roles') || null;
    const tools = Object.fromEntries(M.apiOf(mods, 'roles').mcpTools.map(t => [t.name, t]));
    const ask = (taskId, role, message) => { process.env.HARNESS_TASK_ID = taskId; try { return tools.role_ask.run({ role, message }, ctx); } finally { delete process.env.HARNESS_TASK_ID; } };
    const mk = (name, engine) => tools.role_create.run({ name, persona: 'p', engine }, ctx);
    const recs = () => J.readAll().records;
    const adds = bot => recs().filter(r => r.type === 'queue_add' && r.bot === bot);
    const start = (id, bot) => J.append({ type: 'task_start', task_id: id, bot });
    const finish = (id, reply) => { if (reply !== undefined) J.append({ type: 'reply', task_id: id, text: reply }); J.append({ type: 'task_done', task_id: id }); };
    const sweepJob = () => { const j = (mod && mod.jobs || []).find(x => x.id === 'ask-sweep'); return j ? j.run(ctx) : null; };
    const asksFile = () => JSON.parse(fs.readFileSync(path.join(ctx.state.dir, 'asks.json'), 'utf8')).entries;

    const alice = mk('Alice', 'codex'), bob = mk('Bob', 'opencode'), cara = mk('Cara'), dave = mk('Dave'), eve = mk('Eve'), old = mk('Old');
    tools.role_remove.run({ role: old.id }, ctx);
    check('module has the ask hooks', mod && mod.on && typeof mod.on['task.end'] === 'function' && (mod.jobs || []).some(j => j.id === 'ask-sweep'));
    check('settings declared', mod && mod.settings.ask_depth_cap.default === 3 && mod.settings.ask_chain_cap.default === 12);

    // Refusals.
    check('outside a task: refused with a chat page note', /聊天頁面/.test(throws(() => tools.role_ask.run({ role: 'Bob', message: 'hi' }, ctx))) && !adds(bob.id).length);
    start('tA1', alice.id);
    check('unknown role refused', /No such role/.test(throws(() => ask('tA1', 'Nobody', 'hi'))));
    check('archived role refused', /archived/.test(throws(() => ask('tA1', 'Old', 'hi'))));
    check('self refused', /itself/.test(throws(() => ask('tA1', 'Alice', 'hi'))));
    check('empty message refused', /message is required/.test(throws(() => ask('tA1', 'Bob', '  '))));
    check('refusals queued nothing', adds(bob.id).length === 0 && adds(old.id).length === 0 && !fs.existsSync(path.join(ctx.state.dir, 'asks.json')));

    // Happy path: Alice (codex) asks Bob (opencode), Bob answers, the answer comes back to Alice.
    const r = ask('tA1', 'Bob', 'What is 2+2?');
    check('ask returns at once with queued, task id, target and a bilingual note', r.queued === true && /^t/.test(r.task_id) && r.to === 'Bob' && /結束這一輪/.test(r.note) && /End your turn/.test(r.note), JSON.stringify(r));
    const qa = adds(bob.id);
    check('the message is queued into the target own thread with the ask header', qa.length === 1 && qa[0].task_id === r.task_id && qa[0].prompt.startsWith('[來自角色「Alice」的訊息 / message from role "Alice"]') && /sent back to "Alice" automatically/.test(qa[0].prompt) && /What is 2\+2\?/.test(qa[0].prompt), JSON.stringify(qa));
    const e1 = asks => asks[r.task_id];
    check('asks.json entry keyed by the target task id', (() => { const e = e1(asksFile()); return e && e.from === alice.id && e.to === bob.id && e.depth === 1 && e.chain.join() === [alice.id, bob.id].join() && e.asked_at && !e.delivered_at; })());
    check('no leftover temp or lock files', fs.readdirSync(ctx.state.dir).sort().join() === 'asks.json,roles.json');
    check('sweep before the target ends delivers nothing', sweepJob() === undefined && adds(alice.id).length === 0);
    start(r.task_id, bob.id); J.append({ type: 'reply', task_id: r.task_id, text: 'Four.' });
    check('a reply without task_done is not an end', adds(alice.id).length === 0 && (sweepJob(), adds(alice.id).length === 0));
    J.append({ type: 'task_done', task_id: r.task_id });
    mod.on['task.end']({ task_id: r.task_id, code: 0 }, ctx);
    const back = adds(alice.id);
    check('the reply is queued into the asker thread with the reply header', back.length === 1 && back[0].prompt.startsWith('[角色「Bob」的回覆 / reply from role "Bob"]') && /Four\./.test(back[0].prompt), JSON.stringify(back));
    check('entry marked delivered, not deleted', (() => { const e = e1(asksFile()); return e && e.delivered_at && e.outcome === 'done' && e.delivery_task === back[0].task_id; })());
    sweepJob(); mod.on['task.end']({ task_id: r.task_id, code: 0 }, ctx); sweepJob();
    check('exactly once: more sweeps add nothing', adds(alice.id).length === 1);

    // The delivery turn inherits the chain: Alice, in the delivery task, asks Cara (depth 2 is not reached: the reply entry carries depth 0).
    start(back[0].task_id, alice.id);
    const r2 = ask(back[0].task_id, 'Cara', 'one more thing');
    check('the reply-delivery turn can ask again and keeps the chain id', r2.queued && asksFile()[r2.task_id].chain_id === e1(asksFile()).chain_id, JSON.stringify(asksFile()[r2.task_id]));
    finish(r2.task_id, 'ok');
    sweepJob();

    // Truncation and long replies.
    start('tT1', alice.id);
    const rt = ask('tT1', 'Dave', 'long please'); start(rt.task_id, dave.id); finish(rt.task_id, 'x'.repeat(9000));
    sweepJob();
    const tb = adds(alice.id).find(x => /xxxx/.test(x.prompt));
    check('long reply is cut at about 8000 chars and marked', tb && tb.prompt.length < 8600 && /truncated/.test(tb.prompt), tb && tb.prompt.length);

    // Failures: failed, stopped, queue_fail, queue_cancel, and no reply text.
    const failCase = (label, askTask, prep, rx) => {
      start(askTask, alice.id);
      const x = ask(askTask, 'Eve', label); prep(x.task_id);
      const note = q => /沒有回覆 \/ role "Eve" did not reply/.test(q.prompt) && q.prompt.includes(rx), before = adds(alice.id).filter(note).length;
      sweepJob();
      const m = adds(alice.id).filter(note).slice(before);
      check(`${label}: failure note delivered once`, m.length === 1 && !/Four|xxxx/.test(m[0].prompt), JSON.stringify(m));
      sweepJob(); check(`${label}: not delivered twice`, adds(alice.id).filter(note).length === before + 1);
    };
    failCase('failed task', 'tF1', id => { start(id, eve.id); J.append({ type: 'task_done', task_id: id, auto: true, failed: true, code: 1 }); }, 'its task failed');
    failCase('stopped task', 'tF2', id => { start(id, eve.id); J.append({ type: 'task_done', task_id: id, stopped: true }); }, 'its task was stopped');
    failCase('queue_fail', 'tF3', id => J.append({ type: 'queue_fail', task_id: id, code: 3 }), 'its task failed');
    failCase('queue_cancel', 'tF4', id => J.append({ type: 'queue_cancel', task_id: id }), 'its task was stopped');
    failCase('empty reply', 'tF5', id => { start(id, eve.id); finish(id, '   '); }, 'ended without a reply');

    // Restart sweep: a finished ask with nobody to run task.end, delivered by a fresh module instance (job or load).
    start('tR1', cara.id);
    const rr = ask('tR1', 'Bob', 'restart?'); start(rr.task_id, bob.id); finish(rr.task_id, 'after restart');
    const again = M.load(cfg); const mod2 = again.mods.find(m => m && m.name === 'roles');
    const ctx2 = { state: again.meta.get('roles').state, settings, config: {} };
    mod2.jobs[0].run(ctx2); mod2.jobs[0].run(ctx2); mod2.on['task.end']({ task_id: 'x' }, ctx2); sweepJob();
    check('restart: an undelivered finished ask is delivered once by a new instance', adds(cara.id).filter(q => /after restart/.test(q.prompt)).length === 1);

    // Delivery failure leaves the entry undelivered (retry), never half-marked.
    const realAppend = J.append; start('tR2', cara.id);
    const rf = ask('tR2', 'Bob', 'append fails'); start(rf.task_id, bob.id); finish(rf.task_id, 'late');
    J.append = () => { throw new Error('disk full'); };
    try { sweepJob(); } finally { J.append = realAppend; }
    check('an append failure keeps the entry undelivered', !asksFile()[rf.task_id].delivered_at && !adds(cara.id).some(q => /late/.test(q.prompt)));
    sweepJob();
    check('the next sweep delivers it', asksFile()[rf.task_id].delivered_at && adds(cara.id).filter(q => /late/.test(q.prompt)).length === 1);

    // Depth, cycle and chain caps. ask_depth_cap 2: A asks B (1), B asks C (2), C asks D refused.
    settings.ask_depth_cap = 2;
    start('tD1', alice.id);
    const d1 = ask('tD1', 'Bob', 'd1'); start(d1.task_id, bob.id);
    const d2 = ask(d1.task_id, 'Cara', 'd2'); start(d2.task_id, cara.id);
    check('depth 2 within the cap', asksFile()[d2.task_id].depth === 2 && asksFile()[d2.task_id].chain.length === 3);
    const dm = throws(() => ask(d2.task_id, 'Dave', 'd3'));
    check('depth cap refused with a bilingual note', /層數已達上限/.test(dm) && /depth limit/.test(dm) && /Answer with what you have/.test(dm), dm);
    const cm = throws(() => ask(d2.task_id, 'Alice', 'loop'));
    check('cycle refused (target already in the chain)', /loop/.test(cm) && /循環/.test(cm), cm);
    check('cycle to the direct asker refused too', /loop/.test(throws(() => ask(d2.task_id, 'Bob', 'loop'))));
    check('refused asks queued nothing', adds(dave.id).filter(q => /d3/.test(q.prompt)).length === 0 && adds(alice.id).filter(q => /loop/.test(q.prompt)).length === 0);
    settings.ask_depth_cap = 5;
    // Chain cap 2: the third ask in one chain is refused although the depth is fine.
    settings.ask_chain_cap = 2;
    start('tC1', alice.id);
    const c1 = ask('tC1', 'Bob', 'c1'); start(c1.task_id, bob.id);
    const c2 = ask(c1.task_id, 'Cara', 'c2'); start(c2.task_id, cara.id);
    const cc = throws(() => ask(c2.task_id, 'Dave', 'c3'));
    check('chain cap refused with a bilingual note', /總數已達上限/.test(cc) && /message limit/.test(cc), cc);
    settings.ask_chain_cap = 12; delete settings.ask_depth_cap;
    check('the cap is per chain: a new chain still works', ask('tC1', 'Eve', 'new').queued === true);

    // The main bot can ask like a role, and is asked like a role.
    start('tM1', 'main');
    const rm = ask('tM1', 'Alice', 'from main');
    check('main asks a role', rm.queued && asksFile()[rm.task_id].from === 'main' && /\[來自角色「main」/.test(adds(alice.id).find(q => q.task_id === rm.task_id).prompt));
    start(rm.task_id, alice.id); finish(rm.task_id, 'to main'); sweepJob();
    check('the reply goes to the main bot', adds('main').filter(q => /to main/.test(q.prompt)).length === 1);
    start('tM2', alice.id);
    const rn = ask('tM2', 'main', 'hello main');
    check('a role asks main', rn.queued && adds('main').some(q => q.task_id === rn.task_id));

    // Nested: Bob, asked by Alice, asks Cara and ends his turn. Alice gets Bob's final answer, not his interim text.
    start('tN1', alice.id);
    const n1 = ask('tN1', 'Bob', 'n1'); start(n1.task_id, bob.id);
    const n2 = ask(n1.task_id, 'Cara', 'n2'); finish(n1.task_id, 'interim: I asked Cara');
    sweepJob();
    check('nested: the interim text is not delivered while the inner ask is open', !asksFile()[n1.task_id].delivered_at && !adds(alice.id).some(q => /interim/.test(q.prompt)));
    start(n2.task_id, cara.id); finish(n2.task_id, 'cara says 7'); sweepJob(); sweepJob();
    const nd = asksFile()[n2.task_id].delivery_task;
    check('nested: the inner answer reaches the middle role, the outer ask still waits', !!nd && adds(bob.id).some(q => q.task_id === nd && /cara says 7/.test(q.prompt)) && !asksFile()[n1.task_id].delivered_at);
    start(nd, bob.id); finish(nd, 'final: seven'); sweepJob(); sweepJob();
    check('nested: the final answer is delivered once, the interim text never', adds(alice.id).filter(q => /final: seven/.test(q.prompt)).length === 1 && !adds(alice.id).some(q => /interim/.test(q.prompt)));

    // "main" is the main role (ensureMain) once it exists; until then it is the configured main bot.
    const mrole = M.apiOf(mods, 'roles').main();
    start('tM3', alice.id);
    const rq = ask('tM3', 'main', 'hello main role');
    check('role_ask "main" goes to the main role once it exists', rq.queued && adds(mrole.id).some(q => q.task_id === rq.task_id) && !adds('main').some(q => q.task_id === rq.task_id), JSON.stringify(rq));
    check('role_ask "main" by the main role name or id reaches the same role', ask('tM3', mrole.name, 'by name').queued && ask('tM3', mrole.id, 'by id').queued);

    // The tool is described for the model.
    check('tool description says it does not wait', /does NOT wait/.test(tools.role_ask.description) && /end your turn/.test(tools.role_ask.description));
  } catch (e) { check('suite ran without an exception', false, e && e.stack); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } }
  const fail = results.filter(x => !x).length;
  console.log(`${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
