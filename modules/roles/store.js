'use strict';
// roles store: one JSON file (roles.json) in the module state dir. Reads always re-read the
// file (the server and the MCP process both write it); writes go to a temp file and are renamed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const card = require('./card');

const ID_RE = /^r-[0-9a-f]{8}$/;
const NAME_MAX = 40, PERSONA_MAX = 4000;
const ENGINES = ['claude', 'codex', 'opencode'];
const MODEL_MAX = 100;
const ROLES_MAX = 50; // live (not archived) roles; archived ones cannot be deleted, so they do not count
const CTRL = /[\u0000-\u001f\u007f]/;
const CTRL_KEEP_NL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class RoleError extends Error {}
class RoleLimitError extends RoleError {} // too many roles in total

const lc = s => String(s).toLowerCase();
const len = s => [...s].length;

function checkName(v) {
  if (typeof v !== 'string') throw new RoleError('name must be a text');
  const n = v.trim();
  if (!n) throw new RoleError('name is required');
  if (len(n) > NAME_MAX) throw new RoleError(`name is too long (max ${NAME_MAX} characters)`);
  if (CTRL.test(n)) throw new RoleError('name must be one line of plain text');
  if (ID_RE.test(n)) throw new RoleError('name must not look like a role id');
  return n;
}
function checkPersona(v) {
  if (typeof v !== 'string') throw new RoleError('persona must be a text');
  const p = v.trim();
  if (!p) throw new RoleError('persona is required');
  if (len(p) > PERSONA_MAX) throw new RoleError(`persona is too long (max ${PERSONA_MAX} characters)`);
  if (CTRL_KEEP_NL.test(p)) throw new RoleError('persona contains control characters');
  return p;
}

// engine: which agent runs the role's turns. Absent in older records, which means "claude".
function checkEngine(v) {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!ENGINES.includes(e)) throw new RoleError(`engine must be one of: ${ENGINES.join(', ')}`);
  return e;
}

