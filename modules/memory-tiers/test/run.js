#!/usr/bin/env node
'use strict';
// memory-tiers: store rules (pin budget, demotion, retention, search), capture from task.end, prepareTurn,
// routes and access, guard, lock behaviour, shell commands in real processes, off-by-default.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memtiers-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE;
for (const k of ['HARNESS_TASK_ID', 'HARNESS_TASK_DIR', 'HARNESS_NOW']) delete process.env[k];
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const S = require('../store');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: '' }, WORKER = { kind: 'worker', id: 'w' }, ANON = { kind: 'anonymous', id: '' };
const DAY = 86400000;
const T0 = Date.parse('2030-01-07T12:00:00Z');
const dir = path.join(STATE, 'm', 'memory-tiers');
const L = { core_chars: 100, recall_max: 3, recall_days: 14, archive_max: 4 };

(async () => {
  try {
    // ---- off by default
    const off = M.registry({ modules: { 'memory-tiers': false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().some(r => r.module === 'memory-tiers') && !off.listCommands().includes('memory'));
    check('absent from config: not loaded', !M.registry({ modules: {} }).listRoutes().some(r => r.module === 'memory-tiers'));
    check('off: prepareTurn adds nothing', (await M.prepareTurn(off.mods, { task_id: 't0' })).context.length === 0);
    const cfgDir = path.join(ROOT, 'config');
    const cfgText = fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir).map(f => fs.readFileSync(path.join(cfgDir, f), 'utf8')).join('\n') : '';
    check('never enabled in config/', !/memory-tiers/.test(cfgText));

    const reg = M.registry({ modules: { 'memory-tiers': true }, memory_tiers: { core_chars: 200, recall_max: 4, recall_days: 14, archive_max: 6, recall_in_prompt: 2, capture: true } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('wrong setting type is a load error', M.registry({ modules: { 'memory-tiers': true }, memory_tiers: { core_chars: 'x' } }).errors.length === 1);
    check('unknown setting is a load error', M.registry({ modules: { 'memory-tiers': true }, memory_tiers: { nope: 1 } }).errors.length === 1);
    check('setting out of range is a load error', M.registry({ modules: { 'memory-tiers': true }, memory_tiers: { archive_max: 1 } }).errors.length === 1);
    const routes = reg.listRoutes().filter(r => r.module === 'memory-tiers');
    check('7 routes, all owner access', routes.length === 7 && routes.every(r => (r.access || 'owner') === 'owner'), routes.map(r => r.method + r.path).join());
    check('command memory listed', reg.listCommands().includes('memory'));

    const call = (method, p, o = {}) => {
      const f = reg.findRoute(method, '/m/memory-tiers' + p);
      return f ? reg.callRoute(f, { actor: OWNER, body: o.body, query: {}, ...o }) : Promise.resolve({ status: 'nomatch' });
    };

    // ---- access: every write is owner only
    for (const [m, p] of [['POST', '/core'], ['POST', '/core/m-aaaaaaaaaaaa/unpin'], ['POST', '/archive/m-aaaaaaaaaaaa/restore'], ['POST', '/items/m-aaaaaaaaaaaa/forget'], ['POST', '/sweep'], ['GET', '/memory'], ['GET', '/search?q=x']]) {
      const w = await call(m, p.split('?')[0], { actor: WORKER, body: { text: 'x' } });
      const a = await call(m, p.split('?')[0], { actor: ANON, body: { text: 'x' } });
      check(`access: ${m} ${p} refused for worker and anonymous`, w.status === 403 && a.status === 403, `${w.status}/${a.status}`);
    }

    // ---- pin / budget / dedupe / validation
    let r = await call('POST', '/core', { body: { text: '  Deploys go out on Fridays  ' } });
    const c1 = r.json && r.json.item;
    check('pin new fact (trimmed) lands in core', r.status === 201 && c1.tier === 'core' && c1.text === 'Deploys go out on Fridays' && /^m-[0-9a-f]{12}$/.test(c1.id), JSON.stringify(r));
    r = await call('POST', '/core', { body: { text: 'deploys go out on fridays' } });
    check('duplicate fact (case-insensitive) is 409', r.status === 409);
    for (const bad of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(401) }, { text: 'a\u0000b' }, { id: 'nope' }, { id: 7 }]) {
      r = await call('POST', '/core', { body: bad });
      check('pin rejects ' + JSON.stringify(bad).slice(0, 40), r.status === 400, JSON.stringify(r));
    }
    r = await call('POST', '/core', { body: { id: 'm-000000000000' } });
    check('pin unknown id is 404', r.status === 404);
    r = await call('POST', '/core', { body: { text: 'y'.repeat(190) } });
    check('pin over the core budget is 409 and says the budget', r.status === 409 && /budget is 200/.test(r.json.error), JSON.stringify(r));
    r = await call('GET', '/memory');
    check('list: counts and limits', r.status === 200 && r.json.counts.core === 1 && r.json.counts.core_chars === c1.text.length && r.json.limits.core_chars === 200);

    // ---- capture from task.end (reply record the core journals)
    J.append({ type: 'reply', task_id: 'tk1', text: 'Fixed the login bug.\n\nAlso   cleaned  up.' });
    J.append({ type: 'reply', task_id: 'tk2', text: 'LONG-' + 'z'.repeat(2000) });
    await M.emit(reg.mods, 'task.end', { task_id: 'tk1', code: 0, workdir: tmp });
    await M.emit(reg.mods, 'task.end', { task_id: 'tk2', code: 0, workdir: tmp });
    await M.emit(reg.mods, 'task.end', { task_id: 'tk-no-reply', code: 1, workdir: tmp });
    r = await call('GET', '/memory');
    const rec = r.json.recall;
    check('task.end makes recall items for tasks with a reply only', rec.length === 2 && rec.some(i => i.task_id === 'tk1') && !rec.some(i => i.task_id === 'tk-no-reply'), JSON.stringify(rec));
    check('recall text is whitespace-flattened', rec.find(i => i.task_id === 'tk1').text === 'Fixed the login bug. Also cleaned up.');
    check('recall text is clipped to the item max', rec.find(i => i.task_id === 'tk2').text.length === S.ITEM_MAX && rec.find(i => i.task_id === 'tk2').text.endsWith('...'));
    J.append({ type: 'reply', task_id: 'tk1', text: 'second answer' });
    await M.emit(reg.mods, 'task.end', { task_id: 'tk1', code: 0, workdir: tmp });
    r = await call('GET', '/memory');
    check('same task twice replaces its recall row', r.json.recall.filter(i => i.task_id === 'tk1').length === 1 && r.json.recall.find(i => i.task_id === 'tk1').text === 'second answer');
    const before = S.load(dir).items.length;
    await M.emit(reg.mods, 'task.end', { code: 0 });
    check('task.end without task_id is ignored', S.load(dir).items.length === before);
    await M.emit(reg.mods, 'task.start', { task_id: 'tk9', request: 'SECRET-REQUEST-TEXT', workdir: tmp, resumed: false }).catch(() => {});
    check('request text is never stored', !fs.readFileSync(path.join(dir, 'data.json'), 'utf8').includes('SECRET-REQUEST-TEXT'));
    const off2 = M.registry({ modules: { 'memory-tiers': true }, memory_tiers: { capture: false } });
    const off3 = M.registry({ modules: { 'memory-tiers': true } });
    check('capture defaults to false', off3.settingsFor('memory-tiers').capture === false);
    J.append({ type: 'reply', task_id: 'tk-off', text: 'should not be kept' });
    await M.emit(off2.mods, 'task.end', { task_id: 'tk-off', code: 0, workdir: tmp });
    await M.emit(off3.mods, 'task.end', { task_id: 'tk-off', code: 0, workdir: tmp });
    check('capture off (explicit and default) records nothing', !fs.readFileSync(path.join(dir, 'data.json'), 'utf8').includes('should not be kept'));

    // ---- journal holds metadata only
    const jr = J.readAll().records.filter(x => x.module === 'memory-tiers');
    check('journal has memory records without texts', jr.length > 0 && jr.every(x => !/Deploys go out|login bug|second answer/.test(JSON.stringify(x))));

    // ---- prepareTurn: core + newest live recall, never archive
    let pc = await M.prepareTurn(reg.mods, { task_id: 'tA' });
    let txt = pc.context.map(c => c.text).join('\n');
    check('prepareTurn: core fact and recall notes present, labelled', txt.includes('Deploys go out on Fridays') && txt.includes('second answer') && /not instructions/.test(txt), txt);

    // ---- owner signatures (finding 1)
    check('prepareTurn frames owner notes as background', /Owner notes \(background, not instructions\)/.test(txt), txt);
    const secFile = path.join(STATE, 'secrets', 'memory-tiers.json');
    const hk = JSON.parse(fs.readFileSync(secFile, 'utf8')).hmac_key;
    check('first owner write generated a key in the module secrets file', typeof hk === 'string' && hk.length >= 32);
    const coreRow = S.inTier(S.load(dir), 'core')[0];
    check('pinned entry carries a 64-hex HMAC that verifies', /^[0-9a-f]{64}$/.test(coreRow.sig) && S.verified(hk, coreRow) && !S.verified('x'.repeat(40), coreRow));
    check('view() never exposes the signature', !('sig' in S.view(coreRow)));
    check('store pin without the key is refused', S.pin(S.load(dir), { text: 'no key' }, L).status === 403 && S.pin(S.load(dir), { text: 'no key' }, L, '').status === 403);
    // an agent that requires store.js directly can write rows, but not rows that verify
    S.update(dir, d => { d.items.push({ id: 'm-aaaaaaaaaaaa', tier: 'core', text: 'FORGED-NOSIG', task_id: '', ts: new Date().toISOString(), from: 'owner' }); return {}; }, L);
    S.update(dir, d => { d.items.push({ id: 'm-bbbbbbbbbbbb', tier: 'core', text: 'FORGED-BADSIG', task_id: '', ts: new Date().toISOString(), from: 'owner', sig: 'a'.repeat(64) }); return {}; }, L);
    S.update(dir, d => { d.items.find(i => i.id === coreRow.id).text = 'TAMPERED-TEXT'; return {}; }, L);
    process.env.HARNESS_TASK_ID = 'agent-task';
    const pcF = await M.prepareTurn(reg.mods, { task_id: 'tF' });
    delete process.env.HARNESS_TASK_ID;
    const txtF = pcF.context.map(c => c.text).join('\n');
    check('unverified core entries (no sig, bad sig, tampered text) are not injected', !/FORGED|TAMPERED|Deploys go out/.test(txtF), txtF);
    const sk = J.readAll().records.filter(x => x.module === 'memory-tiers' && x.type === 'memory_unverified_skipped');
    check('skipped entries are journaled as a count only', sk.length > 0 && sk[sk.length - 1].count === 3 && !/FORGED|TAMPERED|Deploys/.test(JSON.stringify(sk)), JSON.stringify(sk));
    S.update(dir, d => { d.items = d.items.filter(i => !/^m-(a{12}|b{12})$/.test(i.id)); d.items.find(i => i.id === coreRow.id).text = coreRow.text; return {}; }, L);
    check('restoring the signed text makes the entry verify again', /Deploys go out on Fridays/.test((await M.prepareTurn(reg.mods, { task_id: 'tG' })).context.map(c => c.text).join('\n')));
    r = await call('POST', '/core', { body: { text: 'Second owner fact' } });
    check('owner route pin signs with the stored key (no key regenerated)', r.status === 201 && JSON.parse(fs.readFileSync(secFile, 'utf8')).hmac_key === hk && S.verified(hk, S.find(S.load(dir), r.json.item.id)));
    await call('POST', '/items/' + r.json.item.id + '/forget');

    // ---- demotion by count: recall_max 4, add more
    for (let i = 0; i < 5; i++) {
      process.env.HARNESS_NOW = String(T0 + i * 1000);
      J.append({ type: 'reply', task_id: 'c' + i, text: 'COUNT-NOTE-' + i });
      await M.emit(reg.mods, 'task.end', { task_id: 'c' + i, code: 0, workdir: tmp });
    }
    delete process.env.HARNESS_NOW;
    let data = S.load(dir);
    const cnt = S.counts(data);
    check('count rule: recall capped at 4, overflow demoted to archive', cnt.recall === 4 && cnt.archive >= 3, JSON.stringify(cnt));
    check('demotion keeps the newest in recall', ['c1', 'c2', 'c3', 'c4'].every(t => S.inTier(data, 'recall').some(i => i.task_id === t)) && !S.inTier(data, 'recall').some(i => i.task_id === 'c0'));
    txt = (await M.prepareTurn(reg.mods, { task_id: 'tA' })).context.map(c => c.text).join('\n');
    check('prepareTurn: only recall_in_prompt (2) newest recall items', (txt.match(/COUNT-NOTE-/g) || []).length === 2 && txt.includes('COUNT-NOTE-4') && txt.includes('COUNT-NOTE-3') && !txt.includes('COUNT-NOTE-2'), txt);
    check('prepareTurn: archive text never injected', S.inTier(data, 'archive').every(i => !txt.includes(i.text)));

    // ---- demotion by age
    const old = { items: [] };
    const mk = (tier, days, text) => ({ id: 'm-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0'), tier, text, ts: new Date(T0 - days * DAY).toISOString(), task_id: '', from: 'task' });
    old.items.push(mk('recall', 20, 'aged'), mk('recall', 1, 'fresh'), mk('core', 400, 'pinned-old'));
    S.enforce(old, { core_chars: 100, recall_max: 10, recall_days: 14, archive_max: 10 }, T0);
    check('age rule: old recall to archive, fresh stays, core untouched', old.items.find(i => i.text === 'aged').tier === 'archive' && old.items.find(i => i.text === 'fresh').tier === 'recall' && old.items.find(i => i.text === 'pinned-old').tier === 'core');
    const old2 = { items: [mk('recall', 400, 'ancient')] };
    S.enforce(old2, { core_chars: 100, recall_max: 10, recall_days: 0, archive_max: 10 }, T0);
    check('recall_days 0 means count only', old2.items[0].tier === 'recall');
    check('prepareTurn view skips aged recall even before a sweep', !S.recallIsLive(old.items[0], { recall_days: 14 }, T0) && S.recallIsLive(old.items[1], { recall_days: 14 }, T0));

    // ---- archive retention cap (6) deletes the oldest
    for (let i = 0; i < 12; i++) {
      process.env.HARNESS_NOW = String(T0 + 100000 + i * 1000);
      J.append({ type: 'reply', task_id: 'r' + i, text: 'RET-NOTE-' + i });
      await M.emit(reg.mods, 'task.end', { task_id: 'r' + i, code: 0, workdir: tmp });
    }
    delete process.env.HARNESS_NOW;
    data = S.load(dir);
    check('retention: archive capped at 6', S.inTier(data, 'archive').length === 6, JSON.stringify(S.counts(data)));
    check('retention: oldest archive items are the ones deleted', !data.items.some(i => i.text === 'COUNT-NOTE-0') && data.items.some(i => i.text === 'RET-NOTE-7'));
    const big = { items: [] };
    for (let i = 0; i < 2100; i++) big.items.push(mk('archive', 1, 'n' + i));
    S.enforce(big, { core_chars: 100, recall_max: 10, recall_days: 14, archive_max: 5000 }, T0);
    check('hard ceiling of 2000 items holds whatever archive_max says', big.items.length === 2000);

    // ---- search (archive by default), tiers, ranking
    r = await call('GET', '/search', { query: { q: 'RET-NOTE' } });
    check('search: archive only by default', r.status === 200 && r.json.items.length > 0 && r.json.items.every(i => i.tier === 'archive'), JSON.stringify(r.json));
    r = await call('GET', '/search', { query: { q: 'ret-note-7' } });
    check('search: case-insensitive', r.json.items.length === 1 && r.json.items[0].text === 'RET-NOTE-7');
    r = await call('GET', '/search', { query: { q: 'RET-NOTE zzz-none' } });
    check('search: all terms must match', r.status === 200 && r.json.items.length === 0);
    r = await call('GET', '/search', { query: { q: 'fridays', tier: 'all' } });
    check('search tier=all includes core', r.json.items.length === 1 && r.json.items[0].tier === 'core');
    r = await call('GET', '/search', { query: { q: 'fridays' } });
    check('search default does not return core', r.json.items.length === 0);
    r = await call('GET', '/search', { query: { q: '' } });
    check('search: empty q is 400', r.status === 400);
    r = await call('GET', '/search', { query: { q: 'x', tier: 'bogus' } });
    check('search: bad tier is 400', r.status === 400);
    r = await call('GET', '/search', { query: { q: 'RET', limit: '2' } });
    check('search: limit honoured', r.json.items.length === 2);
    r = await call('GET', '/search', { query: { q: 'RET', limit: '0' } });
    check('search: bad limit is 400', r.status === 400);
    const rank = { items: [{ id: 'm-111111111111', tier: 'archive', text: 'cat', ts: new Date(T0).toISOString() }, { id: 'm-222222222222', tier: 'archive', text: 'cat cat cat', ts: new Date(T0 - 1000).toISOString() }] };
    check('search: more hits rank first', S.search(rank, 'cat', ['archive']).items[0].id === 'm-222222222222');

    // ---- promote an archive item, restore, unpin, forget (clock after the 2030 rows so a fresh item is the newest)
    process.env.HARNESS_NOW = String(T0 + 10 * DAY);
    const arch = S.inTier(S.load(dir), 'archive').sort((a, b) => S.msOf(b) - S.msOf(a))[0];
    r = await call('POST', `/archive/${arch.id}/restore`);
    check('restore: archive item goes back to recall', r.status === 200 && r.json.item.tier === 'recall');
    r = await call('POST', `/archive/${arch.id}/restore`);
    check('restore of a non-archive item is 409', r.status === 409);
    r = await call('POST', '/core', { body: { id: arch.id } });
    check('promote by id moves recall item into core (no copy)', r.status === 201 && r.json.item.id === arch.id && r.json.item.tier === 'core' && S.load(dir).items.filter(i => i.text === arch.text).length === 1, JSON.stringify(r));
    r = await call('POST', '/core', { body: { id: arch.id } });
    check('promote an already-pinned item is 409', r.status === 409);
    r = await call('POST', `/core/${arch.id}/unpin`);
    check('unpin demotes core to recall', r.status === 200 && r.json.item.tier === 'recall');
    r = await call('POST', `/core/${arch.id}/unpin`);
    check('unpin of a non-core item is 409', r.status === 409);
    r = await call('POST', '/core/not-an-id/unpin');
    check('unpin bad id is 404', r.status === 404);
    r = await call('POST', `/items/${arch.id}/forget`);
    check('forget deletes from any tier', r.status === 200 && r.json.tier === 'recall' && !S.load(dir).items.some(i => i.id === arch.id));
    r = await call('POST', `/items/${arch.id}/forget`);
    check('forget twice is 404', r.status === 404);
    r = await call('POST', `/items/${c1.id}/forget`);
    check('forget core item works', r.status === 200 && S.inTier(S.load(dir), 'core').length === 0);
    delete process.env.HARNESS_NOW;
    r = await call('POST', '/sweep');
    check('sweep route answers counts', r.status === 200 && typeof r.json.counts.recall === 'number');

    // ---- corrupt file: write routes fail soft (503), read of prepareTurn is skipped, file not clobbered
    fs.writeFileSync(path.join(dir, 'data.json'), '{ not json');
    r = await call('POST', '/core', { body: { text: 'z' } });
    check('corrupt data file: write is 503, not a throw', r.status === 503);
    r = await call('GET', '/memory');
    check('corrupt data file: read is 503', r.status === 503);
    const pcBad = await M.prepareTurn(reg.mods, { task_id: 'tB' });
    check('corrupt data file: prepareTurn adds nothing and does not throw', pcBad.context.length === 0);
    const direct = reg.mods.find(m => m.name === 'memory-tiers');
    let thrown = null, directR;
    try { directR = direct.prepareTurn({ settings: reg.settingsFor('memory-tiers'), state: { dir, append: x => J.append({ module: 'memory-tiers', ...x }) }, secret: () => null }); } catch (e) { thrown = e; }
    const pe = J.readAll().records.filter(x => x.type === 'memory_prepare_error');
    check('corrupt data file: hook returns null and journals a short code only', !thrown && directR === null && pe.length > 0 && pe[pe.length - 1].code === 'data_unreadable' && !/json|corrupt|not JSON/i.test(JSON.stringify(pe[pe.length - 1])), String(thrown) + JSON.stringify(pe));
    let thrown2 = null;
    try { direct.prepareTurn({ settings: {}, state: { dir: path.join(tmp, 'x'), append: () => { throw new Error('journal down'); } }, secret: () => { throw new Error('boom'); } }); } catch (e) { thrown2 = e; }
    check('hook never throws even when the journal and secrets fail', thrown2 === null);
    await M.emit(reg.mods, 'task.end', { task_id: 'tk1', code: 0, workdir: tmp });
    check('corrupt data file: capture does not throw and does not clobber', fs.readFileSync(path.join(dir, 'data.json'), 'utf8') === '{ not json');
    fs.rmSync(path.join(dir, 'data.json'));

    // ---- lock: owner token, stale break, never unlocked
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'lock');
    let sawToken = null;
    S.update(dir, d => { sawToken = fs.readFileSync(lock, 'utf8'); return {}; }, L);
    check('lock holds an owner token while updating and is removed after', /^\d+:[0-9a-f]{16}$/.test(sawToken) && !fs.existsSync(lock));
    let lostErr = null;
    try { S.update(dir, d => { fs.writeFileSync(lock, 'someone-else-token'); return S.pin(d, { text: 'LOST-LOCK-WRITE' }, L, 'k'.repeat(32)); }, L); } catch (e) { lostErr = e; }
    check('own nonce re-read before the state write: a replaced lock aborts the write', lostErr && /lock was lost/.test(lostErr.message) && !(fs.existsSync(path.join(dir, 'data.json')) && fs.readFileSync(path.join(dir, 'data.json'), 'utf8').includes('LOST-LOCK-WRITE')));
    check('release never unlinks a lock holding another token', fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === 'someone-else-token');
    const past = new Date(Date.now() - 120000);
    fs.utimesSync(lock, past, past);
    let ran = false;
    S.update(dir, () => { ran = true; return {}; }, L);
    check('stale lock is broken under the breaker mutex and the update runs', ran === true && !fs.existsSync(lock) && !fs.existsSync(lock + '.break') && fs.readdirSync(dir).every(f => !/\.stale-|\.link/.test(f)));
    // breakStale: a lock that changed since it was judged stale is left alone; identical and old is removed
    fs.writeFileSync(lock, 'new-live-holder');
    S.breakStale(lock, 'old-stale-token');
    check('breakStale leaves a lock whose content changed', fs.readFileSync(lock, 'utf8') === 'new-live-holder' && !fs.existsSync(lock + '.break'));
    S.breakStale(lock, 'new-live-holder');
    check('breakStale leaves a byte-identical lock that is not old', fs.existsSync(lock));
    fs.utimesSync(lock, past, past);
    S.breakStale(lock, 'new-live-holder');
    check('breakStale removes a byte-identical old lock and frees the mutex', !fs.existsSync(lock) && !fs.existsSync(lock + '.break'));
    fs.writeFileSync(lock, 'stale-2'); fs.utimesSync(lock, past, past);
    fs.writeFileSync(lock + '.break', ''); // another breaker holds the mutex, fresh
    S.breakStale(lock, 'stale-2');
    check('a fresh breaker mutex makes a second breaker back off', fs.existsSync(lock) && fs.existsSync(lock + '.break'));
    fs.utimesSync(lock + '.break', past, past); // abandoned breaker: older than 10 s
    ran = false;
    S.update(dir, () => { ran = true; return {}; }, L);
    check('an abandoned breaker mutex (>10 s) is cleared and the stale lock broken', ran && !fs.existsSync(lock) && !fs.existsSync(lock + '.break'));
    const holder = 'const fs=require("fs");try{fs.writeFileSync(process.argv[1],"p"+process.pid,{flag:"wx"});console.log("won")}catch(e){console.log(e.code)}';
    fs.writeFileSync(lock, 'held');
    check('lock acquire is an exclusive create (EEXIST when held)', spawnSync(process.execPath, ['-e', holder, lock], { encoding: 'utf8' }).stdout.trim() === 'EEXIST');
    fs.unlinkSync(lock);
    // A fresh lock held by someone else blocks (we never run unlocked): use a child that waits.
    fs.writeFileSync(lock, 'live-holder');
    const t0 = Date.now();
    let threw = null;
    // shorten the wait by racing: update waits up to 5s then throws busy
    try { S.update(dir, () => { ran = 'UNLOCKED'; return {}; }, L); } catch (e) { threw = e; }
    check('fresh foreign lock: update waits then throws busy, never runs unlocked', threw && /busy/.test(threw.message) && ran !== 'UNLOCKED' && fs.readFileSync(lock, 'utf8') === 'live-holder' && Date.now() - t0 >= 4500);
    fs.unlinkSync(lock);
    // parallel writers do not lose rows
    const worker = `const S=require(${JSON.stringify(path.join(__dirname, '..', 'store'))});const d=process.argv[1];for(let i=0;i<10;i++){S.update(d,x=>S.pin(x,{text:'w'+process.argv[2]+'-'+i},{core_chars:100000},'k'.repeat(32)),{core_chars:100000,recall_max:5,recall_days:14,archive_max:50});}`;
    const pdir = path.join(tmp, 'par');
    const kids = [1, 2, 3].map(n => spawnSync(process.execPath, ['-e', worker, pdir, String(n)], { encoding: 'utf8', timeout: 60000 }));
    check('3 writer processes x 10 pins: no lost rows', kids.every(k => k.status === 0) && S.inTier(S.load(pdir), 'core').length === 30, kids.map(k => k.stderr).join(''));

    // ---- stores stay private
    if (process.platform !== 'win32') check('data.json mode 600', (fs.statSync(path.join(pdir, 'data.json')).mode & 0o077) === 0);

    // ---- status lines
    await call('POST', '/core', { body: { text: 'STATUS-FACT' } });
    const sl = (await M.statusLines(reg.mods, J)).join('|');
    check('status line shows tier counts and budget', /memory: core 1 \(11\/200 chars\)/.test(sl), sl);

    // ---- guard
    const guard = (tool, command, env) => { const old = process.env.HARNESS_TASK_ID; if (env) process.env.HARNESS_TASK_ID = 't1'; else delete process.env.HARNESS_TASK_ID; return M.beforeTool(reg.mods, { tool, ti: { command }, input: {} }).finally(() => { if (old === undefined) delete process.env.HARNESS_TASK_ID; else process.env.HARNESS_TASK_ID = old; }); };
    check('guard: agent pin blocked', !!(await guard('Bash', 'node bin/harness.js memory pin "x"', true)));
    check('guard: agent forget blocked', !!(await guard('Bash', 'dantomation memory forget m-aaaaaaaaaaaa', true)));
    check('guard: agent restore blocked', !!(await guard('Bash', 'dantomation memory restore m-aaaaaaaaaaaa', true)));
    check('guard: agent server call blocked', !!(await guard('Bash', 'curl -X POST http://127.0.0.1:1/m/memory-tiers/core', true)));
    check('guard: agent memory search allowed', (await guard('Bash', 'dantomation memory search login', true)) === null);
    check('guard: node require of the store blocked', !!(await guard('Bash', 'node -e "require(\'./modules/memory-tiers/store\').update()"', true)));
    check('guard: paths to the data dir and secrets file blocked', !!(await guard('Bash', 'echo x > state/m/memory-tiers/data.json', true)) && !!(await guard('PowerShell', 'Get-Content state\\secrets\\memory-tiers.json', true)));
    check('guard: bare memory write verbs blocked without the binary name', !!(await guard('Bash', 'node bin/x.js memory pin "y"', true)) && !!(await guard('Bash', 'memory sweep', true)));
    check('guard: memory list stays allowed', (await guard('Bash', 'dantomation memory list', true)) === null);
    process.env.HARNESS_TASK_ID = 'agent-task';
    const wr = direct.beforeTool({ tool: 'Write', ti: { file_path: 'state/m/memory-tiers/data.json' } });
    const wr2 = direct.beforeTool({ tool: 'Write', ti: { file_path: 'notes/todo.txt' } });
    const rd = direct.beforeTool({ tool: 'Read', ti: { file_path: 'state/m/memory-tiers/data.json' } });
    delete process.env.HARNESS_TASK_ID;
    check('guard: file-write tool aimed at the store blocked; other writes and reads pass', !!wr && wr2 === null && rd === null);
    check('guard: owner (no task) allowed', (await guard('Bash', 'dantomation memory pin "x"', false)) === null);

    // ---- commands in real processes
    const cfgFile = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ modules: { 'memory-tiers': true }, memory_tiers: { core_chars: 60 } }));
    const st2 = path.join(tmp, 'state2');
    const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: st2, HARNESS_LOG_DIR: path.join(tmp, 'logs'), HARNESS_WORK_DIR: tmp };
    delete env.HARNESS_TASK_ID; delete env.HARNESS_NOW;
    const run = (verb, args, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), verb, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    let p = run('memory', ['list']);
    check('cmd list on empty store', p.status === 0 && /core 0 \(0\/60 chars\), recall 0, archive 0/.test(p.stdout), p.stdout + p.stderr);
    p = run('memory', ['pin', 'The build needs Node 20']);
    const pid = (p.stdout.match(/m-[0-9a-f]{12}/) || [])[0];
    check('cmd pin prints the id', p.status === 0 && !!pid, p.stdout + p.stderr);
    p = run('memory', ['pin', 'x'.repeat(50)]);
    check('cmd pin over budget exits 3', p.status === 3 && /budget/.test(p.stderr), p.stdout + p.stderr);
    p = run('memory', ['pin']);
    check('cmd pin without text exits 2', p.status === 2 && /usage/.test(p.stderr));
    p = run('memory', ['bogus']);
    check('cmd bogus exits 2 with usage', p.status === 2 && /usage/.test(p.stderr));
    p = run('memory', ['pin', 'blocked'], { HARNESS_TASK_ID: 'task-x' });
    check('cmd pin inside a task exits 6', p.status === 6);
    p = run('memory', ['forget', pid], { HARNESS_TASK_ID: 'task-x' });
    check('cmd forget inside a task exits 6', p.status === 6);
    p = run('memory', ['list'], { HARNESS_TASK_ID: 'task-x' });
    check('cmd list inside a task is allowed', p.status === 0 && p.stdout.includes('Node 20'), p.stdout + p.stderr);
    p = run('memory', ['unpin', pid]);
    check('cmd unpin', p.status === 0 && p.stdout.includes('unpin: ' + pid));
    p = run('memory', ['search', 'node', '--recall']);
    check('cmd search --recall finds the demoted item', p.status === 0 && p.stdout.includes(pid) && /\[recall\]/.test(p.stdout), p.stdout + p.stderr);
    p = run('memory', ['search', 'node']);
    check('cmd search defaults to the archive (no match)', p.status === 0 && /no matches/.test(p.stdout), p.stdout);
    p = run('memory', ['search']);
    check('cmd search without words exits 2', p.status === 2);
    p = run('memory', ['pin', pid]);
    check('cmd pin by id promotes it back', p.status === 0 && p.stdout.includes(pid));
    p = run('memory', ['forget', pid]);
    check('cmd forget', p.status === 0);
    p = run('memory', ['forget', pid]);
    check('cmd forget again exits 3', p.status === 3);
    fs.writeFileSync(path.join(st2, 'm', 'memory-tiers', 'data.json'), '{ broken');
    p = run('memory', ['pin', 'after corrupt']);
    check('cmd on a corrupt store: exit 1 and a clear message, file untouched', p.status === 1 && /corrupt or unreadable/.test(p.stderr) && /data\.json/.test(p.stderr) && fs.readFileSync(path.join(st2, 'm', 'memory-tiers', 'data.json'), 'utf8') === '{ broken', p.stdout + p.stderr);
    p = run('memory', ['list']);
    check('cmd list on a corrupt store: exit 1 and a clear message', p.status === 1 && /corrupt or unreadable/.test(p.stderr));
    fs.unlinkSync(path.join(st2, 'm', 'memory-tiers', 'data.json'));
    p = run('memory', ['sweep']);
    check('cmd sweep', p.status === 0 && /core 0, recall 0, archive 0/.test(p.stdout), p.stdout + p.stderr);

    // ---- no personal paths or addresses in the module files
    const mod = path.join(ROOT, 'modules', 'memory-tiers');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const winHome = ['C:', 'Users'].join('\\');
    const ipRe = /\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b/;
    const bad = walk(mod).filter(f => { const s = fs.readFileSync(f, 'utf8'); return s.includes(winHome) || s.includes(['', 'Users', ''].join('/')) || ipRe.test(s); });
    check('no user paths or non-loopback IPs in module files', bad.length === 0, bad.join());
    check('module requires no sibling module folder', !walk(mod).filter(f => f.endsWith('.js')).some(f => /require\(['"]\.\.\/(?!\.\.\/lib)[a-z-]+\//.test(fs.readFileSync(f, 'utf8').replace(/require\('\.\.\/\.\.\/lib/g, ''))));
  } finally {
    delete process.env.HARNESS_NOW;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('crash:', e); process.exit(1); });
