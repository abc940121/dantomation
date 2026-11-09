#!/usr/bin/env node
'use strict';
// search suite: manifest loads, route validation and owner-only access, kinds
// and filters, CJK, paging, incremental index (only appended bytes are read),
// redaction, caps. Fresh temp state dir; no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + JSON.stringify(info).slice(0, 300) : ''}`); };
const owner = { kind: 'owner', id: 'test' };

(async () => {
  try {
    const off = M.registry({ modules: { search: false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().length && off.settingsFor('search') === null);
    const reg = M.registry({ modules: { search: true } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors);
    check('route listed', reg.listRoutes().map(r => `${r.method} ${r.path} ${r.access}`).join() === 'GET /m/search/search owner');
    const get = (qs, actor = owner) => {
      const u = '/m/search/search' + (qs ? '?' + qs : '');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      return reg.callRoute(reg.findRoute('GET', u), { query, actor });
    };

    // empty journal
    let r = await get('q=anything');
    check('empty journal: no results', r.status === 200 && r.json.total === 0 && r.json.results.length === 0, r);

    // seed
    J.append({ type: 'task_start', task_id: 't1', request: 'please summarize the quarterly pineapple report', bot: 'alpha' });
    J.append({ type: 'reply', task_id: 't1', text: 'The pineapple report shows growth in harbor sales.' });
    J.append({ type: 'queue_add', task_id: 't2', bot: 'beta', prompt: 'remind me about the violin lesson' });
    J.append({ type: 'room_msg', room: 'lounge', speaker: 'human', kind: 'human', text: 'who brought the pineapple pizza?' });
    J.append({ type: 'room_msg', room: 'lounge', speaker: 'gamma', kind: 'bot', text: 'Not me, I only brought lemon tea.' });
    J.append({ type: 'room_msg', room: 'attic', speaker: 'gamma', kind: 'bot', text: '今天的天氣很好，我們去公園散步。' });
    J.append({ type: 'tool_done', task_id: 't1', tool: 'Bash', ok: true });

    r = await get('q=pineapple&limit=50');
    check('word search finds task, reply and room', r.status === 200 && r.json.total === 3 && new Set(r.json.results.map(x => x.kind)).size === 3, r.json);
    check('hits carry ids, snippet and newest first', r.json.results.every(x => x.id && x.snippet) && r.json.results[0].kind === 'room', r.json.results);
    check('reply inherits the task bot', r.json.results.some(x => x.kind === 'message' && x.bot === 'alpha' && x.task_id === 't1'));
    check('case-insensitive', (await get('q=PINEAPPLE')).json.total === 3);
    check('AND of words', (await get('q=pineapple+harbor')).json.total === 1);
    check('non-adjacent words in order do not need to be adjacent', (await get('q=report+pineapple')).json.total === 2);
    check('no match', (await get('q=zebra')).json.total === 0);
    check('kind filter', (await get('q=pineapple&kind=room')).json.total === 1);
    check('bot filter', (await get('q=pineapple&bot=alpha')).json.total === 2);
    check('room filter', (await get('q=lemon&room=lounge')).json.total === 1 && (await get('q=lemon&room=attic')).json.total === 0);
    check('queue_add prompt is a message', (await get('q=violin&kind=message&bot=beta')).json.total === 1);
    check('non-text records are not indexed', (await get('q=Bash')).json.total === 0);

    // CJK
    check('CJK bigram', (await get('q=' + encodeURIComponent('天氣'))).json.total === 1);
    check('CJK longer run', (await get('q=' + encodeURIComponent('去公園散步'))).json.total === 1);
    check('CJK single char', (await get('q=' + encodeURIComponent('園'))).json.total === 1);
    check('CJK non-adjacent chars are not a hit', (await get('q=' + encodeURIComponent('天好'))).json.total === 0);
    check('CJK mixed with word', (await get('q=' + encodeURIComponent('公園 attic')))?.json.total === 0);

    // paging
    for (let i = 0; i < 25; i++) J.append({ type: 'room_msg', room: 'paged', speaker: 'human', kind: 'human', text: `marker line ${i}` });
    const p1 = await get('q=marker&limit=10');
    const p2 = await get('q=marker&limit=10&offset=' + p1.json.next_offset);
    const p3 = await get('q=marker&limit=10&offset=' + p2.json.next_offset);
    check('paging: totals and next_offset', p1.json.total === 25 && p1.json.next_offset === 10 && p2.json.next_offset === 20 && p3.json.results.length === 5 && p3.json.next_offset === null, [p1.json.next_offset, p2.json.next_offset, p3.json]);
    const ids = new Set([...p1.json.results, ...p2.json.results, ...p3.json.results].map(x => x.id));
    check('paging: pages do not overlap', ids.size === 25);

    // incremental
    const realRead = fs.readSync; let bytes = 0;
    fs.readSync = function (fd, buf, o, len, pos) { const n = realRead.apply(this, arguments); bytes += n; return n; };
    const total = fs.statSync(J.JOURNAL).size;
    bytes = 0; await get('q=pineapple');
    check('unchanged journal: zero bytes re-read', bytes === 0, bytes);
    const line = J.append({ type: 'room_msg', room: 'lounge', speaker: 'human', kind: 'human', text: 'a fresh walrus appears' });
    bytes = 0; r = await get('q=walrus');
    const grew = fs.statSync(J.JOURNAL).size - total;
    fs.readSync = realRead;
    check('new record is found and only appended bytes are read', r.json.total === 1 && r.json.results[0].id === line.id && bytes === grew && grew < total, { bytes, grew, total });
    // torn tail: partial line waits for its newline
    fs.appendFileSync(J.JOURNAL, '{"type":"room_msg","room":"lounge","speaker":"human","kind":"human","text":"half w');
    check('torn tail is not indexed yet', (await get('q=half')).json.total === 0);
    fs.appendFileSync(J.JOURNAL, 'ritten line"}\n');
    check('completed line is indexed', (await get('q=half+written')).json.total === 1);

    // redaction
    const KEY = ['sk', 'ant', 'abcdefghijklmnop1234'].join('-');
    J.append({ type: 'reply', task_id: 't9', text: `my key is ${KEY} ok` });
    r = await get('q=' + encodeURIComponent(KEY));
    check('secret-shaped text is neither indexed nor shown', r.json.total === 0 && !JSON.stringify((await get('q=key+ok')).json).includes(KEY), r.json);

    // validation and caps
    check('q required', (await get('')).status === 400 && (await get('q=%20')).status === 400);
    check('q too long', (await get('q=' + 'a'.repeat(201))).status === 400 && (await get('q=' + 'a'.repeat(200))).status === 200);
    check('bad kind', (await get('q=x&kind=evil')).status === 400);
    check('bad bot/room ids', (await get('q=x&bot=' + encodeURIComponent('a b'))).status === 400 && (await get('q=x&room=' + encodeURIComponent('../x'))).status === 400);
    check('limit caps', (await get('q=x&limit=0')).status === 400 && (await get('q=x&limit=51')).status === 400 && (await get('q=x&limit=abc')).status === 400 && (await get('q=x&limit=50')).status === 200);
    check('offset caps', (await get('q=x&offset=-1')).status === 400 && (await get('q=x&offset=100001')).status === 400);
    check('array-valued query uses the first value', (await reg.callRoute(reg.findRoute('GET', '/m/search/search?q=a'), { query: { q: ['walrus', 'zzz'] }, actor: owner })).json.total === 1);
    check('non-owner is refused before the handler', (await get('q=pineapple', { kind: 'anonymous', id: 'x' })).status === 403 && (await get('q=pineapple', { kind: 'worker', id: 'w' })).status === 403);
    check('missing actor is refused', (await reg.callRoute(reg.findRoute('GET', '/m/search/search?q=a'), { query: { q: 'a' } })).status === 403);
    check('settings reject unknown key', M.registry({ modules: { search: true }, search: { nope: 1 } }).errors.length > 0);

    // engine caps: maxDocs drops the oldest, doc chars clipped
    const { createIndex } = require('../engine');
    const ix = createIndex({ maxDocs: 100, maxDocChars: 50 });
    for (let i = 0; i < 150; i++) ix.ingest({ type: 'reply', id: 'r' + i, task_id: 'x', text: `item${i} ` + 'z'.repeat(100) });
    check('max_docs bounds memory, oldest dropped', ix.size() <= 100 && ix.query({ q: 'item149', limit: 5, offset: 0 }).total === 1 && ix.query({ q: 'item0', limit: 5, offset: 0 }).total === 0, ix.size());
    check('max_doc_chars clips indexed text', ix.query({ q: 'item149', limit: 5, offset: 0 }).hits[0].snippet.length <= 60);
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
