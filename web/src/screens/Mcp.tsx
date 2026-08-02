import { Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, jsonBody } from "../api";
import { localizedStatus, translate, useI18n } from "../i18n";
import type { Project, Snapshot } from "../types";
import { Banner, Empty, Field, Modal, Page, Status } from "../ui";
import { message, useResource } from "../useResource";

export function Mcp({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const { t } = useI18n();
  const runtime = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey, 3000);
  const configured = useResource<Record<string, unknown>>(`/api/v1/projects/${project.id}/mcp/configuration`, refreshKey);
  const global = useResource<Record<string, unknown>>(`/api/v1/projects/${project.id}/mcp/global`, refreshKey);
  const effective = useResource<Record<string, unknown>>(`/api/v1/projects/${project.id}/mcp/effective`, refreshKey);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const names = Array.from(new Set([...Object.keys(configured.data ?? {}), ...Object.keys(global.data ?? {}), ...Object.keys(effective.data ?? {}), ...Object.keys(runtime.data?.mcp ?? {})])).sort();

  return <Page title={t("mcp.title")} description={t("mcp.description")} action={<button className="primary-button" onClick={() => setEditing("new")}><Plus size={16} /> {t("mcp.add")}</button>}>
    {(runtime.error || configured.error || global.error || effective.error) && <Banner tone="danger">{runtime.error || configured.error || global.error || effective.error}</Banner>}
    <div className="context-summary mcp-context-summary"><div><small>{translate("common.globalScope")}</small><strong>{translate("mcp.baseSetting")}</strong><span>{translate("mcp.baseSettingDetail")}</span></div><div><small>{translate("workspace.projectScopeOption")}</small><strong>{translate("mcp.localSetting")}</strong><span>{translate("mcp.localSettingDetail")}</span></div><div><small>{translate("mcp.runtimeLabel")}</small><strong>{translate("mcp.runtimeConnection")}</strong><span>{translate("mcp.runtimeConnectionDetail")}</span></div></div>
    <div className="resource-grid mcp-grid">
      {names.map((name) => {
        const status = runtime.data?.mcp?.[name]?.status ?? "unknown";
        const effectiveConfig = (effective.data?.[name] ?? {}) as Record<string, unknown>;
        const local = Object.hasOwn(configured.data ?? {}, name);
        const inherited = Object.hasOwn(global.data ?? {}, name);
        const hasEffectiveConfig = Object.hasOwn(effective.data ?? {}, name);
        const savedConfig = (local ? configured.data?.[name] : inherited ? global.data?.[name] : undefined) as Record<string, unknown> | undefined;
        const displayedConfig = hasEffectiveConfig ? effectiveConfig : savedConfig ?? {};
        const hasSavedConfig = hasEffectiveConfig || Boolean(savedConfig);
        const configState = effective.data === null ? translate("mcp.configStateUnknown") : !hasSavedConfig ? translate("mcp.configStateMissing") : displayedConfig.enabled === false ? translate("mcp.configStateDisabled") : translate("mcp.configStateEnabled");
        const source = local ? (inherited ? translate("mcp.sourceProjectOverride") : translate("mcp.sourceProjectOnly")) : inherited ? translate("mcp.sourceInheritedGlobal") : translate("mcp.sourceRuntimeOnly");
        return <button className="resource-card mcp-card" key={name} onClick={() => setEditing(name)}><span className="resource-icon"><Network size={19} /></span><div><h3>{name}</h3><p>{source}</p><code className="mcp-target" title={mcpTarget(displayedConfig)}>{mcpTarget(displayedConfig)}</code><div className="resource-tags">{inherited && <span className="scope-global">{translate("workspace.globalScopeLabel")}</span>}{local && <span className="scope-project">{translate("workspace.projectScopeLabel")}</span>}<span className={hasSavedConfig && displayedConfig.enabled !== false ? "state-enabled" : displayedConfig.enabled === false ? "state-disabled" : ""}>{configState}</span></div></div><Status value={status} /></button>;
      })}
      {names.length === 0 && <Empty icon={<Network />} title={translate("mcp.emptyTitle")} detail={translate("mcp.emptyDetail")} />}
    </div>
    {editing && <McpEditor project={project} name={editing} localConfig={editing === "new" ? {} : (configured.data?.[editing] as Record<string, unknown> ?? {})} globalConfig={editing === "new" ? {} : (global.data?.[editing] as Record<string, unknown> ?? {})} effectiveConfig={editing === "new" ? {} : (effective.data?.[editing] as Record<string, unknown> ?? {})} status={editing === "new" ? undefined : runtime.data?.mcp?.[editing]} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); configured.reload(); global.reload(); effective.reload(); runtime.reload(); }} />}
  </Page>;
}

