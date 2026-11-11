#!/usr/bin/env node
'use strict';
// Public/private boundary. Runs a synthetic task (fake engine, no model call)
// whose request carries a private marker, in the repo's REAL state/, logs/ and
// work/ dirs. Then proves the marker reached journal, outbox, guard log and the
// work dir, that all of them are git-ignored, and that the marker is in no
// tracked file, no untracked-but-addable file, and no commit.
// The marker is assembled at run time so this file itself never contains it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MARK = ['PRIVATE', 'MARKER', String(7000 + 731)].join('-');
const env = { ...process.env, HARNESS_ENGINE_SCRIPT: path.join(__dirname, 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0' };
delete env.HARNESS_STATE_DIR; delete env.HARNESS_LOG_DIR;
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 , windowsHide: true });

const s = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', `Synthetic task ${MARK}`], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 , windowsHide: true });
console.log(`synthetic task: exit ${s.status} ${s.stdout.trim()}`);
const recs = fs.readFileSync(path.join(ROOT, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return {}; } });
const startRec = recs.filter(r => r.type === 'task_start' && (r.request || '').includes(MARK)).pop();
const task = startRec.task_id;
const wdRel = path.relative(ROOT, path.resolve(ROOT, startRec.workdir || `work/${task}`)).split(path.sep).join('/');

// a guard block whose logged command carries the marker
spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 'boundary', tool_name: 'Bash', tool_input: { command: `rm -rf work/${MARK}` }, cwd: ROOT }), env, encoding: 'utf8' , windowsHide: true }); // same env as the task above: a HARNESS_LOG_DIR set by the caller must not move the guard log

