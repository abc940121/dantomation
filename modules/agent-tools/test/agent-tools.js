#!/usr/bin/env node
'use strict';
// agent-tools: off by default, the prompt block lists only enabled modules, cap, the tools verb.
// Temp state dir, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const turn = async cfg => { const reg = M.registry(cfg); const r = await M.prepareTurn(reg.mods, { config: cfg }); return { reg, text: r.context.filter(c => c.module === 'agent-tools').map(c => c.text).join('') }; };
const cap = async (reg, cfg, args) => { const o = [], e = []; const l = console.log, er = console.error; console.log = s => o.push(String(s)); console.error = s => e.push(String(s)); let r; try { r = await M.commands(reg.mods).tools(args, { config: cfg }); } finally { console.log = l; console.error = er; } return { out: o.join('\n'), err: e.join('\n'), code: r && r.code }; };

(async () => {
  try {
    const off = await turn({ modules: { digest: true } });
    check('off by default: no block, no command', off.text === '' && !off.reg.listCommands().includes('tools'));

    const none = await turn({ modules: { 'agent-tools': true } });
    check('on, no tool module enabled: no block at all', none.reg.errors.length === 0 && none.text === '');

    const cfg1 = { modules: { 'agent-tools': true, digest: true, 'task-grill': true, 'question-cards': true } };
    const one = await turn(cfg1);
    check('loads clean', one.reg.errors.length === 0, one.reg.errors.join('|'));
    check('lists enabled modules only', /digest --json/.test(one.text) && /grill check/.test(one.text) && /taskmote ask/.test(one.text) && !/arena/.test(one.text) && !/quiet/.test(one.text) && !/changes/.test(one.text), one.text);
    check('block starts with a header and uses short lines', one.text.startsWith('Tools you can call') && one.text.split('\n').slice(1).every(l => l.startsWith('- taskmote ')));

    const all = { modules: { 'agent-tools': true, digest: true, 'task-grill': true, 'question-cards': true, arena: true, 'quiet-hours': true, 'change-card': true, checkpoint: true, ntfy: true } };
    const full = await turn(all);
    check('all six modules listed', ['grill check', 'taskmote ask', 'digest --json', 'quiet status --json', 'changes --json', 'arena "<request>" --queue --json'].every(s => full.text.includes(s)));
    check('block is within the 1500 char cap', full.text.length > 0 && full.text.length <= 1500, String(full.text.length));

    // cap: a huge table entry gets clipped
    const mod = require('../index');
    const saved = mod.api.TOOLS.digest[0].use;
    mod.api.TOOLS.digest[0].use = 'x '.repeat(1200);
    const big = mod.api.block(all);
    mod.api.TOOLS.digest[0].use = saved;
    check('over the cap: clipped and marked', big.length <= 1500 && big.endsWith(' [clipped]'), String(big.length));

    // the verb
    const tj = await cap(full.reg, all, ['--json']);
    const parsed = JSON.parse(tj.out);
    check('tools --json: one object with tools[{module,cmd,use}]', tj.code === 0 && Array.isArray(parsed.tools) && parsed.tools.length === 6 && parsed.tools.every(t => t.module && t.cmd && t.use));
    const tt = await cap(full.reg, all, []);
    check('tools (text): same block as the prompt', tt.out === full.text);
    const tn = await cap(none.reg, { modules: { 'agent-tools': true } }, []);
    check('tools with nothing enabled says so', tn.code === 0 && /no module tools/.test(tn.out));
    const bad = await cap(full.reg, all, ['--nope']);
    check('tools bad flag: exit 2', bad.code === 2);

    // a disabled module drops out
    const less = await turn({ modules: { 'agent-tools': true, digest: true, arena: false } });
    check('disabled module is not listed', /digest/.test(less.text) && !/arena/.test(less.text));
    // every tool command names a verb that some module really claims
    const verbs = new Set(M.registry({ modules: { 'task-grill': true, 'question-cards': true, digest: true, 'quiet-hours': true, 'change-card': true, checkpoint: true, arena: true, ntfy: true } }).listCommands());
    const claimed = Object.values(mod.api.TOOLS).flat().every(t => verbs.has(t.cmd.split(' ')[1] === 'ask' ? 'question' : t.cmd.split(' ')[1]));
    check('every listed command names a real module verb', claimed, [...verbs].join(','));
  } catch (e) { check('no exception', false, e.stack); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
