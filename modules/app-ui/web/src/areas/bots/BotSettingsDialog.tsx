// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
// The per-bot settings dialog: display name, color, description, hidden in the sidebar. Derived from OMB
// BotSettingsDialog.tsx and bot-settings/IdentitySection.tsx; the avatar generator, engine and cloud sections are gone.
// Saves go to the module (overrides), then the snapshot is reloaded so the sidebar shows the change.
import { useRef, useState } from "react";
import { useArea } from "@/areas/registry";
import { Avatar } from "@/shell/Avatar";
import type { SnapshotPayload } from "@/store";
import { Field, inputCls } from "./field";
import { Switch } from "./SettingsPrimitives";
import { useModalDialog } from "./use-modal-dialog";
import { API } from "./settings-store";

const SWATCHES = ["#e5484d", "#f76b15", "#e5a000", "#30a46c", "#0d9488", "#3e63dd", "#8e4ec6", "#d6409f"];
const HEX = /^#[0-9a-fA-F]{6}$/;

export function BotSettingsDialog({ botId, close }: { botId: string; close: () => void }) {
  const { client, dispatch, t, useStore } = useArea();
  const bot = useStore((s) => s.bots[botId]);
  const [name, setName] = useState(bot?.name ?? "");
  const [color, setColor] = useState(bot?.color && HEX.test(bot.color) ? bot.color : "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [hidden, setHidden] = useState(bot?.hidden === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLFormElement>(null);
  useModalDialog(ref, close);
  if (!bot) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await client.post(`${API}/bots/${encodeURIComponent(botId)}/settings`, { name: name.trim() || null, color: color || null, description: description.trim() || null, hidden });
      const snap = await client.get<SnapshotPayload>("/m/app-ui/api/snapshot?messages=0");
      dispatch({ type: "snapshot", snapshot: snap });
      close();
    } catch (err) {
      setError(t("bots.bot.failed", { error: err instanceof Error ? err.message : String(err) }));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label={t("bots.bot.cancel")} tabIndex={-1} className="absolute inset-0 bg-black/50" onClick={close} />
      <form ref={ref} role="dialog" aria-modal="true" aria-label={t("bots.bot.title")} tabIndex={-1} onSubmit={submit} className="relative max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-2xl border border-hairline bg-panel p-5 text-ink shadow-2xl outline-none">
        <div className="flex items-center gap-3">
          <Avatar id={botId} name={name || bot.name} color={color || undefined} size={44} />
          <h2 className="text-base font-semibold">{t("bots.bot.title")}</h2>
        </div>
        <Field label={t("bots.bot.name")}>
          <input className={inputCls} value={name} maxLength={40} required onChange={(e) => setName(e.target.value)} />
        </Field>
        <div>
          <div className="mb-1.5 text-[13px] text-ink-secondary">{t("bots.bot.color")}</div>
          <div className="flex flex-wrap items-center gap-2">
            {SWATCHES.map((c) => (
              <button key={c} type="button" aria-label={c} aria-pressed={color === c} onClick={() => setColor(c)} className="size-8 rounded-full ring-offset-2 ring-offset-panel aria-pressed:ring-2 aria-pressed:ring-ink" style={{ background: c }} />
            ))}
            <button type="button" onClick={() => setColor("")} className="min-h-8 rounded-lg px-2 text-xs text-ink-secondary hover:bg-raised-hover">
              {t("bots.bot.reset")}
            </button>
          </div>
        </div>
        <Field label={t("bots.bot.description")}>
          <textarea className={inputCls} rows={3} maxLength={280} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t("bots.bot.hidden")}</div>
            <div className="text-xs text-ink-secondary">{t("bots.bot.hiddenHint")}</div>
          </div>
          <Switch checked={hidden} aria-label={t("bots.bot.hidden")} onClick={() => setHidden(!hidden)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className="min-h-10 rounded-lg px-4 text-sm hover:bg-raised-hover">
            {t("bots.bot.cancel")}
          </button>
          <button type="submit" disabled={busy || !name.trim()} className="min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-accent-text disabled:opacity-40">
            {busy ? t("bots.bot.saving") : t("bots.bot.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
