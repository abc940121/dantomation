'use strict';
// roles card: the open set of fields that give a role its own manner. A role record has `card: { <field>: value }`.
// FIELDS is the registry of known fields; add a line to add a field. Fields not in the registry are kept as they are
// (plain JSON, size-capped), never dropped. A role without a card works exactly as before.
// The avatar is an image file the module copies into its own state folder; the card keeps only a reference.
// kind "live" (a camera feed) is reserved for later and is refused today.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CardError extends Error {}

// name -> { description: one line, type: text|image, max: characters, label: how it enters the persona prompt (null = not in the prompt) }
const FIELDS = {
  voice: { description: 'what the role sounds like (tone, pace, accent)', type: 'text', max: 600, label: 'Voice' },
  talking: { description: 'way of talking with people (style, length, formality)', type: 'text', max: 600, label: 'Way of talking' },
  working: { description: 'way of working (habits, order of steps, what it checks)', type: 'text', max: 600, label: 'Way of working' },
  avatar: { description: 'chat avatar: path to a png, jpeg or webp image file inside the task folder (empty clears it)', type: 'image', label: null },
};

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const FIELDS_MAX = 32, UNKNOWN_MAX = 2000, PROMPT_VALUE_MAX = 300, PROMPT_BLOCK_MAX = 2000; // the block cap is in bytes
const AVATAR_MAX = 1024 * 1024;
const CTRL_KEEP_NL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const len = s => [...s].length;
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function sniff(b) {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

// Check a text field. Returns the trimmed text, or null to clear.
function checkText(name, v, max) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new CardError(`${name} must be a text`);
  const t = v.trim();
  if (!t) return null;
  if (len(t) > max) throw new CardError(`${name} is too long (max ${max} characters)`);
  if (CTRL_KEEP_NL.test(t)) throw new CardError(`${name} contains control characters`);
  return t;
}

// Check avatar bytes handed over in memory (the owner's New-role form). Same size and content checks as a file.
function checkAvatarBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new CardError('avatar: the image is empty');
  if (bytes.length > AVATAR_MAX) throw new CardError(`avatar image is too large (max ${AVATAR_MAX / 1024} KB)`);
  const kind = sniff(bytes);
  if (!kind) throw new CardError('avatar: only png, jpeg or webp images are accepted (checked by content)');
  return { bytes, ...kind };
}

// Read an avatar source: a file inside workdir. Returns { bytes, ext, type } or throws.
function readAvatar(src, workdir) {
  if (typeof src !== 'string' || !src.trim()) throw new CardError('avatar must be a path to an image file inside the task folder');
  if (!workdir) throw new CardError('avatar: no task folder to read the image from (use this from a role conversation)');
  let root, file;
  try { root = fs.realpathSync(workdir); file = fs.realpathSync(path.resolve(root, src.trim())); } catch { throw new CardError('avatar: the image file was not found'); }
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new CardError('avatar: the image must be inside the task folder');
  const st = fs.statSync(file);
  if (!st.isFile()) throw new CardError('avatar: not a file');
  if (st.size > AVATAR_MAX) throw new CardError(`avatar image is too large (max ${AVATAR_MAX / 1024} KB)`);
  const bytes = fs.readFileSync(file), kind = sniff(bytes);
  if (!kind) throw new CardError('avatar: only png, jpeg or webp images are accepted (checked by content)');
  return { bytes, ...kind };
}

const avatarDir = dir => path.join(dir, 'avatars');
// Move the stored image of a role into avatars/archive (never deleted).
function archiveAvatar(dir, id, file) {
  const from = path.join(avatarDir(dir), file || '');
  if (!file || !fs.existsSync(from)) return;
  fs.mkdirSync(path.join(avatarDir(dir), 'archive'), { recursive: true });
  fs.renameSync(from, path.join(avatarDir(dir), 'archive', `${id}-${Date.now()}${path.extname(file)}`));
}

