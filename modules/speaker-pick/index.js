'use strict';
// speaker-pick: in a room with several bots, when a human message names nobody, choose
// the next speaker (round_robin, keyword, or a cheap model). Off by default. It only
// advises: rooms (or the owner) asks POST /m/speaker-pick/pick; see README.md for the
// seam rooms would need. Journals {room, bot, mode, reason}, never message text.
const { mutating, isShell } = require('../../lib/shell');
const S = require('./lib/select');

const inTask = () => !!process.env.HARNESS_TASK_ID;
const mem = S.newMemory();
let modelFn = null; // injected; contract v6 ctx.engines.run (pending) will supply it
const setModelFn = fn => { modelFn = typeof fn === 'function' ? fn : null; return () => { if (modelFn === fn) modelFn = null; }; };

const optsOf = s => ({ mode: s.mode, bots: s.bots, maxConsecutive: s.max_consecutive, maxAutoTurns: s.max_auto_turns,
  modelTimeoutMs: s.model_timeout_ms, recentMessages: s.recent_messages, modelFn });

async function pickRoute(ctx) {
  const b = ctx.body;
  if (!b || typeof b !== 'object' || typeof b.text !== 'string' || !Array.isArray(b.members)) return { status: 400, json: { error: 'body needs {room, text, members:[{id}]}' } };
  const res = await S.pick({ room: b.room, text: b.text, members: b.members, recent: b.recent, fromBot: b.from_bot === true, msgId: b.msg_id }, optsOf(ctx.settings), mem);
  ctx.state.append({ type: 'speaker_pick', room: String(b.room || ''), bot: res.bot, mode: res.mode, reason: res.reason });
  return { status: 200, json: res };
}

// An agent may not call the owner route or edit this module's config from a task.
function beforeTool({ tool, ti }) {
  if (!inTask()) return null;
  const cmd = String((ti && ti.command) || '');
  if (isShell(tool) && /\/m\/speaker-pick(?![\w-])/i.test(cmd)) return ['speaker_pick', 'the speaker-pick API is for the owner only'];
  const touches = /speaker[_-]pick/i.test(JSON.stringify(ti || {})) && /config/i.test(JSON.stringify(ti || {}));
  if (touches && mutating(tool, ti)) return ['speaker_pick', 'speaker-pick settings are changed by the owner, not by agents'];
  return null;
}

module.exports = {
  contract: 2,
  name: 'speaker-pick',
  description: 'Picks the next bot to speak in a room when a message names no bot (round robin, keyword, or cheap model).',
  runsOn: 'main',
  priority: 60,
  hookTimeoutMs: 1000, // beforeTool and statusLines are synchronous checks
  beforeTool,
  routes: [{ method: 'POST', path: '/pick', access: 'owner', description: 'choose a speaker: body {room, text, members:[{id,name?,description?}], recent?, from_bot?, msg_id?} -> {bot|null, mode, reason}', handler: pickRoute }],
  statusLines: (J, ctx) => [`speaker-pick: mode ${ctx.settings.mode}, ${Object.keys(ctx.settings.bots || {}).length} bot descriptions`],
  settings: {
    mode: { type: 'string', default: 'round_robin', enum: ['round_robin', 'keyword', 'model'], description: 'how the next speaker is chosen when nobody is mentioned' },
    bots: { type: 'object', default: {}, description: 'bot id -> short description or keywords (keyword and model fallback scoring)' },
    max_consecutive: { type: 'integer', default: 2, min: 1, description: 'the same bot is not picked more than this many times in a row in one room' },
    max_auto_turns: { type: 'integer', default: 1, min: 1, max: 3, description: 'automatic picks per human message' },
    model_timeout_ms: { type: 'integer', default: 3000, min: 100, max: 60000, description: 'give up on the model answer after this long and fall back' },
    recent_messages: { type: 'integer', default: 4, min: 1, max: 20, description: 'last messages shown to the model' },
  },
  api: { pick: (input, opts) => S.pick(input, opts, mem), setModelFn },
};
