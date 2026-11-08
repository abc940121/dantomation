'use strict';
// parseAnswer(text) -> 'yes' | 'no' | 'unclear'. Strict on purpose: only a closed
// list of clear standalone words counts. The whole text (after dropping
// punctuation) must be made of those words, so any extra word, hedge, question,
// mixed yes/no or unknown character gives 'unclear', and 'unclear' never approves.
// Pure function, no I/O: the voice entry (M4) calls it too.

const YES_LATIN = ['yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'okey', 'approve', 'approved', 'confirm', 'confirmed', 'agree', 'agreed', 'accept', 'goahead', 'doit'];
const NO_LATIN = ['no', 'n', 'nope', 'nah', 'deny', 'denied', 'reject', 'rejected', 'stop', 'cancel', 'cancelled', 'canceled', 'never', 'refuse', 'abort', 'dont', 'donot'];
const FILL_LATIN = ['please', 'pls', 'thanks', 'thankyou'];
const YES_CJK = ['是的', '是', '好的', '好', '可以的', '可以', '確定', '确定', '同意', '批准', '沒問題', '没问题', '行', '對', '对'];
const NO_CJK = ['不要', '不用', '不行', '不可以', '不同意', '不好', '不', '否', '取消', '拒絕', '拒绝', '停止', '停', '別', '别', '算了'];
const FILL_CJK = ['謝謝', '谢谢', '請', '请', '啊', '啦', '喔', '哦', '呀'];

const fold = w => w.replace(/(.)\1+/g, '$1'); // yess, nooo, okk -> same word
const latin = (list, kind) => list.map(w => [fold(w), kind]);
const LATIN = new Map([...latin(YES_LATIN, 'y'), ...latin(NO_LATIN, 'n'), ...latin(FILL_LATIN, 'f')]);
const CJK = [...YES_CJK.map(w => [w, 'y']), ...NO_CJK.map(w => [w, 'n']), ...FILL_CJK.map(w => [w, 'f'])].sort((a, b) => b[0].length - a[0].length);

function parseAnswer(text) {
  if (typeof text !== 'string') return 'unclear';
  let s = text.normalize('NFKC').toLowerCase().trim();
  if (!s || s.length > 40) return 'unclear';
  if (/[?？]/.test(s) || /\p{Extended_Pictographic}/u.test(s)) return 'unclear';
  s = s.replace(/['’`]/g, '')
    .replace(/\bgo ahead\b/g, 'goahead').replace(/\bdo it\b/g, 'doit').replace(/\bdo not\b/g, 'donot').replace(/\bthank you\b/g, 'thankyou');
  const toks = s.match(/[a-z]+|[㐀-䶿一-鿿豈-﫿]+|[\p{L}\p{N}]+/gu) || [];
  let yes = false, no = false;
  for (const t of toks) {
    if (/^[a-z]+$/.test(t)) {
      const k = LATIN.get(fold(t));
      if (!k) return 'unclear';
      if (k === 'y') yes = true; else if (k === 'n') no = true;
    } else if (/^[㐀-鿿豈-﫿]+$/.test(t)) {
      for (let i = 0; i < t.length;) {
        const hit = CJK.find(([w]) => t.startsWith(w, i));
        if (!hit) return 'unclear';
        if (hit[1] === 'y') yes = true; else if (hit[1] === 'n') no = true;
        i += hit[0].length;
      }
    } else return 'unclear'; // digits, other scripts
  }
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return 'unclear';
}

module.exports = { parseAnswer };