// model: optional provider/model id for the opencode engine (passed to -m). "" or null clears it.
function checkModel(v) {
  if (v === null || v === '') return null;
  const m = typeof v === 'string' ? v.trim() : '';
  if (!m) return null;
  if (m.length > MODEL_MAX || !/^[A-Za-z0-9][\w.\-\/:#@+]*$/.test(m)) throw new RoleError(`model must be a provider/model id such as opencode/big-pickle (max ${MODEL_MAX} characters, no spaces)`);
  return m;
}

// workdir: the task folder an avatar image path is read from (a function or a path); default is the task folder of this process.
function createStore(dir, workdir) {
  const wd = () => (typeof workdir === 'function' ? workdir() : workdir !== undefined ? workdir : process.env.HARNESS_TASK_DIR);
  const cardOf = (existing, patch, id) => {
    try { return card.apply(existing, patch, { id, dir: typeof dir === 'function' ? dir() : dir, workdir: wd() }); }
    catch (e) { throw e instanceof card.CardError ? new RoleError(e.message) : e; }
  };
  const file = () => path.join(typeof dir === 'function' ? dir() : dir, 'roles.json');
  function read() {
    let j;
    try { j = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') return []; throw new RoleError('roles.json is unreadable'); }
    return Array.isArray(j && j.roles) ? j.roles.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string') : [];
  }
  function write(roles) {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ roles }, null, 2) + '\n', { mode: 0o600 });
    try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  }
  const live = roles => roles.filter(r => !r.archived_at);
  const find = (roles, key) => {
    const k = String(key == null ? '' : key);
    return roles.find(r => r.id === k) || live(roles).find(r => lc(r.name) === lc(k.trim())) || null;
  };
  const taken = (roles, name, exceptId) => live(roles).some(r => r.id !== exceptId && lc(r.name) === lc(name));
  const need = (roles, key) => {
    const r = find(roles, key);
    if (!r || r.archived_at) throw new RoleError(`no role "${String(key).slice(0, 60)}"`);
    return r;
  };
  const copy = r => ({ ...r });
  const mainOf = roles => live(roles).find(r => r.main === true) || null;

  return {
    all: () => read().map(copy),
    list: () => live(read()).map(copy),
    get(key) { const r = find(read(), key); return r ? copy(r) : null; },
    getMain() { const r = mainOf(read()); return r ? copy(r) : null; },
    // The one main role. When no live role is marked main, make the default one (a data field, never a fixed name).
    // Returns null, and writes nothing, when the default must not be made: a main role existed before (any record, archived
    // included, that is main or was seeded as the default: it is not resurrected), or the live roles are at ROLES_MAX.
    // onCreate(rec) runs once after the write, only when a default was made (the route journals it there).
    ensureMain(def, onCreate) {
      const roles = read(), have = mainOf(roles);
      if (have) return copy(have);
      if (roles.some(r => r.main === true || r.seeded === true)) return null;
      if (live(roles).length >= ROLES_MAX) return null;
      const n = [def.name, def.name + ' (main)'].find(x => !taken(roles, x)) || def.name + ' ' + crypto.randomBytes(2).toString('hex');
      let id; do { id = 'r-' + crypto.randomBytes(4).toString('hex'); } while (roles.some(r => r.id === id));
      const now = new Date().toISOString();
      const rec = { id, name: checkName(n), persona: checkPersona(def.persona), kind: 'session', engine: 'claude', main: true, seeded: true, created_at: now, updated_at: now };
      roles.push(rec); write(roles);
      if (typeof onCreate === 'function') { try { onCreate(copy(rec)); } catch { /* the journal note is best effort */ } }
      return copy(rec);
    },
    create({ name, persona, engine, model, card: cardPatch } = {}) {
      const n = checkName(name), p = checkPersona(persona), e = engine === undefined || engine === null ? 'claude' : checkEngine(engine);
      const mdl = model === undefined ? null : checkModel(model);
      const roles = read();
      if (taken(roles, n)) throw new RoleError(`a role named "${n}" already exists`);
      if (live(roles).length >= ROLES_MAX) throw new RoleLimitError(`there are already ${ROLES_MAX} roles; the limit is ${ROLES_MAX} (archived ones do not count)`);
      let id; do { id = 'r-' + crypto.randomBytes(4).toString('hex'); } while (roles.some(r => r.id === id));
      const c = cardOf(undefined, cardPatch, id), now = new Date().toISOString();
      const rec = { id, name: n, persona: p, kind: 'session', engine: e, ...(mdl ? { model: mdl } : {}), ...(c ? { card: c } : {}), created_at: now, updated_at: now };
      roles.push(rec); write(roles);
      return copy(rec);
    },
    update(key, patch = {}) {
      const roles = read(), r = need(roles, key);
      if (patch.name === undefined && patch.persona === undefined && patch.engine === undefined && patch.model === undefined && patch.main === undefined && patch.card === undefined) throw new RoleError('give a new name, persona, engine, model, main and/or card');
      if (patch.main !== undefined && typeof patch.main !== 'boolean') throw new RoleError('main must be true or false');
      if (patch.main === false && r.main === true) throw new RoleError('there is always one main role: to change it, mark another role as main');
      const n = patch.name === undefined ? r.name : checkName(patch.name);
      const p = patch.persona === undefined ? r.persona : checkPersona(patch.persona);
      const e = patch.engine === undefined ? (r.engine || 'claude') : checkEngine(patch.engine);
      const mdl = patch.model === undefined ? (r.model || null) : checkModel(patch.model);
      if (taken(roles, n, r.id)) throw new RoleError(`a role named "${n}" already exists`);
      const c = cardOf(r.card, patch.card, r.id);
      Object.assign(r, { name: n, persona: p, engine: e, updated_at: new Date().toISOString() });
      if (mdl) r.model = mdl; else delete r.model;
      if (c) r.card = c; else delete r.card;
      if (patch.main === true) { for (const o of roles) if (o.id !== r.id && o.main) delete o.main; r.main = true; }
      write(roles);
      return copy(r);
    },
    archive(key) {
      const roles = read(), r = need(roles, key);
      if (r.main === true) throw new RoleError('this is the main role: mark another role as main before removing it');
      r.archived_at = new Date().toISOString();
      write(roles);
      return copy(r);
    },
  };
}

module.exports = { createStore, RoleError, RoleLimitError, ROLES_MAX, ID_RE, ENGINES, NAME_MAX, PERSONA_MAX, checkName };