function McpEditor({ project, name, localConfig, globalConfig, effectiveConfig, status, onClose, onSaved }: { project: Project; name: string | "new"; localConfig: Record<string, unknown>; globalConfig: Record<string, unknown>; effectiveConfig: Record<string, unknown>; status?: { status?: string; error?: string }; onClose: () => void; onSaved: () => void }) {
  const hasProject = name !== "new" && Object.keys(localConfig).length > 0;
  const hasGlobal = name !== "new" && Object.keys(globalConfig).length > 0;
  const [id, setId] = useState(name === "new" ? "" : name);
  const [scope, setScope] = useState<"project" | "global">(hasProject || name === "new" ? "project" : "global");
  const initialConfig = scope === "global" ? globalConfig : hasProject ? localConfig : name === "new" ? { type: "local", command: ["npx", "-y", "@example/mcp"], enabled: true } : { enabled: effectiveConfig.enabled !== false };
  const [raw, setRaw] = useState(JSON.stringify(initialConfig, null, 2));
  const [error, setError] = useState<string | null>(null);
  const fallbackEnabled = typeof localConfig.enabled === "boolean" ? localConfig.enabled : globalConfig.enabled !== false;
  const effectiveEnabled = Object.keys(effectiveConfig).length > 0 ? effectiveConfig.enabled !== false : fallbackEnabled;
  const globalEnabled = globalConfig.enabled !== false;
  const projectEnabled = effectiveEnabled;

  function selectScope(next: "project" | "global") {
    setScope(next);
    const nextConfig = next === "global" ? (hasGlobal ? globalConfig : { type: "local", command: ["npx", "-y", "@example/mcp"], enabled: true }) : (hasProject ? localConfig : name === "new" ? { type: "local", command: ["npx", "-y", "@example/mcp"], enabled: true } : { enabled: effectiveEnabled });
    setRaw(JSON.stringify(nextConfig, null, 2));
  }

  async function applyConfiguration(action: () => Promise<unknown>) {
    await action();
    onSaved();
  }

  async function save() {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      await applyConfiguration(() => api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(id)}`, { method: "PUT", ...jsonBody({ config: parsed, scope }) }));
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function setEnabled(changedScope: "project" | "global", enabled: boolean) {
    try {
      await applyConfiguration(() => api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(id)}/enabled`, { method: "PATCH", ...jsonBody({ enabled, scope: changedScope }) }));
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function remove(changedScope: "project" | "global") {
    if (name === "new" || !confirm(changedScope === "global" ? translate("mcpEditor.deleteGlobalConfirm", { value0: name }) : translate("mcpEditor.deleteProjectConfirm", { value0: name }))) return;
    try {
      await applyConfiguration(() => api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(name)}?scope=${changedScope}`, { method: "DELETE" }));
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function connect() {
    try {
      await api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(id)}/connect`, { method: "POST", ...jsonBody({}) });
      onSaved();
    } catch (reason) {
      setError(message(reason));
    }
  }

  const runtimeStatus = status?.status ?? "unknown";
  let commonStdioFormat = false;
  try {
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    commonStdioFormat = candidate.transport === "stdio" && typeof candidate.command === "string";
  } catch {
    // The save action reports JSON syntax errors.
  }
  const scopeConfigured = scope === "global" ? hasGlobal : hasProject;
  const scopeEnabled = scope === "global" ? globalEnabled : projectEnabled;
  const scopeTitle = scope === "global" ? translate("mcpEditor.globalSettingTitle") : translate("mcpEditor.projectSettingTitle", { value0: project.name });
  const scopeDescription = scope === "global" ? translate("mcpEditor.globalSettingDetail") : hasProject ? translate("mcpEditor.projectOverrideDetail") : hasGlobal ? translate("mcpEditor.projectInheritedDetail") : translate("mcpEditor.projectOnlyDetail");

  return <Modal wide title={name === "new" ? translate("mcpEditor.addTitle") : `MCP: ${name}`} subtitle={name === "new" ? translate("mcpEditor.addSubtitle") : translate("mcpEditor.editSubtitle")} onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    {status?.status === "failed" && <Banner tone="danger">{translate("mcpEditor.connectionFailed")}</Banner>}
    {name !== "new" && <div className="mcp-state-grid">
      <div><small>{translate("common.globalScope")}</small><strong>{hasGlobal ? (globalEnabled ? translate("mcpEditor.enabled") : translate("mcpEditor.disabled")) : translate("mcpEditor.notConfigured")}</strong><span>{hasGlobal ? translate("mcp.baseSetting") : translate("mcpEditor.noGlobalSetting")}</span></div>
      <div><small>{translate("mcpEditor.projectScopeLabel")}</small><strong>{hasProject ? (projectEnabled ? translate("mcpEditor.enabled") : translate("mcpEditor.disabled")) : translate("mcpEditor.inherited")}</strong><span>{hasProject ? translate("mcpEditor.localOverride") : hasGlobal ? translate("mcpEditor.usesGlobalSetting") : translate("mcpEditor.noSetting")}</span></div>
      <div className={`runtime-${runtimeStatus}`}><small>{translate("mcp.runtimeLabel")}</small><strong>{localizedStatus(runtimeStatus)}</strong><span>{runtimeStatus === "connected" ? translate("mcpEditor.runtimeConnectedDetail") : translate("mcpEditor.runtimeStateDetail")}</span></div>
    </div>}
    <Banner tone="notice">{translate("mcpEditor.autoApplyNotice")}</Banner>
    <div className="form-row"><Field label={translate("mcpEditor.serverNameLabel")}><input className="mono" value={id} onChange={(event) => setId(event.target.value)} disabled={name !== "new"} placeholder="playwright" /></Field><Field label={translate("mcpEditor.scopeLabel")}><select value={scope} onChange={(event) => selectScope(event.target.value as "project" | "global")}><option value="project">{translate("workspace.projectOnly")} {project.name}</option><option value="global">{translate("workspace.allProjects")}</option></select></Field></div>
    <textarea aria-label={translate("mcpEditor.configAria")} className="code-editor modal-editor short" value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} />
    {commonStdioFormat && <Banner tone="notice">{translate("mcpEditor.stdioPrefix")} <code>command</code>  {translate("mcpEditor.and")} <code>args</code>  {translate("mcpEditor.stdioSuffix")}</Banner>}
    <Banner tone="notice">{translate("mcpEditor.secretsPrefix")} <code>[REDACTED]</code>  {translate("mcpEditor.secretsMiddle")} <code>{`{file:...}`}</code>  {translate("mcpEditor.and")} <code>{`{env:...}`}</code>  {translate("mcpEditor.secretsSuffix")}</Banner>
    {name !== "new" && <div className="mcp-scope-control"><div><small>{scope === "global" ? translate("workspace.allProjects") : translate("mcpEditor.projectOnlyLabel")}</small><strong>{scopeTitle}</strong><p>{scopeDescription}</p></div><div className="mcp-scope-buttons"><button className="secondary-button" onClick={() => void setEnabled(scope, !scopeEnabled)}>{scopeEnabled ? (scope === "global" ? translate("mcpEditor.disableGlobal") : translate("mcpEditor.disableProject")) : (scope === "global" ? translate("mcpEditor.enableGlobal") : translate("mcpEditor.enableProject"))}</button>{scopeConfigured && <button className={scope === "project" && hasGlobal ? "secondary-button" : "danger-button"} onClick={() => void remove(scope)}>{scope === "project" && hasGlobal ? <RefreshCw size={15} /> : <Trash2 size={15} />} {scope === "global" ? translate("mcpEditor.deleteGlobal") : hasGlobal ? translate("mcpEditor.useGlobal") : translate("mcpEditor.deleteProject")}</button>}</div></div>}
    {name !== "new" && runtimeStatus !== "connected" && effectiveEnabled && <div className="mcp-runtime-retry"><div><strong>{translate("mcpEditor.disconnectedTitle")}</strong><span>{translate("mcpEditor.disconnectedDetail")}</span></div><button className="secondary-button" onClick={() => void connect()}>{translate("mcpEditor.reconnect")}</button></div>}
    <div className="modal-actions"><span /><button className="secondary-button" onClick={onClose}>{translate("mcpEditor.close")}</button><button className="primary-button" onClick={() => void save()} disabled={!id}>{translate("common.save")} {scope === "global" ? translate("workspace.globalScopeLabel") : translate("workspace.projectScopeLabel")}</button></div>
  </Modal>;
}

function mcpTarget(config: Record<string, unknown>) {
  if (typeof config.url === "string") return config.url;
  if (Array.isArray(config.command)) return config.command.join(" ");
  return translate("mcp.missingTargetAddress");
}
