import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, jsonBody } from "../api";
import { translate, useI18n } from "../i18n";
import type { Project } from "../types";
import { Banner, Field, Page, Panel } from "../ui";
import { message, useResource } from "../useResource";

type Configuration = {
  project: Record<string, unknown>;
  project_path: string;
  global: Record<string, unknown>;
  global_path: string;
};

export function ProjectSettings({ project, onChange }: { project: Project; onChange: () => void }) {
  const { t } = useI18n();
  const config = useResource<Configuration>(`/api/v1/projects/${project.id}/configuration`, 0);
  const [raw, setRaw] = useState("{}");
  const [globalRaw, setGlobalRaw] = useState("{}");
  const [name, setName] = useState(project.name);
  const [endpoint, setEndpoint] = useState(project.endpoint ?? "");
  const [error, setError] = useState<string | null>(null);
  const [editorErrors, setEditorErrors] = useState<{ project: string | null; global: string | null }>({ project: null, global: null });
  const [savedScope, setSavedScope] = useState<"project" | "global" | null>(null);
  const [savingScope, setSavingScope] = useState<"project" | "global" | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (config.data && !initialized.current) {
      initialized.current = true;
      setRaw(JSON.stringify(config.data.project, null, 2));
      setGlobalRaw(JSON.stringify(config.data.global, null, 2));
    }
  }, [config.data]);

  async function save(scope: "project" | "global") {
    const source = scope === "project" ? raw : globalRaw;
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(source) as Record<string, unknown>;
    } catch (reason) {
      setEditorErrors((current) => ({ ...current, [scope]: jsonEditorError(reason, source) }));
      return;
    }
    setSavingScope(scope);
    try {
      await api(`/api/v1/projects/${project.id}/configuration`, { method: "PATCH", ...jsonBody({ values, scope }) });
      setEditorErrors((current) => ({ ...current, [scope]: null }));
      setError(null);
      setSavedScope(scope);
      window.setTimeout(() => setSavedScope(null), 1800);
      config.reload();
    } catch (reason) {
      setEditorErrors((current) => ({ ...current, [scope]: message(reason) }));
    } finally {
      setSavingScope(null);
    }
  }

  async function saveIdentity() {
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        ...jsonBody({ name, endpoint: endpoint || null, clear_endpoint: !endpoint }),
      });
      setError(null);
      onChange();
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function remove() {
    if (!confirm(t("projectSettings.deleteConfirm", { project: project.name }))) return;
    await api(`/api/v1/projects/${project.id}`, { method: "DELETE" });
    onChange();
  }

  return <Page title={t("projectSettings.title")} description={t("projectSettings.description")} action={<button className="primary-button" onClick={() => void save("project")} disabled={!config.data || savingScope !== null}>{savingScope === "project" ? t("common.saving") : savedScope === "project" ? t("common.saved") : t("projectSettings.saveProject")}</button>}>
    {(error || config.error) && <Banner tone="danger">{error || config.error}</Banner>}
    <div className="context-summary settings-context-summary"><div><small>{t("projectSettings.sharedConfig")}</small><strong>{t("projectSettings.allProjects")}</strong><span>{config.data?.global_path ?? "~/.config/opencode/opencode.json"}</span></div><div><small>{t("projectSettings.priority")}</small><strong>{t("projectSettings.projectOverShared")}</strong><span>{t("projectSettings.mergeLevels")}</span></div><div><small>{t("projectSettings.afterSave")}</small><strong>{t("projectSettings.runtimeUpdated")}</strong><span>{t("projectSettings.restartServers")}</span></div></div>
    <div className="settings-identity"><Panel title={t("projectSettings.projectData")}><div className="form-stack"><div className="form-row"><Field label={t("projectSettings.displayName")}><input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label={t("projectSettings.externalAddress")} hint={t("projectSettings.externalAddressHint")}><input className="mono" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4096" /></Field></div><Field label={t("projectSettings.folder")}><input className="mono" value={project.root} readOnly /></Field><button className="secondary-button settings-identity-save" onClick={() => void saveIdentity()}>{t("projectSettings.saveData")}</button></div></Panel></div>
    <div className="config-editor-stack"><Panel title={t("projectSettings.projectConfig")}><div className="config-editor-heading"><span><strong>{config.data?.project_path ?? `${project.root}/opencode.json`}</strong><small>{t("projectSettings.projectConfigHint")}</small></span><button className="secondary-button" onClick={() => void save("project")} disabled={!config.data || savingScope !== null}>{savingScope === "project" ? t("common.saving") : savedScope === "project" ? t("common.saved") : t("common.save")}</button></div>{editorErrors.project && <Banner tone="danger">{t("projectSettings.projectSaveError", { error: editorErrors.project })}</Banner>}<textarea aria-label={t("projectSettings.projectConfigLabel")} aria-invalid={Boolean(editorErrors.project)} className={`code-editor settings-editor${editorErrors.project ? " invalid" : ""}`} value={raw} onChange={(event) => { setRaw(event.target.value); setEditorErrors((current) => ({ ...current, project: null })); }} spellCheck={false} /></Panel><Panel title={t("projectSettings.sharedConfig")}><div className="config-editor-heading"><span><strong>{config.data?.global_path ?? "~/.config/opencode/opencode.json"}</strong><small>{t("projectSettings.sharedConfigHint")}</small></span><button className="secondary-button" onClick={() => void save("global")} disabled={!config.data || savingScope !== null}>{savingScope === "global" ? t("common.saving") : savedScope === "global" ? t("common.saved") : t("projectSettings.saveShared")}</button></div>{editorErrors.global && <Banner tone="danger">{t("projectSettings.sharedSaveError", { error: editorErrors.global })}</Banner>}<textarea aria-label={t("projectSettings.sharedConfigLabel")} aria-invalid={Boolean(editorErrors.global)} className={`code-editor settings-editor${editorErrors.global ? " invalid" : ""}`} value={globalRaw} onChange={(event) => { setGlobalRaw(event.target.value); setEditorErrors((current) => ({ ...current, global: null })); }} spellCheck={false} /></Panel></div>
    <Panel className="danger-zone"><div><div><strong>{t("projectSettings.deleteTitle")}</strong><p>{t("projectSettings.deleteDetail")}</p></div><button className="danger-button" onClick={() => void remove()}><Trash2 size={15} /> {t("projectSettings.deleteButton")}</button></div></Panel>
  </Page>;
}

function jsonEditorError(reason: unknown, source: string) {
  const detail = message(reason);
  const position = /position\s+(\d+)/i.exec(detail);
  if (!position) return translate("projectSettings.invalidJson", { value0: detail });
  const offset = Math.min(Number(position[1]), source.length);
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return translate("projectSettings.invalidJsonAt", { value0: line, value1: column, value2: detail });
}
