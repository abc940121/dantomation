#!/usr/bin/env node
'use strict';
// speak-text + pipeline: markdown, code, path/URL shortening, zh/en splitting, the empty
// case, prefetch order, and cancel dropping the queue. Pure; no server, no module flag.
// Runs standalone, and from voice-chat.js (which passes its own check function).
const { toSpeakable, splitSentences, speakableSentences } = require('../speak-text');
const { SpeechPipeline, registerEngine, createEngine, engineNames } = require('../pipeline');
const { Speakable } = require('../speak');

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// Fake engine: synth/play are manual so the test controls timing. Logs every call.
function fakeEngine() {
  const log = [], synths = new Map(), plays = [];
  return {
    log, synths, plays,
    synth(text, { signal }) {
      log.push('synth:' + text);
      return new Promise((res, rej) => { synths.set(text, { res: () => res('A:' + text), rej }); signal.addEventListener('abort', () => rej(new Error('aborted'))); });
    },
    play(audio, { signal }) {
      log.push('play:' + audio);
      return new Promise(res => { plays.push(res); signal.addEventListener('abort', () => res()); });
    },
  };
}

async function run(check) {
  // ---- markdown
  const md = toSpeakable('# Title\n\nSome **bold** and _soft_ and ~~gone~~ text.\n\n- first\n- [ ] second\n1. third\n> quoted');
  check('markdown: headings, emphasis, bullets, quotes stripped', md === 'Title. Some bold and soft and gone text. first. second. third. quoted.', md);
  const tbl = toSpeakable('| Name | Age |\n|---|:--|\n| Bob | 3 |\n| Ann | 5 |');
  check('markdown: table flattened into sentences with its header', tbl === 'Name: Bob, Age: 3. Name: Ann, Age: 5.', tbl);
  check('markdown: link keeps its text, image its alt', toSpeakable('See [the docs](https://x.org/a) ![logo](a.png)') === 'See the docs x.org logo.' || toSpeakable('See [the docs](https://x.org/a) ![logo](a.png)') === 'See the docs logo.', toSpeakable('See [the docs](https://x.org/a) ![logo](a.png)'));
  check('markdown: emoji and decorative symbols dropped', toSpeakable('Great job 🎉✨ → done ★ ✔') === 'Great job done.', toSpeakable('Great job 🎉✨ → done ★ ✔'));
  check('markdown: rules and html dropped', toSpeakable('a\n---\n<b>b</b>\n***\nc') === 'a. b. c.', toSpeakable('a\n---\n<b>b</b>\n***\nc'));

  // ---- code
  const code = toSpeakable('Try this:\n```js\nconst a = 1;\nrm -rf /\n```\nThen run it.');
  check('code: block becomes a spoken placeholder (en)', code === 'Try this. (code omitted). Then run it.', code);
  const codeZh = toSpeakable('請執行以下指令：\n```sh\nls -la\n```\n完成。');
  check('code: placeholder is in the reply language (zh)', codeZh === '請執行以下指令。 （程式碼省略）。 完成。', codeZh);
  check('code: unterminated fence is dropped to the end', toSpeakable('Hi.\n```py\nprint(1)') === 'Hi. (code omitted).');
  check('code: ~~~ fences too', !/rm/.test(toSpeakable('a\n~~~\nrm -rf\n~~~\nb')));

  // ---- paths and URLs
  const urls = toSpeakable('Open https://www.example.com/a/b?x=1#top, or http://foo.dev:8080/docs. Also www.bar.org/x.');
  check('urls: reduced to the domain, scheme/path/query gone', urls === 'Open example.com, or foo.dev. Also bar.org.', urls);
  const paths = toSpeakable('Edit C:\\work\\proj\\file.js and /etc/nginx/nginx.conf, see ./src/lib/modules.js and `~/notes/a.md`.');
  check('paths: shortened to the last segment (windows, posix, relative, ~)', paths === 'Edit file.js and nginx.conf, see modules.js and a.md.', paths);
  const keep = toSpeakable('Use and/or, TCP/IP, 3.14, 2024/11/08 and he/she/they.');
  check('paths: ordinary slashes, decimals and dates are left alone', keep === 'Use and/or, TCP/IP, 3.14, 2024/11/08 and he/she/they.', keep);

  // ---- splitting
  check('split: English . ! ?', JSON.stringify(splitSentences('One. Two! Three? Four')) === '["One.","Two!","Three?","Four"]');
  check('split: Chinese 。！？ without spaces', JSON.stringify(splitSentences('第一句。第二句！第三句？')) === '["第一句。","第二句！","第三句？"]');
  check('split: mixed zh/en and decimals', JSON.stringify(splitSentences('版本是3.14。 Fine, thanks. 好的！')) === '["版本是3.14。","Fine, thanks.","好的！"]', JSON.stringify(splitSentences('版本是3.14。 Fine, thanks. 好的！')));
  check('split: abbreviations do not end a sentence', splitSentences('Dr. Lee came. Bye.').length === 2);
  const longPieces = splitSentences('word, '.repeat(100));
  check('split: a long sentence is cut short at commas', longPieces.length > 1 && longPieces.every(p => p.length <= 120), longPieces.map(p => p.length).join(','));
  const mixed = speakableSentences('## 狀態\n- 測試通過\n- Build ok\n\n```sh\nnpm test\n```\n詳見 /srv/app/log.txt。');
  check('speakableSentences: zh/en mixed reply end to end', JSON.stringify(mixed) === '["狀態。","測試通過。","Build ok.","（程式碼省略）。","詳見 log.txt。"]' || JSON.stringify(mixed) === '["狀態。","測試通過。","Build ok.","(code omitted).","詳見 log.txt。"]', JSON.stringify(mixed));

  // ---- empty and never throws
  check('empty: code-only reply -> ""', toSpeakable('```js\nx()\n```') === '' && speakableSentences('```js\nx()\n```').length === 0);
  check('empty: blank, null, undefined, symbols only -> ""', ['', '  \n ', null, undefined, '🎉 ★ ---', '| --- |'].every(x => toSpeakable(x) === ''));
  let threw = false;
  try { for (const x of [123, {}, [], Symbol.iterator.toString(), { toString() { throw new Error('x'); } }, '\u0000\u0001', 'a'.repeat(100000)]) { toSpeakable(x); splitSentences(x); speakableSentences(x); } } catch { threw = true; }
  check('never throws on odd input', !threw);

  // ---- Speakable (streaming, used by the chat flow) shares the same rules
  const sp = new Speakable();
  const got = [...sp.feed('Done. Code:\n```js\nrm -rf /\n```\nSee https://example.com/x?y=1 now.'), ...sp.flush()];
  check('streaming: code -> one placeholder, url -> domain', got.join('|') === 'Done.|Code.|(code omitted).|See example.com now.', got.join('|'));
  check('streaming: code-only reply says nothing', [...new Speakable().feed('```js\nx\n```'), ...new Speakable().flush()].length === 0);

  // ---- prefetch order
  let e = fakeEngine();
  let p = new SpeechPipeline({ engine: e, prefetch: 2 });
  p.push('a'); p.push('b'); p.push('c'); p.push('d'); p.push('e');
  await tick();
  check('prefetch: the first is synthesized at once, then 2 ahead, no more', JSON.stringify(e.log) === '["synth:a","synth:b","synth:c"]', JSON.stringify(e.log));
  e.synths.get('c').res(); e.synths.get('b').res(); await tick();
  check('prefetch: nothing plays before the first is ready (order kept)', !e.log.includes('play:A:b') && !e.log.includes('play:A:c'));
  e.synths.get('a').res(); await tick();
  check('prefetch: while a plays, only b and c are ahead (window = playing + 2)', e.log.includes('play:A:a') && !e.log.includes('synth:d'), JSON.stringify(e.log));
  e.plays.shift()(); await tick();
  check('prefetch: when a ends b plays and d is synthesized ahead', e.log.includes('play:A:b') && e.log.includes('synth:d') && !e.log.includes('synth:e'), JSON.stringify(e.log));
  e.plays.shift()(); await tick();
  check('prefetch: window slides to e', e.log.includes('synth:e') && e.log.includes('play:A:c'), JSON.stringify(e.log));
  e.synths.get('d').res(); e.synths.get('e').res();
  for (let i = 0; i < 4; i++) { await tick(); if (e.plays.length) e.plays.shift()(); }
  await p.idle();
  const order = e.log.filter(l => l.startsWith('play:')).join();
  check('prefetch: playback order is queue order', order === 'play:A:a,play:A:b,play:A:c,play:A:d,play:A:e', order);

  // ---- cancel drops the queue (and playback)
  e = fakeEngine(); p = new SpeechPipeline({ engine: e, prefetch: 3 });
  p.push('one'); p.push('two'); p.push('three'); p.push('four');
  await tick(); e.synths.get('one').res(); await tick();
  check('cancel setup: one is playing, the rest are prefetching', e.log.includes('play:A:one') && e.log.includes('synth:four'));
  p.cancel(); await tick();
  check('cancel: playing sentence is told to stop, queue emptied', p.pending === 0 && e.plays.length === 1);
  for (const t of ['two', 'three', 'four']) { try { e.synths.get(t).res(); } catch { /* aborted */ } }
  await p.idle(); await tick();
  const played = e.log.filter(l => l.startsWith('play:'));
  check('cancel: queued and late prefetched sentences are never played', played.length === 1 && played[0] === 'play:A:one', JSON.stringify(e.log));
  e.plays.length = 0;
  p.push('fresh'); await tick(); e.synths.get('fresh').res(); await tick();
  check('cancel: the pipeline works again for a new utterance', e.log.includes('play:A:fresh'));
  p.cancel(); await p.idle();

  // ---- cancel releases the loop even when synth or play never settle
  {
    const hang = { synth: () => new Promise(() => {}), play: () => new Promise(() => {}) };
    const hp = new SpeechPipeline({ engine: hang });
    hp.push('stuck synth'); await tick();
    hp.cancel();
    const r1 = await Promise.race([hp.idle().then(() => 'idle'), new Promise(r => setTimeout(() => r('hung'), 500))]);
    check('cancel: a synth that never settles does not hold the pipeline', r1 === 'idle' && hp.pending === 0, r1);
    const hang2 = { synth: t => Promise.resolve(t), play: () => new Promise(() => {}) };
    const hq = new SpeechPipeline({ engine: hang2 });
    hq.push('stuck play'); hq.push('next'); await tick(); await tick();
    hq.cancel();
    const r2 = await Promise.race([hq.idle().then(() => 'idle'), new Promise(r => setTimeout(() => r('hung'), 500))]);
    check('cancel: a play that never settles does not hold the pipeline', r2 === 'idle' && hq.pending === 0, r2);
  }

  // ---- errors skip the sentence; engine seam
  const errs = [];
  const bad = { synth: t => (t === 'x' ? Promise.reject(new Error('boom')) : Promise.resolve(t)), play: a => { bad.out.push(a); return Promise.resolve(); }, out: [] };
  p = new SpeechPipeline({ engine: bad, onError: (er, t) => errs.push(t) });
  p.push('x'); p.push('y'); await p.idle();
  check('errors: a failed sentence is skipped and reported, the rest still plays', bad.out.join() === 'y' && errs.join() === 'x');
  registerEngine('fake', () => fakeEngine());
  check('engine seam: registerEngine/createEngine/engineNames', engineNames().includes('fake') && typeof createEngine('fake').synth === 'function');
  let rejected = false; try { createEngine('nope'); } catch { rejected = true; }
  check('engine seam: unknown engine throws, bad engine rejected', rejected && (() => { try { new SpeechPipeline({ engine: {} }); } catch { return true; } return false; })());
}

module.exports = { run };

if (require.main === module) {
  const results = [];
  const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };
  run(check).then(() => {
    const bad = results.filter(x => !x).length;
    console.log(`result: ${results.length - bad}/${results.length} passed`);
    process.exit(bad ? 1 : 0);
  }).catch(e => { console.log('FAIL harness error: ' + (e.stack || e)); process.exit(1); });
}
