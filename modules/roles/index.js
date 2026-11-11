'use strict';
// roles: owner-made roles. A role is a bot registered at run time: its own conversation (a full agent
// session) plus a persona text added to its prompt. The core lists dynamicBots() of every module next
// to the configured bots, so a new role needs no restart. Off by default. See README.md.
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');
const { createStore, RoleError, RoleLimitError, ROLES_MAX, ENGINES } = require('./store');
const limits = require('./engines/limits');
const ask = require('./ask');
const card = require('./card');
const { createGroups, roomsOn, bi } = require('./groups');
const chief = require('./chief');

// api functions run with this.ctx when a module calls them (ctx.api) and without it when core does:
// then the state folder is the same fixed path the loader gives this module.
const dirOf = self => (self && self.ctx && self.ctx.state ? self.ctx.state.dir : path.join(J.STATE, 'm', 'roles'));
const storeOf = self => createStore(() => dirOf(self));
const storeOfCtx = ctx => createStore(() => ctx.state.dir);
const roleOfParam = ctx => { const id = String(ctx.params && ctx.params.id || ''); const r = /^r-[0-9a-f]{8}$/.test(id) ? storeOfCtx(ctx).get(id) : null; return r && r.id === id && !r.archived_at ? r : null; };
// Known fields first (from the registry), then any other field the card holds; the UI draws what this lists.
const cardView = r => {
  const c = card.view(r.card) || {};
  const fields = Object.entries(card.FIELDS).map(([key, f]) => ({ key, type: f.type, ...(f.max ? { max: f.max } : {}), ...(f.label ? { label: f.label } : {}), label_zh: f.label_zh || key, label_en: f.label_en || key, description: f.description, known: true }));
  for (const key of Object.keys(c)) if (!card.FIELDS[key]) fields.push({ key, type: 'json', known: false });
  return { id: r.id, name: r.name, fields, card: c, ...(card.avatarUrl(r) ? { avatar: card.avatarUrl(r) } : {}) };
};
// The card's field names as words, from the registry ("voice, way of talking, way of working and chat avatar"): the one place the descriptions get them.
const cardWords = () => { const w = Object.keys(card.FIELDS).map(k => String(card.FIELDS[k].label_en || k).toLowerCase()); return w.length > 1 ? w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1] : w.join(''); };
const groupsOfCtx = ctx => createGroups(() => ctx.state.dir, storeOfCtx(ctx));
const needRooms = ctx => { if (!roomsOn(ctx)) throw new Error(bi('群組聊天需要先開啟 rooms 模組（在設定裡把 modules.rooms 設為 true，並重新啟動一次）。', 'Group chats need the rooms module to be on (set modules.rooms to true in the config and restart once).')); };
const showv = v => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v === null || v === undefined ? '' : typeof v).slice(0, 60); // a request value in an error, never through its own toString
const MAX_GROUP_MEMBERS = 16; // the most role members a group made through the route may have
const groupNote = (ctx, type, g, more) => { try { ctx.state.append({ type, id: g.id, name: g.name, ...more }); } catch { /* best effort */ } };
// What the tools process CLAIMS to be: HARNESS_BOT when it is set, else 'tool'. Written as by_claimed, an audit label only: no code branches on it. Never taken from an argument.
const toolBy = () => process.env.HARNESS_BOT || 'tool';
// Journal first, as the routes do: when the line cannot be written, the tool fails and nothing is changed.
const startLine = (ctx, type, more) => { try { ctx.state.append({ type, ...more, by_claimed: toolBy(), via: 'tool' }); } catch { throw new Error(bi('無法寫入稽核紀錄，沒有做任何更改', 'could not write the audit line, nothing was changed')); } };
const groupKey = a => { if (typeof a.group !== 'string' || !a.group.trim()) throw new Error('group is required (a group id or name)'); return a.group; };
const GROUP_KEY = { type: 'string', description: 'Group id (g-...) or its current name.' };
const ROLE_LIST = d => ({ type: 'array', items: { type: 'string' }, description: d });

