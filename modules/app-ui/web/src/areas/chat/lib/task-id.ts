// A message id is "<task>:u" (yours) or "<task>:<bot>:a" (a reply); the task id is the first part.
// Our own file (MIT).
import type { WireMessage } from "@shared/wire";

export function taskOfMessageId(id: string | undefined): string | null {
  if (!id) return null;
  const head = id.split(":")[0];
  return head || null;
}

export function latestTaskId(messages: readonly WireMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = taskOfMessageId(messages[i]!.id);
    if (id) return id;
  }
  return null;
}
