// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
// Settings building blocks: Switch, Card, SettingRow. Derived from OMB SettingsPrimitives.tsx, trimmed to
// the pieces this area uses (no icon library, no copy-to-clipboard, no "simple look" variants).
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Switch({ checked, className, ...props }: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        checked ? "bg-accent" : "bg-control",
        className,
      )}
    >
      <span className={cn("absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-[left] motion-reduce:transition-none", checked ? "left-[21px]" : "left-[3px]")} />
    </button>
  );
}

export function Card({ title, subtitle, children }: { title?: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl bg-card p-4">
      {title && <div className="text-[16px] font-semibold text-ink">{title}</div>}
      {subtitle && <div className={cn(title && "mt-0.5", "text-[13px] leading-relaxed text-ink-secondary")}>{subtitle}</div>}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

export function SettingRow({ title, subtitle, children, className }: { title: string; subtitle?: ReactNode; children: ReactNode; className?: string }) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} className={cn("px-4 py-3", className)}>
      <div className="grid min-w-0 grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6">
        <div className="min-w-0">
          <div id={titleId} className="text-[14px] font-medium text-ink">
            {title}
          </div>
          {subtitle && <div className="mt-1 text-[12px] leading-relaxed text-pretty text-ink-secondary">{subtitle}</div>}
        </div>
        <div className="flex min-w-0 items-center sm:justify-end">{children}</div>
      </div>
    </div>
  );
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-hairline/40 overflow-hidden rounded-xl bg-card">{children}</div>;
}

export const selectCls = "min-h-9 rounded-lg border border-hairline/40 bg-inset px-3 text-[14px] text-ink focus:outline-none";
