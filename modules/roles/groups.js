'use strict';
// roles/groups.js: owner-made group chats ("rooms") whose members are roles. The owner asks in chat; the
// tools below write <state>/m/roles/groups.json. The rooms module reads the groups through a room source
// (see index.js), so a new group shows up in the chat page without a restart. The main bot is always a
// member and the lead; every role member is its own bot (id r-<8hex>), so it answers with its own persona,
// engine and session. Nothing is deleted: removing a group sets archived_at.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RoleError, checkName } = require('./store');

const ID_RE = /^g-[0-9a-f]{8}$/;
const bi = (zh, en) => `${zh}\n${en}`;
const lc = s => String(s).toLowerCase();
const mainId = config => { const b = config && config.bots; return Array.isArray(b) && b.length && b[0] && b[0].id ? String(b[0].id) : 'main'; };
const roomsOn = ctx => !!(ctx && ctx.config && ctx.config.modules && ctx.config.modules.rooms === true);

function createGroups(dirOf, rolesStore) {
  const file = () => path.join(typeof dirOf === 'function' ? dirOf() : dirOf, 'groups.json');
  function read() {
    let j;
    try { j = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') return []; throw new RoleError(bi('groups.json 無法讀取（檔案可能損壞）', 'groups.json is unreadable')); }
    return Array.isArray(j && j.groups) ? j.groups.filter(g => g && ID_RE.test(g.id) && typeof g.name === 'string' && Array.isArray(g.members)) : [];
  }
  function write(groups) {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ groups }, null, 2) + '\n', { mode: 0o600 });
    try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  }
  const live = gs => gs.filter(g => !g.archived_at);
  const find = (gs, key) => { const k = String(key == null ? '' : key); return gs.find(g => g.id === k) || live(gs).find(g => lc(g.name) === lc(k.trim())) || null; };
  const need = (gs, key) => { const g = find(gs, key); if (!g || g.archived_at) throw new RoleError(bi(`找不到群組「${String(key).slice(0, 60)}」（或已封存）。請先用 group_list 查看。`, `No group "${String(key).slice(0, 60)}" (or it is archived). Check group_list first.`)); return g; };
  const taken = (gs, name, exceptId) => live(gs).some(g => g.id !== exceptId && lc(g.name) === lc(name));
  // role keys (ids or names) -> distinct live role ids; "main" is skipped (always a member anyway)
  function roleIds(keys, what) {
    if (!Array.isArray(keys)) throw new RoleError(bi(`${what} 必須是角色名稱或 id 的清單`, `${what} must be a list of role names or ids`));
    const out = [];
    for (const k of keys) {
      if (typeof k === 'string' && k.trim().toLowerCase() === 'main') continue;
      const r = rolesStore.get(k);
      if (!r || r.archived_at) throw new RoleError(bi(`找不到角色「${String(k).slice(0, 60)}」（或已封存）。請先用 role_list 查看。`, `No such role "${String(k).slice(0, 60)}" (or it is archived). Check role_list first.`));
      if (!out.includes(r.id)) out.push(r.id);
    }
    return out;
  }
  // The members that still exist: archived or removed roles drop out on read.
  const view = (g, ctx) => {
    const roles = new Map(rolesStore.all().map(r => [r.id, r]));
    const members = g.members.filter(id => roles.has(id) && !roles.get(id).archived_at).map(id => ({ id, name: roles.get(id).name }));
    return { id: g.id, name: g.name, lead: mainId(ctx && ctx.config), members, ...(g.archived_at ? { archived_at: g.archived_at } : {}) };
  };
  const copy = g => ({ ...g, members: g.members.slice() });

  return {
    list: ctx => live(read()).map(g => view(g, ctx)),
    get: (key, ctx) => { const g = find(read(), key); return g ? view(g, ctx) : null; },
    create({ name, members } = {}, ctx) {
      const n = checkName(name), ids = roleIds(members, 'members');
      if (!ids.length) throw new RoleError(bi('群組至少要有一個角色成員（主機器人一定在群組裡）', 'a group needs at least one role member (the main bot is always in it)'));
      const gs = read();
      if (taken(gs, n)) throw new RoleError(bi(`已經有名為「${n}」的群組`, `a group named "${n}" already exists`));
      let id; do { id = 'g-' + crypto.randomBytes(4).toString('hex'); } while (gs.some(g => g.id === id));
      const now = new Date().toISOString();
      const rec = { id, name: n, members: ids, created_at: now, updated_at: now };
      gs.push(rec); write(gs);
      return view(rec, ctx);
    },
    update(key, { name, add, remove } = {}, ctx) {
      const gs = read(), g = need(gs, key);
      if (name === undefined && add === undefined && remove === undefined) throw new RoleError(bi('請給新名稱、要加入的角色（add）或要移出的角色（remove）', 'give a new name, roles to add and/or roles to remove'));
      const n = name === undefined ? g.name : checkName(name);
      if (taken(gs, n, g.id)) throw new RoleError(bi(`已經有名為「${n}」的群組`, `a group named "${n}" already exists`));
      let members = g.members.slice();
      if (add !== undefined) for (const id of roleIds(add, 'add')) if (!members.includes(id)) members.push(id);
      if (remove !== undefined) {
        // a removed role may be archived already, so match it by id or by the name it has now
        const all = rolesStore.all();
        const gone = new Set();
        if (!Array.isArray(remove)) throw new RoleError(bi('remove 必須是角色名稱或 id 的清單', 'remove must be a list of role names or ids'));
        for (const k of remove) {
          const s = String(k == null ? '' : k).trim();
          const hit = all.find(r => r.id === s) || all.find(r => !r.archived_at && lc(r.name) === lc(s));
          if (!hit && s.toLowerCase() !== 'main') throw new RoleError(bi(`找不到角色「${s.slice(0, 60)}」`, `No such role "${s.slice(0, 60)}"`));
          if (hit) gone.add(hit.id);
        }
        members = members.filter(id => !gone.has(id));
      }
      Object.assign(g, { name: n, members, updated_at: new Date().toISOString() });
      write(gs);
      return view(g, ctx);
    },
    archive(key, ctx) {
      const gs = read(), g = need(gs, key);
      g.archived_at = new Date().toISOString();
      write(gs);
      return view(g, ctx);
    },
    // A map shaped like settings.rooms, for the rooms module. Never throws: a damaged file adds no rooms.
    rooms(ctx) {
      let gs; try { gs = live(read()); } catch { return {}; }
      const out = {}, main = mainId(ctx && ctx.config);
      for (const g of gs) {
        const v = view(g, ctx);
        out[g.id] = { name: g.name, lead: main, members: [{ id: main, name: main }, ...v.members.filter(m => m.id !== main).map(m => ({ id: m.id, name: m.name, bot: m.id }))] };
      }
      return out;
    },
  };
}

module.exports = { createGroups, roomsOn, mainId, bi };
