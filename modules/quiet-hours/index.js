'use strict';
// quiet-hours: do-not-disturb for phone pings. During the quiet window the ntfy module's
// pings are held in this module's own state file; after it ends they go out as ONE summary.
// Urgent kinds (approval / question waiting) always go through. Nothing is ever denied or
// auto-answered. Off by default. See README.md and DECISIONS.md.
const fs = require('fs');
const path = require('path');

const DEFAULT_URGENT = ['approval_waiting', 'question_waiting'];
const MAX_TITLES = 5, MAX_HELD = 500;
let clock = () => Date.now(); // tests swap this for a fake clock

// ---- time
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function minutes(v, key) {
  const m = HM.exec(String(v));
  if (!m) throw new Error(`quiet-hours: setting "${key}" must be a 24-hour time like "23:00", got ${JSON.stringify(v)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
// -> { start, end } in minutes after midnight. Throws a clear error for a bad setting.
function windowOf(settings) {
  const start = minutes(settings.start, 'start'), end = minutes(settings.end, 'end');
  if (!Array.isArray(settings.urgent_kinds) || settings.urgent_kinds.some(k => typeof k !== 'string')) throw new Error('quiet-hours: setting "urgent_kinds" must be a list of strings');
  return { start, end };
}
const minuteOfDay = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
// Equal start and end means no window. A window with start > end crosses midnight.
const inWindow = (w, ms) => {
  const m = minuteOfDay(ms);
  if (w.start === w.end) return false;
  return w.start < w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end;
};
// The next time the clock reaches the start or the end of the window after ms (epoch ms).
function nextEdge(w, ms) {
  const d = new Date(ms);
  let best = Infinity;
  for (let day = 0; day <= 1; day++) {
    for (const mins of [w.start, w.end]) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, Math.floor(mins / 60), mins % 60, 0, 0).getTime();
      if (t > ms && t < best) best = t;
    }
  }
  return best;
}

// ---- state: one small JSON file in the module's own state folder
const file = ctx => path.join(ctx.state.dir, 'quiet.json');
function load(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(file(ctx), 'utf8'));
    return { held: Array.isArray(j.held) ? j.held : [], override: j.override && (j.override.mode === 'on' || j.override.mode === 'off') ? j.override : null };
  } catch { return { held: [], override: null }; }
}
function save(ctx, st) {
  const f = file(ctx), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, f);
}

// Is it quiet now? The manual override wins until its edge passes, then it is dropped.
function view(ctx, ms = clock()) {
  const w = windowOf(ctx.settings);
  const st = load(ctx);
  if (st.override && !(ms < st.override.until)) { st.override = null; save(ctx, st); }
  const natural = inWindow(w, ms);
  const quiet = st.override ? st.override.mode === 'on' : natural;
  return { w, st, natural, quiet, ms };
}
const hm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

// ---- holding and flushing
function summaryText(held) {
  const n = held.length;
  const lines = [`While quiet: ${n} update${n === 1 ? '' : 's'}`];
  for (const h of held.slice(0, MAX_TITLES)) lines.push('- ' + h.text);
  if (n > MAX_TITLES) lines.push(`and ${n - MAX_TITLES} more`);
  return lines.join('\n');
}
// Send everything held as one ping. The queue is emptied only if the send worked.
async function flush(ctx) {
  const st = load(ctx);
  if (!st.held.length) return { sent: false, reason: 'nothing_held', count: 0 };
  const n = st.held.length;
  const r = await ctx.api('ntfy').sendText(summaryText(st.held), 'While quiet');
  if (!r || !r.sent) return { sent: false, reason: (r && r.reason) || 'send_failed', count: n };
  // re-read: pings held while we were sending stay queued
  const now = load(ctx);
  now.held = now.held.slice(n);
  save(ctx, now);
  ctx.state.append({ type: 'quiet_flushed', count: n });
  return { sent: true, count: n };
}

// The ntfy send gate. true = hold this ping. (ntfy sends as usual if this throws.)
async function gate(ctx, info) {
  const v = view(ctx);
  if (!v.quiet) {
    if (v.st.held.length) await flush(ctx); // quiet ended: the backlog goes first, as one ping
    return false;
  }
  if (ctx.settings.urgent_kinds.includes(info.kind)) return false; // tasks are blocked on these
  v.st.held.push({ kind: String(info.kind), task_id: info.task_id || null, text: String(info.text).slice(0, 120), ts: v.ms });
  if (v.st.held.length > MAX_HELD) v.st.held = v.st.held.slice(-MAX_HELD);
  save(ctx, v.st);
  ctx.state.append({ type: 'quiet_held', kind: String(info.kind) });
  return true;
}

function statusOf(ctx) {
  const v = view(ctx);
  return {
    window: `${hm(v.w.start)}-${hm(v.w.end)}`,
    urgent_kinds: ctx.settings.urgent_kinds.slice(),
    quiet_now: v.quiet,
    override: v.st.override ? { mode: v.st.override.mode, until: new Date(v.st.override.until).toISOString() } : null,
    held: v.st.held.length,
    titles: v.st.held.slice(0, MAX_TITLES).map(h => h.text),
  };
}
function statusText(ctx) {
  const s = statusOf(ctx);
  const o = s.override ? `, manual ${s.override.mode} until ${s.override.until.slice(0, 16).replace('T', ' ')} UTC` : '';
  return `quiet-hours: window ${s.window}, quiet now: ${s.quiet_now ? 'yes' : 'no'}${o}, held: ${s.held}`;
}

function setOverride(ctx, mode) {
  const v = view(ctx);
  v.st.override = { mode, until: nextEdge(v.w, v.ms) };
  save(ctx, v.st);
  ctx.state.append({ type: 'quiet_override', mode });
  return statusOf(ctx);
}

const USAGE = 'usage: taskmote quiet [status [--json]|flush|on|off]';

module.exports = {
  contract: 2,
  name: 'quiet-hours',
  description: 'Do-not-disturb for phone pings: hold ntfy pings at night, send one summary after.',
  runsOn: 'main',
  priority: 96, // after ntfy (95)
  dependsOn: ['ntfy'],

  settings: {
    start: { type: 'string', default: '23:00', description: 'quiet window starts (24-hour local time, HH:MM)' },
    end: { type: 'string', default: '07:30', description: 'quiet window ends (24-hour local time, HH:MM); start later than end crosses midnight' },
    urgent_kinds: { type: 'array', items: 'string', default: DEFAULT_URGENT.slice(), description: 'ping kinds that always go through (a task is blocked on them)' },
  },

  // Install the gate into ntfy while the server runs.
  jobs: [{
    id: 'gate',
    start(ctx) {
      windowOf(ctx.settings); // a bad time setting fails here, with a clear message
      return ctx.api('ntfy').setSendGate(info => gate(ctx, info));
    },
  }],

  commands: {
    async quiet(args, ctx) {
      const json = args.includes('--json');
      const sub = String(args.find(x => x !== '--json') || 'status').toLowerCase();
      try {
        if (sub === 'status') { console.log(json ? JSON.stringify(statusOf(ctx)) : statusText(ctx)); return { handled: true, code: 0 }; }
        if (process.env.HARNESS_TASK_ID && ['on', 'off', 'flush'].includes(sub)) { console.error('quiet: on, off and flush are for the owner; from inside a task use: taskmote quiet status --json'); return { handled: true, code: 2 }; }
        if (sub === 'on' || sub === 'off') { setOverride(ctx, sub); console.log(statusText(ctx)); return { handled: true, code: 0 }; }
        if (sub === 'flush') {
          const r = await flush(ctx);
          console.log(r.sent ? `sent 1 summary ping for ${r.count} held update${r.count === 1 ? '' : 's'}` : r.reason === 'nothing_held' ? 'nothing held' : `could not send (${r.reason}); ${r.count} still held`);
          return { handled: true, code: r.sent || r.reason === 'nothing_held' ? 0 : 1 };
        }
        console.error(USAGE);
        return { handled: true, code: 2 };
      } catch (e) { console.error(e && e.message ? e.message : String(e)); return { handled: true, code: 2 }; }
    },
  },

  routes: [{
    method: 'GET', path: '/status', description: 'quiet hours status: window, quiet now, held count', access: 'owner',
    handler: ctx => {
      try { return { status: 200, json: statusOf(ctx) }; } catch (e) { return { status: 500, json: { error: e.message } }; }
    },
  }],

  statusLines: (J, ctx) => { try { return [statusText(ctx)]; } catch (e) { return [e.message]; } },

  stateVersion: 1,
  migrate() {},

  // tests only: clock, and the pieces
  api: { setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }, check: windowOf, inWindow, nextEdge, summaryText },
};
