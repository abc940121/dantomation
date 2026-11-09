'use strict';
// scaffold: `taskmote new-module <name> [--from-skill <dir>] [--force]` writes a new
// module folder under modules/ (see docs/MODULES.md, "From a skill"). It was a
// trunk verb; it is now this module's command. Turning the module off removes only the verb.
const { cli } = require('./scaffold');

module.exports = {
  contract: 2,
  name: 'scaffold',
  description: 'The new-module verb: turn a skill folder into a module folder.',
  commands: {
    'new-module'(args) {
      try { process.exitCode = cli(args); } catch (e) { console.error('taskmote: ' + e.message); process.exitCode = 2; }
      return { handled: true, code: process.exitCode };
    },
  },
};
