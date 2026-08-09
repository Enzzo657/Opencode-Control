import { useI18n } from "./i18n";

export type ProjectScope = "project" | "global";

export function ScopeSwitch({ value, onChange, label }: { value: ProjectScope; onChange: (scope: ProjectScope) => void; label: string }) {
  const { t } = useI18n();
  return <div className="scope-switch" role="group" aria-label={label}>
    <button type="button" className={value === "project" ? "active" : ""} aria-pressed={value === "project"} onClick={() => onChange("project")}>{t("search.currentProject")}</button>
    <button type="button" className={value === "global" ? "active" : ""} aria-pressed={value === "global"} onClick={() => onChange("global")}>{t("search.allProjects")}</button>
  </div>;
}
