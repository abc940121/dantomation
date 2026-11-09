#!/usr/bin/env node
'use strict';
// voice-chat: wake gating (English + Chinese), follow-up window, card read-aloud and
// yes/no/unclear/re-ask, echo guard by timing and by text, speakable sanitizing, and
// the HTTP route (NDJSON). Uses a mock of server API v0 on 127.0.0.1 only.
// Needs the voice-chat module enabled (SKIP otherwise).
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cur = require(path.join(ROOT, 'lib', 'config')).load();
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };
if (!cur.modules['voice-chat']) { console.log('SKIP: voice-chat is not enabled in this config'); process.exit(0); }

const mod = require('..');
const { createVoiceChat } = require('../voice-chat');
const { Speakable, cleanLine } = require('../speak');
const { similarity } = require('../echo');
const { stripWake } = require('../voice-chat');

// ---- mock server API v0
function mockServer() {
  const m = { cards: [], answers: [], chats: [], script: [], sse: [], bots: [{ id: 'b1', name: 'One' }, { id: 'b2', name: 'Two' }], chatStatus: 200, answerStatus: 200 };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = () => new Promise(r => { const p = []; req.on('data', c => p.push(c)); req.on('end', () => r(JSON.parse(Buffer.concat(p).toString() || '{}'))); });
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/api/bots') return json(200, m.bots);
    if (url.pathname === '/api/cards' && req.method === 'GET') return json(200, m.cards);
    if (/^\/m\/approval-cards\/cards\/[^/]+\/voice$/.test(url.pathname)) return body().then(b => { m.answers.push({ id: url.pathname.split('/')[4], answer: b.text, ...b }); if (m.answerStatus === 200) m.cards = []; json(m.answerStatus, { answer: b.text }); });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\n\n'); m.sse.push(res); req.on('close', () => { m.sse = m.sse.filter(x => x !== res); }); return;
    }
    if (url.pathname === '/api/chat') return body().then(b => {
      m.chats.push(b);
      if (m.chatStatus !== 200) return json(m.chatStatus, {});
      const bots = b.bots === 'all' ? m.bots.map(x => x.id) : b.bots;
      json(200, bots.map(bot => ({ bot, taskId: 't-' + bot })));
      setTimeout(() => { for (const [type, data] of m.script.map(f => typeof f === 'function' ? f(bots) : f).flat()) for (const s of m.sse) s.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }, 30);
    });
    json(404, {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ m, srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
  const { m, srv, base } = await mockServer();
  let clock = 1_000_000;
  const mk = (extra = {}) => createVoiceChat({ cfg: { voice_chat: { api_base: base, ...extra } }, now: () => clock, parseAnswer: require('../../../lib/modules').registry({ modules: { 'approval-cards': true } }).api('approval-cards').parseAnswer });
  const run = async (vc, text, spokenAt) => {
    const lines = []; const r = await vc.utterance({ text, spokenAt }, o => lines.push(o), {});
    return { say: lines.map(l => l.say), r };
  };
  const say1 = (task = 't-b1', texts = ['Hello there.'], extra = []) => [...texts.map((t, i) => ['message', { task, bot: 'b1', text: t, final: i === texts.length - 1 }]), ...extra, ['task_end', { task, state: 'done' }]];

  // ---- wake gating
  let vc = mk(); m.script = [say1()];
  let o = await run(vc, 'what is the weather');
  check('no wake phrase: ignored, no chat sent', o.r.ignored === 'no-wake' && m.chats.length === 0, JSON.stringify(o));
  o = await run(vc, 'Hey assistant, run the tests');
  check('English wake: chat sent to first bot, reply spoken', m.chats.length === 1 && m.chats[0].text === 'run the tests' && JSON.stringify(m.chats[0].bots) === '["b1"]' && o.say[0] === 'Hello there.', JSON.stringify([m.chats, o]));
  vc = mk(); m.chats = []; m.script = [say1()];
  o = await run(vc, '你好助手，帮我看看状态');
  check('Chinese wake: stripped, chat sent', m.chats.length === 1 && m.chats[0].text === '帮我看看状态', JSON.stringify(m.chats));
  const sw = stripWake('Hey assistantship go', mk().settings.wake);
  check('wake must end on a word boundary', !sw.matched);
  vc = mk({ wake: ['computer'] }); m.chats = [];
  o = await run(vc, 'Computer. status please');
  check('configurable wake list', m.chats.length === 1 && m.chats[0].text === 'status please');
  vc = mk(); m.chats = [];
  o = await run(vc, 'hey assistant');
  check('wake phrase alone just answers, no chat', o.say[0] === 'Yes?' && m.chats.length === 0);

  // ---- follow-up window
  vc = mk({ followup_s: 8 }); m.chats = []; m.script = [say1()];
  await run(vc, 'hey assistant hi');
  clock += 5000;
  o = await run(vc, 'and then what');
  check('follow-up within 8 s needs no wake phrase', m.chats.length === 2 && m.chats[1].text === 'and then what', JSON.stringify(m.chats));
  clock += 9000;
  o = await run(vc, 'something else');
  check('follow-up window closes after followup_s', o.r.ignored === 'no-wake' && m.chats.length === 2);

  // ---- card read-aloud and answers
  const card = { id: 'c1', task: 't-b1', bot: 'b1', tool: 'Bash', summary: 'git push origin main', expiresAt: 'x' };
  vc = mk(); m.cards = [card]; m.answers = [];
  o = await run(vc, 'anything');
  check('pending card: question read aloud in one sentence', o.say.length === 1 && /git push origin main/.test(o.say[0]) && /yes or no/.test(o.say[0]) && m.answers.length === 0, JSON.stringify(o));
  clock += 5000;
  o = await run(vc, 'mumble mumble');
  check('unclear: re-asked once', o.say[0] === 'Sorry, yes or no?' && m.answers.length === 0, JSON.stringify(o));
  clock += 5000;
  o = await run(vc, 'what');
  check('unclear twice: card stays pending and says so', /stays pending/.test(o.say[0]) && m.answers.length === 0 && m.cards.length === 1, JSON.stringify(o));
  clock += 20000;
  o = await run(vc, 'yes');
  check('parked card: bare yes without wake is ignored', o.r.ignored === 'no-wake' && m.answers.length === 0, JSON.stringify(o));
  o = await run(vc, 'hey assistant yes');
  check('parked card: wake + yes approves', m.answers.length === 1 && m.answers[0].answer === 'yes' && o.say[0] === 'Approved.', JSON.stringify([m.answers, o]));

  vc = mk(); m.cards = [card]; m.answers = [];
  await run(vc, 'x'); clock += 5000;
  o = await run(vc, 'no');
  check('no answer is sent as no', m.answers[0] && m.answers[0].answer === 'no' && o.say[0] === 'Denied.');
  vc = mk(); m.cards = [card]; m.answers = [];
  await run(vc, 'x'); clock += 5000;
  o = await run(vc, '好的');
  check('Chinese yes approves', m.answers[0] && m.answers[0].answer === 'yes');
  vc = mk(); m.cards = [card]; m.answers = [];
  await run(vc, 'x'); clock += 5000;
  o = await run(vc, 'yes but not the push');
  check('hedged yes is unclear, never approves', m.answers.length === 0 && o.say[0] === 'Sorry, yes or no?');
  vc = mk(); m.cards = [card]; m.answers = []; m.answerStatus = 409;
  await run(vc, 'x'); clock += 5000;
  o = await run(vc, 'yes');
  check('server refusing the answer: say so, nothing assumed', /still pending/.test(o.say[0]));
  m.answerStatus = 200;

  // proactive poll
  vc = mk(); m.cards = [card]; m.answers = [];
  let lines = []; let p = await vc.poll(x => lines.push(x));
  const p2 = await vc.poll(x => lines.push(x));
  check('poll announces a new card once', p.announced && !p2.announced && lines.length === 1);
  clock += 5000;
  o = await run(vc, 'yes');
  check('announced by poll, then yes approves', m.answers.length === 1 && m.answers[0].answer === 'yes');

  // ---- echo guard by timing
  vc = mk(); m.cards = [card]; m.answers = [];
  await run(vc, 'x');                                   // prompt spoken
  vc.playback({ state: 'start', at: 5000 });
  o = await run(vc, 'yes', 5200);
  check('timing: utterance while TTS playing is ignored', o.r.ignored === 'echo-playing' && m.answers.length === 0);
  vc.playback({ state: 'end', at: 7000 });
  o = await run(vc, 'yes', 6000);
  check('timing: utterance starting inside a finished window is ignored', o.r.ignored === 'echo-timing' && m.answers.length === 0);
  o = await run(vc, 'yes', 7250);
  check('timing: within 300 ms after the end is ignored', o.r.ignored === 'echo-timing' && m.answers.length === 0);
  o = await run(vc, 'yes', 7400);
  check('timing: after the 300 ms tail a real yes counts', m.answers.length === 1 && m.answers[0].answer === 'yes', JSON.stringify(o));
  check('playback rejects a bad state', vc.playback({ state: 'pause' }) === false);

  // ---- echo guard by text
  vc = mk(); m.cards = [card]; m.answers = [];
  o = await run(vc, 'anything');
  const prompt = o.say[0];
  clock += 1000;
  o = await run(vc, prompt);
  check('text: the card prompt heard back is ignored', o.r.ignored === 'echo-text' && m.answers.length === 0, JSON.stringify(o));
  o = await run(vc, 'allow git push origin main yes or no');
  check('text: a close variant (ASR noise) is ignored', o.r.ignored === 'echo-text');
  o = await run(vc, 'push origin main, yes or no');
  check('text: a fragment of the prompt is ignored', o.r.ignored === 'echo-text');
  clock += 1000;
  o = await run(vc, 'yes');
  check('text: a bare yes after the prompt is a real answer', m.answers.length === 1);
  // its own "Yes?" acknowledgement must not become a yes
  vc = mk(); m.cards = []; m.answers = [];
  o = await run(vc, 'hey assistant');
  m.cards = [card];
  clock += 500;
  o = await run(vc, 'yes?');
  check('text: its own "Yes?" prompt heard back is not taken as an answer', o.r.ignored === 'echo-text' && m.answers.length === 0, JSON.stringify(o));
  clock += 11000;
  check('text memory expires after 10 s (similarity is not forever)', vc.guard.check('Yes?', undefined) === null);
  check('similarity: identical 1, unrelated low, Chinese works', similarity('Run the tests', 'run the tests!') === 1 && similarity('open the door', 'weather forecast') < 0.3 && similarity('我来运行测试', '我来运行测试吧') > 0.8);

  // ---- speak-text and pipeline (pure)
  await require('./speak-text').run(check);

  // ---- speakable sanitizing
  const sp = new Speakable();
  const got = [...sp.feed('Done. Here is code:\n```js\nconst a = 1;\nrm -rf /\n```\nSee https://example.com/x?y=1 and www.foo.com for more. Next'), ...sp.feed(' sentence here.\n```py\nprint(1)'), ...sp.feed('\nstill code\n``` After code.'), ...sp.flush()];
  const joined = got.join(' | ');
  check('sanitize: fenced code (also across chunks) dropped', !/const a|rm -rf|print|still code/.test(joined) && /After code/.test(joined) && /Next sentence here/.test(joined), joined);
  check('sanitize: URLs spoken as the domain only', !/http|www|\/x|y=1/.test(joined) && /example\.com/.test(joined) && /foo\.com/.test(joined), joined);
  check('sanitize: markdown stripped, inline code kept as words', cleanLine('**Bold** and `npm test` [docs](http://x.y) # head') === 'Bold and npm test docs head');
  const long = new Speakable().feed('word '.repeat(200) + '.');
  check('sanitize: long sentence is chunked short', long.length > 1 && long.every(s => s.length <= 170), long.map(s => s.length).join(','));
  check('sanitize: Chinese sentences split on full stops', new Speakable().feed('第一句。第二句！第三句？').length === 3);

  // ---- streaming through chat: code/URL filtered, tool_call throttled, multi-bot
  vc = mk({ status_s: 4, reply_grace_s: 0.05 }); m.chats = []; m.cards = [];
  m.script = [[
    ['message', { task: 't-b1', bot: 'b1', text: 'Working. ```sh\nrm -rf x\n``` See https://a.b/c now.', final: false }],
    ['tool_call', { task: 't-b1', bot: 'b1', callId: '1', tool: 'Bash', summary: 'curl http://secret' }],
    ['tool_call', { task: 't-b1', bot: 'b1', callId: '2', tool: 'Read', summary: 'x' }],
    ['message', { task: 't-b1', bot: 'b1', text: 'All done', final: true }],
    ['task_end', { task: 't-b1', state: 'done' }],
  ]];
  o = await run(vc, 'hey assistant go');
  check('chat stream: sentences spoken, code placeholder, URL as domain, one status line within 4 s', o.say.join('|') === 'Working.|(code omitted).|See a.b now.|Running Bash.|All done.', o.say.join('|'));
  clock += 5000;
  m.script = [[['tool_call', { task: 't-b1', bot: 'b1', callId: '3', tool: 'Edit', summary: '' }], ['tool_call', { task: 't-b1', bot: 'b1', callId: '4', tool: 'Bash', summary: '' }], ['task_end', { task: 't-b1', state: 'done' }]]];
  o = await run(vc, 'again');
  check('status line again after the interval', o.say.join('|') === 'Running Edit.', o.say.join('|'));
  vc = mk({ bots: 'all' }); m.chats = [];
  m.script = [bots => bots.map(b => [['message', { task: 't-' + b, bot: b, text: 'Hi.', final: true }], ['task_end', { task: 't-' + b, state: 'done' }]]).flat()];
  o = await run(vc, 'hey assistant all of you');
  check('bots: "all" fans out; replies are prefixed by bot', m.chats[0].bots === 'all' && o.say.includes('b1: Hi.') && o.say.includes('b2: Hi.'), JSON.stringify(o));
  // the final reply can arrive just after task_end (the bot marks the task done, then answers)
  vc = mk({ reply_grace_s: 2 }); m.chats = [];
  m.script = [[['task_end', { task: 't-b1', state: 'done' }], ['message', { task: 't-b1', bot: 'b1', text: 'hello', final: true }]]];
  o = await run(vc, 'hey assistant say hello');
  check('reply after task_end is still spoken', o.say.join('|') === 'hello.' || o.say.join('|') === 'hello', o.say.join('|'));
  vc = mk(); m.script = [[['card_pending', { card: { id: 'c9', task: 't-b1', bot: 'b1', tool: 'Bash', summary: 'delete files', expiresAt: 'x' } }]]];
  m.cards = [{ id: 'c9', summary: 'delete files' }];
  o = await run(vc, 'hey assistant clean up');
  check('card_pending during chat: read aloud, stream ends', o.say.length === 1 && /delete files/.test(o.say[0]), JSON.stringify(o));
  m.cards = [];
  vc = mk(); m.chatStatus = 500;
  o = await run(vc, 'hey assistant hi');
  check('chat failure is spoken, not thrown', /could not send/.test(o.say[0]));
  m.chatStatus = 200;

  // ---- route shape (module contract 1: handlers take a ctx and answer {status, json})
  const parseAnswer = require('../../../lib/modules').registry({ modules: { 'approval-cards': true } }).api('approval-cards').parseAnswer;
  const ctxOf = (b, extra = {}) => ({ body: b, settings: { api_base: base, wake: [], bots: [], followup_s: 8, status_s: 4, timeout_s: 180, token: 'missing' }, secret: () => null, api: dep => (dep === 'approval-cards' ? { parseAnswer } : {}), ...extra });
  const routeOf = p => mod.routes.find(r => r.path === p);
  check('manifest: contract 1, dependsOn approval-cards, owner-only routes, secret token',
    mod.contract === 1 && mod.dependsOn.includes('approval-cards') && mod.routes.every(r => !r.access) && mod.settings.token.type === 'secret');
  m.script = [say1('t-b1', ['Routed.'])];
  const c1 = ctxOf({ text: 'hey assistant route test', spokenAt: Date.now() });
  const resp = await routeOf('/utterance').handler(c1);
  const nd = resp.json.lines;
  check('route: {lines: [{say}..., {done:true}]}', resp.status === 200 && nd[0].say === 'Routed.' && nd[nd.length - 1].done === true, JSON.stringify(resp));
  const pb = await routeOf('/playback').handler(ctxOf({ state: 'start' }, { settings: c1.settings }));
  check('route: /playback start ok', pb.status === 200);
  const ig = await routeOf('/utterance').handler(ctxOf({ text: 'hello?' }, { settings: c1.settings }));
  const ign = ig.json.lines[ig.json.lines.length - 1];
  check('route: ignored utterance still ends with {done:true}', ign.done === true && /echo-playing/.test(ign.ignored), JSON.stringify(ig));
  srv.close();
  for (const s of m.sse) s.destroy();

  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FAIL harness error: ' + (e.stack || e)); process.exit(1); });
