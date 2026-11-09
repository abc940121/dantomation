'use strict';
// notifications: an in-app log of events worth the owner's attention, with
// read/unread, a bounded store and a per-kind on/off switch. Off by default.
// See README.md and DECISIONS.md.
const { open, KINDS } = require('./store');

const stores = new Map(); // state dir -> store
const storeOf = ctx => { const d = ctx.state.dir; if (!stores.has(d)) stores.set(d, open(d)); return stores.get(d); };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');
const settingKey = k => 'kind_' + k;

// The setting is the default; an owner override (PATCH /kinds) wins.
function enabled(ctx, store, kind) {
  const o = store.prefs();
  return kind in o ? o[kind] : ctx.settings[settingKey(kind)] !== false;
}

function record(ctx, kind, fields) {
  const store = storeOf(ctx);
  if (!enabled(ctx, store, kind)) return null;
  const item = store.add(kind, fields, ctx.settings.max_entries);
  ctx.state.append({ type: 'notification_created', n_id: item.id, kind }); // id and kind only, no text
  return item;
}

const bad = msg => ({ status: 400, json: { error: msg } });
const intParam = (v, def, min, max) => {
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

const settings = { max_entries: { type: 'integer', default: 500, min: 10, max: 5000, description: 'most entries kept; read ones are pruned first, oldest first' } };
for (const k of KINDS) settings[settingKey(k)] = { type: 'boolean', default: true, description: `record "${k}" notifications (the owner can override at runtime with PATCH /kinds)` };

const kindsOf = (ctx, s) => { const kinds = {}; for (const k of KINDS) kinds[k] = enabled(ctx, s, k); return kinds; };

module.exports = {
  contract: 2,
  name: 'notifications',
  description: 'In-app notification log for the owner: read/unread, bounded, per-kind switch.',
  runsOn: 'main',
  priority: 90,
  settings,

  on: {
    'card.created': ({ card_id, task_id, summary }, ctx) => { record(ctx, 'card_pending', { text: `Approval needed: ${str(summary)}`, ref: card_id, task_id }); },
    'task.end': ({ task_id, code }, ctx) => {
      if (code === 0) record(ctx, 'task_finished', { text: 'Task finished', task_id });
      else record(ctx, 'task_failed', { text: `Task failed (exit ${Number.isInteger(code) ? code : '?'})`, task_id });
    },
    // The two below are events no module emits yet (see README, missing seams).
    'question.asked': ({ question_id, task_id, text }, ctx) => { record(ctx, 'question_asked', { text: `Question: ${str(text)}`, ref: question_id, task_id }); },
    'rooms.mention': ({ room, target, text, msg_id }, ctx) => {
      if (target !== 'owner') return; // only mentions of the owner
      record(ctx, 'room_mention', { text: `Mention in ${str(room).slice(0, 40)}: ${str(text)}`, ref: msg_id });
    },
  },

  routes: [
    { method: 'GET', path: '/list', description: 'list notifications, newest first (?unread=1&offset=&limit=)', access: 'owner',
      handler: ctx => {
        const q = ctx.query || {};
        const offset = intParam(q.offset, 0, 0, 1e6), limit = intParam(q.limit, 50, 1, 200);
        if (offset === null || limit === null) return bad('offset or limit out of range');
        if (q.unread !== undefined && !['0', '1', 'true', 'false'].includes(String(q.unread))) return bad('unread must be 0 or 1');
        return { status: 200, json: storeOf(ctx).list({ unread: q.unread === '1' || q.unread === 'true', offset, limit }) };
      } },
    { method: 'GET', path: '/unread-count', description: 'number of unread notifications', access: 'owner',
      handler: ctx => ({ status: 200, json: { unread: storeOf(ctx).unreadCount() } }) },
    { method: 'POST', path: '/read-all', description: 'mark every notification read', access: 'owner',
      handler: ctx => ({ status: 200, json: { marked: storeOf(ctx).markAllRead() } }) },
    { method: 'POST', path: '/:id/read', description: 'mark one notification read', access: 'owner',
      handler: ctx => {
        const id = intParam(ctx.params && ctx.params.id, null, 1, 2147483647);
        if (id === null) return bad('id must be a positive integer');
        const it = storeOf(ctx).markRead(id);
        return it ? { status: 200, json: it } : { status: 404, json: { error: 'not found' } };
      } },
    { method: 'GET', path: '/kinds', description: 'per-kind on/off (effective values)', access: 'owner',
      handler: ctx => ({ status: 200, json: { kinds: kindsOf(ctx, storeOf(ctx)) } }) },
    { method: 'PATCH', path: '/kinds', description: 'body {kind: true|false|null}; null clears the override', access: 'owner',
      handler: ctx => {
        const b = ctx.body;
        if (!isObj(b) || !Object.keys(b).length) return bad('body must be an object of kind: boolean');
        for (const [k, v] of Object.entries(b)) {
          if (!KINDS.includes(k)) return bad('unknown kind');
          if (typeof v !== 'boolean' && v !== null) return bad('value must be true, false or null');
        }
        const s = storeOf(ctx);
        s.setPrefs(b);
        return { status: 200, json: { kinds: kindsOf(ctx, s) } };
      } },
  ],

  statusLines: (J, ctx) => { try { return [`notifications: ${storeOf(ctx).unreadCount()} unread`]; } catch { return []; } },

  api: { kinds: () => KINDS.slice() },
};
