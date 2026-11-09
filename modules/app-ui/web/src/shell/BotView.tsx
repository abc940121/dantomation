// The foundation 'bot' main view: the winning thread, the thread-inline blocks, the winning composer. Our own file (MIT).
import { listViews, pickSlot, useArea } from "@/areas/registry";

export function BotView() {
  const { useStore, t } = useArea();
  const botId = useStore((s) => s.ui.selectedBotId);
  if (!botId) return <p className="m-auto px-4 text-sm text-ink-secondary">{t("app.pickBot")}</p>;
  const Thread = pickSlot("thread")?.component;
  const Composer = pickSlot("composer")?.component;
  const inline = listViews("thread-inline");
  return (
    <>
      {Thread ? <Thread key={botId} botId={botId} /> : null}
      {inline.map((v) => (
        <v.component key={v.id} botId={botId} />
      ))}
      {Composer ? <Composer key={botId} botId={botId} /> : null}
    </>
  );
}
