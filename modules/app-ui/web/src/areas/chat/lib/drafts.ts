// Per-bot drafts: kept in memory and mirrored to localStorage when it works. Our own file (MIT).
const memory = new Map<string, string>();
const key = (botId: string) => `dantomation.draft.${botId}`;

export function readDraft(botId: string): string {
  const held = memory.get(botId);
  if (held !== undefined) return held;
  try {
    return localStorage.getItem(key(botId)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(botId: string, text: string): void {
  if (text) memory.set(botId, text);
  else memory.delete(botId);
  try {
    if (text) localStorage.setItem(key(botId), text);
    else localStorage.removeItem(key(botId));
  } catch {
    /* storage is optional */
  }
}
