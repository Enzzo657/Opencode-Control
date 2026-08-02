import { FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, jsonBody } from "../api";
import { translate, useI18n } from "../i18n";
import type { Project } from "../types";
import { message, useResource } from "../useResource";

type InstructionsResource = {
  content: string;
  path: string;
  project_exists?: boolean;
  global_content: string;
  global_path: string;
  global_exists: boolean;
};

export function Instructions({ project }: { project: Project }) {
  const { t } = useI18n();
  const resource = useResource<InstructionsResource>(`/api/v1/projects/${project.id}/instructions`, 0);
  const [content, setContent] = useState("");
  const [globalContent, setGlobalContent] = useState("");
  const [saved, setSaved] = useState(false);
  const [globalSaved, setGlobalSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectAvailable = resource.data ? resource.data.project_exists ?? Boolean(resource.data.content) : false;

  useEffect(() => {
    if (resource.data) {
      setContent(resource.data.content ?? "");
      setGlobalContent(resource.data.global_content ?? "");
    }
  }, [resource.data]);

  async function save() {
    try {
      await api(`/api/v1/projects/${project.id}/instructions`, { method: "PUT", ...jsonBody({ content }) });
      setError(null);
      setSaved(true);
      resource.reload();
      window.setTimeout(() => setSaved(false), 1800);
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function saveGlobal() {
    try {
      await api(`/api/v1/projects/${project.id}/instructions/global`, { method: "PUT", ...jsonBody({ content: globalContent }) });
      setError(null);
      setGlobalSaved(true);
      resource.reload();
      window.setTimeout(() => setGlobalSaved(false), 1800);
    } catch (reason) {
      setError(message(reason));
    }
  }

  return <>
    <div className="page-heading"><div><p className="eyebrow">OpenCode Control</p><h1>{t("instructions.title")}</h1><p>{t("instructions.description")}</p></div></div>
    {resource.error && <div className="banner danger">{resource.error}</div>}
    {error && <div className="banner danger">{error}</div>}
    <div className="instruction-flow" aria-label={translate("instructions.flowAria")}><div><span>1</span><small>{translate("instructions.globalRulesLabel")}</small><strong>{translate("instructions.globalFileTitle")}</strong><p>{translate("instructions.globalRulesDetail")}</p></div><i>+</i><div><span>2</span><small>{translate("instructions.repositoryRulesLabel")}</small><strong>{translate("instructions.projectFileTitle")}</strong><p>{translate("instructions.projectRulesDetail")}</p></div><i>=</i><div><span>3</span><small>{translate("instructions.resultLabel")}</small><strong>{translate("instructions.combinedTitle")}</strong><p>{translate("instructions.combinedDetail")}</p></div></div>
    <div className="instruction-stack">
      <div className="editor-layout"><div className="editor-gutter"><FileCode2 /><h3>{translate("instructions.projectFileTitle")}</h3><p>{translate("instructions.projectFileDetail")}</p><div className="path-chip">{resource.data?.path ?? `${project.root}/AGENTS.md`}</div><div className="resource-tags"><span className="scope-project">{translate("instructions.projectOnlyTag")}</span><span className={projectAvailable ? "state-enabled" : "state-pending"}>{projectAvailable ? translate("instructions.fileCreated") : translate("instructions.fileMissing")}</span></div><button className="primary-button instruction-save" onClick={() => void save()} disabled={!resource.data}>{saved ? translate("instructions.saved") : translate("instructions.saveProjectFile")}</button></div><textarea aria-label={translate("instructions.projectFileTitle")} className="code-editor large" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} placeholder={translate("instructions.projectPlaceholder")} /></div>
      <div className="editor-layout inherited-instructions"><div className="editor-gutter"><FileCode2 /><h3>{translate("instructions.globalFileTitle")}</h3><p>{translate("instructions.globalFileDetail")}</p><div className="path-chip">{resource.data?.global_path ?? "~/.config/opencode/AGENTS.md"}</div><div className="resource-tags"><span className="scope-global">{translate("instructions.allProjectsTag")}</span><span className={resource.data?.global_exists ? "state-enabled" : "state-pending"}>{resource.data?.global_exists ? translate("instructions.fileCreated") : translate("instructions.fileMissing")}</span></div><button className="primary-button instruction-save" onClick={() => void saveGlobal()} disabled={!resource.data}>{globalSaved ? translate("instructions.saved") : translate("instructions.saveGlobalFile")}</button></div><textarea aria-label={translate("instructions.globalFileTitle")} className="code-editor large" value={globalContent} onChange={(event) => setGlobalContent(event.target.value)} spellCheck={false} placeholder={translate("instructions.globalPlaceholder")} /></div>
    </div>
  </>;
}
