// A bot avatar: initials on a color taken from the bot color or a hash of its id. Our own file (MIT).
import { cn } from "@/lib/cn";

export function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = Array.from(parts[0]!)[0] ?? "?";
  const second = parts.length > 1 ? (Array.from(parts[1]!)[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function Avatar({ id, name, color, size = 32, className }: { id: string; name: string; color?: string; size?: number; className?: string }) {
  const bg = color || `hsl(${hashHue(id)} 45% 38%)`;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white select-none", className)}
      style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name)}
    </span>
  );
}
