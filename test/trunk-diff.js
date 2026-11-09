#!/usr/bin/env node
'use strict';
// Trunk-diff check (module contract v2): a module branch changes only files under
// modules/<name>/. Usage:
//   node test/trunk-diff.js <base-ref> [--module <name>] [--head <ref>]
//   (or TRUNK_BASE=<ref>; with no base the check prints SKIP and exits 0)
// Every non-merge commit in <base>..<head> is checked; a file outside modules/<name>/
// fails the check. --module restricts the allowed folder to that one module; without
// XX Exit 0 ok/skip, 1 violation, 2 usage/git error.
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
function opt(name) { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; }
const module_ = opt('--module');
const head = opt('--head') || 'HEAD';
const base = args[0] || process.env.TRUNK_BASE;
const cwd = process.env.TRUNK_REPO || path.resolve(__dirname, '..');

if (!base) { console.log('SKIP: no base ref given (node test/trunk-diff.js <base-ref>)'); process.exit(0); }
const git = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });

const SEP = '\x1e';
const log = git('log', '--no-merges', `--format=${SEP}%H%x09%s`, '--name-only', `${base}..${head}`);
if (log.status !== 0) { console.error('git log failed: ' + (log.stderr || '').trim()); process.exit(2); }

// The v2 commit predates the doc rule (its doc has no changelog table); it is exempt by sha.
const GRANDFATHERED = new Set(['acaac4db2846af31b8086fec36968eee24a69ef6']);
const DOC = 'docs/module-contract.md';
// True when commit `sha` adds a new "Version: **contract vN**" line and a changelog row "| N |" with that N.
function bumpsContract(sha) {
  const d = git('show', '--format=', '-U0', sha, '--', DOC);
  if (d.status !== 0) return false;
  const added = d.stdout.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
  const v = added.map(l => /^Version: \*\*contract v(\d+)\*\*\s*$/.exec(l)).find(Boolean);
  return !!v && added.some(l => new RegExp('^\\|\\s*' + v[1] + '\\s*\\|').test(l));
}

const allowed = f => module_ ? f.startsWith(`modules/${module_}/`) : /^modules\/[a-z0-9][a-z0-9-]*\/./.test(f);
const bad = [], exempt = [], ok = new Set();
for (const chunk of log.stdout.split(SEP).filter(Boolean)) {
  const [first, ...rest] = chunk.split('\n');
  const [sha, subject] = [first.slice(0, first.indexOf('\t')), first.slice(first.indexOf('\t') + 1)];
  const files = rest.map(l => l.trim()).filter(Boolean);
  if (/^contract:/.test(subject) && (GRANDFATHERED.has(sha) || bumpsContract(sha))) { exempt.push(`${sha.slice(0, 8)} ${subject} (${files.length} file(s))`); continue; }
  for (const f of files) (allowed(f) ? ok.add(f) : bad.push(`${f}  (${sha.slice(0, 8)} ${subject})`));
}
console.log(`trunk-diff ${base}..${head}: ${ok.size} module file(s), ${exempt.length} contract commit(s) exempt, ${bad.length} outside${module_ ? ` modules/${module_}/` : ' modules/<name>/'}`);
for (const e of exempt) console.log('  exempt: ' + e);
for (const b of bad) console.log('  FAIL outside module folder: ' + b);
process.exit(bad.length ? 1 : 0);
