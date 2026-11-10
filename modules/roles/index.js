'use strict';
// roles: owner-made roles. A role is a bot registered at run time: its own conversation (a full agent
// session) plus a persona text added to its prompt. The core lists dynamicBots() of every module next
// to the configured bots, so a new role needs no restart. Off by default. See README.md.
const path = require('path');
const J = require('../../lib/journal');
const { createStore, RoleError, ENGINES } = require('./store');

// api functions run with this.ctx when a module calls them (ctx.api) and without it when core does:
// then the state folder is the same fixed path the loader gives this module.
const dirOf = self => (self && self.ctx && self.ctx.state ? self.ctx.state.dir : path.join(J.STATE, 'm', 'roles'));
const storeOf = self => createStore(() => dirOf(self));
const storeOfCtx = ctx => createStore(() => ctx.state.dir);

const pub = r => ({ id: r.id, name: r.name, persona: r.persona, engine: r.engine || 'claude' });
const ENGINE_PROP = { type: 'string', enum: ENGINES, description: 'Which agent runs this role: "claude" (default) or "codex" (OpenAI Codex, "GPT"). Use "codex" when the owner asks for GPT / Codex / OpenAI. Optional.' };
const note = (ctx, type, r) => { try { ctx.state.append({ type, id: r.id, name: r.name }); } catch { /* the journal note is best effort */ } };
const asError = e => (e instanceof RoleError ? new Error(e.message) : e);
const guard = fn => (args, ctx) => { try { return fn(args && typeof args === 'object' ? args : {}, ctx); } catch (e) { throw asError(e); } };
const roleKey = a => { if (typeof a.role !== 'string' || !a.role.trim()) throw new Error('role is required (a role id or name)'); return a.role; };

const mcpTools = [
  { name: 'role_create',
    description: 'Create a custom role (a named persona the owner can pick in the chat page and talk to as its own separate conversation). Use when the owner asks to create or add a role or character, e.g. "make a role called X who is ..." in any language. The role appears in the chat page within seconds. It keeps all tools; the persona changes only voice and character.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Short name, 1-40 characters, any language. Must be unique among roles.' }, persona: { type: 'string', description: 'The persona text: who the role is and how it speaks and behaves (max 4000 characters).' }, engine: ENGINE_PROP }, required: ['name', 'persona'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).create({ name: a.name, persona: a.persona, engine: a.engine }); note(ctx, 'role_created', r); return pub(r); }) },
  { name: 'role_update',
    description: 'Change the name, persona and/or engine of an existing role. Use when the owner asks to rename a role, to change its personality, voice or instructions, or to move it to GPT / Codex / OpenAI (engine "codex") or back to Claude (engine "claude"). The role is an id (from role_list) or its current name. Its conversation history is kept.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or current name.' }, name: { type: 'string', description: 'New name (optional).' }, persona: { type: 'string', description: 'New persona text, replacing the old one (optional).' }, engine: ENGINE_PROP }, required: ['role'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).update(roleKey(a), { name: a.name, persona: a.persona, engine: a.engine }); note(ctx, 'role_updated', r); return pub(r); }) },
  { name: 'role_remove',
    description: 'Remove a role from the chat page. Use when the owner asks to delete or remove a role. Nothing is deleted: the role is only hidden (archived) and its conversation is kept. The role is an id or its name.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'Role id or name.' } }, required: ['role'] },
    run: guard((a, ctx) => { const r = storeOfCtx(ctx).archive(roleKey(a)); note(ctx, 'role_archived', r); return { id: r.id, name: r.name, archived: true }; }) },
  { name: 'role_list',
    description: 'List the current roles with id, name, persona and engine (claude or codex). Use before changing or removing a role, or when the owner asks which roles exist.',
    inputSchema: { type: 'object', properties: {} },
    run: guard((a, ctx) => ({ roles: storeOfCtx(ctx).list().map(pub) })) },
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

module.exports = {
  contract: 2,
  name: 'roles',
  description: 'Owner-made roles: bots registered at run time, each its own conversation with a persona text.',
  runsOn: 'main',
  priority: 61,

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

  // Which engine runs the turn: "codex" for a role set to the Codex engine, else no opinion (Claude). The core maps the
  // key through config "engines" (see README). Sync and cheap: the bot comes from the workdir folder name (bot-<id>),
  // else from the task as prepareTurn finds it.
  chooseEngine(turn, ctx) {
    const m = /^bot-(r-[0-9a-f]{8})$/.exec(path.basename(String((turn && turn.workdir) || '')));
    const bot = m ? m[1] : botOfTask(turn && turn.task_id, null);
    if (!/^r-[0-9a-f]{8}$/.test(bot)) return null;
    const r = storeOfCtx(ctx).get(bot);
    return r && !r.archived_at && r.id === bot && r.engine === 'codex' ? 'codex' : null;
  },

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
