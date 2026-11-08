'use strict';
// Bot reply -> speakable text. Pure, no I/O, never throws.
//   toSpeakable(text)        one string: markdown/emoji gone, code -> short placeholder,
//                            paths and URLs shortened, every line ends in a full stop.
//                            '' for code-only or empty input.
//   splitSentences(text)     sentences/short blocks; splits on . ! ? and on 。！？… too.
//   speakableSentences(text) toSpeakable + splitSentences.
//   codePlaceholder(zh)      the spoken stand-in for a code block.

const MARK = '\u0001';           // a code block, until the language is known
const HAN = /\p{Script=Han}/u;
const WORD = /[\p{L}\p{N}]/u;
const hasWord = s => WORD.test(s);

function isZh(s) {
  let han = 0, lat = 0;
  for (const ch of s) { if (HAN.test(ch)) han++; else if (/[A-Za-z]/.test(ch)) lat++; }
  return han > 0 && han >= lat * 0.3;
}
const codePlaceholder = zh => (zh ? '（程式碼省略）。' : '(code omitted).');

// ---- URLs and paths
function domainOf(url) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([^/:?#\s]+)/i.exec(url);
  return m ? m[1].replace(/^www\./i, '') : '';
}
const URL_RE = /(?:\b(?:https?|ftp|wss?):\/\/|\bwww\.)[^\s<>()[\]"'`，。！？、；：）」』]+/gi;
function shortenUrls(s) {
  return s.replace(URL_RE, u => {
    const m = /[.,;:!?]+$/.exec(u);
    const tail = m ? m[0] : '';
    return (domainOf(m ? u.slice(0, -tail.length) : u) || ' ') + tail;
  });
}

const SEG = '[\\p{L}\\p{N}_.@+\\-]+';
const PATH_RE = new RegExp(
  '(?<![\\p{L}\\p{N}_.\\/\\\\:~@-])' +
  '((?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?)' +
  '((?:' + SEG + '[\\\\/])*' + SEG + '[\\\\/]?)', 'gu');
function shortenPaths(s) {
  return s.replace(PATH_RE, (all, prefix, rest) => {
    if (!prefix && !/[\\/]/.test(rest)) return all;
    const trail = /[.\-]+$/.exec(rest);
    const body = trail ? rest.slice(0, -trail[0].length) : rest;
    const segs = body.split(/[\\/]/).filter(Boolean);
    if (!segs.length || !/\p{L}/u.test(segs.join(''))) return all;
    const last = segs[segs.length - 1];
    if (!prefix) {
      const ext = /\.[A-Za-z0-9]{1,8}$/.test(last);
      if (!ext && !(segs.length >= 3 && segs.some(x => x.length >= 5))) return all;
    }
    return last + (trail ? trail[0] : '');
  });
}

// ---- emoji and decorative symbols
const DECOR = /[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣←-⇿⌀-⏿①-⓿─-➿⤀-⥿⬀-⯿•‣⁃●·★☆〰〽\u{1f000}-\u{1faff}]/gu;

// ---- markdown, line by line
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*(?:\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?|(?:[*_=]\s*){3,})\s*$/;
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

function cleanInline(s) {
  return s
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_(\S(?:.*?\S)?)_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(DECOR, ' ')
    .replace(/[*~#|<>{}[\]\\^]/g, ' ')
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function endLine(s) {
  if (!hasWord(s)) return '';
  s = s.replace(/[,，、;；:：\s]+$/, '');
  if (!s) return '';
  if (/[.!?。！？…]["'”’)）」』\]]*$/.test(s)) return s;
  return s + (HAN.test(s) ? '。' : '.');
}

function toSpeakable(input) {
  try {
    if (input === null || input === undefined) return '';
    let s = String(input).replace(/\r\n?/g, '\n');
    s = s.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, '\n' + MARK + '\n');
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = shortenUrls(s);
    s = s.replace(/`([^`\n]*)`/g, '$1');
    s = shortenPaths(s);
    const lines = s.split('\n');
    const out = [];
    let header = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.includes(MARK)) { if (out[out.length - 1] !== MARK) out.push(MARK); header = null; continue; }
      if (RULE.test(raw)) continue;
      let line = raw;
      if (TABLE_ROW.test(raw)) {
        const cs = cells(raw).map(cleanInline);
        const next = lines[i + 1], after = lines[i + 2];
        if (!header && next !== undefined && RULE.test(next) && /\|/.test(next)) {
          header = cs;
          if (!(after !== undefined && TABLE_ROW.test(after))) out.push(endLine(cs.filter(Boolean).join(', ')));
          continue;
        }
        line = cs.map((c, k) => (c && header && header[k] ? header[k] + ': ' + c : c)).filter(Boolean).join(', ');
        out.push(endLine(line));
        continue;
      }
      header = null;
      line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^(?:\s*>)+\s?/, '')
        .replace(/^\s*(?:[-*+•‣◦▪]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
      out.push(endLine(cleanInline(line)));
    }
    const kept = out.filter(Boolean);
    const speech = kept.filter(x => x !== MARK);
    if (!speech.length) return '';
    const ph = codePlaceholder(isZh(speech.join(' ')));
    return kept.map(x => (x === MARK ? ph : x)).join(' ');
  } catch {
    return '';
  }
}

// ---- sentence splitting
const ABBR = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|prof|st|vs|e\.g|i\.e)$/iu;
const CLOSERS = '"\'”’)）」』]';

function cut(s, maxLen) {
  const out = [];
  while (s.length > maxLen) {
    let at = -1;
    for (const ch of ',，、;；:： ') at = Math.max(at, s.lastIndexOf(ch, maxLen));
    if (at < maxLen * 0.3) at = maxLen - 1;
    out.push(s.slice(0, at + 1).trim());
    s = s.slice(at + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

function splitSentences(text, opts) {
  try {
    const maxLen = (opts && opts.maxLen) || 120;
    const s = String(text === null || text === undefined ? '' : text);
    const out = [];
    let start = 0, i = 0;
    const push = end => {
      const piece = s.slice(start, end).trim();
      start = end;
      if (hasWord(piece)) for (const c of cut(piece, maxLen)) if (hasWord(c)) out.push(c);
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\n') { push(i + 1); i++; continue; }
      if ('。！？….!?'.includes(ch)) {
        const cjk = '。！？…'.includes(ch);
        let j = i + 1;
        while (j < s.length && '。！？….!?'.includes(s[j])) j++;
        while (j < s.length && CLOSERS.includes(s[j])) j++;
        const nxt = s[j];
        const boundary = cjk || nxt === undefined || /\s/.test(nxt) || HAN.test(nxt);
        if (boundary && (cjk || !ABBR.test(s.slice(start, i)))) { push(j); i = j; continue; }
        i = j; continue;
      }
      i++;
    }
    push(s.length);
    return out;
  } catch {
    return [];
  }
}

const speakableSentences = (text, opts) => splitSentences(toSpeakable(text), opts);

module.exports = { toSpeakable, splitSentences, speakableSentences, codePlaceholder, isZh };
