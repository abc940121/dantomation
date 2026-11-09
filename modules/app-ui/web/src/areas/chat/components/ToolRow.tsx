// One tool-activity row: a status dot, the tool name and its summary. Our own file (MIT).
import type { WireMessage } from "@shared/wire";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function ToolRow({ message }: { message: WireMessage }) {
  const tool = message.tool;
  if (!tool) return null;
  const state = tool.running ? "dchat.toolRunning" : tool.ok === false ? "dchat.toolFailed" : "dchat.toolDone";
  return (
    <div className="flex items-center gap-2 text-xs text-ink-secondary" title={t(state)}>
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 shrink-0 rounded-full", tool.running ? "animate-status-pulse bg-warning" : tool.ok === false ? "bg-danger" : "bg-success")}
      />
      <span className="shrink-0 font-medium text-ink">{tool.name}</span>
      {tool.summary && <span className="min-w-0 truncate">{tool.summary}</span>}
      <span className="sr-only">{t(state)}</span>
    </div>
  );
}
