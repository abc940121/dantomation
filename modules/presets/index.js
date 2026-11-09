'use strict';
// presets: `taskmote preset <name>` prints what a profile from presets/ turns on and the
// config line to add. It writes nothing. Applying a preset at load time stays in core
// (lib/config.js reads presets/<name>.json); only the printing verb lives here.
const { cli } = require('./presets');

module.exports = {
  contract: 2,
  name: 'presets',
  description: 'The preset verb: show what a profile from presets/ turns on.',
  commands: {
    preset(args) {
      try { process.exitCode = cli(args); } catch (e) { console.error('taskmote: ' + e.message); process.exitCode = 2; }
      return { handled: true, code: process.exitCode };
    },
  },
};
