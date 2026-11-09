// The app shell. Our own file (MIT). Gates first; then a responsive layout (a drawer under 768px),
// a header with the 'header-action' slot, the matching 'main-view', and the 'overlay' slot.
import { Component, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { listViews, pickView, useArea } from "@/areas/registry";
import { activeLocale, onLocaleChange } from "@/lib/i18n";
import { Boot, StoreProvider } from "@/store";
import { Sidebar } from "@/shell/Sidebar";

/** Calls each gate as a function; the first non-null result replaces the app. Gates keep their hooks unconditional. */
function GateHost({ children }: { children: ReactNode }) {
  const gates = listViews("gate");
  let shown: ReactNode = null;
  for (const g of gates) {
    const out = (g.component as (props: object) => ReactNode)({});
    if (out != null && shown == null) shown = out;
  }
  return <>{shown ?? children}</>;
}

function Shell() {
  const { useStore, t, closeOverlay } = useArea();
  const [drawer, setDrawer] = useState(false);
  const view = useStore((s) => s.ui.view);
  const botName = useStore((s) => (s.ui.selectedBotId ? s.bots[s.ui.selectedBotId]?.name : undefined));
  const overlays = useStore((s) => s.ui.overlays);
  const loaded = useStore((s) => s.loaded);
  const Main = pickView("main-view", view)?.component;
  const actions = listViews("header-action");

  return (
    <div className="flex h-dvh w-full bg-app text-ink" style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>
      <aside className="hidden w-72 shrink-0 border-r border-hairline md:block" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label={t("app.close")} className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-panel shadow-xl" style={{ paddingTop: "env(safe-area-inset-top)" }}>
            <Sidebar onPick={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 items-center gap-2 border-b border-hairline px-3" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <button type="button" aria-label={t("app.menu")} onClick={() => setDrawer(true)} className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-raised-hover md:hidden">
            <span aria-hidden="true" className="text-lg leading-none">
              =
            </span>
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{view === "bot" ? (botName ?? "") : ""}</h1>
          {actions.map((v) => (
            <v.component key={v.id} />
          ))}
        </header>
        {!loaded ? <p className="m-auto text-sm text-ink-secondary">{t("app.loading")}</p> : Main ? <Main /> : null}
      </main>
      {overlays.map((o) => {
        const View = listViews("overlay").find((v) => v.id === o.id)?.component;
        return View ? <View key={o.id} {...o.props} close={() => closeOverlay(o.id)} /> : null;
      })}
    </div>
  );
}

/** Top-level boundary: a render error shows a small recoverable message instead of a blank page. Plain text on purpose, so it cannot depend on state that may be what failed. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("app-ui render error", error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ padding: "2rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <p>Something went wrong.</p>
        <button type="button" onClick={() => window.location.reload()} style={{ marginTop: "0.75rem", padding: "0.4rem 1rem", cursor: "pointer" }}>
          Reload
        </button>
      </div>
    );
  }
}

export function App() {
  // a language switch re-renders the shell with the new strings (the store and the stream stay)
  const locale = useSyncExternalStore(onLocaleChange, activeLocale);
  return (
    <ErrorBoundary>
      <StoreProvider>
        <GateHost>
          <Boot />
          <Shell key={locale} />
        </GateHost>
      </StoreProvider>
    </ErrorBoundary>
  );
}
