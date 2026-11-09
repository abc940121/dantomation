// The pairing gate. Our own file (MIT). Shows when there is no valid device token.
import { useState, useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import { auth } from "./client";
import { redeemCode, setToken } from "./token";

export function PairScreen() {
  const [value, setValue] = useState("");
  const [useToken, setUseToken] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setFailed(false);
    let ok = false;
    if (useToken) {
      setToken(v);
      ok = true;
    } else {
      ok = await redeemCode(v);
    }
    setBusy(false);
    if (ok) auth.set("ok");
    else setFailed(true);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-app px-4 text-ink" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-lg font-medium">{t("app.pair.title")}</h1>
        <p className="text-sm text-ink-secondary">{t("app.pair.hint")}</p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type={useToken ? "password" : "text"}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={useToken ? t("app.pair.token") : t("app.pair.code")}
          placeholder={useToken ? t("app.pair.token") : t("app.pair.code")}
          className="min-h-11 w-full rounded-lg bg-inset px-3 text-base text-ink ring-1 ring-hairline outline-none focus:ring-focus"
        />
        {failed && (
          <p role="alert" className="text-sm text-danger">
            {t("app.pair.failed")}
          </p>
        )}
        <button type="submit" disabled={busy || !value.trim()} className="min-h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-text disabled:opacity-40">
          {t("app.pair.submit")}
        </button>
        <button
          type="button"
          onClick={() => {
            setUseToken(!useToken);
            setFailed(false);
          }}
          className="w-full text-xs text-ink-secondary underline"
        >
          {useToken ? t("app.pair.useCode") : t("app.pair.useToken")}
        </button>
      </form>
    </div>
  );
}

/** The 'gate' view: a function component the host calls; null lets the app through. */
export function PairGate() {
  const state = useSyncExternalStore(auth.subscribe, auth.get);
  return state === "unauthorized" ? <PairScreen /> : null;
}
