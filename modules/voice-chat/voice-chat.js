'use strict';
// voice-chat core: text utterance in, speakable NDJSON lines out. No audio here.
//   createVoiceChat({cfg, now, api}) -> { utterance(body, emit, ctx), playback(body), poll(emit), guard, settings }
// emit({say}) is called per sentence; the caller ends the stream with {done: true}.
const { client } = require('./api');
const { Speakable, cleanLine } = require('./speak');
const { EchoGuard } = require('./echo');

const DEFAULTS = {
  wake: ['hey assistant', 'okay assistant', 'ok assistant', 'hey claude', 'okay claude', '你好助手', '嘿助手', '小助手', '助手'],
  followup_s: 8, bots: null, status_s: 4, timeout_s: 180, api_base: 'http://127.0.0.1:7420',
};

function settings(cfg) {
  const v = Object.assign({}, DEFAULTS, (cfg && cfg.voice_chat) || {});
  if (!Array.isArray(v.wake) || !v.wake.length) v.wake = DEFAULTS.wake;
  v.token = v.token || process.env.VOICE_CHAT_TOKEN || '';
  return v;
}

const isCjk = ch => /\p{Script=Han}/u.test(ch);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function wakeRegex(phrase) {
  const words = phrase.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const body = words.map(w => [...w].map(esc).join(isCjk(w[0]) ? '\\s*' : '')).join('[\\s,，、]*');
  return new RegExp('^[\\s,，.。!！]*' + body + '(?![a-z0-9])[\\s,，.。:：!！-]*', 'u');
}
// -> {matched, rest}; the longest matching phrase wins.
function stripWake(text, phrases) {
  const full = String(text).normalize('NFKC');
  const t = full.toLowerCase();
  let best = 0;
  for (const p of phrases) {
    const m = wakeRegex(p).exec(t);
    if (m && m[0].length > best) best = m[0].length;
  }
  return best ? { matched: true, rest: full.slice(best).trim() } : { matched: false, rest: full.trim() };
}

const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trim() : s;
function cardPrompt(card) {
  const what = clip(cleanLine(card.summary || card.tool || 'an action'), 90).replace(/[.?!]+$/, '');
  return `Allow ${what}, yes or no?`;
}

