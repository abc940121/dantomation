'use strict';
// roles: owner-made roles. A role is a bot registered at run time: its own conversation (a full agent
// session) plus a persona text added to its prompt. The core lists dynamicBots() of every module next
// to the configured bots, so a new role needs no restart. Off by default. See README.md.
const path = require('path');
const J = require('../../lib/journal');
const { createStore, RoleError, ENGINES } = require('./store');
const limits = require('./engines/limits');
const ask = require('./ask');
const { createGroups, roomsOn, bi } = require('./groups');

// api functions run with this.ctx when a module calls them (ctx.api) and without it when core does:
// then the state folder is the same fixed path the loader gives this module.
const dirOf = self => (self && self.ctx && self.ctx.state ? self.ctx.state.dir : path.join(J.STATE, 'm', 'roles'));
const storeOf = self => createStore(() => dirOf(self));
const storeOfCtx = ctx => createStore(() => ctx.state.dir);
const groupsOfCtx = ctx => createGroups(() => ctx.state.dir, storeOfCtx(ctx));
const needRooms = ctx => { if (!roomsOn(ctx)) throw new Error(bi('群組聊天需要先開啟 rooms 模組（在設定裡把 modules.rooms 設為 true，並重新啟動一次）。', 'Group chats need the rooms module to be on (set modules.rooms to true in the config and restart once).')); };
const groupNote = (ctx, type, g) => { try { ctx.state.append({ type, id: g.id, name: g.name }); } catch { /* best effort */ } };
const GROUP_KEY = { type: 'string', description: 'Group id (g-...) or its current name.' };
const ROLE_LIST = d => ({ type: 'array', items: { type: 'string' }, description: d });

const pub = r => ({ id: r.id, name: r.name, persona: r.persona, engine: r.engine || 'claude', ...(r.model ? { model: r.model } : {}) });
const ENGINE_PROP = { type: 'string', enum: ENGINES, description: 'Which agent runs this role: "claude" (default) "codex" (OpenAI Codex, "GPT") or "opencode" (OpenCode). Use "codex" when the owner asks for GPT / Codex / OpenAI, "opencode" when the owner asks for OpenCode. Optional.' };
const MODEL_PROP = { type: 'string', description: 'Only for engine "opencode": the provider/model id passed to OpenCode, e.g. "opencode/big-pickle". Only opencode/deepseek-v4.1-flash-free and opencode-go/deepseek-v4.1-flash work by default; any other model is refused unless the owner lists it in the roles config (opencode_extra_paid_models). Without a model the free one is used first, then the Go plan one. Empty string clears it. Optional.' };
const note = (ctx, type, r) => { try { ctx.state.append({ type, id: r.id, name: r.name }); } catch { /* the journal note is best effort */ } };
const asError = e => (e instanceof RoleError ? new Error(e.message) : e);
const guard = fn => (args, ctx) => { try { return fn(args && typeof args === 'object' ? args : {}, ctx); } catch (e) { throw asError(e); } };
const roleKey = a => { if (typeof a.role !== 'string' || !a.role.trim()) throw new Error('role is required (a role id or name)'); return a.role; };

