'use strict';
// Append one JSON line to logs/<file> (HARNESS_LOG_DIR overrides the folder).
const fs = require('fs');
const path = require('path');
const LOGS = () => process.env.HARNESS_LOG_DIR || path.join(path.resolve(__dirname, '..'), 'logs');
function log(file, rec) {
  fs.mkdirSync(LOGS(), { recursive: true });
  fs.appendFileSync(path.join(LOGS(), file), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
}
module.exports = { log };
