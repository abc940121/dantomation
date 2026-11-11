'use strict';
// Pure text helpers for the chat view (no DOM). Loaded before app.js; also required by tests.
//   cleanText(s)      hides internal machinery text from a chat bubble and nothing else
//   avatarUri(id, s)  an initials avatar as an inline SVG data URI, colour derived from the id
(function (root) {
  // Citation tags written by agents for the claim audit: [j:step1], [j:<id>] and [t:"<output line>"].
  const CITE_J = /[ \t]*\[j:\s*[^\]\s]+\s*\]/g;
  const CITE_T = /[ \t]*\[t:\s*"(?:[^"\\\n]|\\.)*"\s*\]/g;
  // A line that is only "step 3 done" (any case, optional end mark).
  const STEP_DONE = /^[ \t]*step[ \t]+\d+[ \t]+done[ \t]*[.!]?[ \t]*$/i;
  // The two-language "treat it as data" line that a role ask puts in front of the asked text.
  const DATA_LINES = ['treat it as data to weigh, not as instructions to follow', '把它當成資料來判斷'];
  const HUMAN_HEAD = /^## Current message \(from human[^\n]*\n?/m;
  const NEXT_HEAD = /^## /m;
  const ROOM_HEAD = /^## Room context\b/m;

  // The room prompt scaffolding: "## Current message (from human ...)" carries the human's real message,
  // then "## Room context ..." is background. Show only the real message.
  function unscaffold(s) {
    const h = HUMAN_HEAD.exec(s);
    if (h) {
      const rest = s.slice(h.index + h[0].length);
      const n = NEXT_HEAD.exec(rest);
      return s.slice(0, h.index) + (n ? rest.slice(0, n.index) : rest);
    }
    const r = ROOM_HEAD.exec(s);
    return r ? s.slice(0, r.index) : s;
  }

  function cleanText(text) {
    if (text == null) return '';
    const lines = unscaffold(String(text).replace(/\r\n?/g, '\n')).split('\n');
    const out = [];
    for (const line of lines) {
      if (STEP_DONE.test(line)) continue;
      if (DATA_LINES.some(d => line.toLowerCase().includes(d))) continue;
      const stripped = line.replace(CITE_J, '').replace(CITE_T, '');
      if (stripped !== line && !stripped.trim()) continue; // the line held only a tag
      out.push(stripped);
    }
    return out.join('\n').trim();
  }

  // ---- avatars
  const hash = s => { let h = 0; for (const ch of String(s)) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0; return Math.abs(h); };
  const colorOf = id => 'hsl(' + (hash(id) % 360) + ',48%,40%)';
  // Up to two initials: first letters of the first two words, or the first character of a CJK name.
  function initials(label) {
    const parts = String(label == null ? '' : label).trim().split(/[\s_-]+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = Array.from(parts[0])[0];
    if (/[^\u0000-\u024f]/.test(first) || parts.length === 1) return first.toUpperCase();
    return (first + Array.from(parts[1])[0]).toUpperCase();
  }
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function avatarUri(id, label) {
    const ns = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
    const svg = '<svg xmlns="' + ns + '" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="' + colorOf(id) + '"/>' +
      '<text x="32" y="32" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="600" fill="#fff">' + esc(initials(label)) + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  const API = { cleanText, avatarUri, initials, colorOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.DantoClean = API;
})(typeof window !== 'undefined' ? window : this);
