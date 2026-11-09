// Hands-free call state machine (pure reducer). Our own file (MIT), shared by the browser and the tests.
// States: idle | listening | sending | working | speaking. There is no push-to-talk state, by design.
// step(machine, event) -> {state, effects[]}. `state` is the next machine ({phase, ...}); the caller keeps it.
//
// Events (all carry `at`, ms epoch, where time matters):
//   start, stop, vad_start, vad_end{at}, transcript_final{text,at}, tick{at}, reply_lines{lines}, poll_lines{lines},
//   speak_end, error{message,fatal?}
// Effects: start_capture, stop_capture, send{text}, speak{text}, cancel_speech, playback{state}, timer{ms}.

export const ENDPOINT_MS = 850;
export const PHASES = Object.freeze(['idle', 'listening', 'sending', 'working', 'speaking']);

export function initial() {
  return { phase: 'idle', text: '', vadEndAt: null, speaking: false, queue: [], error: null };
}

const sayOf = lines => (Array.isArray(lines) ? lines : []).map(l => (l && typeof l.say === 'string' ? l.say.trim() : '')).filter(Boolean);

function startSpeaking(m, texts) {
  const [first, ...queue] = texts;
  return {
    state: { ...m, phase: 'speaking', speaking: true, queue, text: '', vadEndAt: null },
    effects: [{ type: 'playback', state: 'start' }, { type: 'speak', text: first }],
  };
}

function listen(m, extra = {}) {
  return { ...m, phase: 'listening', speaking: false, queue: [], text: '', vadEndAt: null, ...extra };
}

// vad_end + ENDPOINT_MS with a final transcript sends the turn.
function maybeSend(m, now) {
  if (m.phase !== 'listening' || !m.text || m.vadEndAt == null) return null;
  const left = ENDPOINT_MS - (now - m.vadEndAt);
  if (left > 0) return { state: m, effects: [{ type: 'timer', ms: left }] };
  return { state: { ...m, phase: 'sending', text: '', vadEndAt: null }, effects: [{ type: 'send', text: m.text.trim() }] };
}

const cut = m => (m.speaking ? [{ type: 'cancel_speech' }, { type: 'playback', state: 'end' }] : []);

export function step(m, ev) {
  const none = { state: m, effects: [] };
  if (!ev || typeof ev.type !== 'string') return none;
  switch (ev.type) {
    case 'start':
      if (m.phase !== 'idle') return none;
      return { state: listen(m, { error: null }), effects: [{ type: 'start_capture' }] };
    case 'stop':
      if (m.phase === 'idle') return none;
      return { state: initial(), effects: [...cut(m), { type: 'stop_capture' }] };
    case 'vad_start':
      if (m.phase === 'speaking') // barge-in: cut the speech at once
        return { state: listen(m), effects: cut(m) };
      if (m.phase === 'listening') return { state: { ...m, vadEndAt: null }, effects: [] };
      return none;
    case 'vad_end':
      if (m.phase !== 'listening') return none;
      return maybeSend({ ...m, vadEndAt: ev.at }, ev.at) || { state: { ...m, vadEndAt: ev.at }, effects: [] };
    case 'transcript_final': {
      if (m.phase !== 'listening') return none; // speech heard during our own reply or while sending is dropped
      const text = String(ev.text || '').trim();
      if (!text) return none;
      const next = { ...m, text: m.text ? m.text + ' ' + text : text };
      return maybeSend(next, ev.at) || { state: next, effects: [] };
    }
    case 'tick':
      return maybeSend(m, ev.at) || none;
    case 'reply_lines': {
      if (m.phase !== 'sending' && m.phase !== 'working') return none;
      const say = sayOf(ev.lines);
      if (say.length) return startSpeaking(m, say);
      return { state: listen(m), effects: [] };
    }
    case 'poll_lines': {
      const say = sayOf(ev.lines);
      if (!say.length || m.phase === 'idle') return none;
      if (m.phase === 'speaking') return { state: { ...m, queue: [...m.queue, ...say] }, effects: [] };
      return startSpeaking(m, say);
    }
    case 'speak_end': {
      if (m.phase !== 'speaking') return none;
      if (m.queue.length) {
        const [first, ...queue] = m.queue;
        return { state: { ...m, queue }, effects: [{ type: 'speak', text: first }] };
      }
      return { state: listen(m), effects: [{ type: 'playback', state: 'end' }] };
    }
    case 'error': {
      if (m.phase === 'idle') return none;
      const message = String(ev.message || 'error');
      if (ev.fatal) return { state: { ...initial(), error: message }, effects: [...cut(m), { type: 'stop_capture' }] };
      return { state: listen(m, { error: message }), effects: cut(m) };
    }
    default:
      return none;
  }
}
