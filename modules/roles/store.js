'use strict';
// roles store: one JSON file (roles.json) in the module state dir. Reads always re-read the
// file (the server and the MCP process both write it); writes go to a temp file and are renamed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^r-[0-9a-f]{8}$/;
const NAME_MAX = 40, PERSONA_MAX = 4000;
const ENGINES = ['claude', 'codex', 'opencode'];
const MODEL_MAX = 100;
const CTRL = /[\u0000-\u001f\u007f]/;
const CTRL_KEEP_NL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class RoleError extends Error {}

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

function createStore(dir) {
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

  return {
    all: () => read().map(copy),
    list: () => live(read()).map(copy),
    get(key) { const r = find(read(), key); return r ? copy(r) : null; },
    create({ name, persona, engine, model } = {}) {
      const n = checkName(name), p = checkPersona(persona), e = engine === undefined || engine === null ? 'claude' : checkEngine(engine);
      const mdl = model === undefined ? null : checkModel(model);
      const roles = read();
      if (taken(roles, n)) throw new RoleError(`a role named "${n}" already exists`);
      let id; do { id = 'r-' + crypto.randomBytes(4).toString('hex'); } while (roles.some(r => r.id === id));
      const now = new Date().toISOString();
      const rec = { id, name: n, persona: p, kind: 'session', engine: e, ...(mdl ? { model: mdl } : {}), created_at: now, updated_at: now };
      roles.push(rec); write(roles);
      return copy(rec);
    },
    update(key, patch = {}) {
      const roles = read(), r = need(roles, key);
      if (patch.name === undefined && patch.persona === undefined && patch.engine === undefined && patch.model === undefined) throw new RoleError('give a new name, persona, engine and/or model');
      const n = patch.name === undefined ? r.name : checkName(patch.name);
      const p = patch.persona === undefined ? r.persona : checkPersona(patch.persona);
      const e = patch.engine === undefined ? (r.engine || 'claude') : checkEngine(patch.engine);
      const mdl = patch.model === undefined ? (r.model || null) : checkModel(patch.model);
      if (taken(roles, n, r.id)) throw new RoleError(`a role named "${n}" already exists`);
      Object.assign(r, { name: n, persona: p, engine: e, updated_at: new Date().toISOString() });
      if (mdl) r.model = mdl; else delete r.model;
      write(roles);
      return copy(r);
    },
    archive(key) {
      const roles = read(), r = need(roles, key);
      r.archived_at = new Date().toISOString();
      write(roles);
      return copy(r);
    },
  };
}

module.exports = { createStore, RoleError, ID_RE, ENGINES, NAME_MAX, PERSONA_MAX, checkName };