const files = {
  journal: 'state/journal.jsonl',
  outbox: `state/outbox/${task}__s1-message.json`,
  'guard log': 'logs/guard.jsonl',
  'work dir file': `${wdRel}/out.txt`,
};
const res = {};
for (const [name, f] of Object.entries(files)) {
  const has = fs.existsSync(path.join(ROOT, f)) && fs.readFileSync(path.join(ROOT, f), 'utf8').includes(MARK);
  const ign = git('check-ignore', '-v', f);
  console.log(`${name}: ${f} holds marker=${has}; ignored by ${ign.stdout.trim().split('\t')[0] || 'NOTHING'}`);
  res[`${name} has marker and is git-ignored`] = has && ign.status === 0;
}
const grep = git('grep', '-n', '-F', '--untracked', MARK);
console.log(`git grep --untracked -F <marker>: exit ${grep.status} (1 = no match), ${grep.stdout.split('\n').filter(Boolean).length} lines`);
const log = git('log', '-p', '--all');
const n = log.stdout.split(MARK).length - 1;
console.log(`git log -p --all | grep -c <marker>: ${n} (searched ${log.stdout.split('\n').length} lines)`);
const st = git('status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(l => /^\?\? (state|logs|work)\//.test(l));
console.log(`git status shows state/ logs/ work/ paths: ${st.length}`);
res['marker not in tracked or addable files'] = grep.status === 1;
res['marker not in any commit'] = log.status === 0 && n === 0;
res['no runtime path visible to git status'] = st.length === 0;

// ---- owner-specific strings: tree (tracked + addable) and the history of HEAD,
// commit authors included. Only the example rules file (modules/guard-private-rules/example-private.json, earlier rules/example-private.json) may hit. Words are
// assembled at run time so this file has no hits of its own.
const j = (...p) => p.join('');
const FORBID = [
  ['owner first name', new RegExp(j('\\bD', 'an\\b'))],
  ['owner name stem', new RegExp(j('dan', 'ie'), 'i')],
  ['owner handle', new RegExp(j('abc', '940121'))],
  ['automation host', new RegExp(j('n', '8n'), 'i')],
  ['private project', new RegExp(j('for', 'um'), 'i')],
  ['private project 2', new RegExp(j('Key', 'stone'), 'i')],
  ['reviewer name', new RegExp(j('Lo', 'om'), 'i')],
  ['station name', new RegExp(j('Her', 'ta'), 'i')],
  ['station chief', new RegExp(j('站', '長'))],
  ['Windows user path', /[A-Za-z]:(\\\\|\\|\/)+Users(\\\\|\\|\/)+[A-Za-z0-9._-]+/i],
  ['msys user path', /\/[a-z]\/Users\/[A-Za-z0-9._-]+/i],
  ['key-shaped string', /(sk-ant-[A-Za-z0-9_-]{8,}|sk-(proj-)?[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/],
];
FORBID.push(['old local handle', new RegExp(j('dan', '0203'), 'i')]);
const ALLOW = 'modules/guard-private-rules/example-private.json';
const ALLOW_OLD = 'rules/example-private.json'; // same file, before it moved
// The publishing identity is allowed in exactly two forms: the commit
// author/committer line, and the LICENSE copyright line. Those whole lines are
// removed before scanning; the handle anywhere else is still a hit.
const PUB = j('abc', '940121');
const PUB_ID = `${PUB} <55071314+${PUB}@users.noreply.github.com>`;
const PUB_LINES = [`author ${PUB_ID}`, `committer ${PUB_ID}`, `Copyright (c) 2026 ${PUB}`, `+Copyright (c) 2026 ${PUB}`];
// The project name and its repo URL are allowed too (the URL holds the handle).
const NAME = j('task', 'mote');
const OLD_NAME = j('dan', 'tomation'); // the former name: still in history, in the alias shims and in provenance lines
const URL_OK = new RegExp(`(https?://)?github\\.com/${PUB}/(${NAME}|${OLD_NAME})`, 'gi');
const NAME_OK = new RegExp(`${NAME}|${OLD_NAME}`, 'gi');
const strip = text => text.split('\n').filter(l => !PUB_LINES.includes(l.replace(/\r$/, ''))).join('\n').replace(URL_OK, '').replace(NAME_OK, '');
const hits = [];
const scan = (where, text) => { text = strip(text); for (const [name, re] of FORBID) if (re.test(text)) hits.push(`${where}: ${name}`); };
// negative controls: scan() over synthetic strings, kept out of the real hit list
{
  const real = hits.length;
  const hit = t => { const n = hits.length; scan('control', t); const r = hits.length > n; hits.length = n; return r; };
  const ctl = {
    'control: the bare first name still hits': hit(`hello ${j('D', 'an')} there`),
    'control: the project name does not hit': !hit(NAME) && !hit(NAME[0].toUpperCase() + NAME.slice(1)) && !hit(OLD_NAME),
    'control: the project URL does not hit': !hit(`github.com/${PUB}/${NAME}`) && !hit(`https://github.com/${PUB}/${NAME}`),
    'control: the old handle still hits': hit(j('dan', '0203')),
    'control: the handle alone still hits': hit(`user ${PUB}`) && hit(`github.com/${PUB}/other`),
  };
  for (const [k, v] of Object.entries(ctl)) res[k] = v;
  if (hits.length !== real) throw new Error('controls leaked into hits');
}
// Vendored third-party bundles: minified code holds short letter runs that look like the words above.
// A bundle is skipped only while its git blob id is one pinned here, so an edited or swapped file is
// scanned again. A new upstream version needs its blob id added (keep the old one: it stays in history).
const VENDORED = { 'modules/chat-ui/ui/vendor/vue-advanced-chat.umd.js': ['15feb6a87bf903a76c7f3c5d6fb9cddd75d7b0b2'] };
// The history scan runs with --full-index, and a blob id counts only as the whole 40 hex digits (or all
// zeros, for an added or deleted file): a short prefix can be matched by a crafted blob.
const pinned = (f, id) => /^[0-9a-f]{40}$/.test(id) && (/^0+$/.test(id) || (VENDORED[f] || []).includes(id));
const vendoredChunk = chunk => {
  const m = /^diff --git a\/(\S+) b\/\1\n(?:(?:new|deleted) file mode \d+\n)?index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(chunk);
  return !!m && !!VENDORED[m[1]] && pinned(m[1], m[2]) && pinned(m[1], m[3]);
};
{
  const f = Object.keys(VENDORED)[0], b = VENDORED[f][0], head = `diff --git a/${f} b/${f}\n`, zero = '0'.repeat(40);
  const ctl = {
    'a pinned vendored bundle is skipped': vendoredChunk(`${head}new file mode 100644\nindex ${zero}..${b}\n`),
    'a changed bundle is not skipped': !vendoredChunk(`${head}index ${b}..${'abcdef1'.padEnd(40, '0')} 100644\n`),
    'another file with the pinned id is not skipped': !vendoredChunk(`diff --git a/x.js b/x.js\nindex ${zero}..${b}\n`),
    'a blob that shares only the id prefix is not skipped': !vendoredChunk(`${head}new file mode 100644\nindex ${zero}..${b.slice(0, 7)}\n`)
      && !vendoredChunk(`${head}new file mode 100644\nindex ${zero}..${b.slice(0, 7).padEnd(40, 'f')}\n`),
  };
  for (const [k, v] of Object.entries(ctl)) res[`control: vendored: ${k}`] = v;
}
const tree = git('ls-files', '-co', '--exclude-standard').stdout.split('\n').filter(Boolean);
for (const f of tree) {
  if (f === ALLOW) continue;
  if (VENDORED[f] && VENDORED[f].includes(git('hash-object', '--', f).stdout.trim())) continue;
  let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
  scan(`tree ${f}`, t);
}
const hist = git('log', '-p', '--full-index', '--format=commit %H%nauthor %an <%ae>%ncommitter %cn <%ce>%n%B', 'HEAD');
let nChunks = 0;
for (const chunk of hist.stdout.split(/\n(?=diff --git |commit [0-9a-f]{40}\n)/)) {
  nChunks++;
  if (chunk.startsWith(`diff --git a/${ALLOW} `) || chunk.startsWith(`diff --git a/${ALLOW_OLD} `)) continue;
  if (vendoredChunk(chunk)) continue;
  scan(`history ${chunk.split('\n')[0].slice(0, 60)}`, chunk);
}
console.log(`owner-specific strings: ${FORBID.length} patterns over ${tree.length} files and ${nChunks} history chunks of HEAD; hits ${hits.length}`);
for (const h of hits.slice(0, 20)) console.log(`  HIT ${h}`);
res['tree has no owner-specific strings (outside the example rules file)'] = !hits.some(h => h.startsWith('tree '));
res['history of HEAD (authors included) has no owner-specific strings'] = hist.status === 0 && !hits.some(h => h.startsWith('history '));

let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
process.exit(ok ? 0 : 1);
