'use strict';
// ntfy: push pings (task finished, task blocked, approval card waiting) through a
// plain HTTP POST to <server>/<topic>. Off by default; silent until a topic is set.
// Ping only: approval stays in approval-cards. See README.md and DECISIONS.md.

const KINDS = { finished: 'task_finished', blocked: 'task_blocked', approval: 'approval_waiting' };
const HEAD = { finished: 'Task finished', blocked: 'Task blocked', approval: 'Approval waiting' };
const TAGS = { finished: 'white_check_mark', blocked: 'warning', approval: 'raised_hand' };
const PRIORITY = { finished: '3', blocked: '4', approval: '4' };
const WINDOW_MS = 60000, titles = new Map(); // task_id -> short title (only when include_title)
const sent = []; // send timestamps, for the per-minute cap
const PRIORITY_KINDS = new Set(['blocked', 'approval']); // never held by the cap
const held = { count: 0, kind: null, id: null, timer: null, ctx: null }; // rate-capped 'finished' pings, coalesced

const safeId = v => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : null);
const cleanTitle = v => String(v == null ? '' : v).split(/\r?\n/)[0].replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);

function serverUrl(s) {
  let u; try { u = new URL(String(s)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}
const topicOk = t => typeof t === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(t);

function message(kind, taskId, title, extra) {
  let t = HEAD[kind];
  if (taskId) t += `: ${taskId}`;
  if (title) t += ` (${title})`;
  if (extra) t += ` ${extra}`;
  return t;
}

// Returns {sent:boolean, reason?}. Never throws; never carries the topic.
async function ping(ctx, kind, taskId, extra, flush) {
  const s = ctx.settings;
  if (s['kind_' + KINDS[kind]] === false) return { sent: false, reason: 'kind_off' };
  const topic = ctx.secret('topic');
  if (!topic) return { sent: false, reason: 'no_topic' };
  const id = safeId(taskId);
  // A topic is set, so the owner expects pings: every drop from here on is journaled for status.
  const drop = reason => { record(ctx, kind, id, false, 0, reason); return { sent: false, reason }; };
  if (!topicOk(topic)) return drop('bad_topic');
  const base = serverUrl(s.server);
  if (!base) return drop('bad_server');
  const now = Date.now();
  while (sent.length && now - sent[0] > WINDOW_MS) sent.shift();
  const capped = sent.length >= s.max_per_minute;
  if (capped && flush !== 'exit' && (flush || !PRIORITY_KINDS.has(kind))) {
    if (!flush) { held.count++; held.kind = kind; held.id = id; held.ctx = ctx; }
    scheduleFlush(sent[0] + WINDOW_MS - now + 50);
    if (!flush) record(ctx, kind, id, false, 0, 'rate_limited');
    return { sent: false, reason: 'rate_limited', held: true };
  }
  sent.push(now);
  // Piggyback: this send is allowed, so a held backlog goes out as one summary after it.
  // A flush sends the backlog alone; a normal 'finished' ping joins it as the latest. Priority pings send as-is.
  let backlog = null;
  if (held.count && (flush || !PRIORITY_KINDS.has(kind))) {
    backlog = flush ? { n: held.count, kind: held.kind, id: held.id } : { n: held.count + 1, kind, id };
    held.count = 0; held.kind = held.id = null;
  }

  const title = s.include_title && id ? cleanTitle(titles.get(id)) : '';
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: `Taskmote: ${HEAD[kind]}`, Tags: TAGS[kind], Priority: PRIORITY[kind] };
  const link = serverUrl(s.app_url);
  if (s.app_url && link) headers.Click = link;
  let ok = false, status = 0, why = '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), s.timeout_ms);
  const onAbort = () => ac.abort();
  if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${base}/${topic}`, { method: 'POST', body: backlog ? summary(backlog) : message(kind, id, title, extra), headers, redirect: 'error', signal: ac.signal });
    status = res.status; ok = res.ok;
    try { await res.arrayBuffer(); } catch { /* body unused */ }
  } catch (e) { why = e && e.name === 'AbortError' ? 'timeout' : 'network'; } // never e.message: it may carry the URL
  finally { clearTimeout(timer); if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort); }
  record(ctx, kind, id, ok, status, why);
  return ok ? { sent: true } : { sent: false, reason: why || 'http_' + status };
}

const summary = b => `${b.n} pings held, latest: ${b.kind}${b.id ? ' ' + b.id : ''}`;

// The process is about to exit with a backlog (the flush timer is unref'd): send it now, past the cap.
function flushHeld() {
  if (!held.count || !held.ctx) return Promise.resolve();
  if (held.timer) { clearTimeout(held.timer); held.timer = null; }
  return ping(held.ctx, held.kind, held.id, null, 'exit').catch(() => { /* a flush never throws */ });
}
process.on('beforeExit', flushHeld); // held.count is 0 after the send, so this does not loop

// A held backlog must not wait forever: when the minute window frees, send one coalesced message.
function scheduleFlush(ms) {
  if (held.timer) return;
  held.timer = setTimeout(async () => {
    held.timer = null;
    if (!held.count || !held.ctx) return;
    const { kind, id, ctx } = held;
    try { await ping(ctx, kind, id, null, true); } catch { /* a flush never throws */ }
  }, Math.max(50, Math.min(ms, WINDOW_MS + 100)));
  if (held.timer.unref) held.timer.unref();
}

function record(ctx, kind, id, ok, status, why) {
  try { ctx.state.append({ type: 'ntfy_sent', kind: KINDS[kind], task_id: id, ok, status, ...(why ? { why } : {}) }); } catch { /* journal trouble never blocks */ }
}

// One line per drop reason, naming the setting to fix. Never the topic or the URL.
const WHY = {
  bad_topic: 'the topic is not 4-64 letters, digits, _ or -; set it again with: node bin/harness.js secret ntfy topic',
  bad_server: 'the "server" setting is not a plain http(s) URL',
  rate_limited: 'over "max_per_minute"; extra finished pings were held and coalesced into one message (blocked and approval pings always send)',
  timeout: 'the server did not answer within "timeout_ms"',
  network: 'could not reach the server (check "server" and the network)',
};
function lastSend(J, pick = () => true) {
  const recs = (J && J.readAll ? J.readAll().records : []);
  for (let i = recs.length - 1; i >= 0; i--) if (recs[i].type === 'ntfy_sent' && recs[i].module === 'ntfy' && pick(recs[i])) return recs[i];
  return null;
}
function statusLine(J, ctx) {
  const topic = ctx.secret('topic');
  if (!topic) return 'ntfy: no topic (silent)';
  if (!topicOk(topic)) return `ntfy: topic set but unusable: ${WHY.bad_topic}`;
  if (!serverUrl(ctx.settings.server)) return `ntfy: ${WHY.bad_server}`;
  const r = lastSend(J);
  if (!r) return 'ntfy: topic set; no ping sent yet';
  const when = String(r.ts || '').slice(0, 16).replace('T', ' ');
  if (r.ok) {
    // a failed blocked/approval ping stays visible after later pings succeed, until one of its kind succeeds
    const p = lastSend(J, x => x.kind !== KINDS.finished);
    const pw = p && !p.ok ? `; last ${p.kind} ping FAILED ${String(p.ts || '').slice(0, 16).replace('T', ' ')}: ${WHY[p.why] || (p.status ? `the server answered HTTP ${p.status}` : 'unknown error')}` : '';
    return `ntfy: topic set; last ping sent ${when} (${r.kind})${pw}`;
  }
  const why = WHY[r.why] || (r.status ? `the server answered HTTP ${r.status}` : 'unknown error');
  return `ntfy: topic set; last ping FAILED ${when} (${r.kind}): ${why}`;
}

const safely = fn => async (p, ctx) => { try { await fn(p || {}, ctx); } catch { /* a ping never stops core */ } };

module.exports = {
  contract: 2,
  name: 'ntfy',
  description: 'Optional push pings (task finished, blocked, approval waiting) through an ntfy topic.',
  runsOn: 'main',
  priority: 95,
  settings: {
    server: { type: 'string', default: 'https://ntfy.sh', description: 'ntfy server base URL (use your own for self-hosting)' },
    topic: { type: 'secret', description: 'ntfy topic; anyone who knows it can read the pings. Set with: node bin/harness.js secret ntfy topic' },
    app_url: { type: 'string', default: '', description: 'optional link to the local app, sent as the tap-to-open target (empty = none)' },
    include_title: { type: 'boolean', default: false, description: 'add a short first line of the task request to the message (off: id only)' },
    kind_task_finished: { type: 'boolean', default: true, description: 'ping when a task ends with exit 0' },
    kind_task_blocked: { type: 'boolean', default: true, description: 'ping when a task is stalled or ends with a non-zero exit' },
    kind_approval_waiting: { type: 'boolean', default: true, description: 'ping when an approval card is waiting' },
    max_per_minute: { type: 'integer', default: 20, min: 1, max: 600, description: 'most pings sent per minute; extra finished pings are held and sent as one summary (blocked and approval pings are never held)' },
    timeout_ms: { type: 'integer', default: 4000, min: 500, max: 4500, description: 'give up on one send after this long' },
  },
  on: {
    'task.start': safely(({ task_id, request }, ctx) => {
      const id = safeId(task_id);
      if (!ctx.settings.include_title || !id) return;
      titles.set(id, cleanTitle(request));
      while (titles.size > 200) titles.delete(titles.keys().next().value);
    }),
    'task.end': safely(async ({ task_id, code }, ctx) => {
      if (code === 0) await ping(ctx, 'finished', task_id);
      else await ping(ctx, 'blocked', task_id, Number.isInteger(code) ? `(exit ${code})` : '');
      titles.delete(safeId(task_id));
    }),
    'task-watchdog.stalled': safely(({ task_id }, ctx) => ping(ctx, 'blocked', task_id)),
    // The card summary can hold a command line, so only the card's task id is sent.
    'card.created': safely(({ task_id }, ctx) => ping(ctx, 'approval', task_id)),
  },
  statusLines: (J, ctx) => { try { return [statusLine(J, ctx)]; } catch { return ['ntfy: status unreadable']; } },
  api: { serverUrl, topicOk, flushHeld, reset(windowOnly) { sent.length = 0; if (windowOnly) return; held.count = 0; held.kind = held.id = null; if (held.timer) { clearTimeout(held.timer); held.timer = null; } } }, // reset: tests only
};
