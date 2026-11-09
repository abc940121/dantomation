'use strict';
// Checkpoints: before a mutating tool call in a harness task, the checkpoint module
// snapshots the task folder so the owner can roll back.
//   - Private shadow repo state/ckpt/repo.git, private index state/ckpt/<task>.index
//     (GIT_INDEX_FILE). The task folder's own .git, index, HEAD, branches and
//     files are never written.
//   - Snapshot = tree of the folder (honours .gitignore; skips files > 5 MB),
//     commit-tree, ref refs/harness/ckpt/<task>/<n>, journal line kind "checkpoint".
//   - restore(task, n): owner only (HARNESS_OWNER=1). Takes a fresh checkpoint
//     first, so a restore can itself be undone.
// Files are stored byte-for-byte: no eol conversion, filters or ident.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const J = require('../../lib/journal');

const MAX_BYTES = 5 * 1024 * 1024;
const CK = path.join(J.STATE, 'ckpt');
const REPO = path.join(CK, 'repo.git');
const safe = t => String(t).replace(/[^\w.-]/g, '_');
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

function git(dir, index, args, input) {
  const env = { ...process.env };
  for (const k of GIT_ENV_DROP) delete env[k];
  Object.assign(env, {
    GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'harness', GIT_AUTHOR_EMAIL: 'harness@localhost', GIT_COMMITTER_NAME: 'harness', GIT_COMMITTER_EMAIL: 'harness@localhost',
  });
  return execFileSync('git', ['--git-dir', REPO, '--work-tree', dir,
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    ...args], { cwd: dir, env, input, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function ensureRepo() {
  if (fs.existsSync(path.join(REPO, 'HEAD'))) return;
  fs.mkdirSync(CK, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', REPO], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['--git-dir', REPO, 'config', 'core.bare', 'false'], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['--git-dir', REPO, 'config', 'gc.auto', '0'], { stdio: 'ignore', windowsHide: true });
  fs.mkdirSync(path.join(REPO, 'info'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'info', 'attributes'), '* -text -filter -ident -eol -working-tree-encoding -diff -merge\n');
}

function refsOf(task) {
  const prefix = `refs/harness/ckpt/${safe(task)}/`;
  const out = git(CK, path.join(CK, 'none.index'), ['for-each-ref', '--format=%(refname)', prefix]);
  return out.split('\n').filter(Boolean).map(r => Number(r.slice(prefix.length))).filter(Number.isInteger).sort((a, b) => a - b);
}

function withTaskLock(task, fn, waitMs = 20000) {
  fs.mkdirSync(CK, { recursive: true });
  const file = path.join(CK, safe(task) + '.lock');
  const until = Date.now() + waitMs;
  let l;
  while (!(l = J.lock(file, { pids: [process.pid], task_id: task })).held) {
    if (Date.now() > until) throw new Error('checkpoint lock busy');
    nap(50);
  }
  try { return fn(); } finally { J.unlock(file, l.nonce); }
}

// Stage the folder into the task's private index; returns its tree and what was skipped.
function stage(task, dir) {
  const index = path.join(CK, safe(task) + '.index');
  const g = (args, input) => git(dir, index, args, input);
  const excl = [];
  const relState = path.relative(dir, J.STATE);
  if (relState && !relState.startsWith('..') && !path.isAbsolute(relState)) excl.push(`--exclude=/${relState.replace(/\\/g, '/')}/`);
  const userExclude = path.join(dir, '.git', 'info', 'exclude');
  if (fs.existsSync(userExclude)) excl.push(`--exclude-from=${userExclude}`);
  const z = s => s.split('\0').filter(Boolean);

  const listed = [...new Set(z(g(['ls-files', '-z', '-c', '-o', '--exclude-standard', ...excl])))];
  const ignoredCached = new Set(z(g(['ls-files', '-z', '-c', '-i', '--exclude-standard', ...excl])));
  const ignored = z(g(['ls-files', '-z', '-o', '-i', '--directory', '--exclude-standard', ...excl]));
  const keep = []; const drop = [...ignoredCached]; const big = []; const nested = [];
  for (const p of listed) {
    if (ignoredCached.has(p)) continue;
    if (p.endsWith('/')) { nested.push(p); continue; } // another repo inside the folder
    let st = null; try { st = fs.lstatSync(path.join(dir, p)); } catch { /* deleted: stage the removal */ }
    if (st && st.isFile() && st.size > MAX_BYTES) { big.push(`${p} (${st.size} bytes)`); drop.push(p); continue; }
    keep.push(p);
  }
  if (drop.length) g(['rm', '--cached', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], drop.join('\0'));
  if (keep.length) g(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], keep.join('\0'));
  return { tree: g(['write-tree']).trim(), keep, big, ignored, nested };
}

function snap(task, dir, tool) {
  const t0 = Date.now();
  const g = (args, input) => git(dir, path.join(CK, safe(task) + '.index'), args, input);
  const { tree, keep, big, ignored, nested } = stage(task, dir);
  const ns = refsOf(task);
  const n = (ns.length ? ns[ns.length - 1] : 0) + 1;
  const parent = ns.length ? [`-p`, `refs/harness/ckpt/${safe(task)}/${ns[ns.length - 1]}`] : [];
  const sha = g(['commit-tree', tree, ...parent, '-m', `checkpoint ${task} ${n} before ${tool}`]).trim();
  const ref = `refs/harness/ckpt/${safe(task)}/${n}`;
  g(['update-ref', ref, sha, '0'.repeat(40)]); // create only
  const cap = a => a.length > 20 ? [...a.slice(0, 20), `... ${a.length - 20} more`] : a;
  const skipped = { over_5mb: cap(big), ignored: cap(ignored), nested_repos: cap(nested) };
  const ms = Date.now() - t0;
  J.append({ type: 'checkpoint', kind: 'checkpoint', task_id: task, n, ref, sha, tool, dir, files: keep.length, skipped, ms });
  return { n, ref, sha, tree, skipped, ms };
}

function checkpoint(task, dir, tool) {
  ensureRepo();
  return withTaskLock(task, () => {
    try { return snap(task, dir, tool); } catch (e) {
      // A torn private index (power cut) is rebuilt from the folder once.
      const index = path.join(CK, safe(task) + '.index');
      if (!fs.existsSync(index)) throw e;
      fs.rmSync(index, { force: true });
      return snap(task, dir, tool);
    }
  });
}

// The folder's tree now, without making a checkpoint (undo uses it to skip points equal to it).
// opts.wait false: give up at once (throws) when a checkpoint is being taken, for status.
function currentTree(task, dir, opts = {}) {
  ensureRepo();
  return withTaskLock(task, () => stage(task, dir).tree, opts.wait === false ? 0 : 20000);
}
function treeOf(task, n) {
  return git(CK, path.join(CK, 'none.index'), ['rev-parse', '--verify', '-q', `refs/harness/ckpt/${safe(task)}/${n}^{tree}`]).trim();
}
// Trees of many points with one git call per 200 (status counts them all).
function treesOf(task, ns) {
  const out = [];
  for (let i = 0; i < ns.length; i += 200) out.push(...git(CK, path.join(CK, 'none.index'), ['rev-parse', ...ns.slice(i, i + 200).map(n => `refs/harness/ckpt/${safe(task)}/${n}^{tree}`)]).split('\n').filter(Boolean));
  return out;
}
// Paths that differ between two trees.
function changedPaths(a, b) {
  return git(CK, path.join(CK, 'none.index'), ['diff-tree', '-r', '-z', '--name-only', a, b]).split('\0').filter(Boolean);
}

function taskDir(task, ref) {
  const recs = J.readAll().records;
  const c = recs.filter(r => r.type === 'checkpoint' && r.task_id === task && r.dir);
  const hit = c.find(r => r.ref === ref) || c[c.length - 1];
  if (hit) return hit.dir;
  const s = recs.find(r => r.type === 'task_start' && r.task_id === task);
  return s && s.workdir;
}

// opts.user: the undo verb, which has its own agent guards (index.js); the low-level restore stays owner-only.
function restore(task, n, opts = {}) {
  if (!opts.user && process.env.HARNESS_OWNER !== '1') { const e = new Error('restore is owner-only: the owner sets HARNESS_OWNER=1 in their own shell'); e.code = 'OWNER'; throw e; }
  if (!/^[1-9]\d*$/.test(String(n))) throw new Error('checkpoint number must be a positive integer');
  ensureRepo();
  const ref = `refs/harness/ckpt/${safe(task)}/${n}`;
  const dir = taskDir(task, ref);
  if (!dir || !fs.existsSync(dir)) throw new Error(`no folder known for task ${task}`);
  const tmp = path.join(CK, safe(task) + '.restore.index');
  const gt = args => git(dir, tmp, args);
  let target;
  try { target = gt(['rev-parse', '--verify', '-q', ref + '^{commit}']).trim(); } catch { throw new Error(`no checkpoint ${ref}`); }
  const fresh = checkpoint(task, dir, 'restore');
  fs.rmSync(tmp, { force: true });
  try {
    gt(['read-tree', target]);
    gt(['checkout-index', '-a', '-f']);
    // Delete only files the snapshot holds now but the target did not.
    // Ignored, > 5 MB and untracked-by-snapshot files are never touched.
    const added = gt(['diff-tree', '-r', '-z', '--name-only', '--diff-filter=A', target, fresh.sha]).split('\0').filter(Boolean);
    for (const p of added) fs.rmSync(path.join(dir, p), { force: true });
    J.append({ type: 'restore', task_id: task, n: Number(n), ref, sha: target, undo_ref: fresh.ref, removed: added.length });
    return { ref, sha: target, undo: fresh, removed: added };
  } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = { checkpoint, restore, currentTree, treeOf, treesOf, changedPaths, MAX_BYTES, REPO, git, ensureRepo, taskDir, safeId: safe };