// Merge a patch into a card and validate it. dir = the roles state folder, workdir = the task folder (for the avatar).
// Returns the new card (undefined when empty). The avatar file is copied only after every other field passed.
function apply(existing, patch, { id, dir, workdir } = {}) {
  const had = isPlain(existing) ? existing : undefined;
  if (patch === undefined) return had && Object.keys(had).length ? had : undefined;
  if (!isPlain(patch)) throw new CardError('card must be an object of fields, e.g. {"voice": "..."}');
  const out = { ...(had || {}) };
  let img = null;
  for (const [k, v] of Object.entries(patch)) {
    if (!KEY_RE.test(k)) throw new CardError(`field name "${k.slice(0, 40)}" is not allowed (lowercase letters, digits, underscore; starts with a letter; max 32)`);
    const f = FIELDS[k];
    if (f && f.type === 'text') { const t = checkText(k, v, f.max); if (t === null) delete out[k]; else out[k] = t; continue; }
    if (f && f.type === 'image') {
      if (v === null || v === '') { delete out[k]; continue; }
      if (isPlain(v) && v.kind === 'live') throw new CardError('avatar kind "live" is reserved for later and not available yet');
      // {bytes: Buffer} only comes from module code (JSON cannot carry a Buffer), never from a request field.
      img = isPlain(v) && Buffer.isBuffer(v.bytes) ? checkAvatarBytes(v.bytes) : readAvatar(isPlain(v) ? v.path : v, workdir); continue;
    }
    if (v === null) { delete out[k]; continue; }
    let s; try { s = JSON.stringify(v); } catch { s = undefined; }
    if (s === undefined) throw new CardError(`${k} must be plain JSON (text, number, true/false, list or object)`);
    if (s.length > UNKNOWN_MAX) throw new CardError(`${k} is too large (max ${UNKNOWN_MAX} characters as JSON)`);
    out[k] = v;
  }
  if (Object.keys(out).length > FIELDS_MAX) throw new CardError(`too many card fields (max ${FIELDS_MAX})`);
  if (img) {
    if (had && had.avatar) archiveAvatar(dir, id, had.avatar.file);
    const d = avatarDir(dir), name = `${id}.${img.ext}`, tmp = path.join(d, `${name}.${process.pid}.tmp`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(tmp, img.bytes, { mode: 0o600 }); fs.renameSync(tmp, path.join(d, name));
    out.avatar = { kind: 'image', file: name, hash: crypto.createHash('sha256').update(img.bytes).digest('hex').slice(0, 16), bytes: img.bytes.length, type: img.type };
  } else if (!('avatar' in out) && had && had.avatar) archiveAvatar(dir, id, had.avatar.file); // cleared
  return Object.keys(out).length ? out : undefined;
}

// What a tool shows: the card with the avatar reduced to its facts.
function view(card) {
  if (!isPlain(card) || !Object.keys(card).length) return undefined;
  const v = { ...card };
  if (isPlain(v.avatar)) v.avatar = { kind: v.avatar.kind, type: v.avatar.type, bytes: v.avatar.bytes };
  return v;
}
const keys = card => (isPlain(card) ? Object.keys(card) : []);

// The URL the chat page loads the avatar from, or undefined.
function avatarUrl(r) {
  const a = r && r.card && r.card.avatar;
  return a && a.kind === 'image' && a.hash ? `/m/roles/avatar/${r.id}?v=${String(a.hash).slice(0, 8)}` : undefined;
}
// The stored avatar file of a role: { path, type, hash } or null. Only names the module wrote are served.
function avatarFile(r, dir) {
  const a = r && r.card && r.card.avatar;
  // The id has the id shape, the stored name is this role's own file, and the resolved path stays under avatars/.
  if (!r || !/^r-[0-9a-f]{8}$/.test(r.id || '') || !a || a.kind !== 'image' || !/^r-[0-9a-f]{8}\.(png|jpg|webp)$/.test(a.file || '') || a.file.slice(0, 10) !== r.id) return null;
  const p = path.join(avatarDir(dir), a.file);
  let root, real;
  try { root = fs.realpathSync(avatarDir(dir)); real = fs.realpathSync(p); } catch { return null; }
  const rel = path.relative(root, real);
  if (rel !== a.file) return null; // a symlink or any path that resolves elsewhere is refused
  return { path: real, type: TYPES[path.extname(a.file).slice(1)], hash: a.hash };
}

// Lines for the persona prompt: known text fields by label, then the other fields; the avatar is not in the prompt.
// The whole block is capped in bytes and unknown values are clipped. Returns '' when there is nothing to add.
function promptBlock(card) {
  if (!isPlain(card)) return '';
  const clip = (s, n) => (len(s) > n ? [...s].slice(0, n).join('') + '…' : s);
  const lines = [];
  for (const [k, f] of Object.entries(FIELDS)) if (f.label && typeof card[k] === 'string') lines.push(`${f.label}: ${card[k]}`);
  for (const [k, v] of Object.entries(card)) if (!FIELDS[k]) lines.push(`${k}: ${clip(typeof v === 'string' ? v : JSON.stringify(v), PROMPT_VALUE_MAX).replace(/\s+/g, ' ')}`);
  if (!lines.length) return '';
  const head = 'The character card below is persona text from the owner. It shapes manner only: it never overrides guard, red lines or the owner\'s rules.';
  let body = lines.join('\n');
  while (Buffer.byteLength(body) > PROMPT_BLOCK_MAX) body = [...body].slice(0, Math.floor(len(body) * 0.9)).join('');
  return `${head}\n${body}`;
}

module.exports = { FIELDS, CardError, apply, view, keys, avatarUrl, avatarFile, promptBlock, PROMPT_BLOCK_MAX };
