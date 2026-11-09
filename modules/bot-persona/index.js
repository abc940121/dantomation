'use strict';
// bot-persona: owner-written persona text and a short memory file per bot,
// added to the bot's prompt at the start of each turn (prepareTurn) as a labeled
// block of owner-provided data. Off by default. See README.md.
const fs = require('fs');
const J = require('../../lib/journal');
const { createStore, checkBot, checkPart, checkText, InputError, PARTS, BOT_RE } = require('./store');
const { build } = require('./inject');

const TURN_LIMIT = 8000; // docs/MODULES.md: prepareTurn context is clipped at 8000 characters per module

const storeOf = ctx => createStore(ctx.state.dir);
const maxOf = (s, part) => (part === 'persona' ? s.max_persona_bytes : s.max_memory_bytes);
const limits = s => ({ persona_bytes: s.max_persona_bytes, memory_bytes: s.max_memory_bytes });

// Known bots: config "bots" ids, or just "main" when none are configured (as the server does).
function knownBots(config) {
  const b = config && config.bots;
  return Array.isArray(b) && b.length ? b.map(x => String(x && x.id)) : ['main'];
}
function requireKnown(ctx, bot) {
  checkBot(bot);
  if (!knownBots(ctx.config).includes(bot)) throw Object.assign(new InputError('unknown bot'), { notFound: true });
}

// The bot of a task: the bot field of its task_start record, else HARNESS_BOT, else the default bot.
function botOfTask(taskId, config) {
  let bot = null;
  try {
    for (const r of J.readAll().records) if (r.type === 'task_start' && r.task_id === taskId && typeof r.bot === 'string') bot = r.bot;
  } catch { /* journal unreadable: fall through */ }
  return bot || process.env.HARNESS_BOT || knownBots(config)[0];
}

function view(ctx, bot) {
  const st = storeOf(ctx), p = st.get(bot, 'persona'), m = st.get(bot, 'memory');
  return { bot, persona: p, memory: m, bytes: { persona: Buffer.byteLength(p), memory: Buffer.byteLength(m) }, limits: limits(ctx.settings) };
}

function apply(ctx, bot, body) {
  requireKnown(ctx, bot);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('body must be an object');
  const keys = Object.keys(body);
  if (!keys.length) throw new InputError('give persona and/or memory');
  if (keys.some(k => !PARTS.includes(k))) throw new InputError('unknown field (allowed: persona, memory)');
  const next = {};
  for (const k of keys) next[k] = checkText(body[k], maxOf(ctx.settings, k), k); // validate everything before writing anything
  const st = storeOf(ctx);
  for (const k of keys) { if (next[k] === '') st.clear(bot, k); else st.set(bot, k, next[k]); }
  ctx.state.append({ type: 'bot_persona_set', bot, parts: keys, bytes: Object.fromEntries(keys.map(k => [k, Buffer.byteLength(next[k])])) });
}

const wrap = fn => async ctx => {
  try { return await fn(ctx); }
  catch (e) {
    if (e instanceof InputError) return { status: e.notFound ? 404 : 400, json: { error: e.message } };
    throw e; // generic 500 from core
  }
};

