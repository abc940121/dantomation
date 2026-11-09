#!/usr/bin/env node
'use strict';
// gitleaks module: the real program is never needed. A fake `gitleaks` (a node script behind a
// .cmd / sh wrapper) sits first on PATH and acts by GL_STUB_MODE: clean | leak | crash | slow.
// The "secret" in the fake report is built at run time, so no secret-like text lives in the repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-test-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));

const SECRET = ['fake', 'value', Math.random().toString(36).slice(2), 'zzz'].join('_');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const LOG = path.join(tmp, 'args.log');
fs.writeFileSync(path.join(bin, 'stub.js'), `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GL_STUB_LOG, a.join(' ') + '\\n');
const rp = a[a.indexOf('--report-path') + 1];
const mode = process.env.GL_STUB_MODE || 'clean';
if (mode === 'slow') setTimeout(() => process.exit(0), 3000);
else if (mode === 'crash') process.exit(2);
else if (mode === 'leak') {
  fs.writeFileSync(rp, JSON.stringify([{ RuleID: 'fake-rule', File: 'src/app.txt', StartLine: 7, Secret: process.env.GL_STUB_SECRET, Match: process.env.GL_STUB_SECRET }]));
  process.exit(1);
} else { fs.writeFileSync(rp, '[]'); process.exit(0); }
`);
if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'gitleaks.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0stub.js" %*\r\n`);
else { fs.writeFileSync(path.join(bin, 'gitleaks'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/stub.js" "$@"\n`); fs.chmodSync(path.join(bin, 'gitleaks'), 0o755); }
const EMPTY = path.join(tmp, 'empty');
fs.mkdirSync(EMPTY);
const PATH0 = process.env.PATH;
process.env.GL_STUB_LOG = LOG;
process.env.GL_STUB_SECRET = SECRET;
const withStub = () => { process.env.PATH = bin + path.delimiter + PATH0; };
const noStub = () => { process.env.PATH = EMPTY; };

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const run = (reg, cmd, extra = {}) => M.beforeTool(reg.mods, { tool: 'Bash', ti: { command: cmd }, cwd: tmp, ...extra });

(async () => {
  try {
    const off = M.registry({ modules: { gitleaks: false } });
    withStub(); process.env.GL_STUB_MODE = 'leak';
    check('off: nothing registered, commit passes', off.errors.length === 0 && off.settingsFor('gitleaks') === null);
    const reg = M.registry({ modules: { gitleaks: true }, gitleaks: { on_missing: 'block' } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('verb scan listed', reg.listCommands().includes('scan'));

    const c = reg.api('gitleaks').classify;
    check('classify: commit / push / -C / chained', c('git commit -m x').op === 'commit' && c('git push origin main').op === 'push' && c('git add . && git -C sub commit -m x').dir === 'sub' && c('git status') === null && c('echo hi') === null);

    // findings -> block, never the secret
    let r = await run(reg, 'git commit -m "x"');
    check('commit with findings is blocked', r && r[0] === 'secret_scan' && /fake-rule src\/app\.txt:7/.test(r[1]), JSON.stringify(r));
    check('block text has no secret value', !JSON.stringify(r).includes(SECRET));
    const argsLog = fs.readFileSync(LOG, 'utf8');
    check('commit scans staged, json, redacted', /git --staged/.test(argsLog) && /--report-format json/.test(argsLog) && /--redact/.test(argsLog), argsLog.split('\n')[0]);
    r = await run(reg, 'git push origin main');
    check('push with findings is blocked', r && r[0] === 'secret_scan');
    check('push scans unpushed commits', /--log-opts=HEAD --not --remotes/.test(fs.readFileSync(LOG, 'utf8')));
    r = await run(reg, 'git add . && git commit -m x');
    check('chained commit is blocked', r && r[0] === 'secret_scan');

    // a repo with no remote-tracking branches: bounded scan, not the whole history
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
    g('init', '-q');
    for (let i = 0; i < 3; i++) g('commit', '-q', '--allow-empty', '-m', 'c' + i);
    const capped = M.registry({ modules: { gitleaks: true }, gitleaks: { no_remote_commits: 2 } });
    fs.writeFileSync(LOG, '');
    const nerr = []; const w0 = process.stderr.write; process.stderr.write = s => { nerr.push(String(s)); return true; };
    try { r = await run(capped, 'git push https://example.invalid/x HEAD:main', { cwd: repo }); } finally { process.stderr.write = w0; }
    const pl = fs.readFileSync(LOG, 'utf8');
    check('no remotes: push scans the last N commits only', /--log-opts=--max-count=2 HEAD/.test(pl) && !/--not --remotes/.test(pl), pl);
    check('no remotes: findings still block', r && r[0] === 'secret_scan');
    check('no remotes: says the scan was capped', nerr.some(s => /scans only the last 2 of 3 commits/.test(s)), JSON.stringify(nerr));
    g('update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    fs.writeFileSync(LOG, '');
    await run(capped, 'git push', { cwd: repo });
    check('with a remote-tracking branch: unpushed commits as before', /--log-opts=HEAD --not --remotes/.test(fs.readFileSync(LOG, 'utf8')));

    // clean / unrelated
    process.env.GL_STUB_MODE = 'clean';
    check('clean commit passes', (await run(reg, 'git commit -m x')) === null);
    process.env.GL_STUB_MODE = 'leak';
    check('git status is not scanned', (await run(reg, 'git status')) === null);
    check('non-shell tool is not scanned', (await M.beforeTool(reg.mods, { tool: 'Write', ti: { file_path: 'a', content: 'git commit' }, cwd: tmp })) === null);

    // settings
    const noPush = M.registry({ modules: { gitleaks: true }, gitleaks: { scan_push: false } });
    check('scan_push false: push passes', (await run(noPush, 'git push')) === null);
    const bad = M.registry({ modules: { gitleaks: true }, gitleaks: { on_missing: 'maybe' } });
    check('bad enum is a load error', bad.errors.length > 0);

    // scan error / timeout fail closed
    process.env.GL_STUB_MODE = 'crash';
    r = await run(reg, 'git commit -m x');
    check('scanner crash blocks (fail closed)', r && r[0] === 'secret_scan' && /not scanned/.test(r[1]), JSON.stringify(r));
    process.env.GL_STUB_MODE = 'slow';
    const fast = M.registry({ modules: { gitleaks: true }, gitleaks: { scan_timeout_ms: 500 } });
    r = await run(fast, 'git commit -m x');
    check('scan timeout blocks', r && /timed out/.test(r[1]) && /scan_timeout_ms/.test(r[1]), JSON.stringify(r));
    r = await run(fast, 'git push');
    check('push timeout names scan_timeout_ms and no_remote_commits', r && /timed out/.test(r[1]) && /scan_timeout_ms/.test(r[1]) && /no_remote_commits/.test(r[1]), JSON.stringify(r));

    // missing binary
    noStub();
    r = await run(reg, 'git commit -m x');
    check('on_missing=block: commit blocked with install hint', r && r[0] === 'secret_scan' && /not found/.test(r[1]) && /Ask the owner to install gitleaks/.test(r[1]) && !/(npm|brew|winget|choco|go install|curl)/.test(r[1]), JSON.stringify(r));
    check('missing binary: unrelated command passes', (await run(reg, 'ls')) === null);
    const allow = M.registry({ modules: { gitleaks: true } }); // default
    const err = [];
    const w = process.stderr.write; process.stderr.write = s => { err.push(String(s)); return true; };
    let a1, a2;
    try { a1 = await run(allow, 'git commit -m x'); a2 = await run(allow, 'git push'); } finally { process.stderr.write = w; }
    check('default on_missing allows', a1 === null && a2 === null);
    const nw = err.filter(s => /NOT scanned/.test(s));
    check('default: warns on every unscanned commit and push', nw.length === 2 && /git commit/.test(nw[0]) && /git push/.test(nw[1]), JSON.stringify(nw));

    // scan verb, through bin/harness.js as a child process
    const cfg = path.join(tmp, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ modules: { 'guard-base': true, gitleaks: true } }));
    const verb = (mode, extra = []) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'scan', ...extra], { cwd: tmp, encoding: 'utf8',
      env: { ...process.env, PATH: bin + path.delimiter + PATH0, GL_STUB_MODE: mode, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(tmp, 'vstate'), HARNESS_LOG_DIR: path.join(tmp, 'vlogs') } });
    let v = verb('leak');
    check('scan verb: findings exit 1, rule/file/line, no secret', v.status === 1 && /fake-rule\tsrc\/app\.txt:7/.test(v.stdout) && !(v.stdout + v.stderr).includes(SECRET), `${v.status} ${v.stdout}${v.stderr}`);
    v = verb('clean', ['--dir']);
    check('scan verb --dir: clean exit 0 and uses gitleaks dir', v.status === 0 && /^dir /m.test(fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).pop()), `${v.status} ${v.stderr}`);
    v = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'scan'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, PATH: EMPTY, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(tmp, 'vstate'), HARNESS_LOG_DIR: path.join(tmp, 'vlogs') } });
    check('scan verb: missing binary exits 2', v.status === 2 && /could not scan/.test(v.stderr), `${v.status} ${v.stderr}`);
  } catch (e) { check('no exception', false, e.stack); }
  finally { process.env.PATH = PATH0; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* slow stub may still hold the folder */ } }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
