// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by dantomation contributors
// The settings modal: a left nav of every registered 'settings-page' view, the page on the right, a search box.
// Derived from OMB SettingsModal.tsx (frame, nav, search, focus trap); the store, cloud pages and glass look are gone.
import { useMemo, useRef, useState } from "react";
import { listViews, useArea } from "@/areas/registry";
import { cn } from "@/lib/cn";
import { useModalDialog } from "./use-modal-dialog";
import { inputCls } from "./field";

export function SettingsModal({ close, page }: { close: () => void; page?: string }) {
  const { t } = useArea();
  const pages = listViews("settings-page");
  const [active, setActive] = useState(page && pages.some((p) => p.id === page) ? page : (pages[0]?.id ?? ""));
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, close);

  const label = (id: string) => t(`bots.page.${id}`) === `bots.page.${id}` ? id : t(`bots.page.${id}`);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? pages.filter((p) => label(p.id).toLowerCase().includes(q)) : pages;
    // label depends on the active locale; the modal re-renders with the shell when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, query]);
  const View = pages.find((p) => p.id === active)?.component;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-6">
      <button type="button" aria-label={t("bots.settings.close")} tabIndex={-1} className="absolute inset-0 bg-black/50" onClick={close} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t("bots.settings.title")}
        tabIndex={-1}
        className="relative flex h-dvh w-full max-w-3xl flex-col overflow-hidden bg-panel text-ink shadow-2xl outline-none sm:h-[min(40rem,90dvh)] sm:rounded-2xl sm:border sm:border-hairline md:flex-row"
      >
        <nav className="flex shrink-0 flex-col gap-2 border-b border-hairline p-3 md:w-52 md:border-r md:border-b-0" aria-label={t("bots.settings.title")} style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="px-2 text-base font-semibold">{t("bots.settings.title")}</h2>
            <button type="button" aria-label={t("bots.settings.close")} onClick={close} className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-raised-hover md:hidden">
              <span aria-hidden="true">x</span>
            </button>
          </div>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("bots.settings.search")} aria-label={t("bots.settings.search")} className={inputCls} />
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {shown.map((p) => (
              <li key={p.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setActive(p.id)}
                  aria-current={p.id === active ? "page" : undefined}
                  className={cn("min-h-10 w-full rounded-lg px-3 text-left text-sm transition-colors", p.id === active ? "bg-raised font-medium" : "hover:bg-raised-hover")}
                >
                  {label(p.id)}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-ink-secondary">{t("bots.settings.none")}</li>}
          </ul>
        </nav>
        <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          <div className="mb-4 hidden justify-end md:flex">
            <button type="button" aria-label={t("bots.settings.close")} onClick={close} className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-raised-hover">
              <span aria-hidden="true">x</span>
            </button>
          </div>
          {View ? <View /> : null}
        </section>
      </div>
    </div>
  );
}
