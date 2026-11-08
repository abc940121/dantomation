'use strict';
// claim-audit core: a pure function, no I/O.
//   auditReport(reportText, evidence) -> { claims: [{ text, cited, verified, reason }], flagged }
// evidence = { records: [journal records of the task], outputs: [{ text, command?, exit? }], files?: [names] }
// A claim is a sentence that asserts completion or verification. It is verified
// only when every citation in it points at evidence that exists and does not
// contradict the claim. Citation forms:
//   [j:<effect_id | journal id | stepN>]   a journal record of this task
//   [t:"<exact output line>"]              a line inside a recorded command output

const CITE_J = /\[j:\s*([^\]\s]+)\s*\]/g;
const CITE_T = /\[t:\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
const CITE_ANY = /\[j:\s*[^\]\s]+\s*\]|\[t:\s*"(?:[^"\\]|\\.)*"\s*\]/g;

const CLAIM_EN = /\b(done|completed?|finished|fixed|resolved|implemented|tested|pass|passes|passed|passing|verified|confirmed|works|succe(?:ss|eds|eded|ssful(?:ly)?)|all green|green)\b/i;
const CLAIM_ZH = /(完成|修好|修復|修复|修正|已修|測試通過|测试通过|測試過|测试过|驗證過|验证过|驗證通過|验证通过|通過|通过|沒問題|没问题|正常運作|正常运作|成功|搞定|解決了|已解決|解决了|已解决|全綠|全绿)/;

// Sentences about the future, a negative, a failure or a question are not claims.
// "0 failed", "no failures" and "without failures" are not failure talk.
const NOT_EN = /\b(not|never|no longer|isn't|aren't|wasn't|weren't|didn't|doesn't|don't|won't|can't|cannot|couldn't|hasn't|haven't|unable|yet|will|would|should|could|might|may|going to|plan to|about to|need to|needs to|todo|to-do|let me|i'll|if|next)\b|(?<!\b(?:0|zero|no|without) )\b(failed|fails|failures?)\b/i;
const NOT_ZH = /(還沒|还没|尚未|未(?!有問題|有问题)|沒有(?!問題|问题|錯誤|错误|失敗|失败|異常|异常)|没有(?!問題|问题|錯誤|错误|失敗|失败|異常|异常)|沒(?!問題|问题|有|錯|错)|没(?!問題|问题|有|错)|不(?!錯|错)|無法|无法|失敗|失败|將|将|會|会|打算|需要|待|之後|之后|應該|应该|可能|是否|嗎|吗)/;

// Evidence that contradicts a "passes" claim.
const BAD_LINE = /\bFAIL(?:ED|URE|URES)?\b|\bnot ok\b|[✗✖]|\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\bfailed:\s*[1-9]|\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[:=]?\s*[1-9]\d*\b|\bExit code [1-9]|\bError:|\b(?:Type|Assertion|Syntax|Reference)Error\b/;
const PARTIAL = /\b(\d+)\s*\/\s*(\d+)\s+(?:tests?\s+)?(?:pass|passed|passing|ok)\b/gi;
const FRACTION = /\b(\d+)\s*\/\s*(\d+)\b/g;
const FILE_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)*\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|txt|py|sh|css|html|yml|yaml|toml|c|cpp|h|go|rs|java|rb|sql)\b/gi;

