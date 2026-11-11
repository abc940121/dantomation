'use strict';
// One text clip shared by every place that shows a call to the owner (hook card, prompt-tool card, /api/cards).
// clipMid: collapse whitespace; over n characters keep the head and the tail with '...' between (n total), so both the
// start and the end of a long value (a file name, the last argument) stay visible.
const clipMid = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const t = Math.floor((n - 3) / 2), h = n - 3 - t; return s.slice(0, h) + '...' + s.slice(s.length - t); };
// Fixed caps (characters) for what the owner sees of one call: a 1 MB argument cannot bloat a card, the journal summary or the API.
const ARGS_CAP = 1200, SUMMARY_CAP = 1600, INPUT_CAP = 2400;
module.exports = { clipMid, ARGS_CAP, SUMMARY_CAP, INPUT_CAP };
