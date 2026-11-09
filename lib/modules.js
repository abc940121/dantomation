'use strict';
// The one module loader, manifest validator, hook and event dispatcher, and
// registry. The contract is docs/MODULES.md. Core never requires a module by a
// fixed path: enabled names come from the config and are resolved here at run time.
// A module is modules/<name>/index.js exporting a manifest object. With
// `contract: N` (1 up to the trunk CONTRACT) every field is checked (unknown fields are errors). A manifest
// without `contract` is refused. `contract: 0` is a legacy module: only name, priority, the old hooks and
// commands are read, and loading it prints a warning.
// Any problem is an error that names the module; the other modules still load,
// and callers decide (guard blocks every call, start/resume exit 2).
// Every hook, handler and command may return a promise; core awaits it.
// Modules are trusted code running in this process: dependsOn scopes ctx.api and
// nothing else. None of this is a sandbox.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const J = require('./journal');
const { redact, redactFull } = require('./redact');
const E = require('./engines');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'modules');
const CONTRACT = 6; // the highest module contract this trunk supports (docs/module-contract.md)
const ENGINE_HOOK_LIMIT_MS = 60000; // the engine kills a hook call that runs longer
const HOOK_TIMEOUT_MS = 5000; // default for config "modules_hook_timeout_ms"
const LIFECYCLE_TIMEOUT_MS = 60000; // migrate and uninstall hooks
const CHOOSE_ENGINE_TIMEOUT_MS = 200; // chooseEngine is asked before every engine turn: keep it short
const MAX_TURN_CONTEXT = 8000; // chars of prepareTurn context per module
const LEGACY_HOOKS = ['beforeTool', 'afterTool', 'onTaskStart', 'onTaskEnd', 'statusLines'];
const LEGACY_EVENT = { 'task.start': 'onTaskStart', 'task.end': 'onTaskEnd', 'tool.done': 'afterTool' };
const HOOKS = ['beforeTool', 'statusLines', 'prepareTurn', 'migrate', 'uninstall', 'chooseEngine', 'beforeReply'];
const FAIL_MODES = ['open', 'closed'];
const FIELDS = ['contract', 'name', 'description', 'runsOn', 'priority', 'dependsOn', 'beforeTool', 'statusLines', 'prepareTurn', 'on', 'emits',
  'commands', 'routes', 'panels', 'jobs', 'settings', 'api', 'provides', 'stateVersion', 'migrate', 'uninstall', 'chooseEngine', 'beforeReply', 'failMode', 'hookTimeoutMs'];
const RESERVED = ['task', 'tool', 'module', 'core']; // event prefixes only core emits
const ROLES = ['main', 'worker'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ACCESS = ['owner', 'worker', 'public-get', 'public-post'];
const ACTORS = ['owner', 'worker', 'anonymous'];
const MOUNTS = ['chat', 'sidebar', 'page'];
const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'secret'];
const PROVIDER_KINDS = ['tools', 'bots', 'engines'];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const PREFIX_RE = /^[a-z][a-z0-9-]*$/;
const EVENT_RE = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;
const UI_RE = /^ui\/[A-Za-z0-9_\-./]+$/;
const BAD_PARAM = /\.\.|[/\\\0]/;
const MAX_EMIT_DEPTH = 8;
const MAX_INTERVAL_S = 2147483; // setInterval's limit, in seconds
// Every secret value this process ever read from a secrets file or was given to set (rotated-out values stay in): output sinks hide all of them.
const SEEN = new Set();
const noteSecrets = o => { try { for (const v of Object.values(o || {})) if (typeof v === 'string') SEEN.add(v); } catch { /* ignore */ } };
const META = new WeakMap();  // module object -> meta of its latest load
const LOADS = new WeakMap(); // mods array from load() -> Map name -> meta of that load
const warned = new Set();

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// show(v, mt): a short look at a value. With mt (the module's table) the whole text is scrubbed first, then clipped,
// so a clipped secret prefix cannot survive.
const show = (v, mt) => { let t; try { t = String(JSON.stringify(v)); } catch { t = String(v); } t = hideSecrets(mt, t); return t.slice(0, 40); }; // scrub first (every loaded module's secrets too), clip after
// fullMessage is total. Module text must be scrubbed as a whole before it is split or clipped (why()); line() is for harness-made errors only.
const fullMessage = e => { try { return String(e && e.message !== undefined ? e.message : e); } catch { return 'unprintable error'; } };
const line = e => fullMessage(e).split('\n')[0];
const unknown = (obj, allowed, where, out) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) out.push(`${where}: unknown field "${k}" (allowed: ${allowed.join(', ')})`); };
const sectionKey = name => name.replace(/-/g, '_');
const typeOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
const report = msg => process.stderr.write(`harness: ${msg}\n`);
const clone = v => JSON.parse(JSON.stringify(v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Text that leaves the process (stderr, journal, a response): the module's secret
// values become [secret], then secret-shaped strings are redacted (and clipped).
// A secret is hidden in its plain form and in its JSON-escaped form (newline as backslash-n, and so on).
function hideSecrets(mt, s) {
  let out = String(s);
  // longest first, so a secret that is a prefix of another cannot leave the longer one's tail
  // every form of every secret in one list, longest first, so a secret that is a prefix of another (in any form) cannot leave a tail
  const forms = new Set();
  for (const v of [...Object.values((mt && mt.secrets) || {}), ...SEEN]) {
    if (typeof v !== 'string' || v.length < 4) continue;
    const j = JSON.stringify(v).slice(1, -1);
    const jj = JSON.stringify(j).slice(1, -1); // double-escaped: a JSON string inside a JSON string
    for (const f of [v, j, jj]) if (f.length >= 4) forms.add(f);
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('[secret]');
  return out;
}
function scrub(mt, s) { return redact(hideSecrets(mt, s)); }
// For code outside this file (guard, server, harness): text scrubbed against EVERY loaded module's secrets, then pattern-redacted. hideAll: secrets only. Neither clips.
// The owner / worker token values (state dir) are hidden too, so a clip cannot leave a token prefix the server no longer recognises.
function tokenHide(s) { for (const n of ['server.token', 'worker.token']) { let t = ''; try { t = fs.readFileSync(path.join(J.STATE, n), 'utf8').trim(); } catch { /* none */ } if (t.length >= 4) s = s.split(t).join('[secret]'); } return s; }
const hideAll = s => tokenHide(hideSecrets(null, s));
const scrubAll = s => redactFull(tokenHide(hideSecrets(null, s)));
// A record with the module's secrets hidden everywhere (any depth, keys too), through a JSON round trip.
// Fails closed: a record that cannot be serialized, or whose scrubbed text is not JSON, is refused, never journaled raw.
function hideIn(mt, rec) {
  let text;
  try { text = JSON.stringify(rec); } catch (e) { throw new Error('state.append: record cannot be serialized to JSON, so it cannot be scrubbed (' + why(mt, e).slice(0, 80) + ')'); }
  try { return JSON.parse(hideSecrets(mt, text)); } catch { throw new Error('state.append: record could not be scrubbed safely (refused, nothing journaled)'); }
}
// A load-time failure has no table yet (and harness-made load errors are not clipped): hide the module's stored secrets (a throw at require time may carry one).
const loadWhy = (name, e) => { let secrets; try { secrets = readSecrets(name); } catch { return 'failed to load (details withheld: its secrets file could not be read)'; } return redactFull(hideSecrets({ secrets }, fullMessage(e))).split(String.fromCharCode(10))[0]; };
// require + validate of one module folder; any failure is rethrown scrubbed of that module's stored secrets.
function loadModule(name) {
  const dir = path.join(DIR, name);
  try { readSecrets(name); } catch { /* unreadable: loadWhy withholds */ }
  try { const m = require(path.join(dir, 'index.js')); return { m, mt: validate(m, name, dir) }; } catch (e) { throw new Error(loadWhy(name, e)); }
}
const why = (mt, e) => scrub(mt, fullMessage(e)).split('\n')[0];

// One value against one settings spec -> null, or why not. A secret's value is never quoted.
function checkValue(spec, v, mt) {
  const t = spec.type;
  const ok = t === 'array' ? Array.isArray(v) : t === 'object' ? isObj(v) : t === 'integer' ? Number.isInteger(v)
    : t === 'number' ? isNum(v) : t === 'secret' ? typeof v === 'string' && v.length >= 4 : typeof v === t;
  if (!ok) return t === 'secret' ? `must be a string of at least 4 characters (a shorter secret cannot be scrubbed from output), got ${typeOf(v)}` : `must be ${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}, got ${typeOf(v)} ${show(v, mt)}`;
  if (spec.items && v.some(x => checkValue({ type: spec.items }, x, mt))) return `must be an array of ${spec.items}, got ${show(v, mt)}`;
  if (spec.enum && !spec.enum.includes(v)) return `must be one of ${spec.enum.map(x => show(x, mt)).join(', ')}, got ${show(v, mt)}`;
  if (spec.min !== undefined && v < spec.min) return `must be >= ${spec.min}, got ${v}`;
  if (spec.max !== undefined && v > spec.max) return `must be <= ${spec.max}, got ${v}`;
  return null;
}

// ---- secrets: state/secrets/<module>.json, owner-only, never in config.json
const secretsFile = name => path.join(J.STATE, 'secrets', `${name}.json`);
let account = null;
const whoami = () => account || (account = execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim());
const isMe = principal => {
  const a = principal.toLowerCase(), b = whoami().toLowerCase();
  if (a === b) return true;
  const host = (process.env.COMPUTERNAME || '').toLowerCase(); // whoami with no DOMAIN part: only this machine's own account counts
  if (b.includes('\\')) return false;
  const dom = (process.env.USERDOMAIN || '').toLowerCase();
  return (!!host && a === host + '\\' + b) || (!!dom && a === dom + '\\' + b);
};

// Windows: the ACEs of a file or folder as [{ who, perms }] (icacls output).
function aclOf(target) {
  const out = execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true });
  const aces = [];
  out.split(/\r?\n/).forEach((l, i) => {
    if (i === 0) { if (!l.startsWith(target)) return; l = l.slice(target.length); }
    const m = /^\s*(.+?):((?:\([^)]*\))+)\s*$/.exec(l);
    if (m) aces.push({ who: m[1], perms: m[2] });
  });
  return aces;
}

