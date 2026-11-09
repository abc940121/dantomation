'use strict';
// guard-base: generic dangerous operations, the same for every owner (rules.js).
const rules = require('./rules');
const redline = require('./redline');
const { isShell } = require('../../lib/shell');

// Hard blocks first, then the red lines ("ask:" kinds ask the owner; self_modify blocks).
function beforeTool({ tool, ti, cwd }) {
  if (isShell(tool)) { const c = String(ti.command || ''); return rules.shellRules(c, cwd) || redline.shellRedline(c.replace(/\s+/g, ' ')); }
  return rules.fileRules(tool, ti) || redline.fileRedline(tool, ti, cwd) || redline.urlRedline(tool, ti);
}

module.exports = {
  contract: 2,
  name: 'guard-base',
  hookTimeoutMs: 1000, // beforeTool is a cheap synchronous check
  runsOn: ['main', 'worker'],
  description: 'Blocks generic dangerous operations (destructive shell commands, secret writes, protected files).',
  beforeTool,
  api: { rules, redline, beforeTool },
};
