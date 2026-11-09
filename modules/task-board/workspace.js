'use strict';
// Per-task workspace: a git worktree at <workspace_dir>/task-<id> on branch
// task-board/<id>, created from workspace_repo. Every path is checked to stay directly
// under workspace_dir. Removal never deletes the branch, so committed work survives.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true }).toString();
const enabled = s => !!(s.workspace_dir && s.workspace_repo);
function pathFor(s, id) {
  const root = path.resolve(s.workspace_dir), p = path.resolve(root, `task-${id}`);
  if (path.dirname(p) !== root) throw new Error('workspace path escapes workspace_dir');
  return p;
}
// -> workspace path (reused when it already exists, for example after a lease expiry).
function ensure(s, id) {
  const p = pathFor(s, id);
  if (fs.existsSync(path.join(p, '.git'))) return p;
  fs.mkdirSync(path.resolve(s.workspace_dir), { recursive: true });
  const branch = `task-board/${id}`;
  let exists = true;
  try { git(s.workspace_repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { exists = false; }
  git(s.workspace_repo, exists ? ['worktree', 'add', p, branch] : ['worktree', 'add', '-b', branch, p]);
  return p;
}
function remove(s, id) {
  const p = pathFor(s, id);
  if (!fs.existsSync(p)) return false;
  git(s.workspace_repo, ['worktree', 'remove', '--force', p]);
  try { git(s.workspace_repo, ['worktree', 'prune']); } catch { /* best effort */ }
  return true;
}
const shouldClean = (s, status) => s.workspace_cleanup === 'finished' ? (status === 'done' || status === 'failed') : s.workspace_cleanup === 'done' ? status === 'done' : false;

module.exports = { enabled, ensure, remove, pathFor, shouldClean };
