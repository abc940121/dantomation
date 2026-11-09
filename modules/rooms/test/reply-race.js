#!/usr/bin/env node
'use strict';
// rooms reply race: the task is 'done' before the engine writes its reply record.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HARNESS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-race-'));
const J = require('../../../lib/journal');
const mod = require('../index');

let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && info !== undefined ? '  -> ' + JSON.stringify(info).slice(0, 300) : ''}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const ROOMS = { dev: { lead: 'ann', members: [{ id: 'ann', name: 'Ann', bot: 'ann-bot' }] } };

async function run(label, settings, journalAfterDone) {
  const taskId = 'tk-' + label;
  const tasks = { enqueue: async () => ({ id: taskId }), get: async () => ({ state: 'done' }), cancel: async () => {} };
  const posted = [];
  const ctx = { settings: { rooms: ROOMS, human_label: 'human-' + label, reply_timeout_s: 30, poll_ms: 10, reply_grace_s: 15, ...settings },
    state: { append: r => { const x = J.append({ module: 'rooms', ...r }); posted.push(x); return x; } }, tasks, params: { id: 'dev' }, query: {}, body: { text: 'hi @ann' } };
  const h = mod.routes.find(r => r.method === 'POST' && r.path === '/rooms/:id/say').handler;
  J.append({ type: 'task_done', task_id: taskId });
  journalAfterDone(taskId);
  h(ctx);
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && !posted.some(r => r.type === 'room_msg' && r.kind === 'bot') && !posted.some(r => r.type === 'room_turn_skipped')) await wait(10);
  return posted;
}

(async () => {
  let p = await run('late', {}, id => setTimeout(() => { J.append({ type: 'reply', task_id: id, text: 'late hello' }); J.append({ type: 'engine_exit', task_id: id }); }, 300));
  check('reply written after done is still posted', p.some(r => r.type === 'room_msg' && r.kind === 'bot' && r.text === 'late hello'), p);

  p = await run('exit', {}, id => J.append({ type: 'engine_exit', task_id: id }));
  const t0 = Date.now();
  check('engine_exit without a reply ends the wait at once and journals a skip', p.some(r => r.type === 'room_turn_skipped' && r.room === 'dev' && r.member === 'ann' && !('text' in r)) && Date.now() - t0 < 1500, p);

  const s0 = Date.now();
  p = await run('grace', { reply_grace_s: 0.3 }, () => {});
  check('no reply and no exit: the grace expires, nothing posted, skip journaled', !p.some(r => r.type === 'room_msg' && r.kind === 'bot') && p.some(r => r.type === 'room_turn_skipped') && Date.now() - s0 < 3000, p);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(process.env.HARNESS_STATE_DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
