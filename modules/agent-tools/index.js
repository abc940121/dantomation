'use strict';
// agent-tools: tell a task agent which module commands it can call. Off by default.
// prepareTurn adds a short "Tools you can call" block built from the ENABLED modules only;
// `taskmote tools [--json]` prints the same list. See README.md and DECISIONS.md.

const CAP = 1500; // chars of the block, clipped past this
const HEAD = 'Tools you can call (run in your shell, inside this task):';

// One entry per module that has something an agent may call. Keyed by module name, in the order shown.
// cmd: the command, use: one short line saying when to use it.
const TOOLS = {
  'task-grill': [{ cmd: 'taskmote grill check "<request>" --json', use: 'is a request too vague to start? returns {vague, reasons, questions}; asks no one' }],
  'question-cards': [{ cmd: 'taskmote ask "<text>" <option> <option> --free', use: 'ask the owner a question and read the answer later with: taskmote ask get <id>' }],
  digest: [{ cmd: 'taskmote digest --json', use: 'what happened recently (read only)' }],
  'quiet-hours': [{ cmd: 'taskmote quiet status --json', use: 'is the owner in quiet hours? hold non-urgent pings if so' }],
  'change-card': [{ cmd: 'taskmote changes --json', use: 'which finished tasks still wait for the owner to Keep or Undo' }],
  arena: [{ cmd: 'taskmote arena "<request>" --queue --json', use: 'try a request two ways in worktrees; starts after this task ends' }],
};

const enabled = cfg => { const m = (cfg && cfg.modules) || {}; return Object.keys(TOOLS).filter(n => m[n] === true); };
const listFor = cfg => enabled(cfg).flatMap(module => TOOLS[module].map(t => ({ module, cmd: t.cmd, use: t.use })));

function block(cfg) {
  const items = listFor(cfg);
  if (!items.length) return null;
  const text = [HEAD, ...items.map(t => `- ${t.cmd}: ${t.use}`)].join('\n');
  return text.length > CAP ? text.slice(0, CAP - 10).replace(/\s+\S*$/, '') + ' [clipped]' : text;
}

function prepareTurn(ctx) {
  try { const b = block(ctx && ctx.config); return b ? { context: [b] } : null; } catch { return null; } // never block a turn
}

function tools(args, ctx) {
  const a = (Array.isArray(args) ? args : []).map(String);
  if (a.some(x => x !== '--json')) { console.error('usage: taskmote tools [--json]'); return { handled: true, code: 2 }; }
  const items = listFor(ctx && ctx.config);
  console.log(a.includes('--json') ? JSON.stringify({ tools: items }) : (block(ctx && ctx.config) || 'no module tools are enabled'));
  return { handled: true, code: 0 };
}

module.exports = {
  contract: 2,
  name: 'agent-tools',
  description: 'Tells task agents which enabled module commands they can call (a short block in the turn prompt).',
  runsOn: 'main',
  priority: 90,
  dependsOn: [],
  prepareTurn,
  commands: { tools },
  api: { TOOLS, listFor, block, CAP },
};