// null when only the current account has access (nothing inherited), else why not.
// POSIX: no group or other bits.
function aclProblem(target) {
  if (process.platform !== 'win32') return (fs.statSync(target).mode & 0o077) ? `mode ${(fs.statSync(target).mode & 0o777).toString(8)} lets others in` : null;
  const aces = aclOf(target);
  if (!aces.length) return 'no access entries could be read';
  const inherited = aces.filter(a => /\(I\)/.test(a.perms)).map(a => a.who);
  if (inherited.length) return `inherits access for ${inherited.join(', ')}`;
  const others = aces.filter(a => !isMe(a.who)).map(a => a.who);
  return others.length ? `also open to ${others.join(', ')}` : null;
}

// Owner-only: mode 600 (dir 700) on POSIX; on Windows inheritance is cut, the
// current account is granted full control and every other entry is removed.
// Throws if the result is still not owner-only.
function restrict(target, isDir) {
  if (process.platform !== 'win32') { fs.chmodSync(target, isDir ? 0o700 : 0o600); return; }
  const run = args => execFileSync('icacls', [target, ...args], { stdio: 'ignore', windowsHide: true });
  run(['/inheritance:r', '/grant:r', `${whoami()}:${isDir ? '(OI)(CI)F' : 'F'}`]);
  for (const a of aclOf(target)) if (!isMe(a.who)) run(['/remove', /^S-1-/.test(a.who) ? `*${a.who}` : a.who]);
  const bad = aclProblem(target);
  if (bad) throw new Error(`could not make ${target} owner-only: ${bad}`);
}

// The exact command that makes one file owner-only on Windows. The account comes from
// the running process, the path from the runtime; no secret value is ever in it.
function icaclsFix(f) {
  let who;
  try { who = whoami(); } catch { who = process.env.USERNAME || '%USERNAME%'; }
  return `icacls "${f}" /inheritance:r /grant:r "${who}:F"`;
}

// The secrets file's object ({} when none). Bad permissions: POSIX refuses; Windows
// warns once per file and goes on (setting any secret of the module re-locks it).
function readSecrets(name) {
  const f = secretsFile(name);
  if (!fs.existsSync(f)) return {};
  if (process.platform !== 'win32') { if (fs.statSync(f).mode & 0o077) throw new Error(`secrets file ${f} is readable by others; run: chmod 600 "${f}"`); }
  else {
    let bad;
    try { bad = aclProblem(f); } catch (e) { bad = `its access list could not be read (${line(e)})`; }
    if (bad && !warned.has(f)) { warned.add(f); report(`warning: secrets file ${f} is not owner-only: ${bad}. Fix it with: ${icaclsFix(f)}   (or set any secret of module ${name} again: node bin/harness.js secret ${name} <key>)`); }
  }
  let v;
  try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`secrets file ${f} unreadable (${e.code || 'not JSON'})`); }
  if (!isObj(v)) throw new Error(`secrets file ${f} must hold a JSON object`);
  noteSecrets(v);
  return v;
}

// The owner's way to set (value) or remove (value '' / null) one secret setting.
function setSecret(name, key, value) {
  if (!NAME_RE.test(String(name)) || !fs.existsSync(path.join(DIR, name, 'index.js'))) throw new Error(`unknown module "${name}"`);
  const { mt } = loadModule(name);
  const spec = mt.schema[key];
  if (!spec || spec.type !== 'secret') throw new Error(`module ${name} has no secret setting "${key}" (secret settings: ${Object.keys(mt.schema).filter(k => mt.schema[k].type === 'secret').join(', ') || 'none'})`);
  const f = secretsFile(name);
  const d = path.dirname(f);
  if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); restrict(d, true); }
  const cur = readSecrets(name);
  if (value === null || value === undefined || value === '') delete cur[key];
  else { const bad = checkValue(spec, value); if (bad) throw new Error(`secret ${key} ${bad}`); cur[key] = value; noteSecrets({ value }); }
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, '', { mode: 0o600 });
  restrict(tmp, false);
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(tmp, f);
  return f;
}

// A file under a module folder: ui/... -> { file: real path } or { error }. The real
// path (symlinks resolved) must stay inside the module folder and be a regular file.
function realFile(dir, rel) {
  let real, st;
  try { real = fs.realpathSync(path.join(dir, rel)); st = fs.statSync(real); } catch { return { error: `${rel} does not exist` }; }
  let root;
  try { root = fs.realpathSync(dir); } catch { return { error: `module folder ${dir} does not exist` }; }
  if (!real.startsWith(root + path.sep)) return { error: `${rel} resolves outside the module folder` };
  if (!st.isFile()) return { error: `${rel} is not a regular file` };
  return { file: real };
}

