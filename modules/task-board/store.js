'use strict';
// task-board store: one JSON file (board.json) in the module's state dir, written
// atomically (unique tmp + rename). Every read-modify-write runs under an
// inter-process lock file (exclusive create; EPERM/EACCES/EBUSY retried because
// Windows reports those while a deleted lock is still pending), so two agents can
// never claim the same task. Lease expiry is applied inside every locked operation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STATUSES = ['open', 'claimed', 'done', 'failed'];
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const err = (code, msg) => Object.assign(new Error(msg), { code });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Lock with an owner token. The lock file holds "<pid>.<random>"; only its holder removes it.
// A stale lock is broken by renaming it aside, confirming the renamed file is still the stale
// content that was seen (not a successor's fresh lock), and only then deleting it.
function lockAcquire(lockFile, { staleMs, waitMs, transient, sleepMs, busyError }) {
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const start = Date.now();
  for (;;) {
    try { fs.writeFileSync(lockFile, token, { flag: 'wx' }); return token; } catch (e) {
      if (e.code !== 'EEXIST' && !transient.has(e.code)) throw e;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
        const seen = fs.readFileSync(lockFile, 'utf8');
        const aside = `${lockFile}.${token}.stale`;
        fs.renameSync(lockFile, aside);
        let same = false;
        try { same = fs.readFileSync(aside, 'utf8') === seen && Date.now() - fs.statSync(aside).mtimeMs > staleMs; } catch { /* gone */ }
        if (same) { try { fs.unlinkSync(aside); } catch { /* gone */ } continue; }
        // We moved a live successor's lock: put it back without clobbering, then retry.
        try { fs.linkSync(aside, lockFile); } catch { /* someone else took the name */ }
        try { fs.unlinkSync(aside); } catch { /* gone */ }
        continue;
      }
    } catch { /* raced */ }
    if (Date.now() - start > waitMs) throw busyError();
    sleepMs(5);
  }
}
function lockRelease(lockFile, token) {
  try { if (fs.readFileSync(lockFile, 'utf8') === token) fs.unlinkSync(lockFile); } catch { /* gone or not ours */ }
}

