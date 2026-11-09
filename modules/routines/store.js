'use strict';
// Routine definitions + run counters in one JSON file under ctx.state.dir, written atomically.
const fs = require('fs');
const path = require('path');

const FILE = 'routines.json';
const empty = () => ({ v: 1, routines: {}, day: '', runs_today: 0 });

function load(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    if (s && s.v === 1 && s.routines && typeof s.routines === 'object') return { ...empty(), ...s };
  } catch { /* missing or unreadable: start empty */ }
  return empty();
}

function save(dir, s) {
  const f = path.join(dir, FILE), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, f);
}

// One writer at a time (routes and the job share this process).
let chain = Promise.resolve();
function locked(fn) {
  const r = chain.then(fn);
  chain = r.catch(() => {});
  return r;
}

module.exports = { load, save, locked };