// ---- manifest -> meta, or throws one Error listing every problem.
function validate(m, name, dir) {
  if (!isObj(m)) throw new Error('index.js does not export an object');
  const p = [];
  if (m.name === undefined) p.push(`missing "name" (must be ${JSON.stringify(name)})`);
  else if (m.name !== name) p.push(`exports name ${JSON.stringify(m.name)}, expected ${JSON.stringify(name)}`);
  if (m.contract === undefined) throw new Error(`module ${name} has no contract field; add "contract": 2 (docs/MODULES.md)`);
  const version = m.contract;
  if (!Number.isInteger(version) || version < 0) p.push(`contract must be an integer, got ${show(m.contract)}`);
  else if (version > CONTRACT) p.push(`needs module contract ${version}; this core supports up to ${CONTRACT}`);
  const hooks = version >= 1 ? HOOKS : LEGACY_HOOKS;
  for (const h of hooks) if (m[h] !== undefined && typeof m[h] !== 'function') p.push(`${h} must be a function, got ${typeOf(m[h])}`);
  if (m.priority !== undefined && !isNum(m.priority)) p.push(`priority must be a number, got ${typeOf(m.priority)} ${show(m.priority)}`);
  if (m.commands !== undefined && (!isObj(m.commands) || Object.values(m.commands).some(f => typeof f !== 'function'))) p.push('commands must map names to functions');
  const meta = { name, version, dir, failMode: 'open', priority: typeof m.priority === 'number' ? m.priority : 0, runsOn: ['main'], dependsOn: [], on: {}, emits: [],
    routes: [], panels: [], jobs: [], provides: [], schema: {}, settings: {}, secrets: {}, stateVersion: undefined };
  if (!(version >= 1)) { if (p.length) throw new Error(p.join('; ')); return meta; }

  const OLD = { onTaskStart: 'task.start', onTaskEnd: 'task.end', afterTool: 'tool.done' };
  for (const [old, ev] of Object.entries(OLD)) if (m[old] !== undefined) p.push(`"${old}" is contract 0; in contract 1 use on: {"${ev}": fn}`);
  unknown(Object.fromEntries(Object.entries(m).filter(([k]) => !(k in OLD))), FIELDS, 'manifest', p);
  if (RESERVED.includes(name)) p.push(`the name "${name}" is reserved for core events`);
  if (m.description !== undefined && typeof m.description !== 'string') p.push('description must be a string');
  if (m.api !== undefined && !isObj(m.api)) p.push('api must be an object');
  if (m.failMode !== undefined) {
    if (!FAIL_MODES.includes(m.failMode)) p.push(`failMode must be "open" or "closed", got ${show(m.failMode)}`);
    else meta.failMode = m.failMode;
  }
  if (m.hookTimeoutMs !== undefined) {
    if (!Number.isInteger(m.hookTimeoutMs) || m.hookTimeoutMs < 100) p.push(`hookTimeoutMs must be a whole number of milliseconds >= 100, got ${show(m.hookTimeoutMs)}`);
    else meta.hookTimeoutMs = m.hookTimeoutMs;
  }
  if (m.stateVersion !== undefined) {
    if (!Number.isInteger(m.stateVersion) || m.stateVersion < 1) p.push(`stateVersion must be a whole number >= 1, got ${show(m.stateVersion)}`);
    else meta.stateVersion = m.stateVersion;
  }
  if (m.migrate !== undefined && m.stateVersion === undefined) p.push('migrate needs stateVersion (the version migrate brings the state to)');
  if (m.runsOn !== undefined) {
    const r = [].concat(m.runsOn);
    if (!r.length || r.some(x => !ROLES.includes(x)) || new Set(r).size !== r.length) p.push(`runsOn must be "main", "worker" or both, got ${show(m.runsOn)}`);
    else meta.runsOn = r;
  }
  if (m.dependsOn !== undefined) {
    const d = m.dependsOn;
    if (!Array.isArray(d) || d.some(x => typeof x !== 'string' || !NAME_RE.test(x)) || new Set(d).size !== d.length) p.push(`dependsOn must be an array of distinct module names, got ${show(d)}`);
    else if (d.includes(name)) p.push('dependsOn lists the module itself');
    else meta.dependsOn = d.slice();
  }
  if (m.on !== undefined) {
    if (!isObj(m.on)) p.push(`on must be an object of "event.name": function, got ${typeOf(m.on)}`);
    else for (const [ev, fn] of Object.entries(m.on)) {
      if (!EVENT_RE.test(ev)) p.push(`on: event name ${show(ev)} must look like "prefix.name"`);
      else if (typeof fn !== 'function') p.push(`on["${ev}"] must be a function`);
      else meta.on[ev] = fn;
    }
  }
  if (m.emits !== undefined) {
    const e = m.emits;
    if (!Array.isArray(e) || e.some(x => typeof x !== 'string' || !PREFIX_RE.test(x)) || new Set(e).size !== e.length) p.push(`emits must be an array of distinct event prefixes like "card", got ${show(e)}`);
    else if (e.some(x => RESERVED.includes(x))) p.push(`emits: prefixes ${RESERVED.join(', ')} are core's`);
    else meta.emits = e.filter(x => x !== name);
  }
  const list = (field, each) => {
    if (m[field] === undefined) return;
    if (!Array.isArray(m[field])) { p.push(`${field} must be an array, got ${typeOf(m[field])} ${show(m[field])}`); return; }
    m[field].forEach((e, i) => { if (!isObj(e)) p.push(`${field}[${i}] must be an object`); else each(e, `${field}[${i}]`); });
  };
  const ids = kind => { const s = new Set(); return (id, w) => {
    let ok = true;
    if (typeof id !== 'string' || !NAME_RE.test(id)) { ok = false; p.push(`${w}.id must be lowercase letters, digits and dashes, got ${show(id)}`); }
    else if (s.has(id)) { ok = false; p.push(`duplicate ${kind} id "${id}"`); }
    s.add(id);
    return ok;
  }; };
  const seen = new Set();
  list('routes', (r, w) => {
    unknown(r, ['method', 'path', 'handler', 'description', 'access'], w, p);
    let ok = true;
    if (!METHODS.includes(r.method)) { ok = false; p.push(`${w}.method must be one of ${METHODS.join(', ')}, got ${show(r.method)}`); }
    if (typeof r.path !== 'string' || !/^\/[A-Za-z0-9_\-.:/]*$/.test(r.path) || /\.\.|\/\//.test(r.path)) { ok = false; p.push(`${w}.path must look like "/cards/:id", got ${show(r.path)}`); }
    if (typeof r.handler !== 'function') { ok = false; p.push(`${w}.handler must be a function`); }
    const access = r.access === undefined ? 'owner' : r.access;
    if (!ACCESS.includes(access)) { ok = false; p.push(`${w}.access must be one of ${ACCESS.join(', ')}, got ${show(r.access)}`); }
    else if (access === 'public-get' && r.method !== 'GET') { ok = false; p.push(`${w}.access "public-get" is only for GET routes`); }
    else if (access === 'public-post' && r.method !== 'POST') { ok = false; p.push(`${w}.access "public-post" is only for POST routes`); }
    if (!ok) return;
    const key = `${r.method} ${r.path.replace(/:[^/]+/g, ':').replace(/\/$/, '')}`;
    if (seen.has(key)) { p.push(`duplicate route ${r.method} ${r.path}`); return; }
    seen.add(key);
    meta.routes.push({ module: name, method: r.method, path: `/m/${name}${r.path}`, handler: r.handler, description: r.description || '', access });
  });
  const panelId = ids('panel');
  list('panels', (x, w) => {
    unknown(x, ['id', 'title', 'mount', 'entry'], w, p);
    panelId(x.id, w);
    if (typeof x.title !== 'string' || !x.title) p.push(`${w}.title must be a non-empty string`);
    if (!MOUNTS.includes(x.mount)) p.push(`${w}.mount must be one of ${MOUNTS.join(', ')}, got ${show(x.mount)}`);
    if (typeof x.entry !== 'string' || !UI_RE.test(x.entry) || x.entry.includes('..')) { p.push(`${w}.entry must be a file path under ui/, got ${show(x.entry)}`); return; }
    const f = realFile(dir, x.entry);
    if (f.error) p.push(`${w}.entry ${f.error}`);
    else meta.panels.push({ module: name, id: x.id, title: x.title, mount: x.mount, entry: x.entry, url: `/m/${name}/${x.entry}`, file: f.file });
  });
  const jobId = ids('job');
  list('jobs', (j, w) => {
    unknown(j, ['id', 'every', 'run', 'start', 'description'], w, p);
    jobId(j.id, w);
    const interval = j.every !== undefined || j.run !== undefined;
    if (interval === (j.start !== undefined)) p.push(`${w} needs either every + run (interval) or start (long-running), not both or neither`);
    else if (interval && !(isNum(j.every) && j.every > 0 && j.every <= MAX_INTERVAL_S)) p.push(`${w}.every must be a finite number of seconds > 0 and <= ${MAX_INTERVAL_S}, got ${show(j.every)}`);
    else if (interval && typeof j.run !== 'function') p.push(`${w}.run must be a function`);
    else if (!interval && typeof j.start !== 'function') p.push(`${w}.start must be a function`);
    else meta.jobs.push({ module: name, id: j.id, kind: interval ? 'interval' : 'service', every: j.every, run: j.run, start: j.start });
  });
  if (m.provides !== undefined) {
    if (!isObj(m.provides)) p.push(`provides must be an object { ${PROVIDER_KINDS.join(', ')} }, got ${typeOf(m.provides)}`);
    else for (const [kind, arr] of Object.entries(m.provides)) {
      if (!PROVIDER_KINDS.includes(kind)) { p.push(`provides: unknown kind "${kind}" (allowed: ${PROVIDER_KINDS.join(', ')})`); continue; }
      if (!Array.isArray(arr)) { p.push(`provides.${kind} must be an array, got ${typeOf(arr)}`); continue; }
      const pid = ids(`provides.${kind}`);
      arr.forEach((e, i) => {
        const w = `provides.${kind}[${i}]`;
        if (!isObj(e)) { p.push(`${w} must be an object`); return; }
        let ok = pid(e.id, w);
        if (e.description !== undefined && typeof e.description !== 'string') { ok = false; p.push(`${w}.description must be a string`); }
        if (ok) meta.provides.push({ ...e, module: name, kind });
      });
    }
  }
  if (m.settings !== undefined) {
    if (!isObj(m.settings)) p.push(`settings must be an object of key: spec, got ${typeOf(m.settings)}`);
    else for (const [k, s] of Object.entries(m.settings)) {
      const w = `settings.${k}`;
      if (!KEY_RE.test(k)) { p.push(`${w}: key must be lowercase letters, digits and _`); continue; }
      if (!isObj(s)) { p.push(`${w} must be an object {type, default, description}`); continue; }
      unknown(s, ['type', 'default', 'description', 'min', 'max', 'enum', 'items'], w, p);
      if (!TYPES.includes(s.type)) { p.push(`${w}.type must be one of ${TYPES.join(', ')}, got ${show(s.type)}`); continue; }
      if (s.items !== undefined && (s.type !== 'array' || !TYPES.includes(s.items) || s.items === 'secret')) { p.push(`${w}.items is only for arrays and must be a type name`); continue; }
      if (s.enum !== undefined && (!Array.isArray(s.enum) || s.type === 'secret')) { p.push(`${w}.enum must be an array (and is not for secrets)`); continue; }
      if (s.min !== undefined || s.max !== undefined) {
        if (!['number', 'integer'].includes(s.type)) { p.push(`${w}: min/max are only for number and integer`); continue; }
        if ((s.min !== undefined && !isNum(s.min)) || (s.max !== undefined && !isNum(s.max))) { p.push(`${w}: min and max must be finite numbers, got min ${show(s.min)}, max ${show(s.max)}`); continue; }
        if (s.min !== undefined && s.max !== undefined && s.min > s.max) { p.push(`${w}: min ${s.min} is above max ${s.max}`); continue; }
      }
      if (typeof s.description !== 'string' || !s.description) p.push(`${w}.description must be a non-empty string`);
      if (s.type === 'secret') { if ('default' in s) p.push(`${w}: a secret has no default`); else meta.schema[k] = s; continue; }
      if (!('default' in s)) { p.push(`${w}.default is required`); continue; }
      const bad = checkValue(s, s.default);
      if (bad) { p.push(`${w}.default ${bad}`); continue; }
      meta.schema[k] = s;
    }
  }
  if (p.length) throw new Error(p.join('; '));
  return meta;
}

const secretKeys = meta => Object.keys(meta.schema).filter(k => meta.schema[k].type === 'secret');
const secretStatus = v => (v ? 'configured' : 'missing');

// The module's config section (config["<name with - as _>"]) against its schema
// -> { settings, secrets }, or throws. settings: defaults overlaid with the
// configured values, each secret key shown only as "configured" / "missing".
// secrets: the values from the secrets file, reached by modules through ctx.secret(key).
function settingsOf(meta, cfg) {
  const key = sectionKey(meta.name);
  const sec = cfg ? cfg[key] : undefined;
  const out = {}, secrets = {};
  for (const [k, s] of Object.entries(meta.schema)) out[k] = s.type === 'secret' ? 'missing' : clone(s.default);
  if (!(meta.version >= 1)) return { settings: out, secrets };
  const p = [];
  let own = {}; try { own = readSecrets(meta.name); } catch { /* unreadable: nothing to hide */ }
  const sm = { secrets: own }; // this module's stored secrets: a quoted bad value is scrubbed before it is clipped
  if (sec !== undefined && !isObj(sec)) throw new Error(`config "${key}" must be an object, got ${typeOf(sec)}`);
  for (const [k, v] of Object.entries(sec || {})) {
    if (!(k in meta.schema)) { p.push(`config "${key}": unknown key "${k}" (known: ${Object.keys(meta.schema).join(', ') || 'none'})`); continue; }
    if (meta.schema[k].type === 'secret') { p.push(`config "${key}.${k}" is a secret and must not be in the config file: remove it there and set it with: node bin/harness.js secret ${meta.name} ${k}   (value on stdin; stored owner-only in ${secretsFile(meta.name)})`); continue; }
    const bad = checkValue(meta.schema[k], v, sm);
    if (bad) p.push(`config "${key}.${k}" ${bad}`); else out[k] = v;
  }
  if (p.length) throw new Error(p.join('; '));
  if (secretKeys(meta).length) {
    const s = readSecrets(meta.name);
    for (const k of secretKeys(meta)) {
      if (s[k] === undefined) continue;
      const bad = checkValue(meta.schema[k], s[k]);
      if (bad) throw new Error(`secret "${k}" in ${secretsFile(meta.name)} ${bad}`);
      secrets[k] = s[k];
      out[k] = 'configured';
    }
  }
  return { settings: out, secrets };
}

// Settings as anything outside the module may see them (no secret values in them).
const publicSettings = mt => clone(mt.settings);

// ctx.state: the module's own corner of state/. dir is created on first use.
const stateDir = name => path.join(J.STATE, 'm', name);
function makeState(name, mtOf = () => null) {
  const dir = stateDir(name);
  return Object.freeze({
    get dir() { fs.mkdirSync(dir, { recursive: true }); return dir; },
    append(rec) {
      if (!isObj(rec) || typeof rec.type !== 'string' || !rec.type) throw new Error('state.append needs a record object with a string "type"');
      if (rec.module !== undefined && rec.module !== name) throw new Error(`state.append: record module must be "${name}"`);
      return J.append({ ...hideIn(mtOf(), rec), module: name });
    },
  });
}

// fn(signal) awaited, rejecting with .timeout after ms; the signal is aborted then.
// A busy synchronous loop cannot be cut short, and code that ignores the signal
// keeps running in the background.
function timed(fn, ms, what) {
  const ac = new AbortController();
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => { const e = Object.assign(new Error(`${what} took longer than ${ms} ms`), { timeout: true }); ac.abort(e); rej(e); }, ms); });
  return Promise.race([Promise.resolve().then(() => fn(ac.signal)), to]).finally(() => clearTimeout(t));
}

