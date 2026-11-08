'use strict';
// Helpers behind the voice-chat routes (kept out of index.js: a manifest has no extra exports).
const { createVoiceChat } = require('./voice-chat');

// Plain handler: (vc, body, write, ctx) -> Promise. Lines: {say}* then {done: true}.
async function utteranceHandler(vc, body, write, ctx) {
  const t0 = Date.now();
  let r;
  try { r = await vc.utterance(body, write, ctx); } catch (e) { r = { error: String(e.message).slice(0, 120) }; }
  write({ done: true, total_s: +((Date.now() - t0) / 1000).toFixed(2), ...r });
}

async function collect(fn) {
  const lines = [];
  await fn(o => lines.push(o));
  return { status: 200, json: { lines } };
}

// One instance per settings object; rebuilt when the settings object changes.
let cache = { key: null, vc: null };
function vcFor(ctx) {
  if (cache.key === ctx.settings && cache.vc) return cache.vc;
  const s = ctx.settings || {};
  const bots = Array.isArray(s.bots) && s.bots.length ? (s.bots.includes('all') ? 'all' : s.bots) : null;
  const section = { ...s, bots, wake: Array.isArray(s.wake) && s.wake.length ? s.wake : undefined, token: ctx.secret('token') || undefined };
  const parse = ctx.api('approval-cards').parseAnswer;
  cache = { key: ctx.settings, vc: createVoiceChat({ cfg: { voice_chat: section }, parseAnswer: parse }) };
  return cache.vc;
}

module.exports = { utteranceHandler, collect, vcFor };