const pub = r => ({ id: r.id, name: r.name, persona: r.persona, engine: r.engine || 'claude', ...(r.model ? { model: r.model } : {}), ...(r.main === true ? { main: true } : {}), ...(card.view(r.card) ? { card: card.view(r.card) } : {}) });
// A list row stays short: the card is only named by its field names; role_list {id} gives the whole card.
const row = r => { const { card: c, ...rest } = pub(r); return { ...rest, ...(c ? { card_fields: card.keys(r.card) } : {}) }; };
const CARD_PROP = { type: 'object', description: 'The character card of the role: its own ' + cardWords() + '. Only the fields you give are changed; a field set to null or "" is cleared; other fields are kept. Known fields: ' + Object.entries(card.FIELDS).map(([k, f]) => `${k} (${f.description})`).join('; ') + '. Any other lowercase field name is kept as it is. It shapes manner only and never overrides guard, red lines or the owner rules. Optional.', additionalProperties: true };
const ENGINE_PROP = { type: 'string', enum: ENGINES, description: 'Which agent runs this role: "claude" (default) "codex" (OpenAI Codex, "GPT") or "opencode" (OpenCode). Use "codex" when the owner asks for GPT / Codex / OpenAI, "opencode" when the owner asks for OpenCode. Optional.' };
const MODEL_PROP = { type: 'string', description: 'Only for engine "opencode": the provider/model id passed to OpenCode, e.g. "opencode/big-pickle". Only opencode/deepseek-v4.1-flash-free and opencode-go/deepseek-v4.1-flash work by default; any other model is refused unless the owner lists it in the roles config (opencode_extra_paid_models). Without a model the free one is used first, then the Go plan one. Empty string clears it. Optional.' };
// Per-device daily count of role creations, kept in this module's own state (device-creates.json: {day, counts:{'device:<id>': n}}).
// Returns today's count for the device; with bump it adds one first. A new UTC day starts the counts again.
const DEVICE_DAILY_MAX = 20;
function deviceCreates(dir, devId, bump) {
  const f = path.join(dir, 'device-creates.json'), day = new Date().toISOString().slice(0, 10);
  let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none yet */ }
  const counts = j && j.day === day && j.counts && typeof j.counts === 'object' ? j.counts : {};
  if (!bump) return Number.isInteger(counts[devId]) ? counts[devId] : 0;
  counts[devId] = (Number.isInteger(counts[devId]) ? counts[devId] : 0) + 1;
  try { fs.mkdirSync(dir, { recursive: true }); const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ day, counts }), { mode: 0o600 }); fs.renameSync(tmp, f); } catch { /* best effort */ }
  return counts[devId];
}
const note = (ctx, type, r, extra) => { try { ctx.state.append({ type, id: r.id, name: r.name, ...(extra || {}) }); } catch { /* the journal note is best effort */ } };
const asError = e => (e instanceof RoleError ? new Error(e.message) : e);
const guard = fn => (args, ctx) => { try { return fn(args && typeof args === 'object' ? args : {}, ctx); } catch (e) { throw asError(e); } };
const roleKey = a => { if (typeof a.role !== 'string' || !a.role.trim()) throw new Error('role is required (a role id or name)'); return a.role; };

