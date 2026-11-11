#!/usr/bin/env node
'use strict';
// The demo's scripted agent: a stand-in for the model, run by the real harness as its engine
// (HARNESS_ENGINE_SCRIPT, same argv as claude). It makes no LLM call; it does what the real
// engine does with each tool call: run the PreToolUse hook command from the --settings file
// harness.js wrote (guards/guard.js, the full module chain), and on an "ask" call the
// permission-prompt tool from the --mcp-config file (bin/approve-mcp.js) over MCP stdio.
// Each outcome is one JSON line in TASKMOTE_DEMO_EVENTS, which the demo narrates.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const prompt = arg('-p') || '';
const task = (prompt.match(/task_id: (\S+?)\)/) || [])[1];
const EFFECT = path.join(__dirname, '..', '..', 'bin', 'effect.js');
const eff = a => spawnSync(process.execPath, [EFFECT, ...a], { encoding: 'utf8', windowsHide: true });
const event = o => fs.appendFileSync(process.env.TASKMOTE_DEMO_EVENTS, JSON.stringify(o) + '\n');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const hooks = (readJson(arg('--settings')).hooks) || {};
const mcp = ((readJson(arg('--mcp-config')).mcpServers) || {}).taskmote;

let n = 0;
// One hook run -> { id, code, reason, decision }.
function hook(kind, tool, input, id) {
  const h = hooks[kind] && hooks[kind][0] && hooks[kind][0].hooks[0];
  if (!h) return { id, code: 0, decision: null, reason: '' };
  const r = spawnSync(h.command, { shell: true, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ session_id: 'demo', tool_name: tool, tool_input: input, cwd: process.cwd(), tool_use_id: id, tool_response: {} }) });
  let out = {};
  try { out = JSON.parse(r.stdout || '{}').hookSpecificOutput || {}; } catch { /* plain output */ }
  return { id, code: r.status, decision: out.permissionDecision || null, reason: (out.permissionDecisionReason || r.stderr || '').trim() };
}
const pre = (tool, input) => hook('PreToolUse', tool, input, `toolu_demo${++n}`);

// The permission prompt, as the engine sends it: initialize, then tools/call approve. -> {behavior, message?}
function askPromptTool(tool, input, id) {
  return new Promise(resolve => {
    if (!mcp) return resolve({ behavior: 'deny', message: 'no permission-prompt tool configured' });
    const p = spawn(mcp.command, mcp.args || [], { env: { ...process.env, ...(mcp.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== 2) continue;
        let r = { behavior: 'deny', message: 'no answer' };
        try { r = JSON.parse(m.result.content[0].text); } catch { /* keep deny */ }
        p.stdin.end(); resolve(r);
      }
    });
    p.on('exit', () => resolve({ behavior: 'deny', message: 'the prompt tool stopped' }));
    const send = o => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-agent', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: tool, input, tool_use_id: id } } });
  });
}

(async () => {
  const notes = path.join(process.cwd(), 'notes.md');
  // A resumed run gets the journal's history in its prompt, as the real engine does: skip what is done.
  const done = new Set([...prompt.matchAll(/- step (\d+) done/g)].map(m => Number(m[1])));
  if (/resumed run/.test(prompt)) event({ step: 'resume', skipped: [...done] });

  // (a) a harmless edit inside the task folder
  if (!done.has(1)) {
    eff(['step', task, '1', 'started', 'fix a typo in notes.md']);
    const edit = { file_path: notes, old_string: 'Teh launch', new_string: 'The launch is on Friday' };
    const a = pre('Edit', edit);
    if (a.code === 0 && a.decision !== 'ask' && a.decision !== 'deny') {
      fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace(edit.old_string, edit.new_string));
      hook('PostToolUse', 'Edit', edit, a.id);
    }
    event({ step: 'a', ok: a.code === 0, reason: a.reason });
    eff(['step', task, '1', 'done']);
  }

  // (b) a red line: rewrite the remote's history
  if (!done.has(2)) {
    eff(['step', task, '2', 'started', 'publish']);
    const b = pre('Bash', { command: 'git push --force origin main' });
    event({ step: 'b', blocked: b.code === 2, reason: b.reason });
    eff(['step', task, '2', 'done', 'force push blocked']);
  }

  // A journaled side effect (bin/effect.js: intent, act, done). The demo kills this process
  // between the act and its done line; the resumed run re-runs the same command, which
  // reconciles (the file is already there) instead of writing twice.
  const w = spawnSync(process.execPath, [EFFECT, 'write', task, 'demo-summary', 'summary.md'], { encoding: 'utf8', windowsHide: true, input: 'Launch: Friday.\n' });
  event({ step: 'effect', out: (w.stdout || '').trim() });

  // (c) risky but allowed with the owner's yes: a call to a paid API
  const fetchIn = { url: 'https://api.openai.com/v1/chat/completions', prompt: 'summarise notes.md' };
  const c = pre('WebFetch', fetchIn);
  event({ step: 'c', ask: c.decision === 'ask', reason: c.reason });
  if (c.decision === 'ask') {
    const r = await askPromptTool('WebFetch', fetchIn, c.id);
    // A yes would let the call run; the demo agent stops there and makes no network call.
    event({ step: 'c', outcome: r.behavior, message: r.message || '' });
  }

  eff(['task-done', task]);
})();
