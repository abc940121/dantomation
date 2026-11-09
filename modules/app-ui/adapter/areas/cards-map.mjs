// Pure translation between the harness's cards/questions and the shapes the cards UI renders.
// Our own file (MIT). No imports, no I/O: the browser bundle and the tests both load it.

const threadOf = bot => 'main:' + bot;

/** Core approval card ({id, task, bot, tool, summary, expiresAt, state}) -> the UI card. */
export function coreCardToOptionCard(card, now = Date.now()) {
  const exp = card && card.expiresAt ? Date.parse(card.expiresAt) : NaN;
  let state = card.state === 'pending' ? 'pending' : card.state === 'expired' ? 'expired' : 'answered';
  if (state === 'pending' && Number.isFinite(exp) && exp <= now) state = 'expired';
  const decision = card.decision && typeof card.decision === 'object' ? card.decision : null;
  return {
    kind: 'approval',
    requestId: String(card.id),
    threadId: threadOf(card.bot),
    bot: String(card.bot),
    task: card.task || '',
    tool: card.tool || 'tool',
    title: card.tool || 'tool',
    subtitle: String(card.summary || ''),
    options: ['Allow', 'Deny'],
    state,
    expiresAt: Number.isFinite(exp) ? exp : 0,
    answered: state === 'answered' ? String((decision && decision.answer) || card.state || 'answered') : undefined,
  };
}

/** A stored question (see adapter/areas/cards.js) -> the UI card. */
export function questionToCard(q, now = Date.now()) {
  let state = q.state === 'answered' ? 'answered' : q.state === 'expired' ? 'expired' : 'pending';
  if (state === 'pending' && q.expiresAt && q.expiresAt <= now) state = 'expired';
  return {
    kind: 'question',
    requestId: String(q.id),
    threadId: threadOf(q.bot),
    bot: String(q.bot),
    task: q.task || '',
    title: String(q.title || ''),
    subtitle: (q.questions && q.questions[0] && q.questions[0].prompt) || '',
    questions: (q.questions || []).map(x => ({
      question: x.prompt,
      options: (x.options || []).map(o => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
      ...(x.multi ? { multiSelect: true } : {}),
      ...(x.allowText === false ? { custom: false } : {}),
    })),
    state,
    expiresAt: q.expiresAt || 0,
    answers: q.answers || null,
  };
}

/**
 * The HTTP call that settles a request. behavior: allow | deny | answer.
 * Ids starting "q-" are module questions: message is {answers:[{selected,text}]} (an object).
 * @param {string} threadId
 * @param {{requestId: string, behavior?: string, message?: unknown}} req
 * @returns {{method: string, path: string, body: any}}
 */
export function respondToRequest(threadId, { requestId, behavior, message }) {
  const id = String(requestId);
  if (id.startsWith('q-')) {
    const body = message && typeof message === 'object' ? message : { answers: [] };
    return { method: 'POST', path: '/m/app-ui/api/questions/' + encodeURIComponent(id) + '/answer', body };
  }
  const path = '/api/cards/' + encodeURIComponent(id);
  if (behavior === 'allow') return { method: 'POST', path, body: { answer: 'yes' } };
  if (behavior === 'deny') return { method: 'POST', path, body: { answer: 'no' } };
  return { method: 'POST', path, body: { answer: typeof message === 'string' ? message : '' } };
}

/**
 * Notification entries from the card events seen so far (any order). An event is
 * {type: card_pending|card_resolved|question_pending|question_resolved, id, bot, botName?, title, body, at}.
 * Newest first; a pending event gives one entry, a resolved one none. Unread = id not in readIds.
 */
export function deriveNotifications(events, readIds) {
  const read = new Set(readIds || []);
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    if (!e || (e.type !== 'card_pending' && e.type !== 'question_pending')) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      kind: e.type === 'card_pending' ? 'approval' : 'question',
      botId: e.bot,
      botName: e.botName || e.bot,
      threadId: threadOf(e.bot),
      title: e.title || '',
      body: e.body || '',
      at: e.at || 0,
      read: read.has(e.id),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}
