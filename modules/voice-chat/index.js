'use strict';
// voice-chat: hands-free text layer for the voice client. Wake phrase, echo guard,
// card yes/no by voice, chat via the server's /api. Audio stays on the client machine.
// Routes (module contract 2): POST /m/voice-chat/{utterance,poll,playback}, owner only.
// The contract has no streaming responses yet, so utterance and poll answer once, with
// {lines: [{say}..., {done: true, ...}]} (see DECISIONS.md, "S1-4 merge").
const { vcFor, utteranceHandler, collect } = require('./routes');
const { toSpeakable, speakableSentences } = require('./speak-text');
const { SpeechPipeline, registerEngine, createEngine, engineNames } = require('./pipeline');

const body = ctx => (ctx.body && typeof ctx.body === 'object' ? ctx.body : {});

module.exports = {
  contract: 2,
  name: 'voice-chat',
  description: 'Hands-free text layer for the voice client: wake phrase, echo guard, cards by voice.',
  runsOn: 'main',
  dependsOn: ['approval-cards'], // its yes/no parser comes from that module's api
  routes: [
    { method: 'POST', path: '/utterance', description: 'one spoken utterance {text, spokenAt}; answers {lines:[{say}...,{done}]}',
      handler: ctx => collect(write => utteranceHandler(vcFor(ctx), body(ctx), write, { closed: () => false, actor: ctx.actor })) },
    { method: 'POST', path: '/poll', description: 'announce a newly pending card; answers {lines:[...]}',
      handler: ctx => collect(async write => { const r = await vcFor(ctx).poll(write); write({ done: true, ...r }); }) },
    { method: 'POST', path: '/playback', description: 'the client reports TTS start/end {state, at}',
      handler: ctx => { const ok = vcFor(ctx).playback(body(ctx)); return { status: ok ? 200 : 400, json: { ok } }; } },
  ],
  // The TTS-engine seam (see README, "Speech output"): another module that dependsOn
  // voice-chat calls api.registerEngine(name, factory) with factory(opts) -> {synth, play}.
  api: { toSpeakable, speakableSentences, SpeechPipeline, registerEngine, createEngine, engineNames },
  settings: {
    wake: { type: 'array', items: 'string', default: [], description: 'wake phrases; empty = the built-in English and Chinese set' },
    followup_s: { type: 'number', default: 8, min: 0, description: 'seconds after a spoken reply when no wake phrase is needed' },
    bots: { type: 'array', items: 'string', default: [], description: 'bot ids to talk to; ["all"] = every bot; empty = the first bot' },
    status_s: { type: 'number', default: 4, min: 0, description: 'seconds between spoken progress notes' },
    timeout_s: { type: 'number', default: 180, min: 1, description: 'give up on a reply after this many seconds' },
    reply_grace_s: { type: 'number', default: 8, min: 0, description: 'after a task ends, wait this many seconds for its final reply' },
    api_base: { type: 'string', default: 'http://127.0.0.1:7420', description: 'the dantomation server this module talks to' },
    token: { type: 'secret', description: 'bearer token for the server API (set with: node bin/harness.js secret voice-chat token)' },
  },
};
