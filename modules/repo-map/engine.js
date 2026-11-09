'use strict';
// repo-map engine: lightweight regex symbol extraction, reference-count ranking, budgeted render.
// Plain Node only. Unreadable files are skipped rather than raised.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const EXT = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.cs': 'cs', '.md': 'md',
};
const CACHE_VERSION = 1;

// Each rule: [regex, group index of the name, kind]. Only column-0 (top level) declarations.
const RULES = {
  js: [
    [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 1, 'fn'],
    [/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 1, 'class'],
    [/^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 1, 'type'],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 1, 'fn'],
  ],
  py: [[/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, 1, 'fn'], [/^class\s+([A-Za-z_]\w*)/, 1, 'class']],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 1, 'fn'],
    [/^type\s+([A-Za-z_]\w*)/, 1, 'type'],
  ],
  rs: [[/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/, 1, 'item']],
  java: [[/^(?:(?:public|protected|private|abstract|final|static|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, 1, 'class']],
  cs: [[/^(?:(?:public|internal|protected|private|abstract|sealed|static|partial)\s+)*(?:class|interface|enum|struct|record|namespace)\s+([A-Za-z_][\w.]*)/, 1, 'class']],
};

const clean = s => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

function extractSymbols(lang, text) {
  const syms = [];
  const lines = String(text).split('\n');
  if (lang === 'md') {
    let fence = false;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) syms.push({ n: clean(m[2]).slice(0, 60), k: 'h' + m[1].length });
      if (syms.length >= 200) break;
    }
    return syms;
  }
  const rules = RULES[lang] || [];
  for (const raw of lines) {
    if (!raw || raw[0] === ' ' || raw[0] === '\t') continue;
    const line = raw.replace(/\r$/, '');
    for (const [re, g, k] of rules) {
      const m = re.exec(line);
      if (m) { syms.push({ n: m[g].slice(0, 80), k }); break; }
    }
    if (syms.length >= 400) break;
  }
  return syms;
}

function tokensOf(text, cap) {
  const set = new Set();
  const re = /[A-Za-z_$][\w$]{2,}/g;
  let m;
  while ((m = re.exec(text)) && set.size < cap) set.add(m[0]);
  return Array.from(set);
}

// Is `p` inside `root` (both already real paths)?
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function git(root, args, timeout, maxBuffer) {
  return execFileSync('git', args, { cwd: root, maxBuffer, timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8');
}

function gitList(root, timeout) {
  try {
    const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], timeout, 64 * 1024 * 1024);
    return out.split('\0').filter(Boolean);
  } catch { return null; }
}

// path -> position, 0 = touched most recently
function gitRecency(root, timeout) {
  const rank = new Map();
  try {
    const out = git(root, ['log', '-n', '200', '--name-only', '--format=', '-z'], timeout, 16 * 1024 * 1024);
    for (const f of out.split('\0')) {
      const name = f.replace(/^\n+/, '');
      if (name && !rank.has(name)) rank.set(name, rank.size);
    }
  } catch { /* no git or no history */ }
  return rank;
}

function walk(root, limit, out = [], rel = '', depth = 0) {
  if (depth > 12 || out.length >= limit) return out;
  let ents;
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of ents) {
    if (out.length >= limit) break;
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(root, limit, out, r, depth + 1);
    else if (e.isFile() || e.isSymbolicLink()) out.push(r);
  }
  return out;
}

