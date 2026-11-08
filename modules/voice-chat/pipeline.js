'use strict';
// Sentence-by-sentence speech with prefetch. No I/O of its own: the TTS engine is injected.
//
// Engine interface (the seam; a future engine module only has to provide this):
//   engine.synth(text, {signal}) -> Promise<audio>     any opaque audio value
//   engine.play(audio, {signal}) -> Promise<void>      resolves when playback has ended
// `signal` is an AbortSignal; an engine should stop early when it fires, but the pipeline
// does not rely on that: after cancel() a late result is simply discarded.
//
//   const sp = new SpeechPipeline({engine, prefetch: 2});
//   sp.say(text)   toSpeakable + split, queue the sentences; the first one starts at once
//   sp.push(s)     queue one ready sentence
//   sp.cancel()    barge-in / new utterance: stop playback AND drop every queued sentence
//   await sp.idle()
// Order is strict: sentences play in the order queued. While one plays, the next
// `prefetch` are already being synthesized.
const { speakableSentences } = require('./speak-text');

// name -> factory(opts) -> engine. A later module registers here (via voice-chat's api).
const engines = new Map();
function registerEngine(name, factory) {
  if (typeof name !== 'string' || !name || typeof factory !== 'function') throw new Error('registerEngine(name, factory)');
  engines.set(name, factory);
}
const createEngine = (name, opts) => { const f = engines.get(name); if (!f) throw new Error('unknown TTS engine: ' + name); return f(opts); };
const engineNames = () => [...engines.keys()];

const CANCELLED = Symbol('cancelled');

class SpeechPipeline {
  constructor({ engine, prefetch = 2, onError } = {}) {
    if (!engine || typeof engine.synth !== 'function' || typeof engine.play !== 'function') throw new Error('engine needs synth() and play()');
    this.engine = engine;
    this.prefetch = Math.max(0, prefetch | 0);
    this.onError = onError || (() => {});
    this.queue = [];          // not yet playing: {text, audio: Promise|null}
    this.current = null;      // the sentence being synthesized-for or played
    this.gen = 0;
    this.ctl = new AbortController();
    this.stopped = new Promise(r => { this._stop = r; }); // settles on cancel(): awaited work races it
    this.running = null;
  }

  say(text) { for (const s of speakableSentences(text)) this.push(s); }

  push(sentence) {
    const text = String(sentence || '').trim();
    if (!text) return;
    this.queue.push({ text, audio: null });
    this._fill();
    if (!this.running) this.running = this._run();
  }

  cancel() {
    this.gen++;
    this.queue.length = 0;
    this.current = null;
    this.ctl.abort();
    this.ctl = new AbortController();
    this._stop(CANCELLED);
    this.stopped = new Promise(r => { this._stop = r; });
  }

  idle() { return this.running || Promise.resolve(); }
  get pending() { return this.queue.length + (this.current ? 1 : 0); }

  _start(item) {
    if (item.audio) return;
    const { signal } = this.ctl;
    item.audio = Promise.resolve().then(() => this.engine.synth(item.text, { signal }));
    item.audio.catch(() => {});      // reported where it is awaited
  }
  // Keep the window full: the current sentence plus `prefetch` after it.
  _fill() {
    const room = this.prefetch + (this.current ? 0 : 1);
    for (let i = 0; i < room && i < this.queue.length; i++) this._start(this.queue[i]);
  }

  async _run() {
    try {
      while (this.queue.length) {
        const gen = this.gen;
        const stopped = this.stopped;   // a stuck synth or play must not hold the loop past cancel()
        const item = this.queue.shift();
        this.current = item;
        this._start(item);
        this._fill();
        let audio;
        try { audio = await Promise.race([item.audio, stopped]); } catch (e) { if (gen === this.gen) this.onError(e, item.text); this.current = null; continue; }
        if (gen !== this.gen || audio === CANCELLED) continue;
        try { await Promise.race([this.engine.play(audio, { signal: this.ctl.signal }), stopped]); } catch (e) { if (gen === this.gen) this.onError(e, item.text); }
        if (gen === this.gen) this.current = null;
      }
    } finally {
      this.running = null;
    }
  }
}

module.exports = { SpeechPipeline, registerEngine, createEngine, engineNames };