const freeze = v => { if (v && typeof v === 'object') { Object.freeze(v); Object.values(v).forEach(freeze); } return v; };
const prefixOf = ev => String(ev).split('.')[0];

// mods (from load) + module -> its meta of that load.
const metaOf = (mods, m) => (LOADS.get(mods) && LOADS.get(mods).get(m.name)) || META.get(m);

// ctx.tasks until S1 provides the task service (load opts.tasks).
const NO_TASK = () => Promise.reject(new Error('tasks service not available until S1 (no server in this process)'));
const NO_TASKS = Object.freeze({ enqueue: NO_TASK, start: NO_TASK, get: NO_TASK, cancel: NO_TASK });

// ctx.api(dep) for module A: B's functions run with B's ctx, never A's. Inside a call
// `this` inherits B's api object and carries `ctx` (B's module ctx), so B's api
// can use its own settings, state and secrets whoever calls it. Other values pass through.
function peerApi(mt, dep, depth) {
  const peer = mt.peers.get(dep), api = (peer && peer.api) || {};
  const bt = metaOf(mt.list, peer);
  if (!bt || !(bt.version >= 1)) return api;
  const out = {};
  for (const k of Object.keys(api)) {
    const v = api[k];
    out[k] = typeof v === 'function' ? function (...args) { const self = Object.create(api); self.ctx = moduleCtx(bt, {}, depth); return v.apply(self, args); } : v;
  }
  return out;
}

