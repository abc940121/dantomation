// The About settings page: module version, licenses and the OpenMausBot attribution. Our own file (MIT).
import { useArea } from "@/areas/registry";
import pkg from "../../../package.json";
import { Card } from "./SettingsPrimitives";

export function AboutPage() {
  const { t } = useArea();
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("bots.page.about")}</h3>
      <Card title="taskmote app-ui" subtitle={t("bots.about.version", { version: pkg.version })}>
        <p className="text-sm leading-relaxed">{t("bots.about.license")}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-secondary">{t("bots.about.notice")}</p>
        <p className="mt-3 text-xs leading-relaxed text-ink-secondary">{t("bots.about.attribution")}</p>
      </Card>
    </div>
  );
}
