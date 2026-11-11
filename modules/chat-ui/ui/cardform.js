'use strict';
// Role card form logic (pure, no DOM): turns the server's card view into form rows and an edit back into a patch.
// The field list comes from the server (GET /m/roles/cards/<id>), so a new field needs no change here.
(function (root) {
  const ROLE_RE = /^r-[0-9a-f]{8}$/;
  const isRole = id => typeof id === 'string' && ROLE_RE.test(id);

  // view: { fields: [{key, type, max?, label?, description?, known}], card: {key: value} } -> rows for the form.
  function rows(view) {
    const card = view && view.card && typeof view.card === 'object' ? view.card : {};
    const out = [];
    for (const f of (view && Array.isArray(view.fields) ? view.fields : [])) {
      if (!f || typeof f.key !== 'string') continue;
      const v = card[f.key];
      let value = '';
      if (f.type === 'text') value = typeof v === 'string' ? v : '';
      else if (f.type === 'json') { try { value = v === undefined ? '' : (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 1)); } catch (e) { value = ''; } }
      out.push({ key: f.key, type: f.type === 'image' || f.type === 'json' ? f.type : 'text', max: f.max || 0, label: f.label || '', description: f.description || '', known: !!f.known, value });
    }
    return out;
  }

  // edited: { key: text }. Only changed, editable rows go into the patch. '' clears a field.
  // Returns { patch } or { error: key } when a JSON field does not parse.
  function patch(rowList, edited) {
    const out = {};
    for (const r of rowList) {
      if (r.type === 'image' || !edited || typeof edited[r.key] !== 'string') continue;
      const raw = edited[r.key];
      if (raw.trim() === r.value.trim()) continue;
      if (raw.trim() === '') { out[r.key] = null; continue; }
      if (r.type === 'text') { out[r.key] = raw.trim(); continue; }
      try { out[r.key] = JSON.parse(raw); } catch (e) { return { error: r.key }; }
    }
    return { patch: out };
  }

  const API = { isRole, rows, patch };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.DantoCardForm = API;
})(typeof window !== 'undefined' ? window : globalThis);
