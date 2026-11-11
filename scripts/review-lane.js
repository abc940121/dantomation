#!/usr/bin/env node
'use strict';
// Which review lane does a change belong to?
//   node scripts/review-lane.js <base> <head>
// Lists changed paths (git diff --name-only) that match docs/review-lanes.json.
// Exit 0 = push-then-review, 2 = review-first, 1 = usage or git error (fail closed:
// an error never looks like push-then-review).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// REVIEW_LANE_FILE overrides the lane file (used by the test to feed a broken one)
const LANE_FILE = process.env.REVIEW_LANE_FILE || path.join(ROOT, 'docs', 'review-lanes.json');

function loadLanes(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j || !Array.isArray(j.lanes)) throw new Error('lane file needs a "lanes" array');
  if (!Array.isArray(j.known_top) || !j.known_top.length || !j.known_top.every(x => typeof x === 'string' && x && !x.includes('/'))) throw new Error('lane file needs a non-empty "known_top" array of top-level names');
  const lanes = j.lanes.map((l, i) => {
    if (!l || typeof l.pattern !== 'string') throw new Error(`lane ${i}: "pattern" must be a string`);
    return { re: new RegExp(l.pattern), pattern: l.pattern, why: String(l.why || '') };
  });
  lanes.knownTop = j.known_top.slice();
  return lanes;
}

// pure: paths + lanes ([{pattern|re, why}], lanes.knownTop optional) -> [{path, why}] for the paths that are review-first.
// A path whose top-level entry is not in lanes.knownTop is review-first too ("unknown top-level path").
function classify(paths, lanes) {
  const hits = [];
  for (const raw of paths) {
    let matched = false;
    const p = String(raw).split('\\').join('/');
    for (const l of lanes) {
      const re = l.re || new RegExp(l.pattern);
      if (re.test(p)) { hits.push({ path: p, why: l.why || '' }); matched = true; break; }
    }
    if (!matched && lanes.knownTop && !lanes.knownTop.includes(p.split('/')[0])) hits.push({ path: p, why: 'unknown top-level path' });
  }
  return hits;
}

function main(argv) {
  if (argv.length !== 2) { console.error('usage: node scripts/review-lane.js <base> <head>'); return 1; }
  let lanes;
  try { lanes = loadLanes(LANE_FILE); } catch (e) { console.error(`review-lane: ${e.message}`); return 1; }
  const r = spawnSync('git', ['diff', '--name-only', argv[0], argv[1], '--'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) { console.error(`review-lane: git diff failed: ${(r.error && r.error.message) || String(r.stderr).trim()}`); return 1; }
  const paths = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const hits = classify(paths, lanes);
  for (const h of hits) console.log(`review-first ${h.path}  (${h.why})`);
  console.log(hits.length ? `lane: review-first (${hits.length} paths)` : 'lane: push-then-review');
  return hits.length ? 2 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { classify, loadLanes };
