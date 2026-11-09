#!/usr/bin/env node
'use strict';
// Alias: dantomation is the old name of taskmote. Forwards args, stdio and exit code.
const path = require('path');
const { spawnSync } = require('child_process');
const r = spawnSync(process.execPath, [path.join(__dirname, 'taskmote.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) { console.error('dantomation (alias of taskmote): ' + r.error.message); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);
