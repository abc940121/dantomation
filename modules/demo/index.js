'use strict';
// demo: `taskmote demo`, a 60-second tour in a throwaway sandbox (see README.md).
// bin/taskmote.js makes the sandbox and points HARNESS_CONFIG/STATE/WORK/LOG at it before any
// config loads; this command refuses to run outside it.
module.exports = {
  contract: 2,
  name: 'demo',
  description: 'A 60-second tour in a throwaway sandbox: a guarded edit, a hard block, a live approval card, crash and resume, undo.',
  runsOn: 'main',
  dependsOn: [],
  commands: { demo: (args, ctx) => require('./demo').demo(args, ctx) },
};
