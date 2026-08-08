import {
  Bot,
  ChevronDown,
  CircleStop,
  FileCode2,
  Gauge,
  KeyRound,
  Menu,
  MessageSquareText,
  Network,
  Palette,
  Plug,
  RefreshCw,
  Search as SearchIcon,
  Settings,
  Sparkles,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { api } from "./api";
import { AgentCoreMark } from "./AgentCoreMark";
import { I18nProvider, translate, useI18n, type TranslationKey } from "./i18n";
import { FullState, LanguageMenu, ProjectDialog, ServerControl, ThemeDialog, Welcome } from "./ShellComponents";
import { applyTheme, normalizeTheme, themes } from "./theme";
import type { Project } from "./types";
import { message, useResource } from "./useResource";

export { contrastText, themes } from "./theme";

const AgentsSkills = lazy(() => import("./screens/AgentsSkills").then((module) => ({ default: module.AgentsSkills })));
const Commands = lazy(() => import("./screens/Commands").then((module) => ({ default: module.Commands })));
const Dashboard = lazy(() => import("./screens/Dashboard").then((module) => ({ default: module.Dashboard })));
const Instructions = lazy(() => import("./screens/Instructions").then((module) => ({ default: module.Instructions })));
const Mcp = lazy(() => import("./screens/Mcp").then((module) => ({ default: module.Mcp })));
const ProjectSettings = lazy(() => import("./screens/ProjectSettings").then((module) => ({ default: module.ProjectSettings })));
const Providers = lazy(() => import("./screens/Providers").then((module) => ({ default: module.Providers })));
const Secrets = lazy(() => import("./screens/Secrets").then((module) => ({ default: module.Secrets })));
const SearchScreen = lazy(() => import("./screens/Search").then((module) => ({ default: module.Search })));
const Sessions = lazy(() => import("./screens/Sessions").then((module) => ({ default: module.Sessions })));
const Tasks = lazy(() => import("./screens/Tasks").then((module) => ({ default: module.Tasks })));

type View =
  | "overview"
  | "sessions"
  | "search"
  | "tasks"
  | "agents"
  | "skills"
  | "commands"
  | "providers"
  | "secrets"
  | "mcp"
  | "instructions"
  | "settings";

type SessionTarget = { projectId: string; sessionId: string; messageId: string | null; query: string };

const nav: Array<{ group: TranslationKey; items: Array<{ id: View; label: TranslationKey; icon: typeof Gauge }> }> = [
  {
    group: "nav.work",
    items: [
      { id: "overview", label: "nav.overview", icon: Gauge },
      { id: "sessions", label: "nav.sessions", icon: MessageSquareText },
      { id: "search", label: "nav.search", icon: SearchIcon },
      { id: "tasks", label: "nav.tasks", icon: Zap },
    ],
  },
  {
    group: "nav.settings",
    items: [
      { id: "agents", label: "nav.agents", icon: Bot },
      { id: "skills", label: "nav.skills", icon: Sparkles },
      { id: "commands", label: "nav.commands", icon: SquareTerminal },
      { id: "providers", label: "nav.providers", icon: Plug },
      { id: "secrets", label: "nav.secrets", icon: KeyRound },
      { id: "mcp", label: "nav.mcp", icon: Network },
      { id: "instructions", label: "nav.instructions", icon: FileCode2 },
      { id: "settings", label: "nav.projectSettings", icon: Settings },
    ],
  },
];

export function App() {
  return <I18nProvider><ControlApp /></I18nProvider>;
}

function ControlApp() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState(() => sessionTargetFromLocation()?.projectId ?? window.localStorage.getItem("control-project"));
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => normalizeTheme(window.localStorage.getItem("control-theme")));
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionTarget, setSessionTarget] = useState<SessionTarget | null>(() => sessionTargetFromLocation());
  const controlHealth = useResource<{ healthy: boolean; version: string }>(
    "/api/v1/health",
    refreshKey,
    60000,
  );

  useEffect(() => {
    let active = true;
    async function loadProjects() {
      try {
        const next = await api<Project[]>("/api/v1/projects");
        if (!active) return;
        setProjects(next);
        setError(null);
        if (!activeId && next[0]) setActiveId(next[0].id);
        if (activeId && !next.some((project) => project.id === activeId)) {
          setActiveId(next[0]?.id ?? null);
        }
      } catch (reason) {
        if (active) setError(message(reason));
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadProjects();
    return () => { active = false; };
  }, [refreshKey, activeId]);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem("control-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (activeId) window.localStorage.setItem("control-project", activeId);
  }, [activeId]);

  useEffect(() => {
    function popstate() {
      const target = sessionTargetFromLocation();
      setView(viewFromPath(location.pathname));
      setSessionTarget(target);
      if (target) setActiveId(target.projectId);
    }
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, []);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      if (viewFromPath(location.pathname) === "search") {
        const input = document.querySelector<HTMLInputElement>(".search-input input");
        input?.focus();
        input?.select();
        return;
      }
      history.pushState({}, "", "/search");
      setSessionTarget(null);
      setView("search");
      setMobileOpen(false);
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  function navigate(next: View) {
    setSessionTarget(null);
    setView(next);
    history.pushState({}, "", next === "overview" ? "/" : `/${next}`);
    setMobileOpen(false);
  }

  function openSearchSession(projectId: string, sessionId: string, messageId: string | null, query: string) {
    const target = { projectId, sessionId, messageId, query };
    setActiveId(projectId);
    setSessionTarget(target);
    setView("sessions");
    history.pushState({}, "", sessionTargetUrl(target));
    setMobileOpen(false);
  }

  const project = projects.find((item) => item.id === activeId) ?? null;

  if (loading) return <FullState icon={<RefreshCw className="spin" />} title={t("app.starting")} detail={t("app.loading")} />;
  if (error && projects.length === 0) return <FullState icon={<CircleStop />} title={t("app.unavailable")} detail={error} />;

  return (
    <div className="control-shell">
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><AgentCoreMark /></div>
          <div><strong>OpenCode</strong><span>Control</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label={t("app.closeNavigation")} title={t("app.closeNavigation")}><X /></button>
        </div>

        <button className="project-switcher" aria-haspopup="dialog" onClick={() => setAddOpen(true)}>
          <span className="project-avatar">{project?.name.slice(0, 2).toUpperCase() ?? "＋"}</span>
          <span><small>{t("app.currentProject")}</small><strong>{project?.name ?? t("app.addProject")}</strong></span>
          <ChevronDown size={16} />
        </button>

        <nav>
          {nav.map((section) => (
            <div className="nav-section" key={section.group}>
              <p>{t(section.group)}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)} disabled={!project}>
                    <Icon size={17} /><span>{t(item.label)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="theme-toggle" onClick={() => setThemeOpen(true)}>
            <Palette size={16} />
            {t("app.theme", { theme: themes.find((item) => item.id === theme)?.name ?? "OpenCode" })}
          </button>
          <span>Control {controlHealth.data?.version ?? "—"}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label={t("app.openNavigation")} title={t("app.openNavigation")}><Menu /></button>
          <div className="breadcrumbs"><span>{project?.name ?? t("app.workspace")}</span><b>/</b><strong>{labelFor(view, t)}</strong></div>
          <div className="topbar-actions">
            <LanguageMenu />
            {project && <ServerControl project={project} onChange={() => setRefreshKey((value) => value + 1)} />}
            <button className="icon-button" onClick={() => setRefreshKey((value) => value + 1)} aria-label={t("app.refresh")} title={t("app.refresh")}><RefreshCw size={17} /></button>
          </div>
        </header>

        <div className="content">
          {project?.server.last_error && <details className="server-diagnostic"><summary>{project.server.last_error.summary}</summary><div><span>{t("app.phase", { phase: project.server.last_error.phase })}{project.server.last_error.exit_code != null ? ` · exit ${project.server.last_error.exit_code}` : ""}</span>{project.server.last_error.detail && <pre>{project.server.last_error.detail}</pre>}<code>{project.server.last_error.log_path}</code></div></details>}
          {!project ? (
            <Welcome onAdd={() => setAddOpen(true)} />
          ) : (
            <ViewErrorBoundary key={`${project.id}:${view}`}><Suspense fallback={<ScreenLoading />}><ViewContent view={view} project={project} refreshKey={refreshKey} sessionTarget={sessionTarget?.projectId === project.id ? sessionTarget : null} onSessionTargetHandled={() => setSessionTarget(null)} onOpenSearchSession={openSearchSession} onProjectChange={() => setRefreshKey((value) => value + 1)} navigate={navigate} /></Suspense></ViewErrorBoundary>
          )}
        </div>
      </main>

      {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label={t("app.closeNavigation")} />}
      {addOpen && <ProjectDialog projects={projects} onClose={() => setAddOpen(false)} onCreated={(created) => { setActiveId(created.id); setAddOpen(false); setRefreshKey((value) => value + 1); }} onSelect={(id) => { setActiveId(id); setAddOpen(false); }} />}
      {themeOpen && <ThemeDialog value={theme} onChange={(next) => { setTheme(next); setThemeOpen(false); }} onClose={() => setThemeOpen(false)} />}
    </div>
  );
}

function ScreenLoading() {
  const { t } = useI18n();
  return <div className="screen-loading" role="status"><RefreshCw className="spin" /><span>{t("app.loadingView")}</span></div>;
}

class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message || translate("app.unknownViewError") }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("OpenCode Control view failed", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="view-error"><CircleStop /><h1>{translate("app.viewFailed")}</h1><p>{this.state.error}</p><button className="primary-button" onClick={() => location.reload()}><RefreshCw size={15} /> {translate("app.reload")}</button></div>;
  }
}

function ViewContent({ view, project, refreshKey, sessionTarget, onSessionTargetHandled, onOpenSearchSession, onProjectChange, navigate }: { view: View; project: Project; refreshKey: number; sessionTarget: { sessionId: string; messageId: string | null; query: string } | null; onSessionTargetHandled: () => void; onOpenSearchSession: (projectId: string, sessionId: string, messageId: string | null, query: string) => void; onProjectChange: () => void; navigate: (view: View) => void }) {
  if (view === "overview") return <Dashboard project={project} refreshKey={refreshKey} onOpenTasks={() => navigate("tasks")} onOpenSessions={() => navigate("sessions")} />;
  if (view === "sessions") return <Sessions project={project} refreshKey={refreshKey} initialSearchTarget={sessionTarget} onInitialSessionHandled={onSessionTargetHandled} />;
  if (view === "search") return <SearchScreen project={project} onOpenSession={onOpenSearchSession} />;
  if (view === "tasks") return <Tasks project={project} refreshKey={refreshKey} />;
  if (view === "agents") return <AgentsSkills project={project} kind="agents" refreshKey={refreshKey} />;
  if (view === "skills") return <AgentsSkills project={project} kind="skills" />;
  if (view === "commands") return <Commands project={project} refreshKey={refreshKey} />;
  if (view === "providers") return <Providers project={project} refreshKey={refreshKey} />;
  if (view === "secrets") return <Secrets />;
  if (view === "mcp") return <Mcp project={project} refreshKey={refreshKey} />;
  if (view === "instructions") return <Instructions project={project} />;
  return <ProjectSettings project={project} onChange={onProjectChange} />;
}

function viewFromPath(path: string): View { const candidate = path.split("/")[1] as View; return nav.flatMap((group) => group.items).some((item) => item.id === candidate) ? candidate : "overview"; }
function sessionTargetFromLocation(): SessionTarget | null { if (viewFromPath(location.pathname) !== "sessions") return null; const parameters = new URLSearchParams(location.search); const projectId = parameters.get("project"); const sessionId = parameters.get("session"); return projectId && sessionId ? { projectId, sessionId, messageId: parameters.get("message"), query: parameters.get("q") ?? "" } : null; }
function sessionTargetUrl(target: SessionTarget) { const parameters = new URLSearchParams({ project: target.projectId, session: target.sessionId }); if (target.messageId) parameters.set("message", target.messageId); if (target.query) parameters.set("q", target.query); return `/sessions?${parameters}`; }
function labelFor(view: View, t: ReturnType<typeof import("./i18n").createTranslator>) { const key = nav.flatMap((group) => group.items).find((item) => item.id === view)?.label; return t(key ?? "nav.overviewFallback"); }
