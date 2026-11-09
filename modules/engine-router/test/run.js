#!/usr/bin/env node
'use strict';
// engine-router: pure policy plus the module wired into the registry (temp state dir).
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-router-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const P = require('../lib/policy');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const E = { planner: ['big'], editor: ['cheap1', 'cheap2'] };

(async () => {
  try {
    // classify
    check('classify: plan words -> planner', P.classifyStep('design the new cache layer') === 'planner');
    check('classify: rename -> editor', P.classifyStep('rename foo to bar in all files') === 'editor');
    check('classify: mixed -> planner', P.classifyStep('plan and then rename the module') === 'planner');
    check('classify: empty/unknown -> planner', P.classifyStep('') === 'planner' && P.classifyStep('hmm') === 'planner' && P.classifyStep(null) === 'planner');

    // pick
    check('pick: first of role', P.pickEngine('editor', E).engine === 'cheap1');
    check('pick: skips failed', P.pickEngine('editor', E, ['cheap1']).engine === 'cheap2');
    const esc = P.pickEngine('editor', E, ['cheap1', 'cheap2']);
    check('pick: editors spent -> planner', esc.engine === 'big' && esc.role === 'planner' && !esc.exhausted);
    check('pick: all failed -> exhausted', P.pickEngine('editor', E, ['cheap1', 'cheap2', 'big']).exhausted === true);
    check('pick: none configured', P.pickEngine('planner', {}).engine === null && P.pickEngine('planner', {}).exhausted);
    check('pick: bad role -> planner', P.pickEngine('x', E).role === 'planner');

    // counter
    let s = P.newState('s1', 'cheap1');
    s = P.recordOutcome(s, false, 2);
    check('counter: 1 failure no switch', s.fails === 1 && !s.switch);
    s = P.recordOutcome(s, true, 2);
    check('counter: success resets', s.fails === 0);
    s = P.recordOutcome(P.recordOutcome(s, false, 2), false, 2);
    check('counter: 2 in a row switch', s.switch && s.failed_engines.join() === 'cheap1');
    check('counter: same step keeps failed engines', P.startStep(s, 's1', 'cheap2').failed_engines.length === 1);
    check('counter: new step resets', P.startStep(s, 's2', 'cheap2').failed_engines.length === 0);
    check('counter: input not mutated', JSON.stringify(P.recordOutcome(s, true)) !== JSON.stringify(s) && s.fails === 2);

    // half-done
    const base = [{ type: 'task_start', task_id: 'a' }, { type: 'engine_start', task_id: 'a' }];
    const tool = (t, ok, id) => ({ type: 'tool_done', task_id: 'a', tool: t, ok, id });
    check('half: none', !P.halfDone(base, 'a').halfDone);
    check('half: reads only', !P.halfDone([...base, tool('Read', true, 1)], 'a').halfDone);
    check('half: failed edit ignored', !P.halfDone([...base, tool('Edit', false, 1)], 'a').halfDone);
    const hd = P.halfDone([...base, tool('Edit', true, 1), tool('Read', true, 2), tool('Write', true, 3)], 'a');
    check('half: successful edits found', hd.halfDone && hd.mutations.length === 2);
    check('half: other task ignored', !P.halfDone([...base, { ...tool('Edit', true, 1), task_id: 'b' }], 'a').halfDone);
    check('half: reply after edits = finished', !P.halfDone([...base, tool('Edit', true, 1), { type: 'reply', task_id: 'a' }], 'a').halfDone);
    check('half: edits before engine_start ignored', !P.halfDone([tool('Edit', true, 1), ...base], 'a').halfDone);
    check('half: edits before a router switch ignored', !P.halfDone([...base, tool('Edit', true, 1), { type: 'router_switch', module: 'engine-router', task_id: 'a' }], 'a').halfDone);
    check('half: custom mutating list', P.halfDone([...base, tool('Custom', true, 1)], 'a', ['Custom']).halfDone);

    // decide
    const failedState = { ...P.newState('s', 'cheap1'), fails: 2, switch: true, failed_engines: ['cheap1'] };
    check('decide: healthy stays', P.decide({ state: P.newState('s', 'cheap1'), records: [], taskId: 'a', engines: E, role: 'editor' }).action === 'stay');
    let d = P.decide({ state: failedState, records: base, taskId: 'a', engines: E, role: 'editor' });
    check('decide: switch, clean tree', d.action === 'switch' && d.engine === 'cheap2' && !d.halfDone);
    d = P.decide({ state: failedState, records: [...base, tool('Edit', true, 1)], taskId: 'a', engines: E, role: 'editor' });
    check('decide: switch with handoff on half-done', d.action === 'switch_with_handoff' && d.engine === 'cheap2' && /Inspect the working tree/.test(P.handoffNote(d)));
    d = P.decide({ state: { ...failedState, failed_engines: ['cheap1', 'cheap2', 'big'] }, records: base, taskId: 'a', engines: E, role: 'editor' });
    check('decide: exhausted', d.action === 'exhausted' && d.engine === null);
    check('note: empty on stay', P.handoffNote({ action: 'stay' }) === '');

    // module wiring
    const off = M.registry({ modules: { 'engine-router': false } });
    check('off: nothing registered', !off.listRoutes().length && off.settingsFor('engine-router') === null);
    const ENG = { big: { bin: 'big-bin', turn: true }, cheap1: { bin: 'c1', turn: true }, cheap2: { bin: 'c2', turn: true } };
    const reg = M.registry({ engines: ENG, modules: { 'engine-router': true }, engine_router: { planner_engines: ['big'], editor_engines: ['cheap1', 'cheap2'] } });
    check('on: loads clean', reg.errors.length === 0, reg.errors.join(' | '));
    check('defaults: fail_limit 2', reg.settingsFor('engine-router').fail_limit === 2);
    check('provides engines entry', reg.providers('engines').some(p => p.module === 'engine-router'));
    const ev = (e, p) => M.emit(reg.mods, e, p);
    const decide = async (q) => (await reg.callRoute(reg.findRoute('GET', '/m/engine-router/decide'), { query: q, actor: { kind: 'owner', id: 't' } }));

    J.append({ type: 'task_start', task_id: 't1', request: 'rename a to b', workdir: '.' });
    await ev('task.start', { task_id: 't1', request: 'rename a to b', workdir: '.', resumed: false });
    J.append({ type: 'engine_start', task_id: 't1' });
    let r = await decide({ task_id: 't1', step: 'rename a to b' });
    check('route: editor chosen first', r.status === 200 && r.json.engine === 'cheap1' && r.json.role === 'editor', JSON.stringify(r.json));
    J.append({ type: 'tool_done', task_id: 't1', tool: 'Edit', ok: true });
    await ev('tool.done', { task_id: 't1', tool: 'Edit', ok: true });
    await ev('tool.done', { task_id: 't1', tool: 'Bash', ok: false });
    r = await decide({ task_id: 't1', step: 'rename a to b' });
    check('1 failure: stays', r.json.action === 'stay' && r.json.engine === 'cheap1');
    await ev('tool.done', { task_id: 't1', tool: 'Bash', ok: false });
    r = await decide({ task_id: 't1', step: 'rename a to b' });
    check('2 failures: switch with handoff (earlier edit)', r.json.action === 'switch_with_handoff' && r.json.engine === 'cheap2' && /Inspect the working tree/.test(r.json.note), JSON.stringify(r.json));
    check('switch journaled once', J.readAll().records.filter(x => x.type === 'router_switch' && x.module === 'engine-router').length === 1);
    r = await decide({ task_id: 't1', step: 'rename a to b' });
    check('after switch: stays on new engine, no second journal', r.json.action === 'stay' && r.json.engine === 'cheap2' && J.readAll().records.filter(x => x.type === 'router_switch').length === 1, JSON.stringify(r.json));

    // failures on a fresh task with no edits: plain switch; success between failures does not switch
    J.append({ type: 'task_start', task_id: 't2', request: 'x' });
    await ev('task.start', { task_id: 't2', request: 'rename x', workdir: '.', resumed: false });
    await decide({ task_id: 't2', step: 'rename x' });
    await ev('tool.done', { task_id: 't2', tool: 'Bash', ok: false });
    await ev('tool.done', { task_id: 't2', tool: 'Read', ok: true });
    await ev('tool.done', { task_id: 't2', tool: 'Bash', ok: false });
    check('non-consecutive failures: no switch', (await decide({ task_id: 't2', step: 'rename x' })).json.action === 'stay');
    await ev('tool.done', { task_id: 't2', tool: 'Bash', ok: false });
    r = await decide({ task_id: 't2', step: 'rename x' });
    check('consecutive failures, clean tree: plain switch', r.json.action === 'switch' && r.json.engine === 'cheap2' && !r.json.halfDone, JSON.stringify(r.json));

    // prepareTurn
    const pt = await reg.mods.find(m => m.name === 'engine-router').prepareTurn({ ...reg.mods[0], task_id: 't3', request: 'design the schema', settings: reg.settingsFor('engine-router'), config: { engines: ENG }, state: { dir: path.join(tmp, 'pt'), append: () => ({}) } });
    check('prepareTurn: planner recommended', pt && /recommended engine: big \(planner\)/.test(pt.context[0]), JSON.stringify(pt));

    // chooseEngine (contract 6)
    const eng = reg.mods.find(m => m.name === 'engine-router');
    const cctx = { settings: reg.settingsFor('engine-router'), config: { engines: ENG } };
    check('chooseEngine: planner step', eng.chooseEngine({ request: 'design the schema' }, cctx) === 'big');
    check('chooseEngine: editor step', eng.chooseEngine({ request: 'rename a to b' }, cctx) === 'cheap1');
    check('chooseEngine: listed engine core cannot run per turn is skipped', eng.chooseEngine({ request: 'rename a to b' }, { ...cctx, config: { engines: { ...ENG, cheap1: { bin: 'c1' } } } }) === 'cheap2');
    check('chooseEngine: no config engines table -> null', eng.chooseEngine({ request: 'rename a to b' }, { settings: cctx.settings }) === null);
    check('chooseEngine: unconfigured -> null', eng.chooseEngine({ request: 'rename a' }, { settings: { planner_engines: [], editor_engines: [] } }) === null);
    check('chooseEngine: no turn -> safe', eng.chooseEngine(undefined, cctx) === 'big');
    const sw = { settings: reg.settingsFor('engine-router'), config: { engines: ENG }, state: { dir: path.join(tmp, 'sw') } };
    fs.mkdirSync(sw.state.dir, { recursive: true });
    fs.writeFileSync(path.join(sw.state.dir, 'task-s1.json'), JSON.stringify({ engine: 'cheap2' }));
    check('chooseEngine: follows the switch prepareTurn recorded', eng.chooseEngine({ task_id: 's1', request: 'rename a to b' }, sw) === 'cheap2');
    fs.writeFileSync(path.join(sw.state.dir, 'task-s2.json'), JSON.stringify({ engine: 'gone' }));
    fs.writeFileSync(path.join(sw.state.dir, 'task-s3.json'), JSON.stringify({ engine: 'cheap2', exhausted: true }));
    check('chooseEngine: exhausted step -> null (no failed engine relaunched)', eng.chooseEngine({ task_id: 's3', request: 'rename a to b' }, sw) === null);
    {
      const P = require('../lib/policy');
      const sa = { ...sw, state: { ...sw.state, append: () => ({}) } };
      fs.writeFileSync(path.join(sw.state.dir, 'task-s4.json'), JSON.stringify({ ...P.newState('rename a to b', 'cheap2'), failed_engines: ['cheap1', 'cheap2', 'big'] }));
      const pt = eng.prepareTurn({ ...sa, task_id: 's4', request: 'rename a to b' });
      check('prepareTurn: exhausted step still tells the default engine to stop', !!pt && pt.context.some(l => /stop and ask the owner/.test(l)) && eng.chooseEngine({ task_id: 's4', request: 'rename a to b' }, sw) === null, JSON.stringify(pt));
      const none = { settings: { ...sw.settings, planner_engines: [], editor_engines: [] }, state: sa.state, task_id: 's5', request: 'rename a' };
      check('prepareTurn: no engines configured -> no note', eng.prepareTurn(none) === null);
    }
    {
      const sa = { ...sw, state: { ...sw.state, append: () => ({}) } };
      fs.writeFileSync(path.join(sw.state.dir, 'task-s6.json'), JSON.stringify({ ...P.newState('rename a to b', 'cheap1'), fails: 1 }));
      const lost = { ...sa, config: { engines: { ...ENG, cheap1: { bin: 'c1' } } }, task_id: 's6', request: 'rename a to b' };
      const pt = eng.prepareTurn(lost);
      const saved = JSON.parse(fs.readFileSync(path.join(sw.state.dir, 'task-s6.json'), 'utf8'));
      check('prepareTurn: saved engine no longer runnable is dropped and not recommended', pt && /cheap2/.test(pt.context[0]) && saved.engine !== 'cheap1' && saved.fails === 0 && eng.chooseEngine({ task_id: 's6', request: 'rename a to b' }, lost) === 'cheap2', JSON.stringify({ pt, saved }));
    }
    check('chooseEngine: ignores a recorded engine no longer configured', eng.chooseEngine({ task_id: 's2', request: 'rename a to b' }, sw) === 'cheap1');
    check('manifest: hookTimeoutMs 1000', eng.hookTimeoutMs === 1000);
    check('M.chooseEngine picks via registry', await M.chooseEngine(reg.mods, { task_id: 'c1', request: 'rename a to b' }) !== undefined);

    r = await decide({});
    check('route: task_id required', r.status === 400);
    const bad = M.registry({ modules: { 'engine-router': true }, engine_router: { fail_limit: 'x' } });
    check('bad setting rejected', bad.errors.length > 0);
  } catch (e) { check('no exception', false, e.stack || e.message); }
  const failed = results.filter(x => !x).length;
  console.log(`\nengine-router: ${results.length - failed}/${results.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
