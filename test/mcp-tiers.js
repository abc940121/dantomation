#!/usr/bin/env node
'use strict';
// Tool tiers + expand on demand for bin/taskmote-mcp.js (lib/mcp-tiers.js).
// 工具分層與按需展開：tier 1 常駐、tier 2 收合成目錄、tier 3 隱藏且每次展開都記錄。
//   a. unit: defaults (tier 2, category = module), bad tier -> 2, tier 1 listed, expand_tools always listed
//   b. unit: flat prompt size: 50 extra tier-2 tools, or 50 extra categories, barely move the tools/list bytes
//   c. unit: expand by category / name / query; tier 3 is not in menu or category expand, found by name; expanded set shows in the next list
//   c2. unit: the tier 1 cap does not depend on load order; the menu shows the category id and expand takes the id or the title
//   d. end to end over the real server (roles on): tier 1 only, expand_tools -> list_changed -> listed, old tools still callable by name,
//      50 extra roles do not grow role_list
// Runs in any mode: temp dirs, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const T = require('../lib/mcp-tiers');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''}`); };
const bytes = x => Buffer.byteLength(JSON.stringify(x));
const schema = { type: 'object', properties: { a: { type: 'string', description: 'some argument' } } };
const tool = (name, extra = {}) => ({ name, description: `Does ${name}.`, inputSchema: schema, run() {}, ...extra });
const CORE = [tool('ask_owner', { tier: 1, category: 'core', module: 'core' }), tool('queue_task', { tier: 1, category: 'core', module: 'core' }), tool('task_status', { tier: 1, category: 'core', module: 'core' }), tool('search_journal', { tier: 1, category: 'core', module: 'core' }),
  tool('digest', { category: 'journal' }), tool('undo_task', { category: 'tasks' })];
const CATS = { journal: { title: 'Journal', when: 'summaries of what happened while away' }, tasks: { title: 'Tasks', when: 'undo or change a finished task' } };
const names = list => list.map(t => t.name);
const sizeOf = (tools, cats, expanded) => bytes(T.listTools(tools, { categories: cats, expanded }));

