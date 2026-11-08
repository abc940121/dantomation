'use strict';
// spend-count: blocks a session whose notional spend (tokens x the price table in
// the config) is over spend_limit_usd_per_session. Logs logs/spend.jsonl.
const fs = require('fs');
const C = require('../../lib/config');
const { log } = require('../../lib/log');

const CONFIG = C.load();

function sessionSpend(transcript) {
  const prices = CONFIG.prices_usd_per_mtok;
  const seen = new Map();
  let raw = '';
  try { raw = fs.readFileSync(transcript, 'utf8'); } catch { return 0; }
  for (const l of raw.split('\n')) {
    if (!l.includes('"usage"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const m = j.message; if (!m || !m.usage) continue;
    seen.set(m.id || j.uuid, m); // dedupe streamed copies of one message
  }
  let usd = 0;
  for (const m of seen.values()) {
    const fam = Object.keys(prices).find(k => String(m.model || '').includes(k)) || 'default';
    const p = prices[fam]; const u = m.usage;
    usd += ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output +
      (u.cache_creation_input_tokens || 0) * p.input * 1.25 + (u.cache_read_input_tokens || 0) * p.input * 0.1) / 1e6;
  }
  return usd;
}

module.exports = {
  contract: 1,
  name: 'spend-count',
  description: 'Counts the session spend from the transcript and blocks once it is over spend_limit_usd_per_session.',
  beforeTool({ input }) {
    if (!input.transcript_path) return null;
    const limit = Number(process.env.HARNESS_SPEND_LIMIT_USD || CONFIG.spend_limit_usd_per_session);
    const usd = sessionSpend(input.transcript_path);
    log('spend.jsonl', { session_id: input.session_id, usd: Number(usd.toFixed(4)), limit });
    return usd > limit ? ['spend', `session spend $${usd.toFixed(2)} is over the $${limit} limit`] : null;
  },
  api: { sessionSpend },
};