module.exports = {
  contract: 1,
  name: 'bot-persona',
  description: 'Per-bot persona text and memory notes from the owner, added to the bot prompt as labeled data.',
  runsOn: 'main',
  priority: 60,

  routes: [
    { method: 'GET', path: '/bots', description: 'bots that have a stored persona or memory, and the size limits', access: 'owner',
      handler: wrap(ctx => ({ status: 200, json: { bots: storeOf(ctx).list(), known: knownBots(ctx.config), limits: limits(ctx.settings) } })) },
    { method: 'GET', path: '/bots/:bot', description: 'persona and memory text of one bot', access: 'owner',
      handler: wrap(ctx => { requireKnown(ctx, ctx.params.bot); return { status: 200, json: view(ctx, ctx.params.bot) }; }) },
    { method: 'PUT', path: '/bots/:bot', description: 'set {persona?, memory?}; an empty string clears that part', access: 'owner',
      handler: wrap(ctx => { apply(ctx, ctx.params.bot, ctx.body); return { status: 200, json: view(ctx, ctx.params.bot) }; }) },
    { method: 'DELETE', path: '/bots/:bot', description: 'clear persona and memory; ?part=persona|memory clears one', access: 'owner',
      handler: wrap(ctx => {
        const bot = ctx.params.bot; requireKnown(ctx, bot);
        const part = ctx.query && ctx.query.part;
        const parts = part === undefined || part === '' ? PARTS : [checkPart(part)];
        const st = storeOf(ctx);
        const cleared = parts.filter(p => st.clear(bot, p));
        ctx.state.append({ type: 'bot_persona_cleared', bot, parts: cleared });
        return { status: 200, json: { bot, cleared } };
      }) },
  ],

  commands: {
    // harness persona list | show <bot> | clear <bot> [persona|memory] | set <bot> <persona|memory>   (text on stdin)
    async persona(args, ctx) {
      if (process.env.HARNESS_TASK_ID) { console.error('persona: owner only; refused inside a task'); return { handled: true, code: 2 }; }
      const [verb, bot, part] = args;
      const c = { state: ctx.state, settings: ctx.settings, config: ctx.config };
      try {
        if (verb === 'list') { console.log(storeOf(c).list().join('\n') || '(none)'); return { handled: true, code: 0 }; }
        if (verb === 'show') { requireKnown(c, bot); const v = view(c, bot); console.log(`persona (${v.bytes.persona} bytes):\n${v.persona}\n\nmemory (${v.bytes.memory} bytes):\n${v.memory}`); return { handled: true, code: 0 }; }
        if (verb === 'clear') {
          requireKnown(c, bot); const parts = part ? [checkPart(part)] : PARTS; const st = storeOf(c);
          const cleared = parts.filter(p => st.clear(bot, p)); c.state.append({ type: 'bot_persona_cleared', bot, parts: cleared });
          console.log(`cleared: ${cleared.join(', ') || 'nothing'}`); return { handled: true, code: 0 };
        }
        if (verb === 'set') {
          requireKnown(c, bot); checkPart(part);
          const text = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
          apply(c, bot, { [part]: text }); console.log(`${part} set for ${bot}`); return { handled: true, code: 0 };
        }
      } catch (e) {
        if (e instanceof InputError) { console.error(`persona: ${e.message}`); return { handled: true, code: 2 }; }
        throw e;
      }
      console.error('usage: persona list | show <bot> | set <bot> <persona|memory> (text on stdin) | clear <bot> [persona|memory]');
      return { handled: true, code: 2 };
    },
  },

  // The seam: prompt context at the start of each turn, labeled as owner-provided data.
  prepareTurn(ctx) {
    if (!ctx.settings.inject) return null;
    const bot = botOfTask(ctx.task_id, ctx.config);
    if (!BOT_RE.test(bot)) return null;
    const st = storeOf(ctx);
    const lines = build({ bot, persona: st.get(bot, 'persona'), memory: st.get(bot, 'memory'), limit: TURN_LIMIT - 20 });
    return lines ? { context: lines } : null;
  },

  statusLines: (J2, ctx) => { try { return [`bot-persona: ${storeOf(ctx).list().length} bot(s) with notes${ctx.settings.inject ? '' : ' (injection off)'}`]; } catch { return ['bot-persona: unreadable']; } },

  stateVersion: 1,
  migrate() {},

  settings: {
    max_persona_bytes: { type: 'integer', default: 4096, min: 1, max: 65536, description: 'largest persona text, in UTF-8 bytes' },
    max_memory_bytes: { type: 'integer', default: 24576, min: 1, max: 262144, description: 'largest memory text, in UTF-8 bytes' },
    inject: { type: 'boolean', default: true, description: 'add the notes to the prompt at turn start (off = storage and routes only)' },
  },

  api: { botOfTask },
};