// What every contract-1 callback gets on top of its own ctx.
function moduleCtx(mt, base, depth = 0) {
  if (!mt || !(mt.version >= 1)) return base;
  return { ...base, settings: mt.settings, state: mt.state, config: mt.config, tasks: mt.tasks || NO_TASKS,
    secret: key => {
      if (!mt.schema[key] || mt.schema[key].type !== 'secret') throw new Error(`module ${mt.name} has no secret setting "${key}"`);
      return mt.secrets[key] === undefined ? null : mt.secrets[key];
    },
    api: dep => {
      if (!mt.dependsOn.includes(dep)) throw new Error(`module ${mt.name} reached for "${dep}" without listing it in dependsOn`);
      return peerApi(mt, dep, depth);
    },
    engines: Object.freeze({ run: (engine, input, o) => E.run(mt.name, mt.config, engine, input, o) }),
    emit: (ev, payload) => {
      if (!EVENT_RE.test(String(ev))) return Promise.reject(new Error(`event name ${show(ev, mt)} must look like "prefix.name"`));
      const pre = prefixOf(ev);
      if (pre !== mt.name && !mt.emits.includes(pre)) return Promise.reject(new Error(`module ${mt.name} may emit only ${[mt.name, ...mt.emits].map(x => `"${x}.*"`).join(', ')} events, not "${ev}"`));
      return deliver(mt.list, ev, payload, undefined, depth + 1);
    } };
}

// The run-time half of a meta: settings, secrets, state and what ctx needs.
// mt.timeoutMs is the effective per-hook timeout: the module's declared hookTimeoutMs, capped by the global one.
// migrate and uninstall are lifecycle hooks and keep LIFECYCLE_TIMEOUT_MS.
function prime(mt, cfg, extra) {
  const { settings, secrets } = settingsOf(mt, cfg);
  Object.assign(mt, { settings, secrets, config: cfg, state: makeState(mt.name, () => mt) }, extra);
  if (extra && extra.timeoutMs && mt.hookTimeoutMs) mt.timeoutMs = Math.min(mt.hookTimeoutMs, extra.timeoutMs);
  return mt;
}

// ---- loading
// -> { mods: [module...] in load order, errors: ['<name>: why'...], meta: Map name -> meta }
// Load order: dependencies first, then priority (lower first, default 0), then config order.
// opts.role: "main" (default) or "worker"; a module whose runsOn leaves the role out is skipped.
// opts.tasks: the task service for ctx.tasks (S1); without it ctx.tasks rejects.
function load(cfg, opts = {}) {
  const role = opts.role || 'main';
  const errors = [], meta = new Map();
  const conf = (cfg && cfg.modules) || {};
  let ms = HOOK_TIMEOUT_MS;
  if (cfg && cfg.modules_hook_timeout_ms !== undefined) {
    const v = cfg.modules_hook_timeout_ms;
    if (Number.isInteger(v) && v >= 1) ms = v;
    else errors.push(`config: modules_hook_timeout_ms must be a whole number of milliseconds >= 1, got ${show(v)}`);
  }
  const status = new Map();  // name -> why it is not loaded
  const alive = new Map();   // name -> { m, mt, index }
  const claimed = new Map(); // event prefix -> module
  // Every enabled module's secrets are known before any module is required or validated, so one module's load error cannot carry another's secret.
  for (const n of Object.keys(conf)) if (conf[n] === true && NAME_RE.test(n)) { try { readSecrets(n); } catch { /* reported when that module loads */ } }
  Object.keys(conf).forEach((name, index) => {
    const val = conf[name];
    if (typeof val !== 'boolean') { errors.push(`${name}: config value must be true or false`); status.set(name, 'which has a bad config value'); return; }
    if (!NAME_RE.test(name) || !fs.existsSync(path.join(DIR, name))) { errors.push(`${name}: unknown module (no folder modules/${name})`); status.set(name, 'which is not installed'); return; }
    if (!val) { status.set(name, 'which is off in config "modules"'); return; }
    try {
      const m = require(path.join(DIR, name, 'index.js'));
      const mt = validate(m, name, path.join(DIR, name));
      if (!mt.runsOn.includes(role)) { status.set(name, `which does not run on ${role}`); return; }
      for (const pre of [name, ...mt.emits]) {
        const other = claimed.get(pre);
        if (other && other !== name) throw new Error(`event prefix "${pre}" is already ${other === pre ? 'the name of' : 'declared by'} module ${other}`);
      }
      prime(mt, cfg, { timeoutMs: ms, tasks: opts.tasks || NO_TASKS });
      for (const pre of [name, ...mt.emits]) claimed.set(pre, name);
      if (mt.version === 0 && !warned.has(name)) { warned.add(name); report(`module ${name} uses legacy contract 0; it still loads, unchecked. Move it to contract 2 (docs/MODULES.md).`); }
      alive.set(name, { m, mt, index });
    } catch (e) { errors.push(`${name}: ${loadWhy(name, e)}`); status.set(name, 'which failed to load'); }
  });
  // A missing, off or failed dependency drops the module (and, in turn, its dependents).
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, x] of alive) {
      const d = x.mt.dependsOn.find(dep => !alive.has(dep));
      if (d === undefined) continue;
      const why = status.get(d) || (fs.existsSync(path.join(DIR, d)) ? 'which is not in config "modules"' : 'which is not installed');
      errors.push(`${name}: depends on "${d}", ${why}`);
      status.set(name, 'which could not load its own dependencies');
      alive.delete(name);
      changed = true;
    }
  }
  const ordered = [], done = new Set();
  let rest = [...alive.values()];
  for (;;) {
    const ready = rest.filter(x => x.mt.dependsOn.every(d => done.has(d)));
    if (!ready.length) break;
    ready.sort((a, b) => (a.mt.priority - b.mt.priority) || a.index - b.index);
    ordered.push(ready[0]); done.add(ready[0].mt.name);
    rest = rest.filter(x => x !== ready[0]);
  }
  const stuck = new Set(rest.map(x => x.mt.name));
  for (const x of rest) {
    const trail = [x.mt.name];
    let cur = x.mt.name;
    for (;;) {
      cur = alive.get(cur).mt.dependsOn.find(d => stuck.has(d));
      const i = trail.indexOf(cur);
      if (i >= 0) { trail.push(cur); errors.push(`${x.mt.name}: dependency cycle: ${i === 0 ? trail.join(' -> ') : `it depends on ${trail.slice(i).join(' -> ')}`}`); break; }
      trail.push(cur);
    }
  }
  // The engine gives one hook call 60 s. Hooks of one call run one after the other,
  // each with its own timeout, so the timeouts that can add up in one call must fit.
  const budget = (label, pick) => {
    const hit = ordered.filter(x => pick(x.m, x.mt));
    const total = hit.reduce((n, x) => n + (x.mt.timeoutMs || ms), 0);
    if (total >= ENGINE_HOOK_LIMIT_MS) errors.push(`hook time budget: the ${label} hooks of ${hit.map(x => `${x.mt.name} (${x.mt.timeoutMs || ms} ms)`).join(', ')} add up to ${total} ms, which is not under the engine's ${ENGINE_HOOK_LIMIT_MS} ms hook limit; lower modules_hook_timeout_ms or turn a module off`);
  };
  budget('beforeTool (PreToolUse)', m => typeof m.beforeTool === 'function');
  budget('tool.done (PostToolUse)', (m, mt) => (mt.version >= 1 ? !!(mt.on && mt.on['tool.done']) : typeof m.afterTool === 'function'));
  const mods = ordered.map(x => x.m);
  const peers = new Map(ordered.map(x => [x.mt.name, x.m]));
  for (const { m, mt } of ordered) {
    Object.assign(mt, { peers, list: mods });
    META.set(m, mt);
    meta.set(mt.name, mt);
  }
  LOADS.set(mods, meta);
  return { mods, errors, meta };
}

