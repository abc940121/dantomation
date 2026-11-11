#!/usr/bin/env node
'use strict';
// Every process the server, CLI or modules start must pass windowsHide, or a console window flashes
// on the owner's Windows desktop. Scans bin/, lib/ and modules/*/ (not test/ or vendor/ folders) for
// child_process spawn/spawnSync/execFile/execFileSync/exec/execSync/fork calls and fails when the
// call's argument text has no windowsHide. No processes are started.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FNS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

let ok = true;
const check = (name, c, info) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${!c && info !== undefined ? '  -> ' + JSON.stringify(info).slice(0, 300) : ''}`); };

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'test' || e.name === 'vendor' || e.name === 'node_modules' || e.name === '.git') continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// text of the call's parentheses, starting at the "(" at index i (skips strings, templates, comments, regex-free enough for our code)
function argText(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '(') depth++;
    else if (ch === ')') { if (--depth === 0) return src.slice(i, j + 1); }
    else if (ch === '"' || ch === "'" || ch === '`') {
      for (j++; j < src.length && src[j] !== ch; j++) if (src[j] === String.fromCharCode(92)) j++;
    } else if (ch === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; }
    else if (ch === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2); if (j < 0) break; }
  }
  return src.slice(i);
}

function calls(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/require\(\s*['"](node:)?child_process['"]\s*\)/.test(src)) return [];
  // names bound from child_process: destructured, or used as require('child_process').name(
  const bound = new Set();
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
    for (const part of m[1].split(',')) { const [k, v] = part.split(':').map(s => s.trim()); if (k) bound.add(v || k); }
  }
  const found = [];
  const re = /(require\(\s*['"](?:node:)?child_process['"]\s*\)\.|(?<![\w$.]))(\w+)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const name = m[2];
    if (!FNS.includes(name)) continue;
    if (!m[1] && !bound.has(name)) continue;
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue; // a declaration, not a call
    const open = m.index + m[0].length - 1;
    const line = src.slice(0, m.index).split('\n').length;
    found.push({ name, line, text: argText(src, open) });
  }
  return found;
}

const files = [];
for (const d of ['bin', 'lib']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d), files);
for (const m of fs.existsSync(path.join(ROOT, 'modules')) ? fs.readdirSync(path.join(ROOT, 'modules')) : []) {
  const d = path.join(ROOT, 'modules', m);
  if (fs.statSync(d).isDirectory()) walk(d, files);
}

let total = 0;
const missing = [];
for (const f of files) {
  for (const c of calls(f)) {
    total++;
    if (!/\bwindowsHide\b/.test(c.text)) missing.push(`${path.relative(ROOT, f).split(path.sep).join('/')}:${c.line} ${c.name}()`);
  }
}
check('scanner finds process-starting calls', total > 0, { total });
for (const m of missing) console.log(`FAIL missing windowsHide: ${m}`);
check('every child_process call passes windowsHide', missing.length === 0);
console.log(`${total} calls scanned in ${files.length} files`);
process.exit(ok ? 0 : 1);
