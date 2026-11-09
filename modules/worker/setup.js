#!/usr/bin/env node
'use strict';
// One-time setup helper for the worker machine. Changes nothing except the token file.
//   node modules/worker/setup.js token [--force] [--set <token>]   make (or store) the token, owner-only
//   node modules/worker/setup.js check --server http://<host>:7420  test reachability and the token
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// One resolver for `token` and `check`, same order as the worker: config worker.token_file, then the env var, then the default.
// A missing config is fine; an unreadable or malformed one is an error (no detail printed: it could echo file text).
function resolveTokenFile() {
  const C = require('../../lib/config');
  let w;
  try { w = C.load().worker; } catch { return { error: `The config file ${C.file()} cannot be read or is not valid JSON; the worker would not start either. Fix it first.` }; }
  if (w && typeof w.token_file === 'string' && w.token_file) return { file: path.resolve(w.token_file), fromConfig: true };
  return { file: tokenFile(), fromConfig: false };
}
const tokenFile = () => process.env.HARNESS_WORKER_TOKEN_FILE || path.join(os.homedir(), '.harness', 'worker-token');

// Owner-only: Windows -> icacls, current user only, no inheritance; others -> chmod 600.
function lockDown(file) {
  if (process.platform === 'win32') {
    const who = `${process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : ''}${os.userInfo().username}`;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], { stdio: 'ignore', windowsHide: true });
    return `Windows access list set so only ${who} can read it (icacls)`;
  }
  fs.chmodSync(file, 0o600);
  return 'file mode 600 (only you can read it)';
}

function cmdToken(args) {
  const R = resolveTokenFile();
  if (R.error) { console.error(R.error); return 1; }
  const file = R.file;
  const force = args.includes('--force');
  const si = args.indexOf('--set');
  const given = si >= 0 ? args[si + 1] : null;
  if (si >= 0 && !/^[A-Za-z0-9_-]{16,}$/.test(given || '')) { console.error('--set needs the token text (16+ letters, digits, - or _).'); return 2; }
  if (fs.existsSync(file) && !force) {
    console.error(`A token already exists at ${file}. Nothing was changed.\nTo replace it (the old one stops working everywhere), run again with --force.`);
    return 1;
  }
  const token = given || crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.rmSync(file);
  fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  let how;
  try { how = lockDown(file); } catch (e) { fs.rmSync(file, { force: true }); console.error(`Could not make the token file owner-only (${e.message.split('\n')[0]}). It was removed. Nothing was kept.`); return 1; }
  console.log(`Token file written: ${file}\nProtection: ${how}.`);
  if (given) console.log('This is the token you supplied; it is not printed again.');
  else console.log(`\nYour worker token (shown ONCE; it is not printed again):\n\n    ${token}\n\nCopy it to the main server now. Whoever has it can send jobs to this machine's worker, so do not paste it in chat or a URL.`);
  console.log(`\nNext steps:
  1. Put the token on the main server (S1): "dantomation token new" makes the server's token; if the server
     has one already, run  node modules/worker/setup.js token --force --set <server token>  here instead.
  2. In this machine's config (${require('../../lib/config').file()}) add:
       "modules": { "worker": true },
       "worker": { "server": "http://<server-host>:7420", "work_dir": "D:\\\\worker-files" }
  3. Check the link:   node modules/worker/setup.js check --server http://<server-host>:7420
  4. Start it:         node modules/worker/worker.js
  Windows Firewall: nothing to open here. The worker only connects out. The SERVER's firewall must allow inbound TCP 7420 from this machine.`);
  return 0;
}

function get(url, token) {
  return new Promise(resolve => {
    const req = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname, port: url.port || undefined, path: '/api/bots', method: 'GET', timeout: 8000,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', e => resolve({ error: e.code || e.message }));
    req.end();
  });
}

async function cmdCheck(args) {
  const i = args.indexOf('--server');
  const server = i >= 0 ? args[i + 1] : null;
  if (!server) { console.error('usage: node modules/worker/setup.js check --server http://<server-host>:7420'); return 2; }
  let url;
  try { url = new URL(server); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { console.error(`"${server}" is not a URL like http://192.0.2.10:7420`); return 2; }
  const R = resolveTokenFile();
  if (R.error) { console.error(R.error); return 1; }
  const file = R.file, cfgFile = R.fromConfig;
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    if (e.code === 'ENOENT') console.error(`No token at ${file}${cfgFile ? ' (set by worker.token_file in the config)' : ''}. Run first:  node modules/worker/setup.js token`);
    else console.error(`Cannot read the token file ${file} (${e.code || 'error'}).`);
    return 1;
  }
  if (!token) { console.error(`The token file ${file} is empty. Run:  node modules/worker/setup.js token --force`); return 1; }
  const r = await get(url, token);
  if (r.error) {
    console.error(`CANNOT REACH ${url.origin} (${r.error}).\n  - Is the server running (node bin/dantomation.js serve)?\n  - Is it set to listen on the LAN (config server.host), not only 127.0.0.1?\n  - Does the server's firewall allow inbound TCP ${url.port || 80} from this machine?`);
    return 1;
  }
  if (r.status === 401 || r.status === 403) { console.error(`The server at ${url.origin} answered but REFUSED the token (HTTP ${r.status}). The token here and on the server differ; see the "token" step.`); return 1; }
  if (r.status >= 200 && r.status < 300) { console.log(`OK: ${url.origin} is reachable and accepted the token.`); return 0; }
  console.error(`The server answered HTTP ${r.status}, which was not expected. Is that really the dantomation server?`);
  return 1;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'token') process.exit(cmdToken(rest));
  else if (cmd === 'check') process.exit(await cmdCheck(rest));
  else { console.error('usage:\n  node modules/worker/setup.js token [--force] [--set <token>]\n  node modules/worker/setup.js check --server http://<host>:7420'); process.exit(2); }
})();
