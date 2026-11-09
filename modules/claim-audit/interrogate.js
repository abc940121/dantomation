'use strict';
// Interrogate review: pure question generation plus a small store.
// A flagged or high-stakes claim gets short evidence questions ("which line shows X?").
// Answers are checked with the same citation rules as the report itself.
const fs = require('fs');
const path = require('path');

const MAX_QUESTIONS = 3;
const { CITE_ANY } = require('./audit');
const strip = s => String(s || '').replace(CITE_ANY, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length > n ? s.slice(0, n - 3) + '...' : s;

const DEFAULT_STAKES = ['deploy', 'production', 'migrat', 'delete', 'drop table', 'security', 'payment', 'release', 'push', 'merge',
  '部署', '上線', '上线', '刪除', '删除', '付款', '安全', '發布', '发布'];

const isHighStakes = (text, words) => {
  const t = String(text || '').toLowerCase();
  return (words || DEFAULT_STAKES).some(w => w && t.includes(String(w).toLowerCase()));
};

// Which claims get asked about: every unverified one first, then verified high-stakes ones.
function pickClaims(claims, words) {
  const flagged = claims.filter(c => !c.verified).map(c => ({ ...c, why: 'flagged' }));
  const stakes = claims.filter(c => c.verified && isHighStakes(c.text, words)).map(c => ({ ...c, why: 'high-stakes' }));
  return flagged.concat(stakes);
}

// -> [{ n, why, claim, q }] at most MAX_QUESTIONS. The first round asks one question per
// claim; if there are fewer claims than questions the rest are follow-ups on the first claims.
function makeQuestions(claims, words) {
  const picked = pickClaims(claims || [], words);
  if (!picked.length) return [];
  const follow = [
    c => `Which command output line shows the result for "${clip(strip(c.text), 80)}"?`,
    c => `Which journal line shows the change behind "${clip(strip(c.text), 80)}"?`,
  ];
  const out = [];
  for (const c of picked) {
    if (out.length >= MAX_QUESTIONS) break;
    out.push({ c, q: `Which line shows that "${clip(strip(c.text), 100)}"?` });
  }
  for (let i = 0; out.length < MAX_QUESTIONS && i < MAX_QUESTIONS * follow.length; i++) {
    const c = picked[i % picked.length], f = follow[Math.floor(i / picked.length)];
    if (!f) break;
    out.push({ c, q: f(c) });
  }
  return out.slice(0, MAX_QUESTIONS).map((x, i) => ({ n: i + 1, why: x.c.why, claim: clip(strip(x.c.text), 200), q: x.q }));
}

// Store: state/m/claim-audit/interrogations.jsonl, one JSON object per line, latest per task wins.
const file = dir => path.join(dir, 'interrogations.jsonl');
function save(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file(dir), JSON.stringify(rec) + '\n');
}
function load(dir, taskId) {
  let raw = '';
  try { raw = fs.readFileSync(file(dir), 'utf8'); } catch { return null; }
  let last = null;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.task_id === taskId) last = r;
  }
  return last;
}

module.exports = { makeQuestions, pickClaims, isHighStakes, save, load, DEFAULT_STAKES, MAX_QUESTIONS };
