#!/usr/bin/env node
'use strict';
// app-ui rooms area: the pure mapping helpers (adapter/areas/rooms-map.mjs). Made-up text only.
(async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'adapter', 'areas', 'rooms-map.mjs')).href);
  let bad = 0;
  const check = (label, ok, info) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || info === undefined ? '' : ': ' + JSON.stringify(info).slice(0, 300)}`); };

  const room = { id: 'dev', lead: 'ann', window: 20, members: [
    { id: 'ann', name: 'Ann' }, { id: 'bob', name: 'Bob', neverLead: true }, { id: 'cy' },
  ] };
  const g = M.roomToWireGroup(room, { busy: true, speaker: 'bob', queue: ['cy', 'ghost'], lead: 'ann', floor: true });
  check('group: id, thread and members', g.id === 'dev' && g.name === 'dev' && g.threadId === 'room:dev' && g.members.length === 3, g);
  check('group: member name falls back to the id', g.members[2].name === 'cy');
  check('group: lead, presence and queue; unknown queue ids are dropped', g.lead === 'ann' && g.busy && g.speaker === 'bob' && g.floor && g.queue.join() === 'cy', g);
  const idle = M.roomToWireGroup(room);
  check('group: no status means idle', !idle.busy && idle.speaker === null && idle.queue.length === 0 && !idle.floor);
  check('group: a lead that is not a member is dropped', M.roomToWireGroup({ id: 'x', lead: 'zz', members: [{ id: 'a' }] }).lead === null);
  check('group: bad members are skipped', M.roomToWireGroup({ id: 'x', members: [null, {}, { id: 'a' }] }).members.length === 1);

  const human = { id: 'm1', ts: '2026-01-02T03:04:05.000Z', speaker: 'human', label: 'human', kind: 'human', text: 'hello @Ann' };
  const bot = { id: 'm2', ts: '2026-01-02T03:04:09.000Z', speaker: 'ann', label: 'Ann', kind: 'bot', text: 'hi', emotion: 'happy' };
  const sys = { id: 'm3', ts: 'not a date', speaker: 'system', label: 'system', kind: 'system', text: 'Bob is unavailable' };
  const w1 = M.roomMessageToWireMessage(human, 'dev'), w2 = M.roomMessageToWireMessage(bot, 'dev'), w3 = M.roomMessageToWireMessage(sys, 'dev');
  check('message: roles', w1.role === 'user' && w2.role === 'bot' && w3.role === 'bot');
  check('message: stable ids carry the room', w1.id === 'room:dev:m1' && M.roomMessageToWireMessage(human, 'dev').id === w1.id && M.roomMessageToWireMessage(human, 'ops').id === 'room:ops:m1');
  check('message: time, text, speaker label, emotion', w2.createdAt === Date.parse(bot.ts) && w2.text === 'hi' && w2.extra.label === 'Ann' && w2.extra.speaker === 'ann' && w2.extra.emotion === 'happy' && w2.extra.rawId === 'm2', w2);
  check('message: a bad timestamp gives no createdAt; system kind is kept', !('createdAt' in w3) && w3.extra.lineKind === 'system', w3);

  const a = [w1, w2];
  const m1 = M.mergeMessages(a, [w2, w3]);
  check('merge: dedupes by id and keeps order', m1.map(m => m.id).join() === 'room:dev:m1,room:dev:m2,room:dev:m3', m1.map(m => m.id));
  const edited = { ...w2, text: 'hi there' };
  const m2 = M.mergeMessages(a, [edited]);
  check('merge: a known id is replaced in place, input is not mutated', m2.length === 2 && m2[1].text === 'hi there' && a[1].text === 'hi');
  check('merge: undefined lists are fine', M.mergeMessages(undefined, undefined).length === 0 && M.mergeMessages(undefined, [w1]).length === 1);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'k' + i }));
  check('merge: cap keeps the newest rows', M.mergeMessages([], many, 5).map(m => m.id).join() === 'k7,k8,k9,k10,k11');
  check('merge: duplicates inside incoming collapse', M.mergeMessages([], [many[0], many[0], many[1]]).length === 2);

  check('cursor: raw id of the last message', M.cursorOf(m1) === 'm3' && M.cursorOf([]) === undefined && M.cursorOf(undefined) === undefined);

  check('pollDelay: 3 s visible, 15 s hidden', M.pollDelay(true, 0) === 3000 && M.pollDelay(false, 0) === 15000);
  check('pollDelay: doubles on failures', M.pollDelay(true, 1) === 6000 && M.pollDelay(true, 2) === 12000 && M.pollDelay(false, 1) === 30000);
  check('pollDelay: capped at 60 s, tolerates junk', M.pollDelay(true, 50) === 60000 && M.pollDelay(false, 9) === 60000 && M.pollDelay(true, -3) === 3000 && M.pollDelay(true, NaN) === 3000);


  console.log(bad ? `${bad} FAILED` : 'rooms area: all passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