// ---- dispatch
// First beforeTool hit wins: [kind, reason] or null, in load order. null, undefined
// and false allow; [kind, message] (two strings, kind non-empty) blocks; any other
// result is a "module_bad_result" block. A throwing or rejecting module is a hit of
// kind "module", and one that does not settle in time is a hit of kind
// "module_timeout" (its ctx.signal is aborted). All fail closed, never a pass.
async function beforeTool(mods, ctx) {
  for (const m of mods) {
    if (typeof m.beforeTool !== 'function') continue;
    const mt = metaOf(mods, m);
    const ms = (mt && mt.timeoutMs) || HOOK_TIMEOUT_MS;
    let hit;
    try { hit = await timed(signal => m.beforeTool(moduleCtx(mt, { ...ctx, signal })), ms, `module ${m.name} beforeTool`); } catch (e) {
      if (e && e.timeout) return ['module_timeout', `module ${m.name} beforeTool took longer than ${ms} ms (fail closed)`];
      return ['module', `module ${m.name} failed (${why(mt, e).slice(0, 120)})`];
    }
    if (hit === null || hit === undefined || hit === false) continue;
    if (Array.isArray(hit) && hit.length === 2 && typeof hit[0] === 'string' && hit[0] && typeof hit[1] === 'string') return [scrub(mt, hit[0]), scrub(mt, hit[1])];
    return ['module_bad_result', `module ${m.name} beforeTool returned ${scrub(mt, show(hit, mt))}; it must return null (allow) or [kind, message] (block) (fail closed)`];
  }
  return null;
}

// chooseEngine(turn, ctx) of every module in load order, each time-bounded (min of
// CHOOSE_ENGINE_TIMEOUT_MS and the hook timeout). The first non-empty string wins.
// null, a throw, a timeout or a non-string counts as "no opinion". Journals
// engine_choice {module, engine, reason}. -> { engine, module } or null (nothing changes).
async function chooseEngine(mods, turn = {}) {
  for (const m of mods) {
    if (typeof m.chooseEngine !== 'function') continue;
    const mt = metaOf(mods, m);
    if (!mt || !(mt.version >= 1)) continue;
    const ms = Math.min(CHOOSE_ENGINE_TIMEOUT_MS, mt.timeoutMs || HOOK_TIMEOUT_MS);
    let r, reason = 'chosen';
    try { r = await timed(signal => m.chooseEngine(freeze(clone(turn)), moduleCtx(mt, { signal })), ms, `module ${m.name} chooseEngine`); }
    catch (e) { r = null; reason = e && e.timeout ? 'timeout' : 'error'; report(`module ${m.name} chooseEngine failed: ${why(mt, e)}`); }
    if (r !== null && r !== undefined && (typeof r !== 'string' || !r.trim() || r.length > 80)) { r = null; reason = 'bad_result'; }
    if (r === null || r === undefined) {
      if (reason !== 'chosen') { try { J.append({ type: 'engine_choice', module: m.name, engine: null, reason }); } catch { /* journal is best effort here */ } }
      continue;
    }
    const engine = scrub(mt, r);
    try { J.append({ type: 'engine_choice', module: m.name, engine, reason }); } catch { /* best effort */ }
    return { engine, module: m.name };
  }
  return null;
}

// beforeReply(reply, ctx) of every module in load order, each timed (hook timeout).
// It returns a string (the possibly changed reply), null/undefined (unchanged) or
// { block: true, reason }. A throw, timeout or bad result follows the module's
// failMode: "open" (default) keeps the reply, "closed" blocks it. Journals
// reply_hook {module, outcome, task_id} and never the reply text or a hook's free-text reason.
// -> { reply, blocked, module, code, reason } (module = the blocking module's name when blocked)
async function beforeReply(mods, reply, ctx = {}) {
  let cur = reply;
  for (const m of mods) {
    if (typeof m.beforeReply !== 'function') continue;
    const mt = metaOf(mods, m);
    if (!mt || !(mt.version >= 1)) continue;
    const log = outcome => { try { J.append({ type: 'reply_hook', module: m.name, outcome, task_id: ctx.task_id }); } catch { /* best effort */ } }; // fixed codes only: a hook's free-text reason may echo the blocked reply
    let r, bad = null;
    try {
      r = await timed(signal => m.beforeReply(cur, moduleCtx(mt, { ...ctx, signal })), mt.timeoutMs || HOOK_TIMEOUT_MS, `module ${m.name} beforeReply`);
      if (r === null || r === undefined) { log('unchanged'); continue; }
      if (typeof r === 'string') { log(r === cur ? 'unchanged' : 'modified'); cur = r; continue; }
      if (isObj(r) && r.block === true) { const reason = typeof r.reason === 'string' ? scrub(mt, r.reason).slice(0, 200) : 'blocked by module'; log('blocked'); return { reply: cur, blocked: true, module: m.name, code: 'blocked', reason: `module ${m.name}: ${reason}` }; }
      bad = new Error('beforeReply returned an invalid result'); bad.invalid = true;
    } catch (e) { bad = e; }
    const kind = bad.timeout ? 'timeout' : 'error';
    report(`module ${m.name} beforeReply ${bad.timeout ? 'hook_timeout' : bad.invalid ? 'hook_invalid' : 'hook_error'}`); // fixed code only: the message or result may echo the reply
    if (mt.failMode === 'closed') { log(`${kind}_closed`); return { reply: cur, blocked: true, module: m.name, code: kind === 'timeout' ? 'hook_timeout' : 'hook_error', reason: `module ${m.name} beforeReply ${kind} (fail closed)` }; }
    log(`${kind}_open`);
  }
  return { reply: cur, blocked: false };
}

// Events: every module's on[event] in load order, each awaited with the hook
// timeout. A throw, reject or timeout is reported and never stops the others.
// Legacy contract-0 modules get the matching old hook (onTaskStart, onTaskEnd,
// afterTool) with `legacy` as its ctx. -> { errors: [...] }
async function deliver(mods, event, payload, legacy, depth = 0) {
  if (depth > MAX_EMIT_DEPTH) { const msg = `event ${scrub(null, event)} dropped: events nested deeper than ${MAX_EMIT_DEPTH}`; report(msg); return { errors: [msg] }; }
  const data = freeze(payload === undefined ? {} : clone(payload));
  const errors = [];
  for (const m of mods) {
    const mt = metaOf(mods, m);
    let call = null;
    if (mt && mt.version >= 1) { if (mt.on[event]) call = signal => mt.on[event](data, moduleCtx(mt, { signal }, depth)); }
    else if (LEGACY_EVENT[event] && typeof m[LEGACY_EVENT[event]] === 'function') call = () => m[LEGACY_EVENT[event]](legacy || data);
    if (!call) continue;
    try { await timed(call, (mt && mt.timeoutMs) || HOOK_TIMEOUT_MS, `module ${m.name} on ${event}`); } catch (e) {
      const msg = `module ${m.name} on ${scrub(mt, event)} failed: ${why(mt, e)}`;
      errors.push(msg); report(msg);
    }
  }
  return { errors };
}
// Core's emit: any event name. Modules emit through ctx.emit (prefix-checked).
const emit = (mods, event, payload, legacy) => deliver(mods, event, payload, legacy, 0);

