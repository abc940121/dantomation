'use strict';
// Minimal client for the taskmote server API v0 (node:http only, no dependencies).
//   json(method, path, body)  -> {status, body}
//   sse(path, onEvent, onOpen, onError) -> {close()}; onEvent({type, data})
const http = require('http');

function client({ base, token }) {
  const u = new URL(base);
  const headers = extra => ({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
  const opts = (method, p, h) => ({ hostname: u.hostname, port: u.port || 80, path: p, method, headers: headers(h) });

  function json(method, p, body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(opts(method, p, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  function sse(p, onEvent, onOpen, onError) {
    const req = http.request(opts('GET', p, { Accept: 'text/event-stream' }), res => {
      if (onOpen) onOpen();
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          let type = 'message', data = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          try { onEvent({ type, data: JSON.parse(data.join('\n')) }); } catch { /* skip a bad frame */ }
        }
      });
      res.on('error', e => onError && onError(e));
    });
    req.on('error', e => onError && onError(e));
    req.end();
    return { close() { req.destroy(); } };
  }
  return { json, sse };
}

module.exports = { client };
