import { Bot, Braces, Check, ChevronDown, CircleStop, FolderGit2, FolderOpen, Globe2, Network, Play, Search, SquareTerminal } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, jsonBody } from "./api";
import { translate, useI18n } from "./i18n";
import { themes } from "./theme";
import type { Project } from "./types";
import { Banner, Field, Modal, Status } from "./ui";
import { message, useResource } from "./useResource";

export function ServerControl({ project, onChange }: { project: Project; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useResource<Project["server"]>(`/api/v1/projects/${project.id}/server`, project.id, 3000);
  const server = status.data ?? project.server;
  const running = server.state === "running";
  const external = server.state === "external";
  const compatibility = server.compatibility;
  const lastError = server.last_error;
  async function toggle() {
    if (external) return;
    setBusy(true);
    try { await api(`/api/v1/projects/${project.id}/server/${running ? "stop" : "start"}`, { method: "POST", ...jsonBody({}) }); setError(null); status.reload(); onChange(); }
    catch (reason) { setError(message(reason)); status.reload(); onChange(); }
    finally { setBusy(false); }
  }
  const title = error ?? (lastError ? `${lastError.summary}\n${lastError.log_path}` : compatibility?.message ?? server.endpoint ?? undefined);
  const label = error || lastError ? "error" : busy ? "working" : running ? "running" : external ? "external" : "start";
  return <button title={title} aria-label={running ? translate("server.stop") : external ? translate("server.externalAria") : translate("server.startAria")} className={`server-control ${running || external ? "online" : ""} compatibility-${compatibility?.state ?? "unknown"}`} onClick={() => void toggle()} disabled={busy || external}><span className="status-dot" /><span className="server-label-full">{translate(`server.${label}`)}</span><span className="server-label-short">{translate(`server.${label}Short`)}</span>{compatibility?.version && <small>{compatibility.version}</small>}{running ? <CircleStop size={14} /> : <Play size={14} />}</button>;
}

export function ProjectDialog({ projects, onClose, onCreated, onSelect }: { projects: Project[]; onClose: () => void; onCreated: (project: Project) => void; onSelect: (id: string) => void }) {
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectingDirectory, setSelectingDirectory] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const project = await api<Project>("/api/v1/projects", { method: "POST", ...jsonBody({ name, root, endpoint: endpoint || null }) });
      onCreated(project);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function selectDirectory() {
    setSelectingDirectory(true);
    try {
      const selected = await api<{ path: string | null }>("/api/v1/system/select-directory", { method: "POST", ...jsonBody({}) });
      if (!selected.path) return;
      setRoot(selected.path);
      const parts = selected.path.split("/").filter(Boolean);
      const folderName = parts[parts.length - 1] ?? "";
      if (folderName) setName((current) => current.trim() ? current : folderName);
      setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 409
        ? translate("projectDialog.folderPickerBusy")
        : reason instanceof ApiError && [501, 503, 504].includes(reason.status)
          ? translate("projectDialog.folderPickerUnavailable")
          : message(reason));
    } finally {
      setSelectingDirectory(false);
    }
  }

  return <Modal title={translate("projectDialog.title")} subtitle={translate("projectDialog.subtitle")} onClose={onClose}>
    <div className="project-list">{projects.map((project) => <button key={project.id} onClick={() => onSelect(project.id)}><span className="project-avatar">{project.name.slice(0, 2).toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.root}</small></span><Status value={project.server.state === "running" ? "connected" : project.server.state} /></button>)}</div>
    <div className="modal-divider"><span>{translate("projectDialog.add")}</span></div>
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label={translate("common.name")}><input value={name} onChange={(event) => setName(event.target.value)} required placeholder={translate("projectDialog.namePlaceholder")} /></Field>
      <div className="field">
        <label htmlFor="project-directory">{translate("projectDialog.folder")}</label>
        <div className="directory-input"><input id="project-directory" className="mono" value={root} onChange={(event) => setRoot(event.target.value)} required placeholder="/Users/you/code/payments" /><button type="button" className="secondary-button" onClick={() => void selectDirectory()} disabled={selectingDirectory || busy}><FolderOpen size={16} /> {translate(selectingDirectory ? "projectDialog.selectingFolder" : "projectDialog.selectFolder")}</button></div>
        <small>{translate("projectDialog.folderHint")}</small>
      </div>
      <Field label={translate("projectDialog.externalEndpoint")} hint={translate("projectDialog.externalEndpointHint")}><input className="mono" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4096" /></Field>
      <button className="primary-button full" disabled={busy || selectingDirectory}>{busy ? translate("projectDialog.adding") : translate("projectDialog.add")}</button>
    </form>
  </Modal>;
}

export function ThemeDialog({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = themes.filter((theme) => theme.name.toLowerCase().includes(query.trim().toLowerCase()) || theme.id.includes(query.trim().toLowerCase()));
  return <Modal title={translate("theme.title")} subtitle={translate("theme.subtitle")} onClose={onClose}><div className="theme-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={translate("theme.search")} /></div><div className="theme-list" role="listbox">{filtered.map((theme) => <button type="button" role="option" aria-selected={theme.id === value} className={theme.id === value ? "selected" : ""} key={theme.id} onClick={() => onChange(theme.id)}><span className="theme-swatches">{theme.colors.slice(0, 3).map((color) => <i key={color} style={{ background: color }} />)}</span><span><strong>{theme.name}</strong><small>{theme.id}</small></span>{theme.id === value && <Check size={16} />}</button>)}{filtered.length === 0 && <p className="picker-empty">{translate("theme.empty")}</p>}</div></Modal>;
}

export function LanguageMenu() {
  const { locale, setLocale, t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const currentLabel = t(locale === "ru" ? "locale.ru" : "locale.en");

  function select(next: "ru" | "en") {
    setLocale(next);
    if (details.current) details.current.open = false;
  }

  return <details ref={details} className="language-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
    <summary aria-label={`${t("locale.switch")}: ${currentLabel}`} title={t("locale.switch")}><Globe2 size={16} /><span>{currentLabel}</span><ChevronDown size={13} /></summary>
    <div className="language-popover">
      <p>{t("locale.switch")}</p>
      <button className={locale === "ru" ? "selected" : ""} aria-pressed={locale === "ru"} onClick={() => select("ru")}><span className="language-flag" aria-hidden="true">🇷🇺</span><span>{t("locale.ru")}</span>{locale === "ru" && <Check size={17} />}</button>
      <button className={locale === "en" ? "selected" : ""} aria-pressed={locale === "en"} onClick={() => select("en")}><span className="language-flag" aria-hidden="true">🇬🇧</span><span>{t("locale.en")}</span>{locale === "en" && <Check size={17} />}</button>
    </div>
  </details>;
}

export function Welcome({ onAdd }: { onAdd: () => void }) { return <div className="welcome"><div className="welcome-art"><div className="orbit one" /><div className="orbit two" /><SquareTerminal /></div><p className="eyebrow">{translate("welcome.eyebrow")}</p><h1>{translate("welcome.titleFirst")}<br />{translate("welcome.titleSecond")}</h1><p>{translate("welcome.description")}</p><button className="primary-button large-button" onClick={onAdd}><FolderGit2 size={18} />  {translate("welcome.addFirstProject")}</button><div className="welcome-features"><span><Bot />  {translate("welcome.agents")}</span><span><Network />  {translate("welcome.mcp")}</span><span><Braces />  {translate("welcome.nativeConfig")}</span></div></div>; }

export function FullState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="full-state"><div className="brand-mark">{icon}</div><h1>{title}</h1><p>{detail}</p></div>; }