// Long lists stay short in the agent's context: a total, the newest few, and query / limit / offset to reach the rest.
const PAGE_PROPS = { query: { type: 'string', description: 'Only entries whose name or id contains this text.' }, limit: { type: 'number', description: 'How many to return (default 10, max 50).' }, offset: { type: 'number', description: 'Skip this many (newest first), to page on.' } };
function page(list, a, key, text) {
  const q = typeof a.query === 'string' ? a.query.trim().toLowerCase() : '';
  const all = list.filter(x => !q || text(x).toLowerCase().includes(q)).reverse();
  const n = Number(a.limit), o = Number(a.offset);
  const limit = Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 10, offset = Number.isFinite(o) && o >= 0 ? Math.floor(o) : 0;
  const items = all.slice(offset, offset + limit);
  return { total: all.length, offset, more: offset + items.length < all.length, [key]: items };
}
const mcpTools = [
  { name: 'role_create', when: 'Owner wants a new role or character',
    description: 'Create a custom role (a named persona the owner can pick in the chat page and talk to as its own separate conversation). Use when the owner asks to create or add a role or character, e.g. "make a role called X who is ..." in any language. The role appears in the chat page within seconds. It keeps all tools; the persona changes only voice and character.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Short name, 1-40 characters, any language. Must be unique among roles.' }, persona: { type: 'string', description: 'The persona text: who the role is and how it speaks and behaves (max 4000 characters).' }, engine: ENGINE_PROP, model: MODEL_PROP, card: CARD_PROP }, required: ['name', 'persona'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).create({ name: a.name, persona: a.persona, engine: a.engine, model: a.model, card: a.card }); note(ctx, 'role_created', r); return pub(r); }) },
  { name: 'role_update', when: 'Owner wants to change an existing role',
    description: 'Change the name, persona, engine, model and/or character card (' + cardWords() + ') of an existing role. Use when the owner asks to rename a role, to change its personality, voice or instructions, or to move it to GPT / Codex / OpenAI (engine "codex"), to OpenCode (engine "opencode", optional model) or back to Claude (engine "claude"). The role is an id (from role_list) or its current name. Main makes it the main role. Its conversation history is kept.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or current name.' }, name: { type: 'string', description: 'New name (optional).' }, persona: { type: 'string', description: 'New persona text, replacing the old one (optional).' }, engine: ENGINE_PROP, model: MODEL_PROP, card: CARD_PROP, main: { type: 'boolean', description: 'true makes this role the main role (the chief of staff the owner talks to first); the old main role is unmarked. Exactly one role is main, so false is refused. Optional.' } }, required: ['role'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).update(roleKey(a), { name: a.name, persona: a.persona, engine: a.engine, model: a.model, card: a.card, main: a.main }); note(ctx, 'role_updated', r); return pub(r); }) },
  { name: 'role_remove', when: 'Owner wants a role deleted',
    description: 'Remove a role from the chat page. Use when the owner asks to delete or remove a role. Nothing is deleted: the role is only hidden (archived) and its conversation is kept. The role is an id or its name.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or name.' } }, required: ['role'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).archive(roleKey(a)); note(ctx, 'role_archived', r); return { id: r.id, name: r.name, archived: true }; }) },
  { name: 'role_list', when: 'See which roles exist, or find one by name', tier: 1,
    description: 'List the current roles (newest first) with id, name, persona, engine (claude, codex or opencode) and model, plus card_fields (the names of the fields on its character card, when it has one): total, the newest 10, and more:true when there are others (use query, limit, offset to reach them), plus opencode_go_turns_today (how many OpenCode Go plan turns all roles used today). Use before changing or removing a role, or when the owner asks which roles exist. With id (a role id or name) it returns only that role with its full character card.',
    inputSchema: { type: 'object', properties: { ...PAGE_PROPS, id: { type: 'string', description: 'Role id or name: return just this role with its whole card (optional). Without it, a page of the list.' } } },
    run: guard((a, ctx) => {
      if (a.id !== undefined) { const r = storeOfCtx(ctx).get(a.id); if (!r || r.archived_at) throw new Error(`no role "${String(a.id).slice(0, 60)}"`); return { role: pub(r) }; }
      return { ...page(storeOfCtx(ctx).list().map(row), a, 'roles', r => `${r.name} ${r.id}`), opencode_go_turns_today: limits.goCount(ctx.state.dir) };
    }) },
  { name: 'role_ask', when: 'Ask a role a question in its own conversation', tier: 1,
    description: 'Send a message to another role (or "main", the owner\'s main bot) and get its answer later, whatever engine either one runs on. It does NOT wait: it returns at once with queued:true, and the answer arrives as a new message in your own conversation when the other role has finished its turn. After calling it, end your turn right away: do not wait, do not poll, do not invent the answer. The role is an id or name from role_list. Refused for an unknown or archived role, yourself, a role already in the ask chain, or when the chain is too deep or too long; then answer with what you have. Only usable inside a role conversation, not from outside one.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or name, or "main".' }, message: { type: 'string', description: 'What to say or ask. Give the other role all the context it needs; it does not see your conversation.' } }, required: ['role', 'message'] },
    run: guard((a, ctx) => ask.ask(a, ctx, askDeps)) },
  { name: 'group_create', when: 'Owner wants several roles to talk together',
    description: 'Create a group chat (a room) the owner can pick in the chat page, like making a group in a messaging app. Use when the owner asks to make or start a group chat with some roles, in any language. members are role names or ids (from role_list; create the roles first if they do not exist). The main bot is always in the group and is its lead: a message with no @mention goes to it, "@everyone" wakes all, "@<role id>" wakes one role. Each role answers with its own persona, engine and conversation. The group appears in the chat page within seconds. Needs the rooms module to be on.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The group name the owner chose, 1-40 characters, any language. Must be unique among groups.' }, members: ROLE_LIST('Role names or ids to put in the group (at least one).') }, required: ['name', 'members'] },
    run: guard((a, ctx) => {
      needRooms(ctx);
      const groups = groupsOfCtx(ctx), req = { name: a.name, members: a.members };
      groups.check(req);
      const id = groups.newId();
      startLine(ctx, 'group_create_started', { id, name: typeof a.name === 'string' ? a.name.trim().slice(0, 80) : '' });
      try { const g = groups.create({ ...req, id }, ctx); groupNote(ctx, 'group_created', g, { by_claimed: toolBy(), via: 'tool' }); return g; }
      catch (e) { groupNote(ctx, 'group_create_failed', { id, name: req.name }, { by_claimed: toolBy(), via: 'tool' }); throw e; }
    }) },
  { name: 'group_update', when: 'Owner wants to change a group of roles',
    description: 'Rename a group chat and/or add roles to it and/or remove roles from it. Use when the owner asks to rename a group, to add someone to it or to take someone out. The group is an id (from group_list) or its current name. The main bot cannot be removed. The conversation history is kept. Needs the rooms module to be on.',
    inputSchema: { type: 'object', properties: { group: GROUP_KEY, name: { type: 'string', description: 'New name (optional).' }, add: ROLE_LIST('Role names or ids to add (optional).'), remove: ROLE_LIST('Role names or ids to take out (optional).') }, required: ['group'] },
    run: guard((a, ctx) => {
      needRooms(ctx);
      const groups = groupsOfCtx(ctx), key = groupKey(a), fields = { name: a.name, add: a.add, remove: a.remove };
      const g0 = groups.get(key, ctx);
      if (!g0 || g0.archived_at) throw new Error(bi(`找不到群組「${showv(key)}」`, `No group "${showv(key)}"`));
      groups.checkUpdate(g0.id, fields);
      startLine(ctx, 'group_update_started', { group: g0.id });
      const g = groups.update(g0.id, fields, ctx); groupNote(ctx, 'group_updated', g, { by_claimed: toolBy(), via: 'tool' }); return g;
    }) },
  { name: 'group_remove', when: 'Owner wants a group deleted',
    description: 'Remove a group chat from the chat page. Use when the owner asks to delete or close a group. Nothing is deleted: the group is only hidden (archived) and its transcript is kept. The group is an id or its name.',
    inputSchema: { type: 'object', properties: { group: GROUP_KEY }, required: ['group'] },
    run: guard((a, ctx) => {
      needRooms(ctx);
      const groups = groupsOfCtx(ctx), key = groupKey(a), g0 = groups.get(key, ctx);
      if (!g0 || g0.archived_at) throw new Error(bi(`找不到群組「${showv(key)}」`, `No group "${showv(key)}"`));
      startLine(ctx, 'group_remove_started', { group: g0.id });
      const g = groups.archive(g0.id, ctx); groupNote(ctx, 'group_archived', g, { by_claimed: toolBy(), via: 'tool' }); return { id: g.id, name: g.name, archived: true };
    }) },
  { name: 'group_list', when: 'See which groups exist, or find one by name',
    description: 'List the group chats (newest first) with id, name, lead and members (id and name): total, the newest 10, and more:true when there are others (use query, limit, offset). Use before changing or removing a group, or when the owner asks which groups exist. Needs the rooms module to be on.',
    inputSchema: { type: 'object', properties: PAGE_PROPS },
    run: guard((a, ctx) => { needRooms(ctx); return page(groupsOfCtx(ctx).list(ctx), a, 'groups', g => `${g.name} ${g.id}`); }) },
];

