'use strict';
// guard-base: generic dangerous operations, the same for every owner (rules.js).
const rules = require('./rules');
const { isShell } = require('../../lib/shell');

module.exports = {
  name: 'guard-base',
  beforeTool({ tool, ti, cwd }) {
    return isShell(tool) ? rules.shellRules(String(ti.command || ''), cwd) : rules.fileRules(tool, ti);
  },
  rules,
};