const mcpTools = [
  { name: 'role_create',
    description: 'Create a custom role (a named persona the owner can pick in the chat page and talk to as its own separate conversation). Use when the owner asks to create or add a role or character, e.g. "make a role called X who is ..." in any language. The role appears in the chat page within seconds. It keeps all tools; the persona changes only voice and character.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Short name, 1-40 characters, any language. Must be unique among roles.' }, persona: { type: 'string', description: 'The persona text: who the role is and how it speaks and behaves (max 4000 characters).' }, engine: ENGINE_PROP, model: MODEL_PROP }, required: ['name', 'persona'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).create({ name: a.name, persona: a.persona, engine: a.engine, model: a.model }); note(ctx, 'role_created', r); return pub(r); }) },
  { name: 'role_update',
    description: 'Change the name, persona, engine and/or model of an existing role. Use when the owner asks to rename a role, to change its personality, voice or instructions, or to move it to GPT / Codex / OpenAI (engine "codex"), to OpenCode (engine "opencode", optional model) or back to Claude (engine "claude"). The role is an id (from role_list) or its current name. Its conversation history is kept.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or current name.' }, name: { type: 'string', description: 'New name (optional).' }, persona: { type: 'string', description: 'New persona text, replacing the old one (optional).' }, engine: ENGINE_PROP, model: MODEL_PROP }, required: ['role'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).update(roleKey(a), { name: a.name, persona: a.persona, engine: a.engine, model: a.model }); note(ctx, 'role_updated', r); return pub(r); }) },
  { name: 'role_remove',
    description: 'Remove a role from the chat page. Use when the owner asks to delete or remove a role. Nothing is deleted: the role is only hidden (archived) and its conversation is kept. The role is an id or its name.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or name.' } }, required: ['role'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).archive(roleKey(a)); note(ctx, 'role_archived', r); return { id: r.id, name: r.name, archived: true }; }) },
  { name: 'role_list',
    description: 'List the current roles with id, name, persona, engine (claude, codex or opencode) and model, plus opencode_go_turns_today (how many OpenCode Go plan turns all roles used today). Use before changing or removing a role, or when the owner asks which roles exist.',
    inputSchema: { type: 'object', properties: {} },
    run: guard((a, ctx) => ({ roles: storeOfCtx(ctx).list().map(pub), opencode_go_turns_today: limits.goCount(ctx.state.dir) })) },
  { name: 'role_ask',
    description: 'Send a message to another role (or "main", the owner\'s main bot) and get its answer later, whatever engine either one runs on. It does NOT wait: it returns at once with queued:true, and the answer arrives as a new message in your own conversation when the other role has finished its turn. After calling it, end your turn right away: do not wait, do not poll, do not invent the answer. The role is an id or name from role_list. Refused for an unknown or archived role, yourself, a role already in the ask chain, or when the chain is too deep or too long; then answer with what you have. Only usable inside a role conversation, not from outside one.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or name, or "main".' }, message: { type: 'string', description: 'What to say or ask. Give the other role all the context it needs; it does not see your conversation.' } }, required: ['role', 'message'] },
    run: guard((a, ctx) => ask.ask(a, ctx, askDeps)) },
  { name: 'group_create',
    description: 'Create a group chat (a room) the owner can pick in the chat page, like making a group in a messaging app. Use when the owner asks to make or start a group chat with some roles, in any language. members are role names or ids (from role_list; create the roles first if they do not exist). The main bot is always in the group and is its lead: a message with no @mention goes to it, "@everyone" wakes all, "@<role id>" wakes one role. Each role answers with its own persona, engine and conversation. The group appears in the chat page within seconds. Needs the rooms module to be on.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The group name the owner chose, 1-40 characters, any language. Must be unique among groups.' }, members: ROLE_LIST('Role names or ids to put in the group (at least one).') }, required: ['name', 'members'] },
    run: guard((a, ctx) => { needRooms(ctx); const g = groupsOfCtx(ctx).create({ name: a.name, members: a.members }, ctx); groupNote(ctx, 'group_created', g); return g; }) },
  { name: 'group_update',
    description: 'Rename a group chat and/or add roles to it and/or remove roles from it. Use when the owner asks to rename a group, to add someone to it or to take someone out. The group is an id (from group_list) or its current name. The main bot cannot be removed. The conversation history is kept. Needs the rooms module to be on.',
    inputSchema: { type: 'object', properties: { group: GROUP_KEY, name: { type: 'string', description: 'New name (optional).' }, add: ROLE_LIST('Role names or ids to add (optional).'), remove: ROLE_LIST('Role names or ids to take out (optional).') }, required: ['group'] },
    run: guard((a, ctx) => { needRooms(ctx); if (typeof a.group !== 'string' || !a.group.trim()) throw new Error('group is required (a group id or name)'); const g = groupsOfCtx(ctx).update(a.group, { name: a.name, add: a.add, remove: a.remove }, ctx); groupNote(ctx, 'group_updated', g); return g; }) },
  { name: 'group_remove',
    description: 'Remove a group chat from the chat page. Use when the owner asks to delete or close a group. Nothing is deleted: the group is only hidden (archived) and its transcript is kept. The group is an id or its name.',
    inputSchema: { type: 'object', properties: { group: GROUP_KEY }, required: ['group'] },
    run: guard((a, ctx) => { needRooms(ctx); if (typeof a.group !== 'string' || !a.group.trim()) throw new Error('group is required (a group id or name)'); const g = groupsOfCtx(ctx).archive(a.group, ctx); groupNote(ctx, 'group_archived', g); return { id: g.id, name: g.name, archived: true }; }) },
  { name: 'group_list',
    description: 'List the group chats with id, name, lead and members (id and name). Use before changing or removing a group, or when the owner asks which groups exist. Needs the rooms module to be on.',
    inputSchema: { type: 'object', properties: {} },
    run: guard((a, ctx) => { needRooms(ctx); return { groups: groupsOfCtx(ctx).list(ctx) }; }) },
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

  // Before each engine turn: when the task belongs to a role, tell the agent which persona it speaks as.
  prepareTurn(ctx) {
    const bot = botOfTask(ctx.task_id, ctx.config);
    if (!/^r-[0-9a-f]{8}$/.test(bot)) return null;
    const r = storeOfCtx(ctx).get(bot);
    if (!r || r.archived_at || r.id !== bot) return null;
    return { context: [
      `This session is the role "${r.name}". The persona below was written by the owner. Answer in this persona. It changes voice and character only: every tool, MCP server and skill stays available and you should use them normally.`,
      r.persona,
    ] };
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
    dynamicBots() { return storeOf(this).list().map(r => ({ id: r.id, name: r.name })); },
    list() { return storeOf(this).list(); },
    all() { return storeOf(this).all(); },
    get(key) { return storeOf(this).get(key); },
    create(v) { return storeOf(this).create(v); },
    update(key, v) { return storeOf(this).update(key, v); },
    archive(key) { return storeOf(this).archive(key); },
    mcpTools,
  },
};
