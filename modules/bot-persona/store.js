'use strict';
// bot-persona storage: one persona file and one memory file per bot under the
// module's state dir. Plain text, UTF-8, written atomically (tmp + rename).
const fs = require('fs');
const path = require('path');

const PARTS = ['persona', 'memory'];
const BOT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// NUL and other control characters except tab, newline and carriage return.
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class InputError extends Error {}

function checkBot(bot) {
  if (typeof bot !== 'string' || !BOT_RE.test(bot)) throw new InputError('bot id must match [a-z0-9][a-z0-9_-]{0,63}');
  return bot;
}
function checkPart(part) {
  if (!PARTS.includes(part)) throw new InputError('part must be "persona" or "memory"');
  return part;
}
function checkText(text, maxBytes, label) {
  if (typeof text !== 'string') throw new InputError(`${label} must be a string`);
  if (BAD_CHARS.test(text)) throw new InputError(`${label} has control characters`);
  if (text.includes('�')) throw new InputError(`${label} is not valid text`);
  const n = Buffer.byteLength(text, 'utf8');
  if (n > maxBytes) throw new InputError(`${label} is ${n} bytes, the limit is ${maxBytes}`);
  return text;
}

function createStore(dir) {
  const file = (bot, part) => path.join(dir, `${checkBot(bot)}.${checkPart(part)}.txt`);
  return {
    get(bot, part) {
      try { return fs.readFileSync(file(bot, part), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
    },
    set(bot, part, text) {
      const f = file(bot, part);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, f);
    },
    clear(bot, part) {
      try { fs.unlinkSync(file(bot, part)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    },
    // bots that have at least one stored part
    list() {
      let names; try { names = fs.readdirSync(dir); } catch { return []; }
      const out = new Set();
      for (const n of names) { const m = /^(.+)\.(persona|memory)\.txt$/.exec(n); if (m && BOT_RE.test(m[1])) out.add(m[1]); }
      return [...out].sort();
    },
  };
}

module.exports = { createStore, checkBot, checkPart, checkText, InputError, PARTS, BOT_RE };
