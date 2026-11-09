// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
// First-run onboarding in three steps: language, meet your bots (from the snapshot), pairing a phone.
// Derived from OMB onboarding/WelcomeFlow.tsx and MeetScreen.tsx; sign-in, ConnectAi, the tours and the mascot are dropped.
import { useEffect, useState } from "react";
import { useArea } from "@/areas/registry";
import { Avatar } from "@/shell/Avatar";
import type { SnapshotPayload } from "@/store";
import { selectCls } from "./SettingsPrimitives";
import { DEFAULT_CONFIG, saveConfig, type ConfigSlice, type Language } from "./settings-store";

const STEPS = 3;

export function Onboarding() {
  const api = useArea();
  const { t, useStore } = api;
  const slice = useStore((s) => s.slices.config) as ConfigSlice | undefined;
  const order = useStore((s) => s.botOrder);
  const bots = useStore((s) => s.bots);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const config = slice?.config ?? DEFAULT_CONFIG;
  const loaded = useStore((s) => s.loaded);

  // The gate replaces the app, so the app snapshot load may not have run yet.
  useEffect(() => {
    if (loaded) return;
    api.client
      .get<SnapshotPayload>("/m/app-ui/api/snapshot?messages=0")
      .then((snapshot) => api.dispatch({ type: "snapshot", snapshot }))
      .catch(() => undefined);
  }, [loaded, api]);

  const finish = () => {
    setBusy(true);
    saveConfig(api, { onboarded: true }).catch(() => setBusy(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-4 text-ink" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
      <div role="dialog" aria-modal="true" aria-label={t("bots.onboard.step", { n: step + 1, total: STEPS })} className="w-full max-w-md space-y-5 rounded-2xl border border-hairline bg-panel p-6">
        <div className="flex items-center justify-between text-xs text-ink-secondary">
          <span>{t("bots.onboard.step", { n: step + 1, total: STEPS })}</span>
          <button type="button" onClick={finish} disabled={busy} className="min-h-8 rounded-lg px-2 hover:bg-raised-hover">
            {t("bots.onboard.skip")}
          </button>
        </div>
        {step === 0 && (
          <div className="space-y-3">
            <h2 className="text-xl font-semibold">{t("bots.onboard.langTitle")}</h2>
            <p className="text-sm text-ink-secondary">{t("bots.onboard.langHint")}</p>
            <select aria-label={t("bots.general.language")} className={selectCls + " w-full"} value={config.language} onChange={(e) => void saveConfig(api, { language: e.target.value as Language })}>
              {(["auto", "en", "zh-tw"] as const).map((l) => (
                <option key={l} value={l}>
                  {t(`bots.lang.${l}`)}
                </option>
              ))}
            </select>
          </div>
        )}
        {step === 1 && (
          <div className="space-y-3">
            <h2 className="text-xl font-semibold">{t("bots.onboard.meetTitle")}</h2>
            <p className="text-sm text-ink-secondary">{order.length ? t("bots.onboard.meetHint") : t("bots.onboard.meetNone")}</p>
            <ul className="max-h-60 space-y-2 overflow-y-auto">
              {order.map((id) => {
                const b = bots[id];
                return b ? (
                  <li key={id} className="flex items-center gap-3 rounded-lg bg-card p-2">
                    <Avatar id={id} name={b.name} color={b.color} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{b.name}</span>
                      {b.description ? <span className="block truncate text-xs text-ink-secondary">{b.description}</span> : null}
                    </span>
                  </li>
                ) : null;
              })}
            </ul>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-3">
            <h2 className="text-xl font-semibold">{t("bots.onboard.pairTitle")}</h2>
            <p className="text-sm leading-relaxed text-ink-secondary">{t("bots.onboard.pairHint")}</p>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <button type="button" onClick={() => setStep(step - 1)} disabled={step === 0} className="min-h-10 rounded-lg px-4 text-sm hover:bg-raised-hover disabled:opacity-0">
            {t("bots.onboard.back")}
          </button>
          {step < STEPS - 1 ? (
            <button type="button" onClick={() => setStep(step + 1)} className="min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-accent-text">
              {t("bots.onboard.next")}
            </button>
          ) : (
            <button type="button" onClick={finish} disabled={busy} className="min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-accent-text disabled:opacity-40">
              {t("bots.onboard.done")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The 'gate' view: called as a function by the host, so hooks stay unconditional. Shown until config.onboarded. */
export function OnboardingGate(): React.ReactNode {
  const { useStore } = useArea();
  const slice = useStore((s) => s.slices.config) as ConfigSlice | undefined;
  return slice?.loaded && !slice.config.onboarded ? <Onboarding /> : null;
}