function createVoiceChat({ cfg, now = Date.now, api, parseAnswer } = {}) {
  const S = settings(cfg);
  const A = api || client({ base: S.api_base, token: S.token });
  const guard = new EchoGuard({ now });
  const cards = new Map();  // cardId -> {announced, asks, parked}
  let botIds = null;

  const cardSt = id => { if (!cards.has(id)) cards.set(id, { announced: false, asks: 0, parked: false }); return cards.get(id); };
  const speak = (emit, text) => { guard.say(text); emit({ say: text }); };
  const followupOpen = () => guard.lastSpeechEnd > 0 && now() - guard.lastSpeechEnd <= S.followup_s * 1000;

  async function pendingCard() {
    try {
      const r = await A.json('GET', '/api/cards?state=pending');
      if (r.status === 200 && Array.isArray(r.body)) return r.body[0] || null;
    } catch { /* server down: no card */ }
    return null;
  }

  async function resolveBots() {
    if (S.bots === 'all' || (Array.isArray(S.bots) && S.bots.length)) return S.bots;
    if (!botIds) {
      const r = await A.json('GET', '/api/bots');
      if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) throw new Error('no bots');
      botIds = [r.body[0].id];
    }
    return botIds;
  }

  async function answerCard(card, answer, emit) {
    let r;
    try { r = await A.json('POST', `/api/cards/${encodeURIComponent(card.id)}`, { answer }); } catch { r = { status: 0 }; }
    if (r.status >= 200 && r.status < 300) { cards.delete(card.id); speak(emit, answer === 'yes' ? 'Approved.' : 'Denied.'); }
    else if (r.status === 404 || r.status === 410) { cards.delete(card.id); speak(emit, 'That request is no longer pending.'); }
    else speak(emit, 'I could not send your answer. The request is still pending.');
  }

  // true when the utterance was consumed by the card; false lets chat have it.
  async function handleCard(card, rest, wake, emit) {
    const st = cardSt(card.id);
    if (!st.announced) { st.announced = true; st.asks = 0; speak(emit, cardPrompt(card)); return true; }
    const a = parseAnswer(rest);
    if (a === 'yes' || a === 'no') { await answerCard(card, a, emit); return true; }
    if (wake.matched && rest) return false;   // a spoken command, not an answer
    if (st.parked) return false;
    st.asks++;
    if (st.asks === 1) speak(emit, 'Sorry, yes or no?');
    else { st.parked = true; st.asks = 0; speak(emit, 'I did not catch that. The request stays pending.'); }
    return true;
  }

  async function chat(text, emit, ctx) {
    let bots;
    try { bots = await resolveBots(); } catch { speak(emit, 'I cannot reach the server.'); return; }
    const taskIds = new Map();     // taskId -> {bot, speak, done}
    const early = [];
    let finish, ended = false;
    const donePromise = new Promise(r => { finish = r; });
    const lastStatus = { t: 0 };
    const multi = bots === 'all' || bots.length > 1;
    const say = (bot, s) => speak(emit, multi ? `${bot}: ${s}` : s);

    function onEvent(ev) {
      if (ended) return;
      const d = ev.data || {};
      const t = taskIds.get(d.task);
      if (!t) { if (d.task !== undefined) early.push(ev); return; }
      if (ev.type === 'message') {
        for (const s of t.speak.feed(d.text)) say(t.bot, s);
        if (d.final) for (const s of t.speak.flush()) say(t.bot, s);
      } else if (ev.type === 'tool_call') {
        const n = now();
        if (n - lastStatus.t >= S.status_s * 1000) {
          lastStatus.t = n;
          say(t.bot, `Running ${clip(cleanLine(d.tool || ''), 30) || 'a tool'}.`);
        }
      } else if (ev.type === 'card_pending' && d.card) {
        for (const s of t.speak.flush()) say(t.bot, s);
        cardSt(d.card.id).announced = true;
        speak(emit, cardPrompt(d.card));
        ended = true; finish();
      } else if (ev.type === 'task_end') {
        for (const s of t.speak.flush()) say(t.bot, s);
        t.done = true;
        if ([...taskIds.values()].every(x => x.done)) { ended = true; finish(); }
      }
    }

    let opened; const openP = new Promise(r => { opened = r; });
    const stream = A.sse('/api/events', onEvent, () => opened(), () => opened());
    const timer = setTimeout(() => { if (!ended) { ended = true; speak(emit, 'This is taking a while. I will stop narrating it.'); finish(); } }, S.timeout_s * 1000);
    const abort = setInterval(() => { if (ctx && ctx.closed && ctx.closed()) { ended = true; finish(); } }, 200);
    try {
      await Promise.race([openP, new Promise(r => setTimeout(r, 2000))]);
      let r;
      try { r = await A.json('POST', '/api/chat', { bots, text }); } catch { r = { status: 0 }; }
      if (r.status < 200 || r.status >= 300 || !Array.isArray(r.body)) { speak(emit, 'I could not send that to the bots.'); return; }
      for (const x of r.body) taskIds.set(x.taskId, { bot: x.bot, speak: new Speakable(), done: false });
      for (const ev of early.splice(0)) onEvent(ev);
      if (!ended && taskIds.size) await donePromise;
    } finally { clearTimeout(timer); clearInterval(abort); stream.close(); }
  }

  // -> {ignored?: reason}
  async function utterance(body, emit, ctx) {
    const text = String((body && body.text) || '').trim();
    if (!text) return { ignored: 'empty' };
    const echo = guard.check(text, body && Number(body.spokenAt));
    if (echo) return { ignored: 'echo-' + echo };
    const wake = stripWake(text, S.wake);
    const card = await pendingCard();
    const live = card && (!cardSt(card.id).parked || wake.matched);
    if (!wake.matched && !live && !followupOpen()) return { ignored: 'no-wake' };
    if (live && await handleCard(card, wake.rest, wake, emit)) return {};
    if (!wake.rest) { speak(emit, 'Yes?'); return {}; }
    await chat(wake.rest, emit, ctx);
    return {};
  }

  function playback(body) {
    return guard.playback(body && body.state, body && Number(body.at));
  }

  // Announce a newly pending card without waiting for the user to speak.
  async function poll(emit) {
    if (guard.playing) return { announced: false };
    const card = await pendingCard();
    if (!card) return { announced: false };
    const st = cardSt(card.id);
    if (st.announced) return { announced: false };
    st.announced = true; st.asks = 0;
    speak(emit, cardPrompt(card));
    return { announced: true };
  }

  return { utterance, playback, poll, guard, settings: S };
}

module.exports = { createVoiceChat, stripWake, cardPrompt, settings, DEFAULTS };