function readHead(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

// opts: max_files, max_bytes_total, max_file_bytes, cache_entries, use_git, git_timeout_ms,
// cache ({version, files}, mutated), now, sub (relative subpath filter)
function build(rootIn, opts) {
  const o = Object.assign({ max_files: 2000, max_bytes_total: 8 * 1024 * 1024, max_file_bytes: 200 * 1024, cache_entries: 5000, use_git: true, git_timeout_ms: 8000, cache: null, now: Date.now() }, opts || {});
  const root = fs.realpathSync(rootIn);
  let list = o.use_git ? gitList(root, o.git_timeout_ms) : null;
  const usedGit = !!list;
  if (!list) list = walk(root, o.max_files * 4);
  const sub = o.sub ? String(o.sub).replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '') : '';
  const cands = [];
  for (const f of list) {
    const rel = f.replace(/\\/g, '/');
    if (sub && !(rel === sub || rel.startsWith(sub + '/'))) continue;
    if (rel.split('/').some(p => SKIP_DIRS.has(p))) continue;
    if (EXT[path.extname(rel).toLowerCase()]) cands.push(rel);
  }
  cands.sort();
  const truncatedFiles = cands.length > o.max_files;
  const picked = cands.slice(0, o.max_files);

  let cache = o.cache;
  if (!cache || typeof cache !== 'object') cache = { version: CACHE_VERSION, files: {} };
  if (cache.version !== CACHE_VERSION || !cache.files) { cache.version = CACHE_VERSION; cache.files = {}; }
  const infos = [];
  let bytes = 0, skipped = 0, hit = 0, truncatedBytes = false;
  for (const rel of picked) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        const real = fs.realpathSync(abs);
        if (!inside(root, real)) { skipped++; continue; }
        st = fs.statSync(real);
      }
      if (!st.isFile()) continue;
    } catch { skipped++; continue; }
    const key = root + '\0' + rel;
    const c = cache.files[key];
    const want = Math.min(st.size, o.max_file_bytes);
    if (c && c.m === st.mtimeMs && c.s === st.size) {
      c.u = o.now; hit++;
      bytes += want;
      infos.push({ rel, syms: c.syms, toks: c.toks, lang: c.lang });
      continue;
    }
    if (bytes + want > o.max_bytes_total) { truncatedBytes = true; break; }
    let buf;
    try { buf = readHead(abs, want); } catch { skipped++; continue; }
    bytes += buf.length;
    if (buf.includes(0)) { skipped++; continue; }
    const text = buf.toString('utf8');
    const lang = EXT[path.extname(rel).toLowerCase()];
    const syms = extractSymbols(lang, text);
    const toks = lang === 'md' ? [] : tokensOf(text, 3000);
    cache.files[key] = { m: st.mtimeMs, s: st.size, u: o.now, lang, syms, toks };
    infos.push({ rel, syms, toks, lang });
  }
  // retention cap: drop the least recently used entries
  const keys = Object.keys(cache.files);
  if (keys.length > o.cache_entries) {
    keys.sort((a, b) => cache.files[a].u - cache.files[b].u);
    for (const k of keys.slice(0, keys.length - o.cache_entries)) delete cache.files[k];
  }

  const df = new Map();
  for (const f of infos) for (const t of f.toks) df.set(t, (df.get(t) || 0) + 1);
  const rec = usedGit ? gitRecency(root, o.git_timeout_ms) : new Map();
  const ranked = infos.map(f => {
    let score = 0;
    const refs = new Map();
    for (const s of f.syms) {
      if (f.lang === 'md') continue;
      const r = Math.min(Math.max((df.get(s.n) || 1) - 1, 0), 20);
      refs.set(s.n, r);
      score += r;
    }
    const pos = rec.get(f.rel);
    if (pos !== undefined) score += 3 * (1 - Math.min(pos, 199) / 200);
    if (f.lang === 'md') score += 0.5;
    return { rel: f.rel, lang: f.lang, syms: f.syms, refs, score };
  });
  ranked.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1));
  return { root, files: ranked, cache, stats: { total: cands.length, scanned: infos.length, skipped, cache_hits: hit, git: usedGit, truncated: truncatedFiles || truncatedBytes } };
}

function fileLine(f, maxSyms) {
  const seen = new Set();
  let syms = f.syms.filter(s => (seen.has(s.n) ? false : (seen.add(s.n), true)));
  if (syms.length > maxSyms) {
    syms = syms.map((s, i) => ({ s, i, r: f.refs.get(s.n) || 0 })).sort((a, b) => b.r - a.r || a.i - b.i).slice(0, maxSyms).sort((a, b) => a.i - b.i).map(x => x.s);
  }
  const names = syms.map(s => (s.k && s.k[0] === 'h' ? '#'.repeat(+s.k[1]) + ' ' + clean(s.n) : clean(s.n)));
  return clean(f.rel) + (names.length ? ': ' + names.join(', ') : '');
}

function render(result, opts) {
  const max = (opts && opts.max_chars) || 4000;
  const maxSyms = (opts && opts.max_symbols_per_file) || 12;
  let out = 'Repo map (files ranked by how often their symbols are referenced elsewhere):', shown = 0;
  for (const f of result.files) {
    const line = '\n' + fileLine(f, maxSyms);
    if (out.length + line.length > max - 40) {
      const room = max - 40 - out.length;
      if (shown === 0 && room > 20) { out += line.slice(0, room); shown++; }
      break;
    }
    out += line; shown++;
  }
  const more = result.files.length - shown;
  if (more > 0) out += `\n(+${more} more files not shown)`;
  else if (result.stats.truncated) out += '\n(file or byte cap reached; map is partial)';
  if (out.length > max) out = out.slice(0, max);
  return { text: out, shown, total: result.files.length };
}

module.exports = { build, render, extractSymbols, inside, CACHE_VERSION };