// Status lines of every module, in load order; a failing one is one line saying so.
async function statusLines(mods, Jn) {
  const out = [];
  for (const m of mods) {
    if (typeof m.statusLines !== 'function') continue;
    const mt = metaOf(mods, m);
    try { out.push(...[].concat(await timed(signal => m.statusLines(Jn, moduleCtx(mt, { signal })), (mt && mt.timeoutMs) || HOOK_TIMEOUT_MS, `module ${m.name} statusLines`) || [])); }
    catch (e) { out.push(`module ${m.name}: status failed (${why(mt, e).slice(0, 120)})`); }
  }
  return out;
}

// prepareTurn(ctx) of every module before an engine turn, in load order, each
// timed. A module returns null or { context: [strings] }; the strings are added to
// the prompt (clipped at MAX_TURN_CONTEXT chars per module). A failure or a bad
// shape is reported and skipped, never a block.
// -> { context: [{ module, text }], errors: [...] }
async function prepareTurn(mods, ctx = {}) {
  const context = [], errors = [];
  for (const m of mods) {
    const mt = metaOf(mods, m);
    if (!mt || !(mt.version >= 1) || typeof m.prepareTurn !== 'function') continue;
    try {
      const r = await timed(signal => m.prepareTurn(moduleCtx(mt, { ...ctx, signal })), mt.timeoutMs || HOOK_TIMEOUT_MS, `module ${m.name} prepareTurn`);
      if (r === null || r === undefined) continue;
      if (!isObj(r) || (r.context !== undefined && (!Array.isArray(r.context) || r.context.some(s => typeof s !== 'string')))) throw new Error(`must return null or { context: [strings] }, got ${show(r, mt)}`);
      let text = (r.context || []).filter(Boolean).join('\n');
      if (text.length > MAX_TURN_CONTEXT) text = text.slice(0, MAX_TURN_CONTEXT) + ' [clipped]';
      if (text) context.push({ module: m.name, text });
    } catch (e) { const msg = `module ${m.name} prepareTurn failed: ${why(mt, e)}`; errors.push(msg); report(msg); }
  }
  return { context, errors };
}

// stateVersion: state/m/<name>/state-version.json holds the version the module's
// state is at (none: 0). When it is below the module's stateVersion, migrate(from,
// ctx) runs once (timed) and the new version is written. A stored version above the
// module's is an error. -> { errors: ['<name>: why'...] }
const versionFile = name => path.join(stateDir(name), 'state-version.json');
async function migrate(mods) {
  const errors = [];
  for (const m of mods) {
    const mt = metaOf(mods, m);
    if (!mt || !(mt.version >= 1) || mt.stateVersion === undefined) continue;
    const f = versionFile(mt.name);
    try {
      let from = 0;
      if (fs.existsSync(f)) {
        let v;
        try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { v = null; }
        if (!isObj(v) || !Number.isInteger(v.version) || v.version < 0) throw new Error(`${f} holds no whole "version"`);
        from = v.version;
      }
      if (from > mt.stateVersion) throw new Error(`its state is at version ${from}, newer than this module's stateVersion ${mt.stateVersion}`);
      if (from === mt.stateVersion) continue;
      if (typeof m.migrate === 'function') await timed(signal => m.migrate(from, moduleCtx(mt, { signal })), LIFECYCLE_TIMEOUT_MS, `module ${m.name} migrate`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f + '.tmp', JSON.stringify({ version: mt.stateVersion }) + '\n');
      fs.renameSync(f + '.tmp', f);
      if (from > 0) mt.state.append({ type: 'module_migrated', from, to: mt.stateVersion });
    } catch (e) { errors.push(`${m.name}: state migration failed: ${why(mt, e)}`); }
  }
  return { errors };
}

// The owner's uninstall of one module: its uninstall(ctx) hook (timed), then its
// state/m/<name>/ folder and secrets file are removed and a module_uninstalled
// record is written. Journal records stay. The config line and the folder under
// modules/ are the owner's to remove. -> { errors, removed: [paths] }
async function uninstall(cfg, name) {
  if (!NAME_RE.test(String(name)) || !fs.existsSync(path.join(DIR, name, 'index.js'))) throw new Error(`unknown module "${name}"`);
  const { m, mt } = loadModule(name);
  const errors = [], removed = [];
  try { prime(mt, cfg, { timeoutMs: HOOK_TIMEOUT_MS, peers: new Map(), list: [], tasks: NO_TASKS }); }
  catch (e) { errors.push(`settings: ${loadWhy(name, e)} (the hook runs with defaults)`); Object.assign(mt, { config: cfg, state: makeState(name, () => mt), peers: new Map(), list: [], tasks: NO_TASKS }); }
  if (mt.version >= 1 && typeof m.uninstall === 'function') {
    try { await timed(signal => m.uninstall(moduleCtx(mt, { signal })), LIFECYCLE_TIMEOUT_MS, `module ${name} uninstall`); }
    catch (e) { errors.push(`uninstall hook failed: ${why(mt, e)}`); }
  }
  for (const p of [stateDir(name), secretsFile(name)]) if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); }
  J.append({ type: 'module_uninstalled', module: name, removed: removed.length });
  return { errors, removed };
}

// name -> fn(args, core) -> result or promise. The first module (load order) to
// claim a name wins. Contract-1 commands get core plus the module ctx.
function commands(mods) {
  const out = {};
  for (const m of mods) for (const [k, f] of Object.entries(m.commands || {})) {
    if (k in out) continue;
    const mt = metaOf(mods, m);
    out[k] = mt && mt.version >= 1 ? (args, core) => f(args, moduleCtx(mt, core || {})) : f;
  }
  return out;
}

// Who is calling a route: { kind: owner | worker | anonymous, id }.
function actorOf(a) {
  if (isObj(a) && ACTORS.includes(a.kind)) return Object.freeze({ kind: a.kind, id: typeof a.id === 'string' ? a.id : '' });
  return Object.freeze({ kind: 'anonymous', id: '' });
}
const mayCall = (access, actor) => access === 'public-get' || access === 'public-post' || actor.kind === 'owner' || (access === 'worker' && actor.kind === 'worker');

