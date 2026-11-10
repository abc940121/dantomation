#!/usr/bin/env node
'use strict';
// chat-endpoint suite: a rooms member with engine "chat-endpoint" against a fake OpenAI-style
// server on 127.0.0.1. Covers session id, sees/context, journal_text, never-lead, the secret/PII
// screen, fail closed, owner-speech abort and floor, voice reservation, token hygiene.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rooms = { api: require('../../../lib/modules').registry({ modules: { rooms: true } }).api('rooms') }; // modules reach each other through the registry, not by path
const { createEngine } = rooms.api;
const mod = require('../index');
const { makeDeliver, targetUrl, busyLines } = require('../endpoint');
const screen = require('../screen');

let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && info !== undefined ? '  -> ' + JSON.stringify(info).slice(0, 300) : ''}`); };
const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (f, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(10); return f(); };

const TOKEN = 'tok-' + 'Zq81xKd0pLw3Vn7R';
const PHONE = '+1 415 555 0132', EMAIL = 'jane.doe@example.org', CARD = '4111 1111 1111 1111';
const AWS_KEY = 'sk-' + 'ant-abcdefghijklmnop';

function mem() {
  const recs = []; let n = 0;
  return { append: r => { const x = { id: 'm' + (++n) + '-' + 'ab12cd34', ts: new Date().toISOString(), ...r }; recs.push(x); return x; }, all: () => recs.slice() };
}

// fake endpoint: behaviour is swapped per test
function fake() {
  const reqs = [];
  let behave = () => ({ reply_text: 'ok' });
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', async () => {
      let json = null; try { json = JSON.parse(b); } catch { /* */ }
      reqs.push({ url: req.url, headers: req.headers, body: json, raw: b });
      const out = await behave(json, req, res);
      if (out === 'hang') return;
      if (out && out.status) { res.writeHead(out.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out.body || {})); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ reqs, port: srv.address().port, set: f => { behave = f; }, close: () => { srv.closeAllConnections(); srv.close(); } })));
}

(async () => {
  const fk = await fake();
  const URL0 = `http://127.0.0.1:${fk.port}`;
  const logs = [];
  const origLog = console.log; // tokens must never reach any output we produce below
  let pending = [];
  const mkCtx = (settings = {}, store = mem(), events = []) => ({
    settings: { allowed_hosts: [], timeout_s: 20, max_reply_chars: 4000, unavailable_text: '', pii_log_path: '', ...settings },
    secret: k => { if (k !== 'tokens') throw new Error('undeclared secret'); return JSON.stringify({ 'example-token': TOKEN }); },
    state: store, emit: (n, d) => { events.push({ n, d }); return Promise.resolve(); },
    api: () => rooms.api,
  });
  const member = (over = {}, ep = {}) => ({ id: 'ex', name: 'Example', engine: 'chat-endpoint', voice: 'v-ex', endpoint: { url: URL0, token_secret: 'example-token', mode: 'live', ...ep }, ...over });
  const RM = (mm = member(), extra = {}) => ({ dev: { lead: 'ann', window: 30, members: [{ id: 'ann', name: 'Ann', voice: 'v-ann' }, { id: 'bob', name: 'Bob', voice: 'v-bob' }, mm], ...extra } });
  // the engine plus the real deliverer; non-engine members answer with a fixed line
  function setup(mm, opts = {}) {
    const store = mem(), events = [], ctx = mkCtx(opts.settings, store, events);
    const dl = makeDeliver(ctx, opts.deps);
    const eng = createEngine({ rooms: RM(mm, opts.room), store, now: opts.now || Date.now,
      deliver: args => (args.member.engine ? dl(args) : Promise.resolve(typeof (opts.others || {})[args.member.id] === 'function' ? opts.others[args.member.id]() : ((opts.others || {})[args.member.id] || ''))) });
    return { eng, store, events, ctx, dl };
  }
  const sent = () => fk.reqs[fk.reqs.length - 1];

  // ---- manifest
  check('manifest: depends on rooms, provides the engine, one secret', mod.dependsOn.join() === 'rooms' && mod.provides.engines[0].id === 'chat-endpoint' && mod.settings.tokens.type === 'secret');
  {
    let unreg = null, calls = 0;
    const real = rooms.api.registerDeliverer;
    const r = mod.jobs[0].start({ ...mkCtx(), api: d => ({ registerDeliverer: (n, f) => { calls++; check('job: registers under the engine name with a function', n === 'chat-endpoint' && typeof f === 'function' && d === 'rooms'); return real(n, f); } }) });
    unreg = r;
    check('job: start returns the unregister function', calls === 1 && typeof unreg === 'function'); unreg();
  }

  // ---- url policy
  check('url: loopback ok, path completed', targetUrl({ url: 'http://127.0.0.1:9' }, []) === 'http://127.0.0.1:9/v1/chat/completions');
  check('url: an explicit chat path is kept', targetUrl({ url: 'http://localhost:9/v1/chat/completions' }, []) === 'http://localhost:9/v1/chat/completions');
  check('url: a non-loopback host is refused unless listed', targetUrl({ url: 'https://api.example.test/x' }, []) === null && targetUrl({ url: 'https://api.example.test' }, ['api.example.test']) !== null);
  check('url: other schemes and embedded credentials refused', targetUrl({ url: 'file:///x' }, []) === null && targetUrl({ url: 'http://u:p@127.0.0.1:9' }, []) === null);

  // ---- session id, headers, member_id, body shape
  {
    const t = setup(member({}, { member_id: 'example-bot' }));
    fk.set(() => ({ reply_text: 'hello back' }));
    t.eng.say('dev', 'hi @Example');
    await waitFor(() => fk.reqs.length === 1); await sleep(50);
    const q = sent();
    check('session id is <prefix><roomId> (default prefix)', q.body.session_id === 'taskmote:dev' && q.body.user === 'taskmote:dev' && q.headers['x-session-id'] === 'taskmote:dev', q.body);
    check('member_id is sent', q.body.member_id === 'example-bot');
    check('bearer token is sent as a header only', q.headers.authorization === 'Bearer ' + TOKEN && !q.raw.includes(TOKEN));
    check('posts to /v1/chat/completions', q.url === '/v1/chat/completions');
    check('reply is posted by the member', t.store.all().some(r => r.speaker === 'ex' && r.text === ''), t.store.all().map(r => r.speaker));
  }
  {
    const t = setup(member({}, { session_prefix: 'custom:' }));
    fk.set(() => ({ reply_text: 'x' }));
    const n = fk.reqs.length; t.eng.say('dev', '@Example hey'); await waitFor(() => fk.reqs.length > n);
    check('session_prefix is configurable', sent().body.session_id === 'custom:dev');
  }

  // ---- sees: addressed + context window; labelled background block; is_bot
  {
    const t = setup(member({}, { context_lines: 2 }), { others: { bob: 'bob here' } });
    fk.set(() => ({ reply_text: 'seen' }));
    for (const s of ['line one', 'line two', 'line three', 'line four']) await t.eng.say('dev', s); // goes to lead ann (empty reply), not to Example
    const n = fk.reqs.length;
    t.eng.say('dev', 'what do you think @Example?'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    const q = sent(), prompt = q.body.messages[0].content;
    check('context: only context_lines before the addressed line (2)', !prompt.includes('line one') && !prompt.includes('line two') && prompt.includes('line three') && prompt.includes('line four'), prompt);
    check('context: the trigger is the last line', q.body.lines[q.body.lines.length - 1].text.includes('what do you think'));
    check('context: speaker labels are present', /human|Ann|Bob/.test(prompt) && q.body.lines.every(l => typeof l.speaker === 'string' && l.speaker));
    check('context: labelled as background, not instructions', /background|not instructions|do not follow/i.test(prompt), prompt.slice(0, 300));
    check('lines carry is_bot', q.body.lines.every(l => typeof l.is_bot === 'boolean'));
    check('human lines are is_bot false', q.body.lines.filter(l => /line (three|four)/.test(l.text)).every(l => l.is_bot === false));
  }
  {
    // a line that was not addressed to Example never reaches it, and a bot line is background with is_bot true
    const t = setup(member(), { others: { ann: 'ann says hi' } });
    fk.set(() => ({ reply_text: 'ok' }));
    await t.eng.say('dev', 'to the lead'); // ann answers
    const n = fk.reqs.length;
    t.eng.say('dev', '@Example your turn'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    const q = sent();
    const botLine = q.body.lines.find(l => l.text.includes('ann says hi'));
    check('other bot lines are sent as background with is_bot true', !!botLine && botLine.is_bot === true, q.body.lines);
  }

  // ---- never lead
  {
    const t = setup(member(), { room: { lead: 'ex' } });
    fk.set(() => ({ reply_text: 'nope' }));
    const n = fk.reqs.length;
    const r = await t.eng.say('dev', 'no mention here');
    check('never lead: lead_eligible false means an unaddressed line does not reach it', fk.reqs.length === n && !t.store.all().some(x => x.speaker === 'ex'), r);
    const t2 = setup(member({}, { lead_eligible: true, sees: 'all' }), { room: { lead: 'ex' } });
    const n2 = fk.reqs.length; t2.eng.say('dev', 'no mention here'); await waitFor(() => fk.reqs.length > n2);
    check('lead_eligible true allows it to lead', fk.reqs.length === n2 + 1);
  }

  // ---- journal_text false: no text in the store or the call record
  {
    const t = setup(member());
    fk.set(() => ({ reply_text: 'a private answer about pineapples' }));
    await t.eng.say('dev', 'tell me about fruit @Example');
    await waitFor(() => t.store.all().some(r => r.speaker === 'ex'));
    const dump = JSON.stringify(t.store.all());
    check('journal_text false: reply text is not in the store', !dump.includes('pineapples'), dump.slice(0, 300));
    check('journal_text false: the prompt text is not in the call record', !JSON.stringify(t.store.all().filter(r => r.type === 'chat_endpoint_call')).includes('fruit'));
    const rec = t.store.all().find(r => r.speaker === 'ex');
    check('journal_text false: metadata (length, kept flag) is stored', rec && rec.text === '' && rec.text_kept === false && rec.text_len === 'a private answer about pineapples'.length, rec);
    check('journal_text false: the live transcript still shows the text this run', t.eng.messages('dev').some(m => m.text.includes('pineapples')));
    const call = t.store.all().find(r => r.type === 'chat_endpoint_call');
    check('call record has lengths and timing', call && call.ok === true && Number.isInteger(call.prompt_len) && Number.isInteger(call.reply_len) && typeof call.ms === 'number', call);
    const t2 = setup(member({}, { journal_text: true }));
    await t2.eng.say('dev', 'tell me @Example'); await waitFor(() => t2.store.all().some(r => r.speaker === 'ex'));
    check('journal_text true keeps the text', t2.store.all().some(r => r.speaker === 'ex' && r.text.includes('pineapples')));
  }

  // ---- originals are never replaced by a summary
  {
    const t = setup(member());
    fk.set(() => ({ reply_text: 'ok' }));
    await t.eng.say('dev', 'original words here');
    t.eng.setSummary('dev', 'SUMMARY MARKER');
    const n = fk.reqs.length; t.eng.say('dev', '@Example please'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    const body = JSON.stringify(sent().body);
    check('summary never stands in for the original lines', !body.includes('SUMMARY MARKER') && body.includes('original words here'));
  }

  // ---- secret / PII screen: unit
  {
    for (const [k, txt] of [['email', 'mail me at ' + EMAIL], ['phone', 'call ' + PHONE], ['card', 'card ' + CARD], ['password', 'password: hunter2hunter2'], ['secret', 'key ' + AWS_KEY], ['private_key', '-----BEGIN ' + 'PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----']]) {
      const d = screen.dropLines('ok line\n' + txt + '\nlast');
      check(`screen out: ${k} line is dropped whole`, d.hits[k] >= 1 && d.text === 'ok line\nlast', d);
    }
    check('screen out: plain text, ids and times are untouched', screen.dropLines('see [id=m12-ab12cd34] at 2026-11-09 12:30:45 room 7').text.includes('[id=m12-ab12cd34]') && !Object.keys(screen.dropLines('v1.2.3 build 20261109 ok').hits).length);
    const r = screen.redact(`mail ${EMAIL}, ${PHONE}, ${CARD}, password is abc12345, ${AWS_KEY}`);
    check('screen in: each kind is redacted in place', !/jane|555|4111|abc12345|abcdefghijklmnop/.test(r.text) && r.hits.email && r.hits.phone && r.hits.card && r.hits.password && r.hits.secret, r);
    check('screen: Luhn rejects a random 16 digits as a card', !screen.redact('ref 1234 5678 9012 3456').hits.card);
  }

  // ---- outgoing screen: the line is not sent, nothing marked, event has counts only
  {
    const logp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-pii-')), 'sub', 'pii.jsonl');
    const t = setup(member(), { settings: { pii_log_path: logp } });
    fk.set(() => ({ reply_text: 'fine' }));
    await t.eng.say('dev', 'earlier ' + EMAIL + ' leak');
    await t.eng.say('dev', 'harmless context');
    const n = fk.reqs.length;
    t.eng.say('dev', '@Example hello'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    const body = sent().raw;
    check('screen out: the matching line is not sent at all', !body.includes('jane.doe') && !body.includes('earlier') && body.includes('harmless context'));
    check('screen out: no [withheld] marker', !/withheld/i.test(body.replace(/withheld_lines/g, '')));
    const ev = t.events.filter(e => e.n === 'chat-endpoint.pii');
    check('screen out: an event with count and kind only', ev.length >= 1 && ev[0].d.direction === 'out' && ev[0].d.kind === 'email' && ev[0].d.count === 1 && Object.keys(ev[0].d).sort().join() === 'count,direction,kind', ev);
    const lines = fs.readFileSync(logp, 'utf8').trim().split('\n').map(JSON.parse);
    check('pii_log_path: parent dir created, one json line {ts,direction,kind,count}', lines.length >= 1 && Object.keys(lines[0]).sort().join() === 'count,direction,kind,ts' && lines[0].direction === 'out' && !isNaN(Date.parse(lines[0].ts)), lines);
    check('pii_log_path: no text in the file', !fs.readFileSync(logp, 'utf8').includes('jane'));
    // a trigger that is itself withheld sends nothing
    const n2 = fk.reqs.length;
    await t.eng.say('dev', '@Example my card is ' + CARD);
    await sleep(80);
    check('screen out: a withheld trigger sends no request and posts nothing', fk.reqs.length === n2 );
    // a failing log path must not break the turn
    const bad = setup(member(), { settings: { pii_log_path: path.join(os.tmpdir(), 'x\0bad', 'p.jsonl') } });
    await bad.eng.say('dev', 'a ' + EMAIL + ' b');
    const nb = fk.reqs.length; bad.eng.say('dev', '@Example go'); await waitFor(() => fk.reqs.length > nb); await sleep(30);
    check('pii_log_path: a failed write does not break the turn', fk.reqs.length === nb + 1 && bad.store.all().some(r => r.speaker === 'ex'));
  }

  // ---- incoming screen
  {
    const logp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-pii-')), 'in.jsonl');
    const t = setup(member({}, { }), { settings: { pii_log_path: logp } });
    fk.set(() => ({ reply_text: `write to ${EMAIL} or ${PHONE}; key ${AWS_KEY}` }));
    await t.eng.say('dev', '@Example contact?'); await waitFor(() => t.store.all().some(r => r.speaker === 'ex'));
    const txt = t.eng.messages('dev').find(m => m.speaker === 'ex').text;
    check('screen in: reply is redacted before it is posted', !/jane|555|abcdefghijklmnop/.test(txt), txt);
    const lines = fs.readFileSync(logp, 'utf8').trim().split('\n').map(JSON.parse);
    check('screen in: logged by direction in with kinds and counts', lines.every(l => l.direction === 'in') && lines.some(l => l.kind === 'email'), lines);
  }

  // ---- reply shapes, voice, emotion, no_reply, refusal
  {
    const t = setup(member());
    fk.set(() => ({ choices: [{ message: { content: 'plain openai shape' } }] }));
    await t.eng.say('dev', '@Example a'); await waitFor(() => t.eng.messages('dev').some(m => m.speaker === 'ex'));
    check('reply: plain choices[0].message.content is accepted', t.eng.messages('dev').some(m => m.text === 'plain openai shape'));
    const t2 = setup(member());
    fk.set(() => ({ reply_text: 'daily limit reached, try again tomorrow' }));
    await t2.eng.say('dev', '@Example b'); await waitFor(() => t2.eng.messages('dev').some(m => m.speaker === 'ex'));
    check('reply: a refusal is just normal text', t2.eng.messages('dev').some(m => m.text.includes('daily limit')) && !t2.eng.messages('dev').some(m => m.speaker === 'system'));
    const t3 = setup(member({}, { journal_text: true }));
    fk.set(() => ({ reply_text: 'with cues', voice: 'v-ex', emotion: 'happy' }));
    await t3.eng.say('dev', '@Example c'); await waitFor(() => t3.eng.messages('dev').some(m => m.speaker === 'ex'));
    const m3 = t3.eng.messages('dev').find(m => m.speaker === 'ex');
    check('reply: emotion is passed along as a cue on the message', m3.emotion === 'happy', m3);
    check('reply: voice equal to the configured voice is kept', t3.store.all().find(r => r.speaker === 'ex').voice === 'v-ex');
    const t4 = setup(member());
    fk.set(() => ({ reply_text: 'wrong voice', voice: 'v-ann', emotion: 'bad emotion!!<x>' }));
    await t4.eng.say('dev', '@Example d'); await waitFor(() => t4.eng.messages('dev').some(m => m.speaker === 'ex'));
    const r4 = t4.store.all().find(r => r.speaker === 'ex');
    check('reply: a voice that is not the configured one is ignored', r4 && !r4.voice, r4);
    check('reply: an invalid emotion is dropped', r4 && !r4.emotion);
    const ints = [[0.4, 0.4], [7, 1], [-3, 0], ['0.5', undefined], [null, undefined]];
    for (const [inp, want] of ints) {
      const ti = setup(member({}, { journal_text: true }));
      fk.set(() => ({ reply_text: 'tone', emotion: 'calm', intensity: inp }));
      await ti.eng.say('dev', '@Example i'); await waitFor(() => ti.eng.messages('dev').some(m => m.speaker === 'ex'));
      check('reply: intensity ' + JSON.stringify(inp) + ' -> ' + want, ti.store.all().find(r => r.speaker === 'ex').intensity === want, ti.store.all().find(r => r.speaker === 'ex'));
    }
    const tn = setup(member({}, { journal_text: true }));
    fk.set(() => ({ reply_text: 'tone', emotion: 'bogus!', intensity: 0.5 }));
    await tn.eng.say('dev', '@Example n'); await waitFor(() => tn.eng.messages('dev').some(m => m.speaker === 'ex'));
    check('reply: intensity is dropped when emotion is dropped', !('intensity' in tn.store.all().find(r => r.speaker === 'ex')));
    const t5 = setup(member());
    fk.set(() => ({ no_reply: true }));
    await t5.eng.say('dev', '@Example e'); await sleep(60);
    check('no_reply posts nothing', !t5.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system'));
    for (const [label, resp] of [['http 503', { status: 503, body: { error: 'busy' } }], ['http 429', { status: 429, body: {} }], ['busy:true', { busy: true }]]) {
      const tb = setup(member());
      fk.set(() => resp);
      await tb.eng.say('dev', '@Example b'); await sleep(60);
      check('busy (' + label + ') is a pass: no reply, no unavailable line', !tb.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system'));
    }
    const call = (m, skipped, ts) => ({ type: 'chat_endpoint_call', member: m, ms: 5, ok: true, ts, ...(skipped ? { skipped } : {}) });
    check('status: 2 busy calls stay quiet', busyLines([call('h', 'busy', 't1'), call('h', 'timeout', 't2')]).length === 0);
    const bl = busyLines([call('h', null, 't0'), call('h', 'busy', 't1'), call('h', 'timeout', 't2'), call('h', 'busy', 't3'), { type: 'chat_endpoint_call', member: 'h', ok: true, skipped: 'hop_too_deep' }]);
    check('status: 3 busy/timeout calls in a row show one line with the start time', bl.length === 1 && /h has not answered its last 3 calls/.test(bl[0]) && bl[0].includes('t1'), bl);
    check('status: one answered call clears the line', busyLines([call('h', 'busy', 't1'), call('h', 'busy', 't2'), call('h', 'busy', 't3'), call('h', null, 't4')]).length === 0);
  }

  // ---- fail closed
  {
    const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r)); const dp = dead.address().port; await new Promise(r => dead.close(r));
    const t = setup(member({}, { url: `http://127.0.0.1:${dp}` }));
    await t.eng.say('dev', '@Example anyone?'); await waitFor(() => t.store.all().some(r => r.speaker === 'system'));
    const sys = t.store.all().filter(r => r.speaker === 'system');
    check('down: exactly one short unavailable system line', sys.length === 1 && /unavailable/i.test(sys[0].text) && sys[0].text.length < 120, sys);
    check('down: no reply from the bot and no token in the line', !t.store.all().some(r => r.speaker === 'ex') && !JSON.stringify(t.store.all()).includes(TOKEN));
    fk.set(() => ({ status: 500, body: { error: 'boom ' + TOKEN } }));
    const t2 = setup(member());
    await t2.eng.say('dev', '@Example hi'); await waitFor(() => t2.store.all().some(r => r.speaker === 'system'));
    check('http 500: unavailable line, no leak of the server body or token', t2.store.all().filter(r => r.speaker === 'system').length === 1 && !JSON.stringify(t2.store.all()).includes(TOKEN) && !JSON.stringify(t2.store.all()).includes('boom'));
    fk.set(() => ({ status: 200, body: { unexpected: true } }));
    const t3 = setup(member());
    await t3.eng.say('dev', '@Example hi'); await waitFor(() => t3.store.all().some(r => r.speaker === 'system'));
    check('malformed reply: unavailable', t3.store.all().some(r => r.speaker === 'system'));
    const t4 = setup(member({}, { url: 'https://api.example.test/v1' }));
    const n = fk.reqs.length;
    await t4.eng.say('dev', '@Example hi'); await waitFor(() => t4.store.all().some(r => r.speaker === 'system'));
    check('unlisted host: refused before any request', t4.store.all().some(r => r.speaker === 'system') && fk.reqs.length === n);
    const t5 = setup(member({}, { token_secret: 'missing' }));
    await t5.eng.say('dev', '@Example hi'); await waitFor(() => t5.store.all().some(r => r.speaker === 'system'));
    check('unknown token_secret: unavailable, no request', t5.store.all().some(r => r.speaker === 'system') && fk.reqs.length === n);
    // redirect is not followed
    fk.set((b, req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/x' }); res.end(); return 'hang'; });
    const t6 = setup(member());
    await t6.eng.say('dev', '@Example hi'); await waitFor(() => t6.store.all().some(r => r.speaker === 'system'));
    check('a redirect is not followed (fail closed)', t6.store.all().some(r => r.speaker === 'system'));
  }
  // ---- timeout
  {
    fk.set(() => 'hang');
    const t = setup(member({}, { timeout_s: 0.15 }));
    const n = fk.reqs.length;
    await t.eng.say('dev', '@Example slow'); await waitFor(() => fk.reqs.length > n); await sleep(400);
    check('timeout: posts nothing (no reply, no system line)', !t.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system'));
    check('timeout: default is 20 s', mod.settings.timeout_s.default === 20);
  }

  // ---- @everyone throttle
  {
    fk.set(() => ({ reply_text: 'r' }));
    let clock = 1_000_000;
    const t = setup(member(), { now: () => clock, deps: { now: () => clock } });
    const n = fk.reqs.length;
    await t.eng.say('dev', 'hello @everyone'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    check('everyone: reaches the bot the first time', fk.reqs.length === n + 1);
    clock += 5000;
    await t.eng.say('dev', 'again @everyone'); await sleep(60);
    check('everyone: dropped when under 30 s after the last one', fk.reqs.length === n + 1);
    clock += 31000;
    await t.eng.say('dev', 'later @everyone'); await waitFor(() => fk.reqs.length > n + 1); await sleep(30);
    check('everyone: reaches the bot again after the gap', fk.reqs.length === n + 2);
    const t2 = setup(member({}, { everyone_min_gap_s: 0 }), { now: () => clock, deps: { now: () => clock } });
    const n2 = fk.reqs.length;
    await t2.eng.say('dev', 'a @everyone'); await waitFor(() => fk.reqs.length > n2); await sleep(30);
    await t2.eng.say('dev', 'b @everyone'); await waitFor(() => fk.reqs.length > n2 + 1); await sleep(30);
    check('everyone: the gap is configurable', fk.reqs.length === n2 + 2);
    const n3 = fk.reqs.length;
    await t.eng.say('dev', '@Example direct'); await waitFor(() => fk.reqs.length > n3);
    check('everyone: an @mention is never throttled', fk.reqs.length === n3 + 1);
  }

  // ---- one hop: a bot reply never wakes the chat-endpoint bot again
  {
    fk.set(() => ({ reply_text: 'ok' }));
    const t = setup(member(), { others: { ann: 'hey @Example look' } });
    const n = fk.reqs.length;
    await t.eng.say('dev', 'to ann'); await sleep(100);
    const hop = fk.reqs.length - n;
    const t2 = setup(member(), { others: { ann: 'hey @Example look' } });
    check('hop: a bot may wake it once (hop 1), and its reply wakes nobody further', hop <= 1 && t2 !== null);
    const lastReq = fk.reqs[fk.reqs.length - 1];
    if (hop === 1) check('hop: the hop turn is marked via hop', lastReq.body.via === 'hop', lastReq.body.via);
    const exLines = t.store.all().filter(r => r.speaker === 'ex').length;
    await sleep(50);
    check('hop: no chain beyond one hop', fk.reqs.length - n <= 1 && exLines <= 1);
  }

  // ---- owner speech: abort and flush; floor hold
  {
    const t = setup(member());
    fk.set(() => 'hang');
    const n = fk.reqs.length;
    const p = t.eng.say('dev', '@Example long one');
    await waitFor(() => fk.reqs.length > n);
    fk.set(() => ({ reply_text: 'fresh' }));
    const p2 = t.eng.say('dev', 'actually never mind @Bob');
    await waitFor(() => fk.reqs.some(r => r.body && r.body.abort === true));
    const ab = fk.reqs.find(r => r.body && r.body.abort === true);
    check('owner speech: the endpoint gets {abort:true} for the session', ab && ab.body.session_id === 'taskmote:dev' && ab.headers.authorization === 'Bearer ' + TOKEN, ab && ab.body);
    await p; await p2; await sleep(30);
    check('owner speech: the aborted reply is cancelled locally (nothing posted by the bot)', !t.store.all().some(r => r.speaker === 'ex'));
  }
  {
    let gate; const gated = new Promise(r => { gate = r; });
    const t = setup(member(), { others: { ann: () => gated.then(() => 'ann: @Example over to you') } });
    fk.set(() => ({ reply_text: 'after floor' }));
    const n = fk.reqs.length;
    t.eng.say('dev', 'start'); await sleep(30);
    t.eng.holdFloor('dev', true, 60000); gate(); // the owner starts speaking while a bot turn is finishing
    await sleep(200);
    check('floor: while the owner speaks, no bot takes the floor (no request)', fk.reqs.length === n);
    t.eng.holdFloor('dev', false);
    await waitFor(() => fk.reqs.length > n);
    check('floor: released, the turn proceeds', fk.reqs.length === n + 1);
    const t2 = setup(member());
    t2.eng.holdFloor('dev', true, 60000);
    const n2 = fk.reqs.length;
    t2.eng.say('dev', '@Example speak');
    await sleep(60);
    await t2.eng.say('dev', 'new human line');
  }

  // ---- voice reservation (rooms side; voice-chat has no per-bot voice hook)
  {
    const eng = createEngine({ rooms: RM(member({}), {}), store: mem(), deliver: async () => '' });
    check('voice: canUseVoice true for the owner, false for others', eng.canUseVoice('v-ex', 'ex', 'dev') === true && eng.canUseVoice('v-ex', 'ann', 'dev') === false && eng.canUseVoice('v-ann', 'ann', 'dev') === true && eng.canUseVoice('v-ex', 'ex', 'other') === false);
    const clash = RM(member({ voice: 'v-ann' }));
    const e2 = createEngine({ rooms: clash, store: mem(), deliver: async () => '' });
    const ann = e2.rooms()[0].members.find(m => m.id === 'ann');
    check('voice: a member that reuses an engine member\'s voice loses it, with a problem noted', !ann.voice && e2.problems.some(p => /reserved/.test(p)), e2.problems);
    const spoken = createEngine({ rooms: RM(member({}), {}), store: mem(), deliver: async () => '' });
    check('voice: voiceFor the engine member is its own voice', spoken.voiceFor('dev', { speaker: 'ex' }) === 'v-ex' && spoken.voiceFor('dev', { speaker: 'ann' }) === 'v-ann');
  }

  // ---- token hygiene
  {
    fk.set(() => ({ status: 401, body: { error: 'bad token ' + TOKEN } }));
    const t = setup(member());
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    await t.eng.say('dev', '@Example hi'); await waitFor(() => t.store.all().some(r => r.speaker === 'system'));
    const all = JSON.stringify([t.store.all(), t.events, t.eng.messages('dev'), out]);
    check('token: never in the store, events, messages or errors', !all.includes(TOKEN));
    check('token: never in the request body', fk.reqs.every(r => !r.raw.includes(TOKEN)));
    void orig;
  }

  // ---- shadow mode: same call, reply discarded, metadata-only event
  {
    const shadowMember = ep => { const m = member({}, ep); if (ep && ep.mode === undefined) delete m.endpoint.mode; return m; };
    const evs = t => t.store.all().filter(r => r.type === 'chat_endpoint_shadow');
    const quiet = t => !t.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system') && !t.events.some(e => /voice|tts/i.test(e.n));
    const run = async (name, behave, ep, outcome, over = {}) => {
      fk.set(behave);
      const t = setup(shadowMember(ep));
      const n = fk.reqs.length;
      await t.eng.say('dev', '@Example hello ' + name); await waitFor(() => evs(t).length > 0, 3000); await sleep(50);
      const ev = evs(t)[0] || {};
      check(`shadow ${name}: posts nothing, the door was called, outcome ${outcome}`, quiet(t) && fk.reqs.length === n + 1 && ev.outcome === outcome && ev.mode === 'shadow' && ev.bot === 'ex' && ev.room === 'dev', ev);
      check(`shadow ${name}: event has only metadata (no text field)`, Object.keys(ev).sort().join() === 'bot,id,latency_ms,mode,outcome,reply_len,room,ts,type,would_reply' && !JSON.stringify(ev).includes('SECRETREPLY') && typeof ev.latency_ms === 'number' && !isNaN(Date.parse(ev.ts)), ev);
      return { t, ev };
    };
    const ok = await run('ok', () => ({ reply_text: 'SECRETREPLY' }), { mode: 'shadow' }, 'ok');
    check('shadow ok: would_reply true, reply_len set', ok.ev.would_reply === true && ok.ev.reply_len === 11);
    await run('journal_text true', () => ({ reply_text: 'SECRETREPLY' }), { mode: 'shadow', journal_text: true }, 'ok');
    const nr = await run('no_reply', () => ({ no_reply: true }), { mode: 'shadow' }, 'no_reply');
    check('shadow no_reply: would_reply false', nr.ev.would_reply === false);
    await run('timeout', () => 'hang', { mode: 'shadow', timeout_s: 0.15 }, 'timeout');
    await run('error', () => ({ status: 500, body: {} }), { mode: 'shadow' }, 'error');
    await run('missing mode is shadow', () => ({ reply_text: 'SECRETREPLY' }), {}, 'ok');
    await run('unknown mode is shadow', () => ({ reply_text: 'SECRETREPLY' }), { mode: 'loud' }, 'ok');
    // the trigger itself holds a secret: nothing is sent
    fk.set(() => ({ reply_text: 'x' }));
    const tp = setup(shadowMember({ mode: 'shadow' })); const np = fk.reqs.length;
    await tp.eng.say('dev', '@Example my password: hunter2hunter2'); await waitFor(() => evs(tp).length > 0);
    check('shadow pii_dropped: nothing sent, event outcome pii_dropped', fk.reqs.length === np && evs(tp)[0].outcome === 'pii_dropped' && quiet(tp));
    // not counted as having replied: @everyone round logic is unaffected and the reply never reaches the room
    fk.set(() => ({ reply_text: 'SECRETREPLY' }));
    const te = setup(shadowMember({ mode: 'shadow' })); await te.eng.say('dev', '@everyone hi'); await waitFor(() => evs(te).length > 0);
    check('shadow @everyone: still posts nothing', quiet(te) && !JSON.stringify(te.eng.messages('dev')).includes('SECRETREPLY'));
    // live is unchanged
    fk.set(() => ({ reply_text: 'live reply' }));
    const tl = setup(member({}, { mode: 'live' })); await tl.eng.say('dev', '@Example hi live'); await waitFor(() => tl.store.all().some(r => r.speaker === 'ex'));
    check('live: still posts the reply and writes no shadow event', tl.store.all().some(r => r.speaker === 'ex') && evs(tl).length === 0);
  }

  // ---- top-level body fields (chat_id, room_id, from, text, mentions, is_host, prev_turns, hop)
  {
    fk.set(() => ({ reply_text: 'fine' }));
    const t = setup(member(), { others: { bob: 'hey @Example look at this' } });
    await t.eng.say('dev', 'plain earlier line');
    await t.eng.say('dev', 'secret one: ' + AWS_KEY + ' and mail ' + EMAIL);
    const n = fk.reqs.length;
    await t.eng.say('dev', '@Example hello there'); await waitFor(() => fk.reqs.length > n);
    const b = sent().body;
    check('body: every top-level field present', ['messages', 'session_id', 'chat_id', 'room_id', 'from', 'text', 'mentions', 'is_host', 'prev_turns', 'hop'].every(k => k in b), Object.keys(b));
    check('body: chat_id is the session id, room_id the room', b.chat_id === 'taskmote:dev' && b.chat_id === b.session_id && b.room_id === 'dev');
    check('body: human trigger is hop 0, host, from the human', b.hop === 0 && b.is_host === true && b.from.id === 'human' && b.from.is_bot === false && b.text === '@Example hello there');
    check('body: mentions list the addressed member ids', JSON.stringify(b.mentions) === JSON.stringify(['ex']), b.mentions);
    check('body: prev_turns are {id, from, text, hop}, oldest first, at most 6', Array.isArray(b.prev_turns) && b.prev_turns.length <= 6 && b.prev_turns.every(x => x.id && x.from && 'name' in x.from && 'is_bot' in x.from && typeof x.text === 'string' && x.hop === 0) && b.prev_turns[0].text === 'plain earlier line');
    check('body: no secret or PII in from.name, text or prev_turns', !JSON.stringify([b.from, b.text, b.prev_turns]).includes(AWS_KEY) && !JSON.stringify([b.from, b.text, b.prev_turns]).includes(EMAIL));
    // @everyone is reported as a mention
    const n2 = fk.reqs.length; await t.eng.say('dev', '@everyone ping'); await waitFor(() => fk.reqs.length > n2);
    const ev = fk.reqs.slice(n2).map(x => x.body).find(x => x.via === 'everyone');
    check('body: @everyone appears in mentions', !!ev && ev.mentions.includes('everyone'), ev && ev.mentions);
    // a bot line answering a human is hop 1 as a trigger; the member's own reply (a bot answering a bot) never goes back out
    const n3 = fk.reqs.length; await t.eng.say('dev', '@Bob please'); await waitFor(() => fk.reqs.length > n3);
    const hb = sent().body;
    check('body: a bot trigger is hop 1, not host, from a bot', hb.hop === 1 && hb.is_host === false && hb.from.is_bot === true && hb.from.id === 'bob' && /Example/.test(hb.text));
    await sleep(100);
    const n4 = fk.reqs.length; await t.eng.say('dev', '@Example once more'); await waitFor(() => fk.reqs.length > n4);
    const lb = sent().body;
    check('body: no hop >= 2 line in prev_turns or lines (a bot reply to a bot line is dropped)', lb.prev_turns.every(x => x.hop === 0 || x.hop === 1) && !lb.prev_turns.some(x => x.from.id === 'ex' && x.text === 'fine' && x.hop > 1) && lb.prev_turns.some(x => x.hop === 1), lb.prev_turns);
  }


  // ---- review fixes
  {
    // shadow never blocks the queue; at most 2 in-flight calls per bot, then skipped_busy
    fk.set(() => 'hang');
    const ts = setup(member({}, { mode: 'shadow', timeout_s: 1 }));
    const evs = () => ts.store.all().filter(r => r.type === 'chat_endpoint_shadow');
    const t0 = Date.now();
    const n = fk.reqs.length;
    await ts.eng.say('dev', '@Example block me?');
    check('shadow: the turn returns at once while the call is still in flight', Date.now() - t0 < 500 && evs().length === 0 && !ts.store.all().some(r => r.speaker === 'ex'), Date.now() - t0);
    await waitFor(() => fk.reqs.length > n);
    await waitFor(() => evs().length > 0, 3000);
    check('shadow: the background call keeps the timeout and records its outcome', evs()[0].outcome === 'timeout', evs());

    const calls = [], tev = [];
    const ctxS = mkCtx({ timeout_s: 0.3 }, { append: r => { tev.push(r); return r; }, all: () => tev });
    const dl = makeDeliver(ctxS, { fetch: (u, o) => new Promise((res, rej) => { calls.push(u); o.signal.addEventListener('abort', () => rej(new Error('aborted'))); }) });
    const args = (id = 'ex') => ({ room: 'dev', member: { ...member({ id }), name: 'Example' }, lines: [], mentions: [], trigger: null, via: 'mention' });
    const shadowArgs = id => { const a = args(id); a.member.endpoint = { ...a.member.endpoint, mode: 'shadow' }; return a; };
    const r1 = await dl(shadowArgs()), r2 = await dl(shadowArgs()), r3 = await dl(shadowArgs());
    check('shadow cap: the third call while two are in flight makes no request', r1 === '' && r2 === '' && r3 === '' && calls.length === 2, calls.length);
    const busy = tev.filter(r => r.outcome === 'skipped_busy');
    check('shadow cap: the skipped call is recorded as skipped_busy, metadata only', busy.length === 1 && busy[0].would_reply === false && busy[0].reply_len === 0 && busy[0].bot === 'ex', tev);
    await dl(shadowArgs('other-bot'));
    check('shadow cap: another bot has its own allowance', calls.length === 3);
    await waitFor(() => tev.filter(r => r.outcome === 'timeout').length === 3, 3000);
    await dl(shadowArgs());
    check('shadow cap: once calls finish the bot may call again', calls.length === 4);
    await waitFor(() => tev.filter(r => r.outcome === 'timeout').length === 4, 3000);
  }
  {
    // screen: any PEM block, one name helper
    const cert = '-----BEGIN ' + 'CERTIFICATE-----\nMIIBcertbodyline\n-----END CERTIFICATE-----';
    const d = screen.dropLines('before\n' + cert + '\nafter');
    check('screen: a whole non-key PEM block is dropped on send', d.text === 'before\nafter' && d.hits.private_key === 1, d);
    const d2 = screen.dropLines('keep\n-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\nmore');
    check('screen: an unterminated BEGIN drops everything to the end', d2.text === 'keep', d2);
    const rd = screen.redact('x ' + cert + ' y');
    check('screen: a PEM block is redacted whole on receive', !/certbody|BEGIN|END/.test(rd.text) && rd.hits.private_key === 1, rd);
    const rd2 = screen.redact('x -----BEGIN ' + 'DSA PARAMETERS-----\nAAAA tail without end');
    check('screen: an unterminated BEGIN is redacted to the end on receive', !/AAAA|tail|BEGIN/.test(rd2.text), rd2);
    const sn = screen.screenName('Bob ' + EMAIL + '\n' + 'x'.repeat(200));
    check('screen: screenName is one line, redacted, capped', !sn.text.includes(EMAIL) && !sn.text.includes('\n') && sn.text.length <= 80 && sn.hits.email === 1, sn);
  }
  {
    // every name in every field goes through the shared helper
    fk.set(() => ({ reply_text: 'fine' }));
    const BOBNAME = 'Bob ' + EMAIL, SELFNAME = 'Ex ' + PHONE;
    const room = { members: [{ id: 'ann', name: 'Ann', voice: 'v-ann' }, { id: 'bob', name: BOBNAME, voice: 'v-bob' }, member({ name: SELFNAME })] };
    const tn = setup(member({ name: SELFNAME }), { room, others: { bob: 'hey @ex look' } });
    const n = fk.reqs.length;
    await tn.eng.say('dev', '@bob please'); await waitFor(() => fk.reqs.length > n); await sleep(50);
    const q = sent();
    check('names: a bot name with PII appears nowhere in the request', q.body.from.id === 'bob' && !q.raw.includes(EMAIL) && !q.raw.includes('555 0132') && q.raw.includes('[email]'), q.body.from);
    check('names: from.name, lines[].speaker, prompt and prev_turns are all screened', !JSON.stringify([q.body.from, q.body.lines, q.body.messages, q.body.prev_turns]).includes('example.org'));
    const n2 = fk.reqs.length;
    await tn.eng.say('dev', '@ex again'); await waitFor(() => fk.reqs.length > n2); await sleep(50);
    check('names: the member\'s own name with PII is screened in the prompt', !sent().raw.includes('555 0132') && sent().raw.includes('[phone]'), sent().body.messages[0].content.slice(0, 200));
  }
  {
    // an echoed configured token drops the reply; the event carries only a count
    const OTHER = 'other-' + 'Qm44zzzzAAAA';
    for (const [name, echo] of [['this bot\'s token', 'here you go ' + TOKEN], ['any other configured token', 'psst ' + OTHER]]) {
      fk.set(() => ({ reply_text: echo }));
      const t = setup(member());
      t.ctx.secret = () => JSON.stringify({ 'example-token': TOKEN, other: OTHER });
      await t.eng.say('dev', '@Example say it');
      const ev = t.events.filter(e => e.n === 'chat-endpoint.token_echo');
      const all = JSON.stringify([t.store.all(), t.events, t.eng.messages('dev')]);
      check(`token echo (${name}): reply dropped, nothing posted by the bot`, !t.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system'), t.store.all());
      check(`token echo (${name}): one event with only a count, no text anywhere`, ev.length === 1 && JSON.stringify(ev[0].d) === '{"count":1}' && !all.includes(TOKEN) && !all.includes(OTHER), ev);
    }
    const tj = setup(member({}, { journal_text: true }));
    fk.set(() => ({ reply_text: 'safe ' + TOKEN }));
    await tj.eng.say('dev', '@Example say it');
    check('token echo: not on disk even with journal_text true', !JSON.stringify(tj.store.all()).includes(TOKEN) && !tj.store.all().some(r => r.speaker === 'ex'));
  }
  {
    // a body read that ignores the abort still counts as timed out
    const slow = (delay) => (u, o) => Promise.resolve({ status: 200, text: () => new Promise(r => setTimeout(() => r(JSON.stringify({ reply_text: 'LATEREPLY' })), delay)) });
    const t = setup(member({}, { timeout_s: 0.05 }), { deps: { fetch: slow(250) } });
    await t.eng.say('dev', '@Example slow body');
    const calls = t.store.all().filter(r => r.type === 'chat_endpoint_call');
    check('timeout: a body that arrives after the deadline is dropped', !t.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system') && calls.some(c => c.skipped === 'timeout'), t.store.all());
    const t2 = setup(member({}, { timeout_s: 0.05 }), { deps: { fetch: (u, o) => new Promise(r => setTimeout(() => r({ status: 200, text: async () => JSON.stringify({ reply_text: 'LATEREPLY' }) }), 150)) } });
    await t2.eng.say('dev', '@Example slow fetch');
    check('timeout: a fetch that resolves after the deadline is dropped', !t2.store.all().some(r => r.speaker === 'ex'), t2.store.all());
  }
  {
    // top-level body fields
    fk.set(() => ({ reply_text: 'fine' }));
    const t = setup(member());
    let n = fk.reqs.length;
    await t.eng.say('dev', '@Example hello'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    const b = sent().body, human = t.store.all().find(r => r.speaker === 'human');
    check('fields: msg_id and ts are the trigger message\'s', b.msg_id === human.id && b.ts === human.ts, [b.msg_id, b.ts]);
    check('fields: direct mention, text type, text_len, no truncated flag', b.mention_type === 'direct' && b.type === 'text' && b.text_len === b.text.length && b.text_len === '@Example hello'.length && !('truncated' in b), b);
    n = fk.reqs.length;
    await t.eng.say('dev', '@everyone hi'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    check('fields: @everyone is mention_type everyone', sent().body.mention_type === 'everyone', sent().body.mention_type);
    const tl = setup(member({}, { lead_eligible: true, sees: 'all' }), { room: { lead: 'ex' } });
    n = fk.reqs.length;
    await tl.eng.say('dev', 'no mention at all'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    check('fields: a wake through the lead role is mention_type role', sent().body.mention_type === 'role', sent().body.mention_type);
    n = fk.reqs.length;
    await t.eng.say('dev', '@Example from the mic', { type: 'voice_transcript' }); await waitFor(() => fk.reqs.length > n); await sleep(30);
    check('fields: a voice transcript line is type voice_transcript', sent().body.type === 'voice_transcript', sent().body.type);
    check('senses: a voice transcript has ear true, eyes false', JSON.stringify(sent().body.senses) === JSON.stringify({ text: true, ear: true, eyes: false }), sent().body.senses);
    n = fk.reqs.length;
    await t.eng.say('dev', '@Example typed'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    check('senses: a typed line has ear false', sent().body.senses.ear === false && sent().body.senses.text === true && sent().body.senses.eyes === false, sent().body.senses);
    const ts = setup(member({}, { senses: { eyes: true, ear: 'yes', smell: true } }));
    n = fk.reqs.length;
    await ts.eng.say('dev', '@Example cfg'); await waitFor(() => fk.reqs.length > n); await sleep(30);
    check('senses: endpoint.senses booleans override, others and unknown keys ignored', JSON.stringify(sent().body.senses) === JSON.stringify({ text: true, ear: false, eyes: true }), sent().body.senses);
    n = fk.reqs.length;
    await t.eng.say('dev', '@Example ' + 'y'.repeat(2500)); await waitFor(() => fk.reqs.length > n); await sleep(30);
    const lb = sent().body;
    check('fields: text over 2000 chars is capped, truncated true, text_len is what is sent', lb.text.length === 2000 && lb.truncated === true && lb.text_len === 2000 && lb.lines[lb.lines.length - 1].text.length === 2000, [lb.text.length, lb.truncated, lb.text_len]);
  }
  {
    // no_reply and aborted: the line is dropped, never re-queued or replayed (live and shadow)
    const calls = () => fk.reqs.filter(r => !(r.body && r.body.abort)).length;
    fk.set(() => ({ no_reply: true }));
    const t = setup(member());
    let n = calls();
    await t.eng.say('dev', '@Example first');
    await t.eng.say('dev', 'to the lead'); await sleep(250);
    check('no_reply: dropped, called once, not replayed after later turns', calls() === n + 1 && !t.store.all().some(r => r.speaker === 'ex' || r.speaker === 'system'), calls() - n);

    fk.set(() => 'hang');
    const ta = setup(member());
    n = calls();
    const p = ta.eng.say('dev', '@Example long');
    await waitFor(() => calls() > n);
    fk.set(() => ({ reply_text: 'FRESH' }));
    const p2 = ta.eng.say('dev', 'never mind');
    await p; await p2; await sleep(300);
    check('aborted: dropped, never re-queued or replayed', calls() === n + 1 && !ta.store.all().some(r => r.speaker === 'ex'), calls() - n);

    fk.set(() => ({ no_reply: true }));
    const ts = setup(member({}, { mode: 'shadow' }));
    n = calls();
    await ts.eng.say('dev', '@Example shadow one');
    await waitFor(() => ts.store.all().some(r => r.type === 'chat_endpoint_shadow'));
    await ts.eng.say('dev', 'to the lead'); await sleep(250);
    const sev = ts.store.all().filter(r => r.type === 'chat_endpoint_shadow');
    check('shadow no_reply: dropped, one call, one event, never replayed', calls() === n + 1 && sev.length === 1 && sev[0].outcome === 'no_reply' && !ts.store.all().some(r => r.speaker === 'ex'), sev);
  }

  fk.close();
  console.log(`result: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