(async () => {
  // a. defaults
  const n = T.normalize({ name: 'x', run() {} }, 'mymod');
  check('normalize: no tier -> 2, no category -> module name', n.tier === 2 && n.category === 'mymod', n);
  check('normalize: a bad tier (7, "1") falls back to 2', T.normalize({ name: 'x', tier: 7 }, 'm').tier === 2 && T.normalize({ name: 'x', tier: '1' }, 'm').tier === 2);
  const L0 = T.listTools(CORE, { categories: CATS, expanded: new Set() });
  check('list: tier 1 tools plus expand_tools only', JSON.stringify(names(L0).sort()) === JSON.stringify(['ask_owner', 'expand_tools', 'queue_task', 'search_journal', 'task_status']), names(L0));
  check('list: every listed tool has name, description, inputSchema and no internals', L0.every(t => t.name && t.description && t.inputSchema && t.run === undefined && t.tier === undefined && t.category === undefined), L0[0]);
  check('list: there is no call_tool: expand_tools does not mention it and says to call tools by their own name', !names(L0).includes('call_tool') && !/call_tool/.test(L0.find(t => t.name === 'expand_tools').description) && /own name/.test(L0.find(t => t.name === 'expand_tools').description), L0.find(t => t.name === 'expand_tools').description);
  const meta = L0.find(t => t.name === 'expand_tools');
  check('expand_tools: its description names the folded categories with a hint line', /Journal/.test(meta.description) && /summaries of what happened/.test(meta.description) && /Tasks/.test(meta.description), meta.description);

  // b. flat size
  const base = sizeOf(CORE, CATS, new Set());
  const more = k => Array.from({ length: k }, (_, i) => tool(`extra_${i}`, { category: 'journal' }));
  check('size: 50 more tier-2 tools in an existing category add 0 bytes to tools/list', sizeOf([...CORE, ...more(50)], CATS, new Set()) === base, [sizeOf([...CORE, ...more(50)], CATS, new Set()), base]);
  const manyCats = Array.from({ length: 50 }, (_, i) => tool(`c${i}_tool`, { category: `cat${i}` }));
  const catInfo = { ...CATS }; for (let i = 0; i < 50; i++) catInfo[`cat${i}`] = { title: `Category ${i}`, when: 'when you need the cat' + i + ' things, a rather long one line hint that must be clipped to keep the prompt small, beyond any sensible size' };
  const s50 = sizeOf([...CORE, ...manyCats], catInfo, new Set());
  const s10 = sizeOf([...CORE, ...manyCats.slice(0, 10)], catInfo, new Set());
  check('size: 50 extra categories cost <= 1500 bytes (menu is capped, not 50 lines)', s50 - base <= 1500, s50 - base);
  check('size: 50 categories vs 10 categories is the same size (cap reached)', Math.abs(s50 - s10) < 40, [s50, s10]);
  const menu50 = T.listTools([...CORE, ...manyCats], { categories: catInfo, expanded: new Set() }).find(t => t.name === 'expand_tools').description;
  check('size: the capped menu says how many more there are and how to list them', /and \d+ more/.test(menu50) && /expand_tools/.test(menu50), menu50.slice(-200));
  check('size: tier 1 count stays <= 8 with the meta tools', L0.length <= 8);
  // a module declaring too many tier 1 tools is demoted to tier 2 with a warning
  const greedy = Array.from({ length: 12 }, (_, i) => tool(`greedy_${i}`, { tier: 1, category: 'greedy', module: 'greedy' }));
  const warnings = [];
  const Lg = T.listTools([...CORE, ...greedy], { categories: CATS, expanded: new Set(), warn: m => warnings.push(m) });
  check('cap: 4 core + 12 greedy tier 1 tools list at most 8 tools including the meta tools', Lg.length <= 8, names(Lg));
  check('cap: the demoted tools warn once each (logged), and fold into their category', warnings.length >= 1 && /demoted to tier 2/.test(warnings[0]) && T.expand([...CORE, ...greedy], { category: 'greedy' }, CATS).tools.some(t => t.name === 'greedy_11'), warnings);
  check('cap: an earlier (core) tier 1 tool keeps its place over a later module tool', names(Lg).includes('ask_owner') && names(Lg).includes('greedy_0') && !names(Lg).includes('greedy_11'), names(Lg));

  // c. expand
  const ALL = [...CORE, tool('wipe_all', { tier: 3, category: 'danger', description: 'Deletes everything. Dangerous.' }), tool('role_make', { category: 'roles' }), tool('role_kill', { category: 'roles' })];
  const cats2 = { ...CATS, roles: { title: 'Roles', when: 'make or change roles' }, danger: { title: 'Danger', when: 'never in the menu' } };
  const menuAll = T.listTools(ALL, { categories: cats2, expanded: new Set() }).find(t => t.name === 'expand_tools').description;
  check('tier 3 is not in the menu', !/Danger|wipe_all|never in the menu/.test(menuAll), menuAll);
  const e1 = T.expand(ALL, { category: 'roles' }, cats2);
  check('expand by category: the tier-2 schemas of that category', JSON.stringify(names(e1.tools)) === JSON.stringify(['role_make', 'role_kill']) && e1.tools.every(t => t.inputSchema) && e1.reveal.length === 2, e1);
  const e2 = T.expand(ALL, { category: 'danger' }, cats2);
  check('expand by category does not hand out tier 3', e2.tools.length === 0 && e2.reveal.length === 0, e2);
  const e3 = T.expand(ALL, { name: 'wipe_all' }, cats2);
  check('expand by name reaches tier 3 and reports tier 3 (so the caller can log it)', names(e3.tools).join() === 'wipe_all' && e3.reveal[0].tier === 3, e3);
  const e4 = T.expand(ALL, { query: 'delet' }, cats2);
  check('expand by query: tier 3 matches are names only, no schema', e4.matches.some(m => m.name === 'wipe_all' && m.tier === 3) && e4.tools.length === 0, e4);
  const e5 = T.expand(ALL, {}, cats2);
  check('expand with no arguments lists the categories with counts and no tier 3', e5.categories.some(c => c.category === 'roles' && c.tools === 2) && !e5.categories.some(c => c.category === 'danger'), e5);
  const e6 = T.expand(ALL, { name: 'nope' }, cats2);
  check('expand: an unknown name is an error text, not a crash', typeof e6.error === 'string' && /nope/.test(e6.error), e6);
  const e7 = T.expand(ALL, { category: 'roles', name: 'wipe_all' }, cats2);
  check('expand: more than one selector is refused', typeof e7.error === 'string', e7);
  const L1 = T.listTools(ALL, { categories: cats2, expanded: new Set(['role_make', 'wipe_all']) });
  check('list after expand: expanded tools (also tier 3) are listed', names(L1).includes('role_make') && names(L1).includes('wipe_all') && !names(L1).includes('role_kill'), names(L1));
  check('find: reaches an unlisted tool by name (tools/call works for any registered tool)', T.find(ALL, 'role_kill') && T.find(ALL, 'role_kill').name === 'role_kill' && !T.find(ALL, 'zzz'));

  // c2. cap order and category id/title
  const mk = (mod, i) => tool(mod + '_t' + i, { tier: 1, category: mod, module: mod });
  const mixed = [...[0, 1, 2].map(i => mk('zeta', i)), ...[0, 1].map(i => tool('core_t' + i, { tier: 1, category: 'core', module: 'core' })), ...[0, 1, 2].map(i => mk('alpha', i)), tool('misc_t', { module: 'alpha' })];
  const tiersOf = list => Object.fromEntries(T.prepare(list, null).map(p => [p.tool.name, p.tier]));
  const t1 = tiersOf(mixed), t2 = tiersOf([...mixed].reverse()), t3 = tiersOf([...mixed].sort((a, b) => (a.name < b.name ? -1 : 1)));
  const keepers = o => Object.keys(o).filter(k => o[k] === 1).sort().join();
  check('cap order: the same tools in two or three orders keep the same tier 1 set and demote the same tools', JSON.stringify(t1) === JSON.stringify(Object.fromEntries(Object.keys(t1).map(k => [k, t2[k]]))) && keepers(t1) === keepers(t2) && keepers(t2) === keepers(t3), [keepers(t1), keepers(t2), keepers(t3)]);
  check('cap order: core first, then module name, then tool name (core_t0, core_t1, alpha_t0..2, zeta_t0, zeta_t1: seven slots beside expand_tools)', keepers(t1) === 'alpha_t0,alpha_t1,alpha_t2,core_t0,core_t1,zeta_t0,zeta_t1' && t1.zeta_t2 === 2, keepers(t1));
  const catsT = { roles: { title: 'Roles and groups', when: 'make or change roles' } };
  const menuT = T.listTools([...CORE, tool('role_make', { category: 'roles' })], { categories: catsT, expanded: new Set() }).find(t => t.name === 'expand_tools').description;
  check('menu line shows the category id and its title: roles (Roles and groups)', /- roles [(]Roles and groups[)]: make or change roles/.test(menuT), menuT);
  const byId = T.expand([...CORE, tool('role_make', { category: 'roles' })], { category: 'roles' }, catsT);
  const byTitle = T.expand([...CORE, tool('role_make', { category: 'roles' })], { category: 'roles AND groups' }, catsT);
  check('expand accepts the category id, or the title in any case', names(byId.tools).join() === 'role_make' && names(byTitle.tools).join() === 'role_make', [byId, byTitle]);

  // d. end to end
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tiers-'));
  const d = path.join(tmp, 'e'); fs.mkdirSync(d, { recursive: true });
  const cfg = path.join(d, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules: { roles: true, 'question-cards': true, digest: true, search: true, checkpoint: true, 'guard-base': true } }));
  const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(d, 'state'), HARNESS_LOG_DIR: path.join(d, 'logs'), HARNESS_WORK_DIR: path.join(d, 'work'), HARNESS_NO_SERVER: '1' };
  delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR; delete env.HARNESS_OWNER;
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskmote-mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); const notes = []; let buf = '', nextId = 1;
  child.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); if (m.id === undefined) { notes.push(m); continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
  const call = (method, params) => new Promise((res, rej) => { const id = nextId++; const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000); waiting.set(id, m => { clearTimeout(t); res(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const run = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); const text = r.result && r.result.content && r.result.content[0].text; let json = null; try { json = JSON.parse(text); } catch { /* text */ } return { err: !!(r.result && r.result.isError), text, json, raw: r }; };
  const journal = () => { try { return fs.readFileSync(path.join(env.HARNESS_STATE_DIR, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  check('initialize: advertises tools.listChanged', init.result.capabilities.tools.listChanged === true, init.result.capabilities);
  const l0 = (await call('tools/list', {})).result.tools;
  const nm0 = names(l0);
  check('server list: exactly the 7 tier 1 tools (role_create / group_list / digest / undo_task are folded)', JSON.stringify([...nm0].sort()) === JSON.stringify(['ask_owner', 'expand_tools', 'queue_task', 'role_ask', 'role_list', 'search_journal', 'task_status']), nm0);
  // no relist: a client that never relists can still call a folded tool by its own name (the client's permission rules apply to it)
  const nr = await run('role_create', { name: 'NoRelist', persona: 'p' });
  check('a folded tool can be called directly by name before it was expanded or listed', !nr.err && /^r-[0-9a-f]{8}$/.test(nr.json.id), nr.text);
  const nu = await run('call_tool', { name: 'role_list', args: {} });
  check('call_tool is gone: the server never runs an inner tool, it answers unknown tool', nu.raw.error && nu.raw.error.code === -32602 && /unknown tool/.test(nu.raw.error.message), nu.raw);
  const ngl = await run('group_list', {});
  check('a folded tool called directly answers its own errors (group_list needs rooms)', ngl.err && /rooms/.test(ngl.text), ngl.text);
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const dr = await call('tools/call', { name: bad, arguments: {} });
    check('tools/call "' + bad + '" is an unknown tool (JSON-RPC -32602), not an inherited function', dr.error && dr.error.code === -32602 && /unknown tool/.test(dr.error.message), dr);
  }
  const size0 = bytes(l0);
  const ex = await run('expand_tools', { category: 'roles' });
  check('expand_tools category roles: returns the schemas of the folded role tools', !ex.err && ex.json.tools.some(t => t.name === 'role_create' && t.inputSchema) && ex.json.tools.some(t => t.name === 'group_create'), ex.text);
  await new Promise(r => setTimeout(r, 100));
  check('expand_tools sends notifications/tools/list_changed', notes.some(m => m.method === 'notifications/tools/list_changed'), notes);
  const l1 = names((await call('tools/list', {})).result.tools);
  check('after expand the next tools/list includes the expanded tools', l1.includes('role_create') && l1.includes('group_create'), l1);
  const rc = await run('role_create', { name: 'Captain', persona: 'You are a calm ship captain.' });
  check('an expanded tool runs', !rc.err && /^r-[0-9a-f]{8}$/.test(rc.json.id), rc.text);
  const un = await run('undo_task', { task_id: 'tnope' });
  check('a still-folded tool runs by name too', un.err && /no task/.test(un.text), un.text);
  const ex3 = await run('expand_tools', { name: 'digest' });
  check('expand by name: digest', !ex3.err && ex3.json.tools[0].name === 'digest', ex3.text);
  check('tier 2 expands are not journaled as tool_expand (only tier 3 are)', !journal().some(r => r.type === 'tool_expand'));
  const bad = await run('expand_tools', { name: 'nope' });
  check('expand_tools unknown name: a tool error', bad.err && /nope/.test(bad.text), bad.text);
  for (let i = 0; i < 12; i++) await run('role_create', { name: 'R' + i, persona: 'p' + i });
  const rlMid = bytes((await run('role_list', {})).json); // 13 roles: already past one page
  for (let i = 12; i < 48; i++) await run('role_create', { name: 'R' + i, persona: 'p' + i });
  const rl = await run('role_list', {});
  check('role_list with 50 roles (the role limit): count plus a short recent list, not all of them', rl.json.total === 50 && rl.json.roles.length <= 10 && rl.json.more === true, [rl.json && rl.json.total, rl.json && rl.json.roles.length]);
  const rq = await run('role_list', { query: 'Capt' });
  check('role_list: query finds a role outside the recent ones', rq.json.roles.length === 1 && rq.json.roles[0].name === 'Captain', rq.text);
  const rp = await run('role_list', { limit: 5, offset: 5 });
  check('role_list: limit and offset page through', rp.json.roles.length === 5 && rp.json.offset === 5, rp.text);
  const rlSize = bytes(rl.json);
  check('role_list size does not grow with the role count (13 roles vs 50, bounded by the page)', rlSize <= rlMid + 150 && rlSize < 6000, [rlMid, rlSize]);
  check('tier 1 list size at start is small', size0 < 9000, size0);
  child.stdin.end();
  await new Promise(r => setTimeout(r, 300));
  // e. in process: a tier 3 tool is hidden, expand by name is journaled
  let ran = 0;
  Object.assign(process.env, env);
  const S = require('../bin/taskmote-mcp.js');
  S.extraTools.push({ name: 'nuke_cache', when: 'Wipe the cache when it is stale', tier: 3, category: 'danger', description: 'Wipes the cache.', inputSchema: { type: 'object', properties: {} }, run: () => { ran++; return { wiped: true }; } });
  const rpc = (method, params) => S.handle({ jsonrpc: '2.0', id: nextId++, method, params });
  const listed = (await rpc('tools/list', {})).result.tools.map(t => t.name);
  check('tier 3 is not in tools/list or the menu', !listed.includes('nuke_cache') && !/nuke_cache|danger/i.test(JSON.stringify((await rpc('tools/list', {})).result)));
  const q = await rpc('tools/call', { name: 'expand_tools', arguments: { query: 'cache' } });
  check('expand by query shows a tier 3 name but no schema, and journals nothing', !q.result.isError && /nuke_cache/.test(q.result.content[0].text) && !/inputSchema/.test(q.result.content[0].text) && !journal().some(r => r.type === 'tool_expand'), q.result.content[0].text);
  ran = 0; // sentinel: an expansion must never execute a tool
  const x3 = await rpc('tools/call', { name: 'expand_tools', arguments: { name: 'nuke_cache' } });
  const jr = journal().filter(r => r.type === 'tool_expand');
  check('expand by name of a tier 3 tool is journaled {type:tool_expand, tool, tier:3}', !x3.result.isError && jr.length === 1 && jr[0].tool === 'nuke_cache' && jr[0].tier === 3 && 'task_id' in jr[0], jr);
  check('after that expand the tier 3 tool is listed and a list_changed notification is queued', (await rpc('tools/list', {})).result.tools.some(t => t.name === 'nuke_cache') && S.notes.some(m => m.method === 'notifications/tools/list_changed'));
  check('expanding a tool runs nothing: zero executions of the sentinel right after the expansion', ran === 0, ran);
  ran = 0;
  const c3 = await rpc('tools/call', { name: 'call_tool', arguments: { name: 'nuke_cache', args: {} } });
  check('call_tool of a tier 3 tool is an unknown tool, the tool did not run and nothing is journaled as a call', c3.error && c3.error.code === -32602 && /unknown tool/.test(c3.error.message) && ran === 0 && journal().filter(r => r.type === 'tool_call').length === 0, [c3, ran]);
  // hints: every registered tool (core, modules, meta) carries one short "when to use me" line, and the agent sees it
  {
    const all = S.allTools();
    const none = T.missingWhen(all);
    check('when: every registered tool has a "when to use me" line (' + all.length + ' tools)', all.length >= 15 && none.length === 0, none);
    const long = all.filter(t => String(t.when).length > T.WHEN_LEN).map(t => t.name);
    check('when: no line is longer than ' + T.WHEN_LEN + ' characters (it would be cut)', long.length === 0, long);
    check('when: a tool with no line, or an empty or non-text one, is reported', JSON.stringify(T.missingWhen([{ name: 'a' }, { name: 'b', when: '' }, { name: 'c', when: 5 }, { name: 'd', when: ' x ' }])) === JSON.stringify(['a', 'b', 'c']));
    const lst = (await rpc('tools/list', {})).result.tools;
    check('when: the tier listing shows the line for each tool, the meta tools too', lst.length >= 8 && lst.every(t => /When to use: .+.$/.test(t.description) || /When to use: /.test(t.description)), lst.map(t => t.name));
    check('when: the meta tools have their own lines', all.concat(T.listTools([], { categories: {}, expanded: new Set() })).filter(t => t.name === 'expand_tools').every(t => /When to use: /.test(t.description)));
    const ec = await rpc('tools/call', { name: 'expand_tools', arguments: { category: 'roles' } });
    const tj = JSON.parse(ec.result.content[0].text).tools;
    check('when: expand_tools shows the line on every tool it returns', tj.length >= 5 && tj.every(t => typeof t.when === 'string' && t.when.length > 0), tj.map(t => t.name + ':' + t.when));
    const eq = JSON.parse((await rpc('tools/call', { name: 'expand_tools', arguments: { query: 'cache' } })).result.content[0].text);
    check('when: a query match, even a tier 3 name, shows the line (no schema)', eq.matches.every(m => m.when) && !/inputSchema/.test(JSON.stringify(eq.matches)) && eq.matches.some(m => m.name === 'nuke_cache' && /stale/.test(m.when)), eq.matches);
  }
  const d3 = await rpc('tools/call', { name: 'nuke_cache', arguments: {} });
  const jc = journal().filter(r => r.type === 'tool_call');
  check('a direct call of a tier 3 tool runs and is journaled {type:tool_call, tier:3}', !d3.result.isError && /wiped/.test(d3.result.content[0].text) && ran === 1 && jc.length === 1 && jc[0].tool === 'nuke_cache' && jc[0].tier === 3, [d3.result, jc]);
  // privacy: a secret-looking argument value never reaches the journal (assembled at run time)
  const secret = ['sk', 'live', 'Zx9' + 'Qw7' + 'Lm4'].join('_');
  await rpc('tools/call', { name: 'expand_tools', arguments: { name: 'nuke_cache' } });
  await rpc('tools/call', { name: 'nuke_cache', arguments: { token: secret, note: 'x' + secret } });
  const rawJournal = fs.readFileSync(path.join(env.HARNESS_STATE_DIR, 'journal.jsonl'), 'utf8');
  const tierRecs = journal().filter(r => r.type === 'tool_expand' || r.type === 'tool_call');
  const okKeys = new Set(['type', 'tool', 'tier', 'task_id', 'id', 'ts']);
  check('journal privacy: the argument value of a tier 3 expand and call is not in the journal text', !rawJournal.includes(secret) && !rawJournal.includes('Zx9'), 'secret found in journal');
  check('journal privacy: tier 3 records hold only type/tool/tier/task_id plus the journal id and ts', tierRecs.length >= 3 && tierRecs.every(r => Object.keys(r).every(k => okKeys.has(k))), tierRecs);
  const c2 = await rpc('tools/call', { name: 'task_status', arguments: {} });
  check('a tier 1 call is not journaled as a tool_call', !c2.result.isError && !journal().some(r => r.type === 'tool_call' && r.tool === 'task_status'));
  const unk = await rpc('tools/call', { name: 'zzz_none', arguments: {} });
  check('tools/call of an unknown name is still a JSON-RPC error', unk.error && unk.error.code === -32602, unk);
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  const pass = results.filter(Boolean).length;
  console.log(`result: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