// What S1 (server), S2 (UI) and S3 (worker) read. Nothing here serves HTTP or
// renders UI. No listing carries a secret's value.
function registry(cfg, opts = {}) {
  const { mods, errors, meta } = load(cfg, opts);
  const all = k => [...meta.values()].flatMap(mt => mt[k]);
  const listRoutes = () => all('routes').map(({ module, method, path: p, handler, description, access }) => ({ module, method, path: p, handler, description, access }));
  const segs = s => s.split('/').filter(Boolean);
  const secretsOf = mt => Object.fromEntries(secretKeys(mt).map(k => [k, secretStatus(mt.secrets[k])]));
  return {
    role: opts.role || 'main', mods, errors,
    modules: () => [...meta.values()].map(mt => ({ name: mt.name, contract: mt.version, runsOn: mt.runsOn.slice(), dependsOn: mt.dependsOn.slice(), secrets: secretsOf(mt), stateVersion: mt.stateVersion })),
    listCommands: () => Object.keys(commands(mods)),
    listRoutes,
    listPanels: () => all('panels').map(({ module, id, title, mount, entry, url, file }) => ({ module, id, title, mount, entry, url, file })),
    listJobs: () => all('jobs').map(({ module, id, kind, every }) => ({ module, id, kind, every })),
    // provides.<kind> of every loaded module: [{ module, kind, id, description?, ... }].
    providers(kind) {
      if (!PROVIDER_KINDS.includes(kind)) throw new Error(`unknown provider kind "${kind}" (kinds: ${PROVIDER_KINDS.join(', ')})`);
      return all('provides').filter(x => x.kind === kind).map(x => ({ ...x }));
    },
    // A copy of a loaded module's settings ({} without a schema), secrets shown as
    // "configured" / "missing"; null when not loaded.
    settingsFor: name => meta.has(name) ? publicSettings(meta.get(name)) : null,
    // The settings schema of a loaded module, for a settings UI: { section, settings } or null.
    settingsSchema: name => meta.has(name) ? { section: sectionKey(name), settings: clone(meta.get(name).schema) } : null,
    // Validates the whole patch first (nothing changes if any key is bad), then
    // applies it: null resets a setting to its default, a secret goes to the secrets
    // file ('' or null removes it), the rest updates the in-memory settings and
    // opts.save(section, newSection) is awaited to persist the config section (S1
    // owns writing the config file). -> the new public settings.
    async updateSettings(name, patch, uo = {}) {
      const mt = meta.get(name);
      if (!mt) throw new Error(`module "${name}" is not loaded`);
      if (!isObj(patch)) throw new Error('settings patch must be an object');
      const p = [];
      for (const [k, v] of Object.entries(patch)) {
        const s = mt.schema[k];
        if (!s) { p.push(`unknown setting "${k}" (known: ${Object.keys(mt.schema).join(', ') || 'none'})`); continue; }
        if (v === null || (s.type === 'secret' && v === '')) continue;
        const bad = checkValue(s, v, mt);
        if (bad) p.push(`${k} ${bad}`);
      }
      if (p.length) throw new Error(`module ${name}: ${p.join('; ')}`);
      const key = sectionKey(name);
      const section = { ...(mt.config && isObj(mt.config[key]) ? mt.config[key] : {}) };
      for (const [k, v] of Object.entries(patch)) {
        const s = mt.schema[k];
        if (s.type === 'secret') {
          setSecret(name, k, v);
          noteSecrets(mt.secrets);
          if (v === null || v === '') delete mt.secrets[k]; else mt.secrets[k] = v;
          mt.settings[k] = secretStatus(mt.secrets[k]);
        } else if (v === null) { delete section[k]; mt.settings[k] = clone(s.default); }
        else { section[k] = clone(v); mt.settings[k] = clone(v); }
      }
      if (isObj(mt.config)) mt.config[key] = section;
      if (typeof uo.save === 'function') await uo.save(key, clone(section));
      return publicSettings(mt);
    },
    // A loaded module's api object (core use; modules use ctx.api), or null.
    api: name => meta.has(name) ? (mods.find(m => m.name === name).api || {}) : null,
    // A module's ui/ file for static serving -> real path, or null (outside the
    // folder after symlinks, not a regular file, or no such module).
    uiFile(name, rel) {
      const mt = meta.get(name);
      if (!mt || typeof rel !== 'string' || !UI_RE.test(rel) || rel.includes('..')) return null;
      return realFile(mt.dir, rel).file || null;
    },
    // Runs pending state migrations of the loaded modules (see migrate()).
    migrate: () => migrate(mods),
    // method + url path -> { route, params } or null. Params are URL-decoded; one
    // holding "..", "/", "\" or NUL after decoding matches nothing.
    findRoute(method, urlPath) {
      const want = segs(String(urlPath).split('?')[0]);
      // Among the routes that match, compare segment by segment from the left: at the first segment where one route
      // has a literal and the other a :param, the literal wins. Routes equal in that respect: declaration order.
      let best = null, bestSegs = null;
      const beats = (a, b) => { for (let i = 0; i < a.length; i++) { const la = !a[i].startsWith(':'), lb = !b[i].startsWith(':'); if (la !== lb) return la; } return false; };
      for (const r of listRoutes()) {
        const have = segs(r.path);
        if (r.method !== method || have.length !== want.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < have.length && ok; i++) {
          if (have[i].startsWith(':')) {
            let v;
            try { v = decodeURIComponent(want[i]); } catch { ok = false; break; }
            if (BAD_PARAM.test(v) || /%[0-9A-Fa-f]{2}/.test(v)) ok = false; else params[have[i].slice(1)] = v;
          } else ok = have[i] === want[i];
        }
        if (ok && (!best || beats(have, bestSegs))) { best = { route: r, params }; bestSegs = have; }
      }
      return best;
    },
    // Calls a route handler with the module ctx filled in -> Promise<{status, json}>.
    // ctx.actor ({ kind: owner | worker | anonymous, id }) is checked against the
    // route's access first: 403 { error: "forbidden" }. A throwing handler or a bad
    // response is a 500 { error: "internal error", ref } and a route_error journal
    // record (ref is its id) with the scrubbed detail; never a crash.
    async callRoute(found, ctx = {}) {
      const r = found.route;
      const mt = meta.get(r.module);
      const actor = actorOf(ctx.actor);
      if (!mayCall(r.access || 'owner', actor)) return { status: 403, json: { error: 'forbidden' } };
      const fail = detail => {
        let ref = null;
        try { ref = J.append({ type: 'route_error', module: r.module, method: r.method, path: r.path, error: scrub(mt, detail) }).id; } catch (e) { report(`route_error not journaled: ${why(mt, e)}`); }
        return { status: 500, json: { error: 'internal error', ref } };
      };
      try {
        const res = await r.handler(moduleCtx(mt, { query: {}, body: undefined, ...ctx, params: found.params, actor }));
        return res && Number.isInteger(res.status) ? res : fail(`route returned no {status}, got ${show(res, mt)}`);
      } catch (e) { return fail(why(mt, e)); }
    },
    // Core's emit for the server process (modules use ctx.emit).
    emit: (event, payload) => emit(mods, event, payload),
    // Starts every job in load order; resolves to { stop() -> Promise }. A service's
    // start is timed (hook timeout). stop() goes in reverse load order: clears the
    // timer, waits for an in-flight run, then calls the service's stop, each timed.
    // ctx.signal of a job is aborted when stop() begins. Job errors go to onError, never throw.
    async startJobs(ctx = {}, onError = (job, e) => report(`job ${job.module}/${job.id} failed: ${why(meta.get(job.module), e)}`)) {
      const halt = new AbortController();
      const running = [];
      for (const job of all('jobs')) {
        const mt = meta.get(job.module);
        const ms = mt.timeoutMs || HOOK_TIMEOUT_MS;
        const jctx = () => moduleCtx(mt, { ...ctx, signal: halt.signal });
        if (job.kind === 'interval') {
          const r = { job, ms, inflight: null };
          r.timer = setInterval(() => {
            if (r.inflight) return; // no overlap: a slow run skips ticks
            r.inflight = Promise.resolve().then(() => job.run(jctx())).catch(e => onError(job, e)).finally(() => { r.inflight = null; });
          }, job.every * 1000);
          running.push(r);
        } else {
          let started;
          try {
            const s = await timed(() => (started = Promise.resolve().then(() => job.start(jctx()))), ms, `job ${job.module}/${job.id} start`);
            if (typeof s === 'function') running.push({ job, ms, stop: s });
            else onError(job, new Error('start() must return a stop function'));
          } catch (e) {
            if (e && e.timeout && started) started.then(s => typeof s === 'function' && s(), () => {}); // a late start is stopped at once
            onError(job, e);
          }
        }
      }
      return { async stop() {
        halt.abort();
        running.forEach(r => r.timer && clearInterval(r.timer));
        for (const r of running.slice().reverse()) {
          if (r.inflight) { try { await timed(() => r.inflight, r.ms, `job ${r.job.module}/${r.job.id} run`); } catch (e) { onError(r.job, e); } }
          if (r.stop) { try { await timed(() => r.stop(), r.ms, `job ${r.job.module}/${r.job.id} stop`); } catch (e) { onError(r.job, e); } }
        }
      } };
    },
  };
}

module.exports = { load, validate, registry, beforeTool, chooseEngine, beforeReply, emit, statusLines, prepareTurn, migrate, uninstall, commands, setSecret, secretsFile, hideAll, scrubAll,
  aclProblem, icaclsFix, restrict, ENGINE_HOOK_LIMIT_MS, DIR, CONTRACT, HOOK_TIMEOUT_MS, RESERVED, PROVIDER_KINDS, sectionKey };