const norm = s => String(s).replace(/\s+/g, ' ').trim();
const unesc = s => s.replace(/\\(["\\])/g, '$1');
const slash = s => String(s).replace(/\\/g, '/');

function splitSentences(text) {
  const cites = [];
  const masked = String(text).replace(CITE_ANY, m => { cites.push(m); return `\u0001${cites.length - 1}\u0001`; });
  const parts = masked.split(/(?<=[.!?。！？])\s+|(?<=[。！？])|\n+/)
    .map(s => s.replace(/^\s*(?:[-*>#]+|\d+[.)])\s+/, '').trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    // A piece that is only citations belongs to the sentence before it.
    if (out.length && /^(?:\u0001\d+\u0001[\s.,;。，；]*)+$/.test(p)) { out[out.length - 1] += ' ' + p; continue; }
    out.push(p);
  }
  return out.map(s => s.replace(/\u0001(\d+)\u0001/g, (_, i) => cites[Number(i)]));
}

function isClaim(sentence) {
  const s = sentence.replace(CITE_ANY, ' ');
  if (/[?？]\s*$/.test(s.trim())) return false;
  if (!CLAIM_EN.test(s) && !CLAIM_ZH.test(s)) return false;
  return !NOT_EN.test(s) && !NOT_ZH.test(s);
}

function resolveJournal(ref, ev) {
  const recs = ev.records || [];
  const r = String(ref);
  const step = /^step[-_ ]?(\d+)$/i.exec(r);
  if (step) {
    const hit = recs.filter(x => x.type === 'step' && Number(x.step) === Number(step[1]));
    if (!hit.length) return { ok: false, reason: `journal step ${step[1]} not found` };
    if (!hit.some(x => x.status === 'done')) return { ok: false, reason: `journal step ${step[1]} is not done` };
    return { ok: true };
  }
  const byEffect = recs.filter(x => x.effect_id === r);
  if (byEffect.length) {
    if (byEffect.some(x => x.type === 'effect_uncertain')) return { ok: false, reason: `cited effect ${r} is UNCERTAIN in the journal` };
    if (!byEffect.some(x => x.type === 'effect_done')) return { ok: false, reason: `cited effect ${r} has no done record` };
    return { ok: true };
  }
  if (recs.some(x => x.id === r)) return { ok: true };
  return { ok: false, reason: `journal id ${r} not found` };
}

function checkQuote(quote, claimText, ev) {
  const q = norm(unesc(quote));
  if (q.length < 3) return { ok: false, reason: 'quote too short to check' };
  const hits = (ev.outputs || []).filter(o => norm(o.text || '').includes(q));
  if (!hits.length) return { ok: false, reason: `quote not found in any recorded output: "${q.slice(0, 60)}"` };
  let why = null;
  for (const o of hits) {
    why = null;
    if (BAD_LINE.test(q)) why = `cited line shows a failure: "${q.slice(0, 60)}"`;
    else if ([...q.matchAll(PARTIAL)].some(m => Number(m[1]) < Number(m[2]))) why = `cited line shows a partial pass: "${q.slice(0, 60)}"`;
    else if (o.exit !== undefined && o.exit !== null && Number(o.exit) !== 0) why = `cited output exited with code ${o.exit}`;
    if (!why) break;
  }
  if (why) return { ok: false, reason: why };
  const qf = [...q.matchAll(FRACTION)].map(m => `${m[1]}/${m[2]}`);
  const cf = [...claimText.replace(CITE_ANY, ' ').matchAll(FRACTION)].map(m => `${m[1]}/${m[2]}`);
  const off = cf.find(f => !qf.includes(f));
  if (qf.length && off) return { ok: false, reason: `claim says ${off} but the cited line shows ${qf.join(', ')}` };
  return { ok: true };
}

// Does any evidence mention this file name (an effect target, a command, an output)?
function knownFile(tok, ev) {
  const t = slash(tok).replace(/^\.\//, '');
  const base = t.split('/').pop();
  for (const f of ev.files || []) { const g = slash(f); if (g === t || g.endsWith('/' + t) || (!t.includes('/') && g.split('/').pop() === base)) return true; }
  for (const r of ev.records || []) if (r.target) { const g = slash(r.target); if (g === t || g.endsWith('/' + t) || (!t.includes('/') && g.split('/').pop() === base)) return true; }
  for (const o of ev.outputs || []) if (slash((o.text || '') + ' ' + (o.command || '')).includes(t)) return true;
  return false;
}

function auditReport(reportText, evidence) {
  const ev = evidence || {};
  const claims = [];
  for (const sentence of splitSentences(reportText == null ? '' : reportText)) {
    if (!isClaim(sentence)) continue;
    const text = sentence.replace(/\s+/g, ' ').trim();
    const refs = [...sentence.matchAll(CITE_J)].map(m => ['j', m[1]]).concat([...sentence.matchAll(CITE_T)].map(m => ['t', m[1]]));
    const c = { text, cited: refs.length > 0, verified: false, reason: '' };
    claims.push(c);
    if (!refs.length) { c.reason = 'no citation'; continue; }
    const bad = [];
    for (const [kind, v] of refs) {
      const r = kind === 'j' ? resolveJournal(v, ev) : checkQuote(v, sentence, ev);
      if (!r.ok) bad.push(r.reason);
    }
    if (!bad.length) {
      const miss = [...new Set(sentence.replace(CITE_ANY, ' ').match(FILE_TOKEN) || [])].filter(f => !knownFile(f, ev));
      if (miss.length) bad.push(`names a file with no evidence of it: ${miss.join(', ')}`);
    }
    if (bad.length) c.reason = bad.join('; ');
    else { c.verified = true; c.reason = 'citation matches evidence'; }
  }
  return { claims, flagged: claims.filter(c => !c.verified).length };
}

module.exports = { auditReport, splitSentences, isClaim };
