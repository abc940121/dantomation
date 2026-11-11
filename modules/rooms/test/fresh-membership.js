#!/usr/bin/env node
'use strict';
// rooms: who is in a room is read fresh from the room source at three points (turn start, right before a reply is posted,
// hop routing). A member who left, or a room that went away, gets nothing posted, whatever the engine had captured:
// the group changed outside the engine, with no dropTurns call, even after the engine was replaced. A member's running
// task is stopped (not left to finish) when they are removed or the group is archived, from any process.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HARNESS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-fresh-'));
const J = require('../../../lib/journal');
const mod = require('../index');

let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  -> ' + JSON.stringify(info).slice(0, 300) : '')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); } return false; };

// the "group store": the table a room source returns. Changing it is the group file changing outside the engine.
const GROUPS = {};
const room = (id, names) => ({ name: id, lead: names[0], members: names.map(n => ({ id: n, name: n[0].toUpperCase() + n.slice(1), bot: n + '-' + id })) });
const delivered = [];   // every delivery an engine member got: { room, member }
mod.api.registerDeliverer('recheck-eng', async a => { delivered.push({ room: a.room, member: a.member.id }); return { text: 'engine reply' }; });
mod.api.registerRoomSource(() => JSON.parse(JSON.stringify(GROUPS)));

const enq = [], posted = [], cancelled = [];
const plan = {};   // bot -> { reply, closed }  (closed keeps the task running)
const tasks = {
  enqueue: async bot => { const id = 'tk' + (enq.length + 1); enq.push({ bot, id }); const p = plan[bot]; if (p && p.reply) J.append({ type: 'reply', task_id: id, text: p.reply }); return { id }; },
  get: async id => { const e = enq.find(x => x.id === id); return { state: e && plan[e.bot] && plan[e.bot].closed ? 'running' : 'done' }; },
  cancel: async id => { cancelled.push(id); },
};
let onAppend = null;   // the test watches the engine's own journal records: a synchronous hook, no clock
const ctxOf = (label, params, body) => ({ settings: { rooms: {}, human_label: 'human-' + label, reply_timeout_s: 30, poll_ms: 10, reply_grace_s: 3 },
  state: { append: r => { const x = J.append({ module: 'rooms', ...r }); posted.push(x); if (onAppend) onAppend(x); return x; } }, tasks, params, query: {}, body });
const route = (m, p) => mod.routes.find(r => r.method === m && r.path === p).handler;
const say = (label, id, text) => route('POST', '/rooms/:id/say')(ctxOf(label, { id }, { text }));
const floor = (label, id, speaking) => route('POST', '/rooms/:id/floor')(ctxOf(label, { id }, { speaking }));
const botsIn = id => enq.filter(e => e.bot.endsWith('-' + id)).map(e => e.bot.split('-')[0]);
const said = (id, who) => posted.filter(r => r.type === 'room_msg' && r.room === id && r.kind === 'bot' && (!who || r.speaker === who));
const taskOf = (id, who) => { const e = enq.find(x => x.bot === who + '-' + id); return e && e.id; };
const stopped = (id, who) => cancelled.includes(taskOf(id, who));
const skipped = (id, who) => posted.filter(r => r.type === 'room_turn_skipped' && r.room === id && (!who || r.member === who));
const setMembers = (id, names) => { GROUPS[id] = room(id, names); };
const withEngine = (id, names) => { const r = room(id, names); r.members.push({ id: 'xan', name: 'Xan', engine: 'recheck-eng' }); GROUPS[id] = r; return r; };
const statusOf = id => route('GET', '/rooms/:id/status')(ctxOf('k', { id })).json;
const deliveredTo = (id, who) => delivered.filter(d => d.room === id && d.member === who);