function open(dir, opts = {}) {
  const now = opts.now || (() => Date.now());
  const file = path.join(dir, 'board.json');
  const lockFile = path.join(dir, 'board.lock');
  const STALE_MS = 10000, WAIT_MS = 15000;
  let expiredLog = [];

  const read = () => {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none or corrupt: empty board */ }
    if (!d || typeof d !== 'object') d = {};
    if (!Array.isArray(d.tasks)) d.tasks = [];
    if (!Number.isInteger(d.seq)) d.seq = 0;
    return d;
  };
  const write = d => {
    fs.mkdirSync(dir, { recursive: true });
    const t = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(t, JSON.stringify(d));
      for (let i = 0; ; i++) {
        try { fs.renameSync(t, file); break; } catch (e) { if (!TRANSIENT.has(e.code) || i >= 50) throw e; sleep(5); }
      }
    } catch (e) { try { fs.unlinkSync(t); } catch { /* gone */ } throw e; }
  };
  // A claimed task whose lease ended goes back to open (the owner is presumed dead).
  function expire(d) {
    const t = now(); let n = 0;
    for (const x of d.tasks) {
      if (x.status === 'claimed' && x.lease_until <= t) {
        expiredLog.push({ id: x.id, owner: x.owner });
        Object.assign(x, { status: 'open', owner: null, lease_until: null, claimed_at: null, expired_count: (x.expired_count || 0) + 1, updated: t });
        n++;
      }
    }
    return n > 0;
  }
  // fn(d) -> { save?, value }
  const locked = fn => {
    fs.mkdirSync(dir, { recursive: true });
    const token = lockAcquire(lockFile, { staleMs: opts.staleMs || STALE_MS, waitMs: opts.waitMs || WAIT_MS, transient: TRANSIENT, sleepMs: sleep, busyError: () => err('busy', 'task-board store busy') });
    try {
      const d = read();
      const changed = expire(d);
      let out; let fnErr = null;
      try { out = fn(d); } catch (e) { fnErr = e; }
      if (changed || (out && out.save)) write(d); // lease expiry is kept even when fn threw
      if (fnErr) throw fnErr;
      return out ? out.value : undefined;
    } finally { lockRelease(lockFile, token); }
  };

  const byId = (d, id) => d.tasks.find(x => x.id === id);
  const blockedBy = (d, x) => x.deps.filter(dep => { const y = byId(d, dep); return !y || y.status !== 'done'; });
  const view = (d, x) => { const b = blockedBy(d, x); return { ...x, blocked_by: b, ready: x.status === 'open' && b.length === 0 }; };
  const need = (d, id) => { const x = byId(d, id); if (!x) throw err('not_found', 'no such task'); return x; };
  const mayAct = (x, by, force) => { if (!force && x.owner !== by) throw err('not_owner', 'task is not claimed by you'); };
  const reopen = (x, ts) => Object.assign(x, { status: 'open', owner: null, lease_until: null, claimed_at: null, updated: ts });

  return {
    // Expired claims released since the last call (any operation may release them).
    takeExpired() { const e = expiredLog; expiredLog = []; return e; },

    add({ id, title, deps = [], task_ref = null }, cap = 1000) {
      const t = clean(title, 200);
      if (!t) throw err('bad_input', 'title is required');
      if (!Array.isArray(deps) || deps.length > 50) throw err('bad_input', 'deps must be an array of at most 50 ids');
      if (id !== undefined && id !== null && !(typeof id === 'string' && ID_RE.test(id))) throw err('bad_input', 'bad task id (letters, digits, _ and -, up to 64)');
      for (const dep of deps) if (typeof dep !== 'string' || !ID_RE.test(dep)) throw err('bad_input', 'bad dependency id');
      const ref = task_ref == null ? null : clean(task_ref, 64);
      return locked(d => {
        d.seq += 1;
        const tid = id || `tb-${d.seq}`;
        if (byId(d, tid)) throw err('exists', 'a task with that id exists');
        if (deps.includes(tid)) throw err('bad_input', 'a task cannot depend on itself');
        for (const dep of deps) if (!byId(d, dep)) throw err('bad_input', `unknown dependency ${dep}`);
        // Prune the oldest finished tasks nothing remaining depends on (the new task counts) to stay under the cap.
        let over = d.tasks.length - cap + 1;
        if (over > 0) {
          // A done task referenced by any other task is kept; removing others can free more, so repeat.
          const drop = new Set();
          for (let moved = true; moved && over > 0;) {
            moved = false;
            for (const x of d.tasks) {
              if (over <= 0) break;
              if (drop.has(x) || x.status !== 'done' || deps.includes(x.id)) continue;
              if (d.tasks.some(y => y !== x && !drop.has(y) && y.deps.includes(x.id))) continue;
              drop.add(x); over--; moved = true;
            }
          }
          if (over > 0) throw err('full', 'board is full');
          d.tasks = d.tasks.filter(x => !drop.has(x));
        }
        const ts = now();
        const x = { id: tid, title: t, deps: [...new Set(deps)], status: 'open', owner: null, lease_until: null, claimed_at: null,
          task_ref: ref, workspace: null, attempts: 0, expired_count: 0, note: null, created: ts, updated: ts };
        d.tasks.push(x);
        return { save: true, value: view(d, x) };
      });
    },
    get(id) { return locked(d => { const x = byId(d, id); return { value: x ? view(d, x) : null }; }); },
    list({ status, owner, ready } = {}) {
      return locked(d => ({ value: d.tasks.map(x => view(d, x)).filter(x => (!status || x.status === status) && (!owner || x.owner === owner) && (!ready || x.ready)) }));
    },
    // Claim a specific task, or the first ready open one. null when nothing is ready.
    claim(owner, { id, lease_ms, task_ref = null, max_per_owner = 0 } = {}) {
      return locked(d => {
        if (max_per_owner > 0 && d.tasks.filter(x => x.status === 'claimed' && x.owner === owner).length >= max_per_owner) throw err('limit', 'owner holds too many claims');
        let x;
        if (id) {
          x = need(d, id);
          if (x.status !== 'open') throw err('not_open', `task is ${x.status}`);
          if (blockedBy(d, x).length) throw err('blocked', 'dependencies are not done');
        } else x = d.tasks.find(y => y.status === 'open' && !blockedBy(d, y).length);
        if (!x) return { value: null };
        const ts = now();
        Object.assign(x, { status: 'claimed', owner, lease_until: ts + lease_ms, claimed_at: ts, attempts: x.attempts + 1, task_ref: task_ref || x.task_ref, updated: ts });
        return { save: true, value: view(d, x) };
      });
    },
    heartbeat(id, by, lease_ms, force = false) {
      return locked(d => {
        const x = need(d, id);
        if (x.status !== 'claimed') throw err('not_claimed', 'lease already expired or task not claimed');
        mayAct(x, by, force);
        x.lease_until = now() + lease_ms; x.updated = now();
        return { save: true, value: view(d, x) };
      });
    },
    // ok -> done (returns the dependants that just became ready), else failed.
    finish(id, by, ok, note, force = false) {
      return locked(d => {
        const x = need(d, id);
        if (x.status !== 'claimed') throw err('not_claimed', `task is ${x.status}`);
        mayAct(x, by, force);
        Object.assign(x, { status: ok ? 'done' : 'failed', lease_until: null, note: note ? clean(note, 500) : null, updated: now() });
        const unblocked = ok ? d.tasks.filter(y => y.status === 'open' && y.deps.includes(id) && !blockedBy(d, y).length).map(y => y.id) : [];
        return { save: true, value: { task: view(d, x), unblocked } };
      });
    },
    // claimed_at pins the claim: when given, release only that exact claim.
    release(id, by, force = false, claimedAt = null) {
      return locked(d => {
        const x = need(d, id);
        if (x.status !== 'claimed') throw err('not_claimed', `task is ${x.status}`);
        if (claimedAt !== null && (x.claimed_at !== claimedAt || x.owner !== by)) throw err('not_claimed', 'the claim changed hands');
        mayAct(x, by, force);
        reopen(x, now());
        return { save: true, value: view(d, x) };
      });
    },
    // Release every claim linked to a harness task (it ended or stalled).
    releaseByRef(ref) {
      return locked(d => {
        const out = [];
        for (const x of d.tasks) if (x.status === 'claimed' && x.task_ref === ref) { out.push({ id: x.id, owner: x.owner }); reopen(x, now()); }
        return { save: out.length > 0, value: out };
      });
    },
    retry(id) {
      return locked(d => {
        const x = need(d, id);
        if (x.status !== 'failed') throw err('not_failed', `task is ${x.status}`);
        Object.assign(x, { status: 'open', owner: null, note: null, updated: now() });
        return { save: true, value: view(d, x) };
      });
    },
    remove(id) {
      return locked(d => {
        const x = need(d, id);
        if (x.status === 'claimed') throw err('claimed', 'release the task first');
        if (d.tasks.some(y => y.id !== id && y.deps.includes(id))) throw err('has_dependants', 'other tasks depend on it');
        d.tasks.splice(d.tasks.indexOf(x), 1);
        return { save: true, value: { removed: x } };
      });
    },
    setWorkspace(id, ws) {
      return locked(d => { const x = byId(d, id); if (!x) return { value: null }; x.workspace = ws; return { save: true, value: view(d, x) }; });
    },
    sweep() { return locked(() => ({ value: null })); },
  };
}

module.exports = { open, ID_RE, STATUSES, lockAcquire, lockRelease };
