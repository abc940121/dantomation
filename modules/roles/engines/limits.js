'use strict';
// roles/engines/limits.js: what the non-Claude engine scripts (codex.js, opencode.js) share. Plain node, no packages.
//   - settings: the engine scripts run as separate processes, so they read the "roles" settings from the config file
//     (HARNESS_CONFIG, else ~/.harness/config.json) themselves: daily_turn_cap, opencode_extra_paid_models, opencode_allow_bash,
//     opencode_timeout_s (default 900), goDailyCap (default 0 = off).
//   - a per-role daily turn cap, counted in <state>/m/roles/turns-<bot id>.json per local day.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CAP = 200;
const DEFAULT_TIMEOUT_S = 900;

function settings(env) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(env.HARNESS_CONFIG || path.join(os.homedir(), '.harness', 'config.json'), 'utf8')) || {}; } catch { /* no config: defaults */ }
  const s = j.roles && typeof j.roles === 'object' && !Array.isArray(j.roles) ? j.roles : {};
  const cap = Number.isInteger(s.daily_turn_cap) && s.daily_turn_cap >= 0 ? s.daily_turn_cap : DEFAULT_CAP;
  const paid = Array.isArray(s.opencode_extra_paid_models) ? s.opencode_extra_paid_models.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
  const goCap = Number.isInteger(s.go_daily_cap ?? s.goDailyCap) && (s.go_daily_cap ?? s.goDailyCap) >= 0 ? (s.go_daily_cap ?? s.goDailyCap) : 0;
  const timeoutS = Number.isInteger(s.opencode_timeout_s) && s.opencode_timeout_s >= 1 ? s.opencode_timeout_s : DEFAULT_TIMEOUT_S;
  return { cap, paid, bash: s.opencode_allow_bash === true, web: s.opencode_allow_web !== false, goCap, timeoutS };
}

const stateDir = (env, root) => path.join(env.HARNESS_STATE_DIR || path.join(root, 'state'), 'm', 'roles');
const turnsFile = (env, root, bot) => path.join(stateDir(env, root), `turns-${String(bot).replace(/[^\w-]/g, '_')}.json`);
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function readCount(f, day) {
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && j.day === day && Number.isInteger(j.n) && j.n >= 0 ? j.n : 0; } catch { return 0; }
}

// Count one turn for the role today. -> { ok: true } or { ok: false, message } (nothing counted when refused).
// cap 0 = off. The turn is counted when it starts, so failed turns count too.
function takeTurn(env, root, bot, now) {
  const { cap } = settings(env);
  if (!cap) return { ok: true };
  const day = localDay(now || new Date()), f = turnsFile(env, root, bot), n = readCount(f, day);
  if (n >= cap) {
    return { ok: false, cap, message: `This role reached its daily limit of ${cap} turns on this engine. It resets tomorrow (local time).\n這個角色在此引擎上已達到每日 ${cap} 次對話的上限，明天（本地時間）重置。` };
  }
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ day, n: n + 1 }) + '\n', { mode: 0o600 });
    try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  } catch { /* a counter that cannot be saved must not block the owner's turn */ }
  return { ok: true };
}

// OpenCode Go plan turns, all roles together, per local day: <state dir>/opencode-go-turns.json ({day, n}).
const goFile = dir => path.join(dir, 'opencode-go-turns.json');
const goCount = (dir, now) => readCount(goFile(dir), localDay(now || new Date()));
function goTake(dir, cap, now) {
  const day = localDay(now || new Date()), f = goFile(dir), n = readCount(f, day);
  if (cap && n >= cap) return { ok: false, n, message: `The OpenCode Go plan daily limit of ${cap} turns (all roles together) is reached. It resets tomorrow (local time).\nOpenCode Go 方案今日對話次數（所有角色合計）已達上限 ${cap} 次，明天（本地時間）重置。` };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ day, n: n + 1 }) + '\n', { mode: 0o600 });
    try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  } catch { /* best effort */ }
  return { ok: true, n: n + 1 };
}

module.exports = { settings, takeTurn, turnsFile, localDay, goCount, goTake, DEFAULT_CAP, DEFAULT_TIMEOUT_S };