(async () => {
  // 1. a finished reply waiting for the floor (it has left the in-flight set) is checked again right before the post
  for (const [id, removeAnn] of [['f1', false], ['f2', true]]) {
    GROUPS[id] = room(id, ['ann', 'bob']);
    plan['ann-' + id] = { reply: 'hello from ann', closed: true };
    await say('a', id, '@ann hi');
    await until(() => botsIn(id).includes('ann'));
    await floor('a', id, true);                    // the owner starts speaking: replies wait for the floor
    plan['ann-' + id].closed = false;              // the task finishes, its reply is read, the engine waits for the floor
    await wait(300);
    if (removeAnn) setMembers(id, ['bob']);        // the group changes outside the engine: no dropTurns
    await floor('a', id, false);
    await until(() => said(id).length || skipped(id).length);
    if (!removeAnn) check('control: a member still in the room has the reply posted after the floor wait', said(id, 'ann').length === 1 && !skipped(id).length, { said: said(id), skipped: skipped(id) });
    else check('a member removed during the floor wait: the reply is not posted, a skip is journaled', !said(id).length && skipped(id, 'ann').some(r => r.reason === 'removed'), { said: said(id), skipped: skipped(id) });
  }

  // 2. hop routing reads the room as it is now: a reply that mentions a removed member does not queue them again
  for (const [id, removeBob] of [['h1', false], ['h2', true]]) {
    GROUPS[id] = room(id, ['ann', 'bob', 'cy']);
    plan['ann-' + id] = { reply: 'ping @bob and @cy', closed: true };
    plan['bob-' + id] = { reply: 'bob here' }; plan['cy-' + id] = { reply: 'cy here' };
    await say('b', id, '@ann go');
    await until(() => botsIn(id).includes('ann'));
    if (removeBob) setMembers(id, ['ann', 'cy']);
    plan['ann-' + id].closed = false;
    await until(() => botsIn(id).includes('cy'));
    await wait(400);
    if (!removeBob) check('control: an untouched room hops to every member the reply names', botsIn(id).includes('bob') && botsIn(id).includes('cy') && said(id, 'ann').length === 1, { bots: botsIn(id) });
    else {
      check('a surviving reply that names a removed member does not queue or run them', said(id, 'ann').length === 1 && !botsIn(id).includes('bob'), { bots: botsIn(id), skipped: skipped(id) });
      check('the member still in the room is woken and answers', botsIn(id).includes('cy') && said(id, 'cy').length === 1, { bots: botsIn(id) });
    }
  }

  // 3. turn start: a queued turn of a member removed outside the engine is refused; others in the room and other rooms are untouched
  for (const id of ['q1', 'q2']) { GROUPS[id] = room(id, ['ann', 'bob', 'cy']); for (const n of ['ann', 'bob', 'cy']) plan[n + '-' + id] = { reply: n + ' ok', closed: n === 'ann' }; await say('c', id, '@everyone go'); }
  await until(() => botsIn('q1').includes('ann') && botsIn('q2').includes('ann'));
  setMembers('q1', ['ann', 'cy']);                  // bob is removed from q1 only
  plan['ann-q1'].closed = false; plan['ann-q2'].closed = false;
  await until(() => said('q1', 'cy').length && said('q2', 'cy').length);
  await wait(200);
  check('a queued turn of a removed member is refused at turn start (no task, a skip is journaled)', !botsIn('q1').includes('bob') && skipped('q1', 'bob').some(r => r.reason === 'removed'), { bots: botsIn('q1'), skipped: skipped('q1') });
  check('the other members of that room still answer', said('q1', 'ann').length === 1 && said('q1', 'cy').length === 1, said('q1').map(r => r.speaker));
  check('control: the same member in the other room is untouched', botsIn('q2').includes('bob') && said('q2', 'bob').length === 1 && !skipped('q2').length, { bots: botsIn('q2'), skipped: skipped('q2') });

  // 4. the engine is replaced (human_label changes) while a turn runs: the old engine's work is checked just the same
  GROUPS.e1 = room('e1', ['ann', 'bob']); plan['ann-e1'] = { reply: 'ann e1', closed: true }; plan['bob-e1'] = { reply: 'bob e1' };
  await say('old', 'e1', '@everyone go');
  await until(() => botsIn('e1').includes('ann'));
  await route('GET', '/rooms')(ctxOf('new', {}));    // another human_label: a new engine replaces the cached one
  setMembers('e1', ['bob']);                         // ann leaves (another process); the new engine has never heard of her turn
  await until(() => stopped('e1', 'ann'));           // her task is still running: it must be cancelled, not left to finish
  check('a replaced engine stops the running task of a removed member', stopped('e1', 'ann'), cancelled);
  await until(() => said('e1', 'bob').length);
  await wait(200);
  plan['ann-e1'].closed = false;
  check('a replaced engine does not post the reply of a removed member', !said('e1', 'ann').length && skipped('e1', 'ann').some(r => r.reason === 'removed'), { said: said('e1').map(r => r.speaker), skipped: skipped('e1') });
  check('and the member who stayed still has the reply posted', said('e1', 'bob').length === 1, said('e1').map(r => r.speaker));

  // 5. a room that went away (archived group): nothing queued is run or posted
  GROUPS.z1 = room('z1', ['ann', 'bob']); plan['ann-z1'] = { reply: 'ann z1', closed: true }; plan['bob-z1'] = { reply: 'bob z1' };
  await say('z', 'z1', '@everyone go');
  await until(() => botsIn('z1').includes('ann'));
  delete GROUPS.z1;
  plan['ann-z1'].closed = false;
  await until(() => skipped('z1').length >= 1);
  await wait(200);
  check('an archived group: the running task is cancelled', stopped('z1', 'ann'), cancelled);
  plan['ann-z1'].closed = false;
  check('an archived group: no reply is posted and no queued member is run', !said('z1').length && !botsIn('z1').includes('bob') && skipped('z1').length >= 1, { said: said('z1'), bots: botsIn('z1'), skipped: skipped('z1') });

  // 6. removed by another process while the engine that started the turn is still cached: the task is cancelled; the others go on
  GROUPS.o1 = room('o1', ['ann', 'bob']); plan['ann-o1'] = { reply: 'ann o1', closed: true }; plan['bob-o1'] = { reply: 'bob o1' };
  await say('o', 'o1', '@everyone go');
  await until(() => botsIn('o1').includes('ann'));
  setMembers('o1', ['bob']);                         // the group file is rewritten elsewhere: no dropTurns, no engine call
  await until(() => stopped('o1', 'ann') && said('o1', 'bob').length);
  check('a member removed by another process has the running task cancelled', stopped('o1', 'ann') && !said('o1', 'ann').length, { cancelled, said: said('o1').map(r => r.speaker) });
  check('and the member who stayed answers', said('o1', 'bob').length === 1, said('o1').map(r => r.speaker));
  plan['ann-o1'].closed = false;

  // 7. removed while the owner holds the floor right after speaking: the turn is dropped and nothing is posted
  GROUPS.w1 = room('w1', ['ann', 'bob']); plan['ann-w1'] = { reply: 'ann w1' }; plan['bob-w1'] = { reply: 'bob w1' };
  // an owner line clears the floor, so the floor is taken right after it, while the turns are still queued
  const said7 = say('w', 'w1', '@everyone go');
  await floor('w', 'w1', true);                      // the owner keeps speaking: a turn waits for the floor before it is delivered
  await said7;
  await wait(300);
  setMembers('w1', ['bob']);                         // ann leaves during that wait
  await floor('w', 'w1', false);
  await until(() => skipped('w1', 'ann').length || botsIn('w1').includes('ann'));
  await wait(300);
  check('removed while the owner holds the floor: nothing of theirs is posted, a skip is journaled (the owner line clears the floor, so a task may already be queued; it is dropped)', !said('w1', 'ann').length && skipped('w1', 'ann').some(r => r.reason === 'removed'), { bots: botsIn('w1'), skipped: skipped('w1') });

  // 8. the re-check right before delivery (engine.js, "The group may have changed during the wait"). The owner holds the floor,
  // a turn for member X is queued and waits for it, X leaves (or the group is archived), the floor is released. The hook fires
  // on the turn's own room_seen record, i.e. after turn start and before the floor wait, with no await between them, so the
  // order is fixed and nothing is timed. X is an engine member: a harness-task member is also stopped inside the deliverer,
  // an engine member only here, so a delivery to X can only be prevented by this re-check. An engine member has no task to
  // cancel; the task-bot control below shows no task is queued either.
  for (const [id, how] of [["k1", "removed"], ["k2", "archived"]]) {
    withEngine(id, ["ann"]); plan["ann-" + id] = { reply: "hello from ann" };
    let held = null, fired = 0;
    onAppend = r => { if (r.type === "room_seen" && r.room === id && r.member === "xan") { fired++; floor("k", id, true); } };
    await say("k", id, "@xan go");
    await until(() => fired === 1);
    onAppend = null;
    held = statusOf(id).floor;
    if (how === "removed") { setMembers(id, ["ann"]); await floor("k", id, false); }   // X leaves, then the floor is released: the waiting turn goes on
    else { floor("k", id, false); delete GROUPS[id]; }   // archived: released and archived in one synchronous step (the floor route refuses an archived room); no timer can run between
    await until(() => skipped(id, "xan").length);
    check("k: the floor was held while the turn waited, and the hook fired once (" + how + ")", held === true && fired === 1, { held, fired });
    check("a member who left while the turn waited for the floor gets no delivery, and a removed skip is journaled (" + how + ")", !deliveredTo(id, "xan").length && skipped(id, "xan").some(r => r.reason === "removed") && !said(id, "xan").length, { delivered, skipped: skipped(id), said: said(id) });
    check("no task was queued for that turn, so none is left pending (" + how + ")", !botsIn(id).length, { bots: botsIn(id) });
  }
  // control: the same shape with X staying gets its delivery
  {
    withEngine("k3", ["ann"]); let fired = 0;
    onAppend = r => { if (r.type === "room_seen" && r.room === "k3" && r.member === "xan") { fired++; floor("k", "k3", true); } };
    await say("k", "k3", "@xan go");
    await until(() => fired === 1);
    onAppend = null;
    await floor("k", "k3", false);
    await until(() => deliveredTo("k3", "xan").length);
    check("control: with X still in the room, the floor release lets the delivery through", deliveredTo("k3", "xan").length === 1, delivered);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  fs.rmSync(process.env.HARNESS_STATE_DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
