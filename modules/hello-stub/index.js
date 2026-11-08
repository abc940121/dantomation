'use strict';
// hello-stub: the module template. It uses every part of module contract 1 once
// (see docs/MODULES.md) and does nothing useful. Off by default. Copy this folder
// to modules/<your-name>/, rename, and delete the parts you do not need.
const { isShell } = require('../../lib/shell');

let ticks = 0, tasks = 0;

module.exports = {
  contract: 1,
  name: 'hello-stub',
  description: 'Template module: one of every contract part.',
  runsOn: 'main',
  priority: 0,
  dependsOn: [], // names of modules this one reaches through ctx.api(name); none here
  emits: [],     // extra event prefixes besides its own name ("hello-stub.*")

  // Hook (may be async; core awaits it, cut off after modules_hook_timeout_ms):
  // block a shell command containing the block_word setting (off when empty).
  beforeTool({ tool, ti, settings }) {
    const w = settings.block_word;
    if (!w || !isShell(tool) || !String((ti && ti.command) || '').includes(w)) return null;
    return ['hello_stub', `the word "${w}" is blocked by hello-stub`];
  },

  // Command: `harness hello [name]` / `dantomation hello [name]`.
  commands: {
    // ctx.state.append writes a journal record tagged module: "hello-stub".
    async hello(args, ctx) {
      const name = args.join(' ') || 'world';
      console.log(`${ctx.settings.greeting}, ${name}`);
      ctx.state.append({ type: 'hello_greeted', name });
      await ctx.emit('hello-stub.greeted', { name });
      return { handled: true, code: 0 };
    },
  },

  // Route: GET /m/hello-stub/hello?name=x -> {greeting}. access: owner (default),
  // worker or public-get; ctx.actor says who is calling. A throw becomes a generic 500.
  routes: [{
    method: 'GET', path: '/hello', description: 'a greeting', access: 'owner',
    handler: ({ query, settings }) => ({ status: 200, json: { greeting: `${settings.greeting}, ${(query && query.name) || 'world'}` } }),
  }],

  // Core events: run after core's journal write; a throw is reported, never fatal.
  on: { 'task.start': () => { tasks++; } },

  // Status lines for `dantomation status`.
  // Secrets are read only through ctx.secret(key) (value or null); ctx.settings shows
  // a secret only as "configured" / "missing".
  statusLines: (J, ctx) => (ctx.secret('api_token') === null ? [] : ['hello-stub: token configured']),

  // Before each engine turn: extra prompt lines (null or { context: [strings] }).
  // Every hook ctx also has ctx.signal (aborted on timeout) and ctx.tasks (S1; rejects until then).
  prepareTurn: ({ resumed }) => ({ context: resumed ? ['hello-stub: this task was resumed'] : [] }),

  // Contributions others list through registry.providers(kind): tools, bots, engines.
  provides: { tools: [{ id: 'hello', description: 'says hello' }] },

  // State layout version; migrate(fromVersion, ctx) runs once when the stored one is older.
  stateVersion: 1,
  migrate() {},
  // The owner ran `harness uninstall hello-stub`: clean up anything outside
  // state/m/hello-stub/ (core removes that folder and the secrets file).
  uninstall() {},

  // Panel: ui/hello.js mounts into the sidebar.
  panels: [{ id: 'hello', title: 'Hello', mount: 'sidebar', entry: 'ui/hello.js' }],

  // Job: every 60 s, count a tick.
  jobs: [{ id: 'tick', every: 60, run() { ticks++; } }],

  // Settings: config section "hello_stub".
  settings: {
    greeting: { type: 'string', default: 'hello', description: 'word the command and route greet with' },
    block_word: { type: 'string', default: '', description: 'shell commands containing this are blocked; empty = off' },
    // Write-only: set with `node bin/harness.js secret hello-stub api_token` (value on stdin).
    // ctx.secret('api_token') is the value or null; settings and listings show configured / missing.
    api_token: { type: 'secret', description: 'example secret, unused' },
  },

  // Module-specific exports; core never calls these.
  api: { ticks: () => ticks, tasks: () => tasks },
};
