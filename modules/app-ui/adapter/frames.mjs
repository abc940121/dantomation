// Core event -> OpenMausBot-style frames. Pure ESM, no I/O; the browser imports it and the
// tests run it in node. translate(ev, state) returns an array of frames; unknown event types
// give []. Every id comes from the task (and bot), so a replayed event makes the same frame.
//
//   ev:    the core SSE event { type, seq, ...data } (task, bot, text, final, callId, ...)
//   state: a plain object the caller keeps between calls: { replies: {}, taskBot: {} }
//
// Frame shapes are in web/shared/wire.ts.

export const threadId = botId => 'main:' + botId;
export const userId = task => task + ':u';
export const replyId = (task, bot) => task + ':' + bot + ':a';

export function newState() { return { replies: {}, taskBot: {} }; }

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export function translate(ev, state) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return [];
  const s = state || newState();
  s.replies = s.replies || {}; s.taskBot = s.taskBot || {};
  const task = str(ev.task, 100);
  if (ev.type !== 'bot_status' && !task) return [];
  const bot = str(ev.bot, 100) || s.taskBot[task] || '';
  if (task && bot) s.taskBot[task] = bot;
  const tid = threadId(bot);
  const at = Number.isFinite(ev.ts) ? ev.ts : undefined;
  const turn = (type, extra) => ({ kind: 'runtime', event: { type, eventId: `${task}:${type}${extra && extra.state ? ':' + extra.state : ''}`, threadId: tid, turnId: task, createdAt: at, ...extra } });
  switch (ev.type) {
    case 'task_start':
      if (!bot) return [];
      return [
        { kind: 'message', threadId: tid, message: { id: userId(task), role: 'user', kind: 'text', text: str(ev.prompt, 8000), createdAt: at } },
        turn('turn.started'),
      ];
    case 'message': {
      if (!bot) return [];
      const id = replyId(task, bot);
      const message = { id, role: 'bot', kind: 'text', text: str(ev.text, 20000), createdAt: at, streaming: ev.final === false };
      if (ev.final === false) {
        const exists = !!s.replies[id];
        s.replies[id] = true;
        return [{ kind: exists ? 'message.patch' : 'message', threadId: tid, message }];
      }
      s.replies[id] = true;
      return [{ kind: 'message', threadId: tid, message }, turn('turn.completed', { state: 'completed' })];
    }
    case 'tool_call':
      if (!bot) return [];
      return [{ kind: 'activity', botId: bot, threadId: tid, message: { id: `${task}:t:${str(ev.callId, 100)}`, role: 'bot', kind: 'activity', createdAt: at, tool: { name: str(ev.tool, 100), callId: str(ev.callId, 100), summary: str(ev.summary, 300), running: true } } }];
    case 'tool_result':
      if (!bot) return [];
      return [{ kind: 'activity', botId: bot, threadId: tid, message: { id: `${task}:t:${str(ev.callId, 100)}`, role: 'bot', kind: 'activity', createdAt: at, tool: { name: '', callId: str(ev.callId, 100), summary: str(ev.summary, 300), ok: ev.ok === true, running: false } } }];
    case 'bot_status':
      if (!str(ev.bot, 100)) return [];
      return [{ kind: 'bot', bot: { id: str(ev.bot, 100), threadId: threadId(str(ev.bot, 100)), name: '', title: '', description: '', status: ['idle', 'busy', 'offline'].includes(ev.status) ? ev.status : 'idle', partial: true } }];
    case 'task_end':
      if (!bot) return [];
      return [turn('turn.completed', { state: ['done', 'failed', 'stopped'].includes(ev.state) ? ev.state : 'done' })];
    default:
      return [];
  }
}
