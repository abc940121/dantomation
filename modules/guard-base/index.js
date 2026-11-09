'use strict';
// guard-base: generic dangerous operations, the same for every owner (rules.js).
const rules = require('./rules');
const { isShell } = require('../../lib/shell');

function beforeTool({ tool, ti, cwd }) {
  return isShell(tool) ? rules.shellRules(String(ti.command || ''), cwd) : rules.fileRules(tool, ti);
}

module.exports = {
  contract: 2,
  name: 'guard-base',
  runsOn: ['main', 'worker'],
  description: 'Blocks generic dangerous operations (destructive shell commands, secret writes, protected files).',
  beforeTool,
  api: { rules, beforeTool },
};
