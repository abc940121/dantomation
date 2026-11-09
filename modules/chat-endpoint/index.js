'use strict';
// chat-endpoint: an engine for rooms members that talks to an OpenAI-style chat URL.
// Off by default. Needs the rooms module. See README.md.
const { makeDeliver } = require('./endpoint');

module.exports = {
  contract: 1,
  name: 'chat-endpoint',
  description: 'Rooms engine for a bot behind an OpenAI-style chat URL: fail closed, secret/PII screen, no text kept by default.',
  runsOn: 'main',
  dependsOn: ['rooms'],
  provides: { engines: [{ id: 'chat-endpoint', description: 'a rooms member with engine "chat-endpoint" is answered by its endpoint block' }] },
  jobs: [{
    id: 'register',
    start(ctx) { return ctx.api('rooms').registerDeliverer('chat-endpoint', makeDeliver(ctx)); },
  }],
  settings: {
    tokens: { type: 'secret', description: 'JSON object {"<token_secret name>": "<bearer token>"} (set with: node bin/harness.js secret chat-endpoint tokens)' },
    allowed_hosts: { type: 'array', items: 'string', default: [], description: 'hosts besides loopback an endpoint url may use' },
    timeout_s: { type: 'number', default: 20, min: 1, description: 'give up on one request after this many seconds (posts nothing)' },
    max_reply_chars: { type: 'integer', default: 4000, min: 1, description: 'longest reply kept' },
    unavailable_text: { type: 'string', default: '', description: 'the system line when an endpoint is down; empty = "<name> is unavailable."' },
    pii_log_path: { type: 'string', default: '', description: 'when set, one JSON line per secret/PII event {ts, direction, kind, count} is appended here; never any text' },
  },
};
