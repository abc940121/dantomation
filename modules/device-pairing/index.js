'use strict';
// device-pairing: a phone gets its own revocable token instead of the owner token.
// Off by default. The owner mints a one-time code (CLI or owner-only route); the phone
// swaps it for a per-device token that only works on a short route allowlist.
const S = require('./store');

const byDevice = ctx => String((ctx.actor && ctx.actor.id) || '').startsWith('device:');
const deny = { status: 403, json: { error: 'forbidden' } };
const body = ctx => (ctx.body && typeof ctx.body === 'object' ? ctx.body : {});

// ---- command: taskmote device <pair|list|revoke <id>> (old spellings: pair, devices, revoke)
const DEVICE_USAGE = 'usage: taskmote device pair | device list | device revoke <id>';
async function pair() {
  const m = S.mintCode();
  console.log(`Pairing code (valid 2 minutes, single use): ${m.short}`);
  console.log(`Link fragment for the QR: #p=${m.code}`);
  console.log('Open <server address>/m/app-ui/ui/#p=<code> (or /m/chat-ui/ui/) in the browser or on the phone, or type the six digits into the page.');
  return { handled: true, code: 0 };
}
async function list() {
  const l = S.list();
  if (!l.length) console.log('no paired devices');
  // A home-screen app (a device with a parent) is listed right after its parent and marked, so it can be seen and revoked.
  const ids = new Set(l.map(d => d.id)), kids = {};
  for (const d of l) if (d.parent && ids.has(d.parent)) (kids[d.parent] = kids[d.parent] || []).push(d);
  const ordered = [];
  for (const d of l) if (!(d.parent && ids.has(d.parent))) ordered.push(d, ...(kids[d.id] || []));
  for (const d of ordered) console.log(`${d.id}  ${d.revoked ? 'revoked' : d.expired ? 'expired' : 'active '}  ${d.label}  created ${d.created}  last seen ${d.lastSeen || 'never'}${d.parent ? `  home-screen app of ${d.parent}` : ''}`);
  return { handled: true, code: 0 };
}
async function revoke(args) {
  const ok = S.revoke(args[0]);
  console.log(ok ? `revoked ${args[0]}` : `no such device: ${args[0] || '(give a device id)'}`);
  return { handled: true, code: ok ? 0 : 1 };
}
async function device(args) {
  const [sub, ...a] = args;
  if (sub === 'pair' && !a.length) return pair();
  if (sub === 'list' && !a.length) return list();
  if (sub === 'revoke' && a.length === 1) return revoke(a);
  console.error(DEVICE_USAGE);
  return { handled: true, code: 2 };
}

module.exports = {
  contract: 2,
  name: 'device-pairing',
  description: 'One-time pairing codes and per-device tokens for phones, with a deny-by-default route allowlist.',
  runsOn: 'main',
  routes: [
    { method: 'POST', path: '/mint', description: 'owner: mint a pairing code {code, short, expiresAt}',
      handler: ctx => (byDevice(ctx) ? deny : { status: 200, json: S.mintCode() }) },
    { method: 'GET', path: '/devices', description: 'owner: list devices (never the token or its hash)',
      handler: ctx => (byDevice(ctx) ? deny : { status: 200, json: S.list() }) },
    { method: 'POST', path: '/devices/:id/revoke', description: 'owner: revoke one device',
      handler: ctx => (byDevice(ctx) ? deny : S.revoke(ctx.params.id) ? { status: 200, json: { revoked: ctx.params.id } } : { status: 404, json: { error: 'no such device' } }) },
    { method: 'POST', path: '/redeem', access: 'public-post', description: 'phone: swap a pairing code {code, label} for a device token',
      handler: ctx => { const b = body(ctx), r = S.redeem(b.code, b.label); return r.ok ? { status: 200, json: { token: r.token, id: r.id, label: r.label } } : { status: r.status, json: { error: r.error } }; } },
    { method: 'POST', path: '/handoff', description: 'paired device or owner: mint one 10-minute pairing code {code, expiresAt} to carry into the home-screen app (5 an hour per device; a device made from a handoff cannot ask)',
      handler: ctx => {
        if (!ctx.actor || ctx.actor.kind !== 'owner') return deny; // fail closed: only a paired device or the owner
        const r = S.mintHandoff(byDevice(ctx) ? String(ctx.actor.id).slice(7) : null);
        return r.ok ? { status: 200, json: { code: r.code, expiresAt: r.expiresAt } } : { status: r.status, json: { error: r.error } };
      } },
  ],
  commands: { device, pair, devices: list, revoke },
  api: { authenticate: S.authenticate, allows: S.allows, audit: S.audit },
};
