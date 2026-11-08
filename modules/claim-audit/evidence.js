'use strict';
// Reads what really happened from the two places that hold it:
//   - the journal (effects, steps) for [j:...] citations;
//   - the engine's own stream log, state/engine-<task>.jsonl, for command outputs
//     ([t:"..."] citations) and the agent's final message. Only tool results count
//     as output evidence; the agent's own text is never evidence for itself.
// Nothing is copied into the journal except a count and a hash (see index.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(p => (p && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : '')).join('\n') : '';

function parseStream(raw) {
  const uses = new Map(), outputs = [];
  let result = null, lastText = null;
  for (const line of String(raw).split('\n')) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'result' && typeof j.result === 'string') result = j.result;
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const p of content) {
      if (!p || typeof p !== 'object') continue;
      if (j.type === 'assistant' && p.type === 'tool_use') uses.set(p.id, p);
      else if (j.type === 'assistant' && p.type === 'text' && p.text) lastText = p.text;
      else if (j.type === 'user' && p.type === 'tool_result') {
        const text = textOf(p.content);
        const use = uses.get(p.tool_use_id) || {};
        const ti = use.input || {};
        const m = /\bExit code (\d+)/.exec(text);
        outputs.push({ text, tool: use.name || '', command: String(ti.command || ti.file_path || ''),
          exit: m ? Number(m[1]) : (p.is_error ? 1 : null) });
      }
    }
  }
  return { report: result != null ? result : lastText, outputs };
}

// -> { report, evidence: { records, outputs, files }, hash }
function collect(J, taskId) {
  const records = J.readAll().records.filter(r => r.task_id === taskId);
  let raw = '';
  try { raw = fs.readFileSync(path.join(J.STATE, `engine-${taskId}.jsonl`), 'utf8'); } catch { /* no log */ }
  const { report, outputs } = parseStream(raw);
  const files = [];
  for (const r of records) if (r.target) files.push(r.target);
  const hash = crypto.createHash('sha256').update(JSON.stringify(outputs.map(o => o.text))).digest('hex').slice(0, 16);
  return { report, evidence: { records, outputs, files }, hash };
}

module.exports = { collect, parseStream };
