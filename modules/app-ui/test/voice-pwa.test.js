#!/usr/bin/env node
'use strict';
// voice-pwa: call state machine, manifest, icons, service worker, icon generator. Made-up text only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = path.resolve(__dirname, '..');
const PUB = path.join(APP, 'web', 'public');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };
const types = effects => effects.map(e => e.type);

(async () => {
  const M = await import(path.join(APP, 'adapter', 'areas', 'voice-machine.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const { step, initial, ENDPOINT_MS, PHASES } = M;
  const T0 = 1_000_000;
  const run = (m, evs) => { let effects = []; for (const e of evs) { const r = step(m, e); m = r.state; effects = effects.concat(r.effects); } return { m, effects }; };

  check('endpoint is 850 ms', ENDPOINT_MS === 850);
  check('states are exactly idle/listening/sending/working/speaking', JSON.stringify(PHASES) === JSON.stringify(['idle', 'listening', 'sending', 'working', 'speaking']));
  check('no hold-to-talk state or event', !PHASES.some(p => /talk|hold|push/i.test(p)) && !/talk|hold|push/i.test(fs.readFileSync(path.join(APP, 'adapter', 'areas', 'voice-machine.mjs'), 'utf8').replace(/\/\/.*$/gm, '')));

  // start / stop
  let r = step(initial(), { type: 'start' });
  check('start: idle -> listening, opens capture', r.state.phase === 'listening' && types(r.effects).join() === 'start_capture');
  check('start twice is a no-op', step(r.state, { type: 'start' }).effects.length === 0);
  r = step(r.state, { type: 'stop' });
  check('stop: -> idle, releases capture', r.state.phase === 'idle' && types(r.effects).join() === 'stop_capture');
  check('stop while idle is a no-op', step(initial(), { type: 'stop' }).effects.length === 0);

  // endpoint timing
  const listening = step(initial(), { type: 'start' }).state;
  let o = run(listening, [{ type: 'vad_start' }, { type: 'transcript_final', text: 'check the status', at: T0 }, { type: 'vad_end', at: T0 + 100 }]);
  check('vad_end + final transcript, endpoint not reached: stays listening and arms a timer', o.m.phase === 'listening' && o.effects.some(e => e.type === 'timer' && e.ms === ENDPOINT_MS), JSON.stringify(o));
  let t = step(o.m, { type: 'tick', at: T0 + 100 + ENDPOINT_MS - 1 });
  check('tick 1 ms early does not send', t.state.phase === 'listening' && !t.effects.some(e => e.type === 'send'));
  t = step(o.m, { type: 'tick', at: T0 + 100 + ENDPOINT_MS });
  check('tick at vad_end + 850 ms sends', t.state.phase === 'sending' && t.effects[0].type === 'send' && t.effects[0].text === 'check the status');
  o = run(listening, [{ type: 'vad_start' }, { type: 'vad_end', at: T0 }, { type: 'transcript_final', text: 'late words', at: T0 + 900 }]);
  check('final transcript arriving after the endpoint sends at once', o.m.phase === 'sending' && o.effects.some(e => e.type === 'send' && e.text === 'late words'));
  o = run(listening, [{ type: 'vad_end', at: T0 }, { type: 'tick', at: T0 + 5000 }]);
  check('vad_end without a transcript never sends', o.m.phase === 'listening' && !o.effects.some(e => e.type === 'send'));
  o = run(listening, [{ type: 'transcript_final', text: 'first part', at: T0 }, { type: 'vad_end', at: T0 + 10 }, { type: 'vad_start' }, { type: 'tick', at: T0 + 2000 }]);
  check('speaking again before the endpoint cancels it', o.m.phase === 'listening' && !o.effects.some(e => e.type === 'send'));
  o = run(o.m, [{ type: 'transcript_final', text: 'second part', at: T0 + 2100 }, { type: 'vad_end', at: T0 + 2200 }, { type: 'tick', at: T0 + 2200 + ENDPOINT_MS }]);
  check('the two parts are sent as one utterance', o.effects.some(e => e.type === 'send' && e.text === 'first part second part'));
  check('blank transcript is ignored', step(listening, { type: 'transcript_final', text: '   ', at: T0 }).state.text === '');

  // sending -> speaking -> listening
  const sending = { ...listening, phase: 'sending' };
  r = step(sending, { type: 'reply_lines', lines: [{ say: 'Hello there.' }, { say: 'All done.' }, { done: true }] });
  check('reply with lines: sending -> speaking, playback start then speak first line', r.state.phase === 'speaking' && types(r.effects).join() === 'playback,speak' && r.effects[0].state === 'start' && r.effects[1].text === 'Hello there.' && r.state.queue.length === 1);
  const sp = r.state;
  r = step(sp, { type: 'speak_end' });
  check('speak_end with a queue speaks the next line', r.state.phase === 'speaking' && r.effects[0].type === 'speak' && r.effects[0].text === 'All done.');
  r = step(r.state, { type: 'speak_end' });
  check('last speak_end: -> listening, playback end', r.state.phase === 'listening' && r.effects.length === 1 && r.effects[0].type === 'playback' && r.effects[0].state === 'end');
  r = step(sending, { type: 'reply_lines', lines: [{ done: true, ignored: 'echo-text' }] });
  check('reply with nothing to say: back to listening', r.state.phase === 'listening' && r.effects.length === 0);
  check('reply_lines outside sending/working is ignored', step(listening, { type: 'reply_lines', lines: [{ say: 'x' }] }).state.phase === 'listening');
  check('working accepts a reply', step({ ...listening, phase: 'working' }, { type: 'reply_lines', lines: [{ say: 'Done.' }] }).state.phase === 'speaking');

  // barge-in
  r = step(sp, { type: 'vad_start' });
  check('barge-in: vad_start while speaking cancels speech, ends playback, -> listening', r.state.phase === 'listening' && types(r.effects).join() === 'cancel_speech,playback' && r.effects[1].state === 'end' && r.state.queue.length === 0);
  r = step(sp, { type: 'speak_end' });
  o = run(sp, [{ type: 'vad_start' }, { type: 'speak_end' }]);
  check('a late speak_end after barge-in does nothing', o.m.phase === 'listening' && !o.effects.some(e => e.type === 'speak'));
  check('transcript during speaking is dropped', step(sp, { type: 'transcript_final', text: 'echo of the reply', at: T0 }).state.text === '');
  r = step(sp, { type: 'stop' });
  check('stop while speaking cancels the speech and playback', r.state.phase === 'idle' && types(r.effects).join() === 'cancel_speech,playback,stop_capture');

  // poll
  r = step(listening, { type: 'poll_lines', lines: [{ say: 'A card needs you.' }, { done: true }] });
  check('poll_lines while listening: speaks', r.state.phase === 'speaking' && r.effects[1].text === 'A card needs you.');
  r = step(sp, { type: 'poll_lines', lines: [{ say: 'Another one.' }] });
  check('poll_lines while speaking: queued, not spoken over', r.state.phase === 'speaking' && r.effects.length === 0 && r.state.queue.length === 2);
  check('poll_lines with nothing to say changes nothing', step(listening, { type: 'poll_lines', lines: [{ done: true }] }).effects.length === 0);
  check('poll_lines while idle is ignored', step(initial(), { type: 'poll_lines', lines: [{ say: 'x' }] }).state.phase === 'idle');
  check('poll_lines while sending speaks too', step(sending, { type: 'poll_lines', lines: [{ say: 'Heads up.' }] }).state.phase === 'speaking');

  // errors
  r = step(sending, { type: 'error', message: 'network' });
  check('error while sending: back to listening with the message', r.state.phase === 'listening' && r.state.error === 'network');
  r = step(sp, { type: 'error', message: 'tts' });
  check('error while speaking cuts the speech', r.state.phase === 'listening' && types(r.effects).join() === 'cancel_speech,playback');
  r = step(listening, { type: 'error', fatal: true, message: 'mic blocked' });
  check('fatal error: -> idle, capture released, message kept', r.state.phase === 'idle' && r.state.error === 'mic blocked' && types(r.effects).includes('stop_capture'));
  check('unknown events change nothing', step(listening, { type: 'push_to_talk' }).state === listening && step(listening, null).state === listening);

  // every (phase, event) pair lands in a known phase
  const all = ['start', 'stop', 'vad_start', 'vad_end', 'transcript_final', 'tick', 'reply_lines', 'poll_lines', 'speak_end', 'error'];
  let known = true;
  for (const p of PHASES) for (const e of all) {
    const out = step({ ...initial(), phase: p, speaking: p === 'speaking' }, { type: e, text: 'abc', at: T0, lines: [{ say: 'x' }], message: 'm' });
    if (!PHASES.includes(out.state.phase)) known = false;
  }
  check('every phase x event pair ends in a known phase', known);

  // manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
  check('manifest: start_url and scope are relative', manifest.start_url === './' && manifest.scope === './' && manifest.display === 'standalone');
  check('manifest: name is taskmote', manifest.name === 'taskmote' && manifest.short_name === 'taskmote');
  const srcs = (manifest.icons || []).map(i => i.src);
  check('manifest: icons are relative and exist', srcs.length >= 2 && srcs.every(s => !/^(\/|[a-z]+:)/i.test(s) && fs.existsSync(path.join(PUB, s))), srcs.join());
  check('manifest: has 192 and 512 png icons', ['192x192', '512x512'].every(sz => manifest.icons.some(i => i.sizes === sz && i.type === 'image/png')));
  check('manifest: no OpenMausBot brand strings', !/maus|openmaus|ogb/i.test(JSON.stringify(manifest)));
  const icons = fs.readdirSync(path.join(PUB, 'icons'));
  check('icons: our four files, no OMB names', ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].every(f => icons.includes(f)) && !icons.some(f => /^app-icon/.test(f)));
  const png = fs.readFileSync(path.join(PUB, 'icons', 'icon-192.png'));
  check('icon-192.png is a 192x192 png', png.slice(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 192 && png.readUInt32BE(20) === 192);

  // service worker
  const sw = path.join(PUB, 'sw.js');
  const swText = fs.existsSync(sw) ? fs.readFileSync(sw, 'utf8') : '';
  check('sw.js exists with install/activate/fetch', /skipWaiting/.test(swText) && /clients\.claim/.test(swText) && /'fetch'/.test(swText));
  check('sw.js never caches', !/caches\./.test(swText) && /\/api/.test(swText));

  // icon generator is deterministic and matches the committed files
  const { build } = require(path.join(APP, 'tools', 'make-icons.js'));
  const hash = b => Object.entries(b).map(([k, v]) => k + ':' + crypto.createHash('sha256').update(v).digest('hex')).join('|');
  const a = build(), b = build();
  check('make-icons output is deterministic', hash(a) === hash(b));
  check('committed icons match the generator', Object.entries(a).every(([k, v]) => (k.endsWith('.svg') ? Buffer.from(fs.readFileSync(path.join(PUB, 'icons', k), 'utf8').replace(/\r\n/g, '\n')) : fs.readFileSync(path.join(PUB, 'icons', k))).equals(v)));

  // source hygiene
  const dir = path.join(APP, 'web', 'src', 'areas', 'voice');
  const src = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : src.push(path.join(d, f.name)); })(dir);
  const text = src.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  check('voice sources: no push-to-talk, no cloud speech providers', !/pushToTalk|push-to-talk|fish|ogb\b|electron/i.test(text.replace(/\/\/.*$/gm, '')));
  check('voice sources: derived files carry the Apache header', ['lib/vad.ts', 'components/CallView.tsx'].every(f => fs.readFileSync(path.join(dir, f), 'utf8').startsWith('// Copyright 2026 Milind Soni and OpenMausBot contributors')));
  const prov = fs.readFileSync(path.join(APP, 'provenance', 'voice-pwa.md'), 'utf8');
  check('provenance lists the derived files', ['web/src/areas/voice/lib/vad.ts', 'web/src/areas/voice/components/CallView.tsx'].every(f => prov.includes('modules/app-ui/' + f)));

  const bad = results.filter(x => !x).length;
  console.log(`${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
