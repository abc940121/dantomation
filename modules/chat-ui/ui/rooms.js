'use strict';
// Pure helpers for the room picker (no DOM). Loaded before app.js; also required by tests.
(function (root) {
  const BASE = '/m/rooms/rooms';
  const R = {
    BASE,
    listPath: () => BASE,
    messagesPath: (id, since) => BASE + '/' + encodeURIComponent(id) + '/messages' + (since ? '?since=' + encodeURIComponent(since) : ''),
    sayPath: id => BASE + '/' + encodeURIComponent(id) + '/say',
    // The module is on only when the list call succeeds with a rooms array; anything else hides the picker.
    parseRooms(resp) {
      if (!resp || !resp.ok || !resp.body || !Array.isArray(resp.body.rooms)) return [];
      return resp.body.rooms.filter(r => r && typeof r.id === 'string').map(r => ({ id: r.id, name: typeof r.name === 'string' && r.name ? r.name : r.id, members: Array.isArray(r.members) ? r.members.length : 0 }));
    },
    listOk: resp => !!(resp && resp.ok && resp.body && Array.isArray(resp.body.rooms)),
    // Merge new transcript lines into the list by id (duplicates dropped, order kept).
    merge(list, incoming) {
      const seen = new Set(list.map(m => m.id)), out = list.slice();
      for (const m of Array.isArray(incoming) ? incoming : []) if (m && m.id != null && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
      return out;
    },
    // ?room=<id> in a page query string; null when absent. withRoom returns the query string with room set or removed.
    roomFromSearch(search) { const v = new URLSearchParams(search || '').get('room'); return v ? v : null; },
    withRoom(search, id) { const p = new URLSearchParams(search || ''); if (id) p.set('room', id); else p.delete('room'); const s = p.toString(); return s ? '?' + s : ''; },
    lastId: list => (list.length ? list[list.length - 1].id : null),
    label: m => String((m && (m.label || m.speaker)) || '?'),
    sayBody: text => { const t = String(text == null ? '' : text).trim(); return t ? { text: t } : null; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = R; else root.DantoRooms = R;
})(typeof window !== 'undefined' ? window : this);
