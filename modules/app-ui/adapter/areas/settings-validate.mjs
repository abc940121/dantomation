// Pure validators and merge for the app-ui settings routes (config and per-bot overrides). Our own file (MIT).
// Shared by the server (adapter/areas/settings.js) and tests; no I/O.
export const LANGUAGES = ['auto', 'en', 'zh-tw'];
export const APPEARANCES = ['system', 'light', 'dark'];
export const DEFAULT_CONFIG = Object.freeze({ language: 'auto', appearance: 'system', onboarded: false, profile: Object.freeze({}) });

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const hasControl = s => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);

/** The stored config with defaults filled in and anything invalid dropped. */
export function normalizeConfig(stored) {
  const s = isObj(stored) ? stored : {};
  const profile = {};
  if (isObj(s.profile) && typeof s.profile.displayName === 'string' && s.profile.displayName && s.profile.displayName.length <= 60 && !hasControl(s.profile.displayName)) profile.displayName = s.profile.displayName;
  return {
    language: LANGUAGES.includes(s.language) ? s.language : 'auto',
    appearance: APPEARANCES.includes(s.appearance) ? s.appearance : 'system',
    onboarded: s.onboarded === true,
    profile,
  };
}

/** Validate a partial config body and merge it over `current`. Returns {ok:true, config} or {ok:false, error}. */
export function mergeConfig(current, body) {
  if (!isObj(body)) return { ok: false, error: 'body must be an object' };
  const base = normalizeConfig(current);
  const next = { ...base, profile: { ...base.profile } };
  for (const key of Object.keys(body)) {
    const v = body[key];
    if (key === 'language') {
      if (!LANGUAGES.includes(v)) return { ok: false, error: 'language must be one of ' + LANGUAGES.join(', ') };
      next.language = v;
    } else if (key === 'appearance') {
      if (!APPEARANCES.includes(v)) return { ok: false, error: 'appearance must be one of ' + APPEARANCES.join(', ') };
      next.appearance = v;
    } else if (key === 'onboarded') {
      if (typeof v !== 'boolean') return { ok: false, error: 'onboarded must be a boolean' };
      next.onboarded = v;
    } else if (key === 'profile') {
      if (!isObj(v)) return { ok: false, error: 'profile must be an object' };
      for (const pk of Object.keys(v)) {
        if (pk !== 'displayName') return { ok: false, error: 'unknown profile key: ' + pk };
        const d = v.displayName;
        if (d === null || d === '') delete next.profile.displayName;
        else if (typeof d !== 'string' || d.length > 60 || hasControl(d)) return { ok: false, error: 'displayName must be at most 60 characters without control characters' };
        else next.profile.displayName = d;
      }
    } else {
      return { ok: false, error: 'unknown key: ' + key };
    }
  }
  return { ok: true, config: next };
}

/** Validate a bot settings body and merge it over the bot's current override. null clears a field. */
export function mergeBotOverride(current, body) {
  if (!isObj(body)) return { ok: false, error: 'body must be an object' };
  const next = isObj(current) ? { ...current } : {};
  for (const key of Object.keys(body)) {
    const v = body[key];
    if (key === 'name') {
      if (v === null) delete next.name;
      else if (typeof v !== 'string' || v.trim().length < 1 || v.length > 40 || hasControl(v)) return { ok: false, error: 'name must be 1 to 40 characters' };
      else next.name = v.trim();
    } else if (key === 'color') {
      if (v === null) delete next.color;
      else if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) return { ok: false, error: 'color must look like #rrggbb' };
      else next.color = v.toLowerCase();
    } else if (key === 'description') {
      if (v === null) delete next.description;
      else if (typeof v !== 'string' || v.length > 280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { ok: false, error: 'description must be at most 280 characters' };
      else if (v === '') delete next.description;
      else next.description = v;
    } else if (key === 'hidden') {
      if (v === null) delete next.hidden;
      else if (typeof v !== 'boolean') return { ok: false, error: 'hidden must be a boolean' };
      else if (v) next.hidden = true;
      else delete next.hidden;
    } else {
      return { ok: false, error: 'unknown key: ' + key };
    }
  }
  return { ok: true, override: next };
}

/** Engines list from a roster: [{id, name, available, botCount}], in first-seen order. */
export function synthesizeInstances(roster) {
  const out = new Map();
  for (const b of roster || []) {
    const id = String(b.engine || 'claude');
    const row = out.get(id) || { id, name: id, available: true, botCount: 0 };
    row.botCount += 1;
    out.set(id, row);
  }
  return [...out.values()];
}