// The bot of a task, as bot-persona finds it: the task_start record, else HARNESS_BOT, else the default bot.
function botOfTask(taskId, config) {
  let bot = null;
  try {
    for (const r of J.readAll().records) if (r.type === 'task_start' && r.task_id === taskId && typeof r.bot === 'string') bot = r.bot;
  } catch { /* journal unreadable: fall through */ }
  const b = config && config.bots;
  return bot || process.env.HARNESS_BOT || (Array.isArray(b) && b.length ? String(b[0] && b[0].id) : 'main');
}

const askDeps = { storeOfCtx, botOfTask };
const sweepAsks = ctx => { try { ask.sweep(ctx, askDeps); } catch { /* retried by the next sweep */ } };

module.exports = {
  contract: 2,
  name: 'roles',
  description: 'Owner-made roles: bots registered at run time, each its own conversation with a persona text.',
  runsOn: 'main',
  priority: 61,
  optionalDependsOn: ['rooms'],

  // The chat page's "new group" button. Same effect as the group_create tool, for the owner, with no model in between.
  // Members must be existing role ids (a name or an unknown id is a 400, never skipped); the answer carries the room id.
  routes: [
    // The chat page's "new role" button: the owner makes a role by hand, no model in between. Same store and
    // checks as the role_create tool, so the role looks the same to groups and to every other route.
    { method: 'POST', path: '/roles', access: 'owner', description: 'create a role by hand {name, job (one line), avatar?: {data: base64 png/jpeg/webp}}; answers 201 {id, name, persona, engine}; 409 at 50 live roles (archived ones do not count); 429 after 20 creations by one paired device in a day. Only name, job and avatar are read, so a paired device gets exactly what the owner gets',
      handler(ctx) {
        const bad = error => ({ status: 400, json: { error } });
        const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        const job = typeof b.job === 'string' ? b.job.trim() : '';
        if (!name || [...name].length > 40) return bad(bi('角色名稱要 1-40 個字', 'the role name must be 1-40 characters'));
        if (!job || [...job].length > 200 || /[\r\n]/.test(job)) return bad(bi('職責要寫成 1-200 個字的一行', 'the job must be one line of 1-200 characters'));
        // A paired device (the server rewrites it to an owner actor named device:<id>) may make DEVICE_DAILY_MAX roles a day; the owner is not limited.
        const dev = ctx.actor && typeof ctx.actor.id === 'string' && ctx.actor.id.startsWith('device:') ? ctx.actor.id : null;
        if (dev && deviceCreates(ctx.state.dir, dev) >= DEVICE_DAILY_MAX) {
          try { ctx.state.append({ type: 'role_rate_limited', by: dev, limit: DEVICE_DAILY_MAX }); } catch { /* best effort */ }
          return { status: 429, json: { error: bi(`這個裝置今天已建立 ${DEVICE_DAILY_MAX} 個角色，明天再試`, `this device has already made ${DEVICE_DAILY_MAX} roles today; try again tomorrow`) } };
        }
        // Optional picture: {data: base64}. JSON, not a raw upload; the body cap (256 KB) keeps it small, the card checks the content.
        let card;
        if (b.avatar !== undefined && b.avatar !== null) {
          const d = b.avatar && typeof b.avatar === 'object' ? b.avatar.data : undefined;
          if (typeof d !== 'string' || !d || d.length > 300000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d) || d.length % 4) return bad(bi('頭像圖檔無法讀取', 'the avatar image could not be read'));
          card = { avatar: { bytes: Buffer.from(d, 'base64') } };
        }
        try {
          const r = storeOfCtx(ctx).create({ name, persona: job, ...(card ? { card } : {}) });
          if (dev) deviceCreates(ctx.state.dir, dev, true);
          note(ctx, 'role_created', r, ctx.actor && ctx.actor.id ? { by: ctx.actor.id } : undefined);
          return { status: 201, json: pub(r) };
        } catch (e) {
          if (e instanceof RoleLimitError) return { status: 409, json: { error: bi(`角色已達上限（最多 ${ROLES_MAX} 個，已封存的不算）`, `role limit reached (at most ${ROLES_MAX} roles, archived ones do not count)`) } };
          if (!(e instanceof RoleError)) throw e;
          return bad(bi('無法建立角色：' + e.message, e.message));
        }
      } },
    { method: 'POST', path: '/groups', access: 'owner', description: 'create a group chat {name, members:[role id]}; answers 201 {id (the room id), name, lead, members}',
      handler(ctx) {
        const bad = error => ({ status: 400, json: { error } });
        const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name || [...name].length > 40) return bad(bi('群組名稱要 1-40 個字', 'the group name must be 1-40 characters'));
        if (!Array.isArray(b.members) || !b.members.length || b.members.length > MAX_GROUP_MEMBERS) return bad(bi(`成員要是 1-${MAX_GROUP_MEMBERS} 個角色 id 的清單`, `members must be a list of 1-${MAX_GROUP_MEMBERS} role ids`));
        const store = storeOfCtx(ctx), ids = [];
        for (const k of b.members) {
          const r = typeof k === 'string' ? store.get(k) : null;
          if (!r || r.archived_at || r.id !== k) return bad(bi(`找不到角色 id「${showv(k)}」`, `no such role id "${showv(k)}"`));
          if (!ids.includes(r.id)) ids.push(r.id);
        }
        const by = ctx.actor && ctx.actor.id;
        // the owner's own call takes the same path: audit line first, nothing is created when it cannot be written
        const groups = groupsOfCtx(ctx);
        let id;
        try { needRooms(ctx); groups.check({ name, members: ids }); id = groups.newId(); }
        catch (e) { return bad(String(e && e.message || 'could not create the group').slice(0, 300)); }
        try { ctx.state.append({ type: 'group_created', id, name, members: ids, by }); }
        catch { return { status: 500, json: { error: 'could not write the audit line, nothing was created' } }; }
        try { return { status: 201, json: groups.create({ name, members: ids, id }, ctx) }; }
        catch { groupNote(ctx, 'group_create_failed', { id, name }, { members: ids, by }); return { status: 500, json: { error: 'could not create the group' } }; }
      } },
    // Edit or archive a group from the chat page {name?, add?:[role id], remove?:[role id]} or {archived:true}. The audit line is written first and must land.
    { method: 'PATCH', path: '/groups/:id', access: 'owner', description: 'rename a group, add or remove members ({name?, add?, remove?}: role ids) archive it ({archived: true}) or bring an archived one back ({archived: false}); answers 200 with the group; 404 for an unknown or archived id; a group never ends with no member',
      handler(ctx) {
        const bad = error => ({ status: 400, json: { error } });
        const id = String((ctx.params && ctx.params.id) || '');
        const b = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
        const groups = groupsOfCtx(ctx), g = /^g-[0-9a-f]{8}$/.test(id) ? groups.get(id, ctx) : null;
        const restore = b.archived === false;
        if (!g || (g.archived_at && !restore)) return { status: 404, json: { error: bi('找不到這個群組', 'no such group') } };
        const by = (ctx.actor && ctx.actor.id) || 'owner';
        if (Object.keys(b).some(k => !['name', 'add', 'remove', 'archived'].includes(k))) return bad(bi('只能改 name、add、remove 或 archived', 'only name, add, remove or archived can be changed'));
        const archive = b.archived === true;
        if (b.archived !== undefined && !archive && !restore) return bad(bi('archived 只能是 true（封存）或 false（還原）', 'archived can only be true (archive) or false (restore)'));
        if (restore) {
          if (Object.keys(b).length > 1) return bad(bi('還原群組時不能同時改其他欄位', 'restore cannot be combined with other changes'));
          if (!g.archived_at) return { status: 200, json: g };   // already live: nothing to do, nothing journaled
          try { needRooms(ctx); groups.checkRestore(id); }
          catch (e) { return { status: 409, json: { error: String(e && e.message || 'could not restore the group').slice(0, 300) } }; }
          try { ctx.state.append({ type: 'group_restore_started', group: id, by, via: 'route' }); }
          catch { return { status: 500, json: { error: 'could not write the audit line, nothing was changed' } }; }
          let r;
          try { r = groups.restore(id, ctx); }
          catch (e) {   // a restore that broke after the started line must not look like one still in flight
            try { ctx.state.append({ type: 'group_restore_failed', group: id, by, via: 'route', kind: String(e && (e.code || e.name) || 'error').slice(0, 40) }); } catch { /* best effort */ }
            return { status: 500, json: { error: bi('還原群組失敗', 'could not restore the group') } };
          }
          groupNote(ctx, 'group_restored', r, { by }); return { status: 200, json: r };
        }
        const store = storeOfCtx(ctx), ids = {};
        if (archive && (b.name !== undefined || b.add !== undefined || b.remove !== undefined)) return bad(bi('封存群組時不能同時改其他欄位', 'archive cannot be combined with other changes'));
        for (const k of ['add', 'remove']) {
          if (b[k] === undefined) continue;
          if (!Array.isArray(b[k]) || !b[k].length || b[k].length > MAX_GROUP_MEMBERS) return bad(bi(`${k} 要是 1-${MAX_GROUP_MEMBERS} 個角色 id 的清單`, `${k} must be a list of 1-${MAX_GROUP_MEMBERS} role ids`));
          ids[k] = [];
          for (const x of b[k]) {
            const r = typeof x === 'string' ? store.get(x) : null;
            if (!r || r.id !== x || (k === 'add' && r.archived_at)) return bad(bi(`找不到角色 id「${showv(x)}」`, `no such role id "${showv(x)}"`));
            if (!ids[k].includes(r.id)) ids[k].push(r.id);
          }
        }
        const fields = { name: typeof b.name === 'string' ? b.name.trim() : b.name, add: ids.add, remove: ids.remove, max: MAX_GROUP_MEMBERS };
        if (!archive && b.name === undefined && !ids.add && !ids.remove) return bad(bi('請給新名稱、要加入的角色（add）或要移出的角色（remove）', 'give a new name, roles to add and/or roles to remove'));
        try { needRooms(ctx); if (!archive) groups.checkUpdate(id, fields); }
        catch (e) { return bad(String(e && e.message || 'could not change the group').slice(0, 300)); }
        try { ctx.state.append({ type: archive ? 'group_remove_started' : 'group_update_started', group: id, by, via: 'route' }); }
        catch { return { status: 500, json: { error: 'could not write the audit line, nothing was changed' } }; }
        try { const r = archive ? groups.archive(id, ctx) : groups.update(id, fields, ctx); groupNote(ctx, archive ? 'group_archived' : 'group_updated', r, { by }); return { status: 200, json: r }; }
        catch (e) { return bad(String(e && e.message || 'could not change the group').slice(0, 300)); }
      } },
    // Archived groups, for a Restore list: {groups:[{id, name, archived_at, members:[role id]}]}, newest archived first. Read-only; no persona, no turns.
    { method: 'GET', path: '/groups/archived', access: 'owner', description: 'the archived groups, newest archived first: {groups:[{id, name, archived_at, members:[role id]}]}; read-only; restore one with PATCH /groups/:id {archived: false}',
      handler(ctx) { try { needRooms(ctx); } catch (e) { return { status: 409, json: { error: String(e && e.message).slice(0, 300) } }; } return { status: 200, json: { groups: groupsOfCtx(ctx).archivedList() } }; } },
    // The chat page asks which role is the main one. The owner token and a paired device make the default main role on first use (the same fixed content, once); any other caller only reads it (200 {id:null} until it exists, so the page's polling is not a 404).
    { method: 'GET', path: '/main', description: 'the main role {id, name}; for the owner and for a paired device it creates the default chief-of-staff role when none is marked main (fixed content, once); any other caller is read-only ({id:null} with status 200 until then)',
      handler: ctx => { try { const a = ctx.actor, owner = !!a && a.kind === 'owner' && (a.id === undefined || a.id === '' || (typeof a.id === 'string' && a.id.startsWith('device:'))); const r = owner ? storeOfCtx(ctx).ensureMain(chief.DEFAULT, c => ctx.state.append({ type: 'role_created', id: c.id, name: c.name, by: a.id || 'owner', main: true })) : storeOfCtx(ctx).getMain(); if (!r) return { status: 200, json: { id: null } }; return { status: 200, json: { id: r.id, name: r.name } }; } catch { return { status: 500, json: { error: 'internal error' } }; } } },
    // Role card (owner). The avatar is served as a raw image; the card routes give the field registry with the values, so the page draws its fields from data.
    { method: 'GET', path: '/avatar/:id', access: 'owner', raw: true, description: 'the role avatar image (png, jpeg or webp); 404 when the role has none',
      handler(ctx) {
        const id = String(ctx.params && ctx.params.id || '');
        const r = /^r-[0-9a-f]{8}$/.test(id) ? storeOfCtx(ctx).get(id) : null;
        const f = r && r.id === id && !r.archived_at ? card.avatarFile(r, ctx.state.dir) : null;
        if (!f) return { status: 404, json: { error: 'no avatar' } };
        let body; try { if (fs.statSync(f.path).size > require('../../lib/modules').RAW_MAX) return { status: 413, json: { error: 'avatar too large' } }; body = fs.readFileSync(f.path); } catch { return { status: 404, json: { error: 'no avatar' } }; }
        return { status: 200, body, type: f.type, etag: String(f.hash || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || undefined };
      } },
    { method: 'GET', path: '/cards/:id', access: 'owner', description: 'one role card: {id, name, fields:[{key, type, max?, label?, description?, known}], card}',
      handler(ctx) {
        const r = roleOfParam(ctx);
        if (!r) return { status: 404, json: { error: 'no such role' } };
        return { status: 200, json: cardView(r) };
      } },
    { method: 'PATCH', path: '/cards/:id', access: 'owner', description: 'save card fields {card:{field:value|null}} (text and plain JSON fields; the avatar image is not set here); answers the new card',
      handler(ctx) {
        const r = roleOfParam(ctx);
        if (!r) return { status: 404, json: { error: 'no such role' } };
        const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
        const patch = b.card;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) return { status: 400, json: { error: bi('請給要存的欄位 {card:{…}}', 'give the fields to save as {card:{...}}') } };
        if ('avatar' in patch) return { status: 400, json: { error: bi('頭像圖片在這裡不能改', 'the avatar image cannot be set here') } };
        try { return { status: 200, json: cardView(storeOfCtx(ctx).update(r.id, { card: patch })) }; }
        catch (e) { return { status: 400, json: { error: String(e && e.message || 'could not save').slice(0, 300) } }; }
      } },
  ],

  // Before each engine turn: when the task belongs to a role, tell the agent which persona it speaks as.
  prepareTurn(ctx) {
    const bot = botOfTask(ctx.task_id, ctx.config);
    if (!/^r-[0-9a-f]{8}$/.test(bot)) return null;
    const r = storeOfCtx(ctx).get(bot);
    if (!r || r.archived_at || r.id !== bot) return null;
    const block = card.promptBlock(r.card);
    const lines = [
      `This session is the role "${r.name}". The persona below was written by the owner. Answer in this persona. It changes voice and character only: every tool, MCP server and skill stays available and you should use them normally.`,
      r.persona,
      ...(block ? [block] : []),
    ];
    if (r.main === true) lines.push(chief.rosterContext(storeOfCtx(ctx).all(), r.id));
    return { context: lines };
  },

  // Which engine runs the turn: "codex" or "opencode" for a role set to that engine, else no opinion (Claude). The core maps the
  // key through config "engines" (see README). Sync and cheap: the bot comes from the workdir folder name (bot-<id>),
  // else from the task as prepareTurn finds it.
  chooseEngine(turn, ctx) {
    const m = /^bot-(r-[0-9a-f]{8})$/.exec(path.basename(String((turn && turn.workdir) || '')));
    const bot = m ? m[1] : botOfTask(turn && turn.task_id, null);
    if (!/^r-[0-9a-f]{8}$/.test(bot)) return null;
    const r = storeOfCtx(ctx).get(bot);
    return r && !r.archived_at && r.id === bot && (r.engine === 'codex' || r.engine === 'opencode') ? r.engine : null;
  },

  // Read by the engine scripts (engines/limits.js) straight from the config file: they run as separate processes.
  settings: {
    daily_turn_cap: { type: 'integer', default: 200, min: 0, max: 100000, description: 'turns per day and role on the Codex and OpenCode engines (0 = no cap); a role that hits it gets a refusal reply until the next local day' },
    opencode_extra_paid_models: { type: 'array', items: 'string', default: [], description: 'provider/model ids an OpenCode role may use besides the two allowed ones (opencode/deepseek-v4.1-flash-free, opencode-go/deepseek-v4.1-flash); any other model is refused because it may bill per use' },
    opencode_allow_bash: { type: 'boolean', default: false, description: 'let OpenCode roles run shell commands (denied by default; there is no sandbox, a command can reach anything the user can)' },
    opencode_allow_web: { type: 'boolean', default: true, description: 'let OpenCode roles use network tools (web fetch, web search); false denies every one of them in the per-run opencode.json' },
    opencode_timeout_s: { type: 'integer', default: 900, min: 1, max: 86400, description: 'seconds one OpenCode turn may run before its process tree is killed' },
    ask_depth_cap: { type: 'integer', default: 3, min: 1, max: 10, description: 'role_ask: how many asks deep one chain may go (A asks B, B asks C is depth 2); past it the role is told to answer with what it has' },
    ask_chain_cap: { type: 'integer', default: 12, min: 1, max: 1000, description: 'role_ask: most messages one ask chain may send in total' },
    go_daily_cap: { type: 'integer', default: 0, min: 0, max: 100000, description: 'OpenCode Go plan turns per day across all roles (0 = no cap); refuses with a bilingual reply when reached' },
  },

  // role_ask return leg: a finished task may be the answer to an ask. The interval job also catches stopped or failed tasks
  // (they may never emit task.end) and anything left over by a restart.
  on: { 'task.end': (data, ctx) => sweepAsks(ctx) },
  jobs: [{ id: 'ask-sweep', every: 5, description: 'deliver role_ask answers to the asking role', run: ctx => { sweepAsks(ctx); } },
    { id: 'rooms-source', description: 'let the rooms module list the owner-made groups (only when rooms is on)',
    start(ctx) {
      if (!roomsOn(ctx)) return () => {};
      try {
        const rooms = ctx.api('rooms');
        return rooms ? rooms.registerRoomSource(() => groupsOfCtx(ctx).rooms(ctx)) : () => {};
      } catch { return () => {}; }
    } }],

  stateVersion: 1,
  migrate() {},

  api: {
    dynamicBots() { return storeOf(this).list().map(r => ({ id: r.id, name: r.name, ...(card.avatarUrl(r) ? { avatar: card.avatarUrl(r) } : {}) })); },
    // The stored avatar image of a role: { path, type, hash } or null (for the route that serves it).
    avatarFile(key) { const r = storeOf(this).get(key); return r && !r.archived_at ? card.avatarFile(r, dirOf(this)) : null; },
    list() { return storeOf(this).list(); },
    all() { return storeOf(this).all(); },
    get(key) { return storeOf(this).get(key); },
    main() { return storeOf(this).ensureMain(chief.DEFAULT); },
    create(v) { return storeOf(this).create(v); },
    update(key, v) { return storeOf(this).update(key, v); },
    archive(key) { return storeOf(this).archive(key); },
    mcpTools,
    mcpCategories: { roles: { title: 'Roles and groups', when: 'create, rename or remove a role or group chat' } },
  },
};
