// Pure helper for the chat history route (ESM so the route loader ignores it). Our own file (MIT).
// Takes one page of messages fetched with a limit of n+1 and says whether older ones remain.
export function pageOf(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list.length > limit;
  return { messages: hasMore ? list.slice(list.length - limit) : list, hasMore };
}

/** The core task id a message belongs to: ids look like "<task>:u" or "<task>:<bot>:a". */
export function taskOfMessageId(id) {
  if (typeof id !== 'string') return null;
  const head = id.split(':')[0];
  return head || null;
}
