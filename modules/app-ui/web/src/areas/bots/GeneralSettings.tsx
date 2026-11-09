// The General settings page: language, appearance and an optional display name. Our own file (MIT).
import { useEffect, useState } from "react";
import { useArea } from "@/areas/registry";
import { Card, SettingRow, SettingsGroup, selectCls } from "./SettingsPrimitives";
import { inputCls } from "./field";
import { saveConfig, DEFAULT_CONFIG, type Appearance, type ConfigSlice, type Language } from "./settings-store";

const LANGS: Language[] = ["auto", "en", "zh-tw"];
const LOOKS: Appearance[] = ["system", "light", "dark"];

export function GeneralSettings() {
  const api = useArea();
  const { t, useStore } = api;
  const slice = useStore((s) => s.slices.config) as ConfigSlice | undefined;
  const config = slice?.config ?? DEFAULT_CONFIG;
  const [error, setError] = useState("");
  const [name, setName] = useState(config.profile.displayName ?? "");
  useEffect(() => setName(config.profile.displayName ?? ""), [config.profile.displayName]);

  const save = (patch: Parameters<typeof saveConfig>[1]) => {
    setError("");
    saveConfig(api, patch).catch((e: Error) => setError(t("bots.general.saveFailed", { error: e.message })));
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("bots.page.general")}</h3>
      <SettingsGroup>
        <SettingRow title={t("bots.general.language")} subtitle={t("bots.general.languageHint")}>
          <select aria-label={t("bots.general.language")} className={selectCls} value={config.language} onChange={(e) => save({ language: e.target.value as Language })}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {t(`bots.lang.${l}`)}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title={t("bots.general.appearance")} subtitle={t("bots.general.appearanceHint")}>
          <select aria-label={t("bots.general.appearance")} className={selectCls} value={config.appearance} onChange={(e) => save({ appearance: e.target.value as Appearance })}>
            {LOOKS.map((a) => (
              <option key={a} value={a}>
                {t(`bots.appearance.${a}`)}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>
      <Card title={t("bots.general.name")} subtitle={t("bots.general.nameHint")}>
        <input
          className={inputCls}
          value={name}
          maxLength={60}
          aria-label={t("bots.general.name")}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (config.profile.displayName ?? "") && save({ profile: { displayName: name.trim() || null } as never })}
        />
      </Card>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
