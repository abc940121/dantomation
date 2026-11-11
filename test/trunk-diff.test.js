#!/usr/bin/env node
'use strict';
// Tests test/trunk-diff.js against a temp git repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'trunk-diff.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-trunkdiff-'));
const git = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' , windowsHide: true }); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
const put = (f, t = 'x\n') => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t + Math.random()); };
const commit = (msg, ...files) => { files.forEach(f => put(f)); git('add', '-A'); git('commit', '-m', msg); };
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: dir, env: { ...process.env, TRUNK_REPO: dir, TRUNK_BASE: '' }, encoding: 'utf8' , windowsHide: true });

let fails = 0;
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + info}`); if (!cond) fails++; };

try {
  git('init', '-q', '-b', 'main');
  commit('trunk', 'lib/a.js', 'modules/old/index.js');
  const base = git('rev-parse', 'HEAD');

  let r = run();
  check('no base -> SKIP, exit 0', r.status === 0 && /^SKIP:/m.test(r.stdout), r.stdout + r.stderr);

  git('checkout', '-q', '-b', 'good');
  commit('add mod', 'modules/new/index.js', 'modules/new/test/t.js');
  r = run(base);
  check('only module files -> exit 0', r.status === 0 && /2 module file/.test(r.stdout), r.stdout + r.stderr);
  r = run(base, '--module', 'new');
  check('--module matching -> exit 0', r.status === 0, r.stdout);
  r = run(base, '--module', 'other');
  check('--module other -> exit 1', r.status === 1, r.stdout);

  commit('touch lib', 'lib/a.js');
  r = run(base);
  check('trunk file changed -> exit 1 and names it', r.status === 1 && /lib\/a\.js/.test(r.stdout), r.stdout);

  // a doc with a version line and a changelog table; docText(v, n) has rows 1..n
  const docText = (v, n) => `Version: **contract v${v}**

## Changelog

| Version | Change |
|---|---|
${Array.from({ length: n }, (_, i) => `| ${i + 1} | change ${i + 1} |
`).join('')}`;
  const putDoc = (v, n) => { fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs/module-contract.md'), docText(v, n)); };
  git('checkout', '-q', '-b', 'docbase', base);
  putDoc(2, 2); git('add', '-A'); git('commit', '-m', 'add contract doc');
  const docBase = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'bump', docBase);
  putDoc(3, 3); put('lib/a.js'); git('add', '-A'); git('commit', '-m', 'contract: v3 adds field');
  commit('add mod2', 'modules/two/index.js');
  r = run(docBase);
  check('contract: subject + doc bump (version + changelog row) is exempt', r.status === 0 && /1 contract commit/.test(r.stdout), r.stdout);

  git('checkout', '-q', '-b', 'nodoc', docBase);
  commit('contract: sneak a lib change', 'lib/a.js');
  r = run(docBase);
  check('contract: subject with no doc change fails', r.status === 1 && r.stdout.includes("lib/a.js") && /0 contract commit/.test(r.stdout), r.stdout);

  git('checkout', '-q', '-b', 'docnosubject', docBase);
  putDoc(3, 3); put('lib/a.js'); git('add', '-A'); git('commit', '-m', 'change lib and bump doc');
  r = run(docBase);
  check('doc change without the contract: subject still fails', r.status === 1 && r.stdout.includes("lib/a.js"), r.stdout);

  git('checkout', '-q', '-b', 'halfbump', docBase);
  put('docs/module-contract.md', 'Version: **contract v2**\n| 3 | row only |\n'); put('lib/a.js'); git('add', '-A'); git('commit', '-m', 'contract: row but no version change');
  r = run(docBase);
  check('contract: subject with a changelog row but no version line fails', r.status === 1 && r.stdout.includes("lib/a.js"), r.stdout);

  git('checkout', '-q', '-b', 'sneaky', base);
  commit('add mod3 and README', 'modules/three/index.js', 'README.md');
  r = run(base);
  check('mixed commit fails', r.status === 1 && /README\.md/.test(r.stdout), r.stdout);

  r = run('no-such-ref');
  check('bad ref -> exit 2', r.status === 2, r.stdout + r.stderr);
} catch (e) { console.log('FAIL exception ' + e.message); fails++; }
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `result: ${fails} FAIL` : 'result: all PASS');
process.exit(fails ? 1 : 0);
