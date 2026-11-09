#!/usr/bin/env node
'use strict';
// ntfy: in-process, fresh temp state dir, a local http server on 127.0.0.1 only. No real network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info ? ': ' + info : ''}`); };
const TOPIC = 'zq-secret-topic-91x';

(async () => {
  const hits = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'hang') return; // never answers
      res.writeHead(mode === 'err' ? 500 : 200); res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const settle = () => new Promise(r => setTimeout(r, 50));
  const mk = cfg => M.registry({ modules: { ntfy: true }, ntfy: cfg });
  const sentReset = keep => M.registry({ modules: { ntfy: true } }).api('ntfy').reset(keep);
  const status = async r => (await M.statusLines(r.mods, J)).join('\n');

  try {
    const off = M.registry({ modules: { ntfy: false } });
    check('off: nothing registered', off.errors.length === 0 && off.settingsFor('ntfy') === null);

    let reg = mk({ server: base });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('topic masked as missing', reg.settingsFor('ntfy').topic === 'missing');
    await M.emit(reg.mods, 'task.end', { task_id: 't1', code: 0, workdir: '/w' });
    check('no topic: no request sent', hits.length === 0);
    check('no topic: status says silent', /ntfy: no topic \(silent\)/.test(await status(reg)));
    check('no topic: nothing journaled (silent on purpose)', !J.readAll().records.some(r => r.type === 'ntfy_sent'));

    reg.updateSettings('ntfy', { topic: TOPIC }, { save: async () => {} });
    reg = mk({ server: base, app_url: 'http://127.0.0.1:7420/', include_title: true });
    check('topic shows configured, not the value', reg.settingsFor('ntfy').topic === 'configured' && !JSON.stringify(reg.settingsFor('ntfy')).includes(TOPIC));

    await M.emit(reg.mods, 'task.start', { task_id: 't1', request: 'fix the login page\nsecond line', workdir: '/w', resumed: false });
    await M.emit(reg.mods, 'task.end', { task_id: 't1', code: 0, workdir: '/w' });
    await settle();
    check('finished: one POST to /<topic>', hits.length === 1 && hits[0].method === 'POST' && hits[0].url === '/' + TOPIC, JSON.stringify(hits[0] && hits[0].url));
    check('finished: body is kind + id + title only', hits[0] && hits[0].body === 'Task finished: t1 (fix the login page)', hits[0] && hits[0].body);
    check('click link set from app_url', hits[0] && hits[0].headers.click === 'http://127.0.0.1:7420', hits[0] && hits[0].headers.click);
    check('topic not in body or headers', hits[0] && !hits[0].body.includes(TOPIC) && !JSON.stringify(hits[0].headers).includes(TOPIC));

    await M.emit(reg.mods, 'task.end', { task_id: 't2', code: 3, workdir: '/w' });
    await M.emit(reg.mods, 'task-watchdog.stalled', { task_id: 't3', reason: 'loop', detail: 'rm -rf /tmp/x', cancelled: false });
    await M.emit(reg.mods, 'card.created', { card_id: 'c1', task_id: 't4', summary: 'run curl http://x -H "Authorization: Bearer abc123"', rule: 'r', expires_at: 'x' });
    await M.emit(reg.mods, 'card.created', { card_id: 'c2', task_id: 'x y;rm', summary: 's' });
    await settle();
    check('blocked on non-zero exit', hits[1] && hits[1].body === 'Task blocked: t2 (exit 3)', hits[1] && hits[1].body);
    check('blocked on stall, detail not sent', hits[2] && hits[2].body === 'Task blocked: t3', hits[2] && hits[2].body);
    check('approval: only task id, no summary', hits[3] && hits[3].body === 'Approval waiting: t4', hits[3] && hits[3].body);
    check('task id with odd chars dropped', hits[4] && hits[4].body === 'Approval waiting', hits[4] && hits[4].body);

    const files = fs.readdirSync(STATE, { recursive: true }).map(f => path.join(STATE, String(f))).filter(f => fs.statSync(f).isFile() && !f.includes('secrets'));
    const journal = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    check('journal has ntfy_sent records without the topic', journal.includes('ntfy_sent') && !journal.includes(TOPIC));

    const n = hits.length;
    reg = mk({ server: base, kind_task_finished: false });
    await M.emit(reg.mods, 'task.end', { task_id: 't9', code: 0, workdir: '/w' });
    await settle();
    check('kind switch off: nothing sent', hits.length === n);

    mode = 'err';
    reg = mk({ server: base });
    const errs = await M.emit(reg.mods, 'task.end', { task_id: 't5', code: 0, workdir: '/w' });
    check('server 500: no error escapes', !errs || !errs.length, JSON.stringify(errs));
    mode = 'hang';
    const t0 = Date.now();
    reg = mk({ server: base, timeout_ms: 500 });
    await M.emit(reg.mods, 'task.end', { task_id: 't6', code: 0, workdir: '/w' });
    check('hanging server: cut off by timeout', Date.now() - t0 < 3000, String(Date.now() - t0));
    reg = mk({ server: 'http://127.0.0.1:1' });
    const errs2 = await M.emit(reg.mods, 'task.end', { task_id: 't7', code: 0, workdir: '/w' });
    check('refused connection: no error escapes', !errs2 || !errs2.length);
    const st1 = await status(reg);
    check('status names a failed last ping and why, not the topic', /last ping FAILED .*could not reach the server/.test(st1) && !st1.includes(TOPIC), st1);
    mode = 'ok';
    reg = mk({ server: base });
    await M.emit(reg.mods, 'task.end', { task_id: 't8', code: 0, workdir: '/w' });
    const st2 = await status(reg);
    check('status shows a good last ping', /ntfy: topic set; last ping sent .*\(task_finished\)/.test(st2), st2);

    reg = mk({ server: base, max_per_minute: 2 });
    let b = hits.length;
    for (let i = 0; i < 4; i++) await M.emit(reg.mods, 'card.created', { card_id: 'c' + i, task_id: 'a' + i, summary: 's' });
    await M.emit(reg.mods, 'task.end', { task_id: 'b1', code: 2, workdir: '/w' });
    await settle();
    check('priority pings (approval, blocked) pass the cap', hits.length - b === 5, String(hits.length - b));

    // fresh window: first two finished pings send, the next three are held; the following allowed send is coalesced
    sentReset();
    reg = mk({ server: base, max_per_minute: 2 });
    b = hits.length;
    for (let i = 1; i <= 5; i++) await M.emit(reg.mods, 'task.end', { task_id: 'f' + i, code: 0, workdir: '/w' });
    await settle();
    check('finished pings beyond the cap are held, not sent', hits.length - b === 2, String(hits.length - b));
    const st3 = await status(reg);
    check('held ping is journaled and status explains it', /last ping FAILED .*held and coalesced/.test(st3), st3);
    sentReset(true); // window frees; the held backlog stays
    await M.emit(reg.mods, 'task.end', { task_id: 'f6', code: 0, workdir: '/w' });
    await settle();
    check('next allowed send is one coalesced message with count and latest', hits.length - b === 3 && hits[hits.length - 1].body === '4 pings held, latest: finished f6', hits[hits.length - 1].body);
    await M.emit(reg.mods, 'task.end', { task_id: 'f7', code: 0, workdir: '/w' });
    await settle();
    check('counter reset after the summary', hits[hits.length - 1].body === 'Task finished: f7', hits[hits.length - 1].body);
    check('no message or header ever holds the topic', hits.every(h => !h.body.includes(TOPIC) && !JSON.stringify(h.headers).includes(TOPIC)));

    reg = mk({ server: 'ftp://x.example' });
    const n2 = hits.length;
    await M.emit(reg.mods, 'task.end', { task_id: 't10', code: 0, workdir: '/w' });
    const st4 = await status(reg);
    check('bad server: nothing sent, status says the server setting is wrong', hits.length === n2 && /ntfy: the "server" setting is not a plain http\(s\) URL/.test(st4), st4);
    check('bad server drop is journaled with why', J.readAll().records.some(r => r.type === 'ntfy_sent' && r.why === 'bad_server' && r.task_id === 't10'));

    check('topic in config is a load error', mk({ topic: 'abcd1234' }).errors.length >= 1);
    const api = mk({}).api('ntfy');
    check('non-http server refused', api.serverUrl('ftp://x') === null);
    check('serverUrl trims slash, refuses credentials', api.serverUrl('https://ntfy.sh/') === 'https://ntfy.sh' && api.serverUrl('https://u:p@x.example') === null);
    check('default server is https://ntfy.sh', mk({}).settingsFor('ntfy').server === 'https://ntfy.sh');
  } catch (e) {
    check('suite ran without throwing', false, e && e.stack);
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
