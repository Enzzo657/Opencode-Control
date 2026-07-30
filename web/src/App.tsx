import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  BrainCircuit,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  CircleDollarSign,
  CircleStop,
  Copy,
  Cpu,
  Download,
  File,
  FileCode2,
  FolderGit2,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  KeyRound,
  Menu,
  MessageSquareText,
  Maximize2,
  Minus,
  Network,
  Paperclip,
  Palette,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Minimize2,
  X,
  Zap,
} from "lucide-react";
import { Component, lazy, memo, Suspense, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ErrorInfo, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, jsonBody } from "./api";
import type { Agent, Attachment, CommandItem, GitState, Project, ProviderAuthEntry, ProviderSummary, RuntimeConfig, SecretInfo, Session, SkillImportPreview, Snapshot, Task, WorkspaceItem } from "./types";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

type View =
  | "overview"
  | "sessions"
  | "tasks"
  | "agents"
  | "skills"
  | "commands"
  | "providers"
  | "secrets"
  | "mcp"
  | "instructions"
  | "settings";

const nav: Array<{ group: string; items: Array<{ id: View; label: string; icon: typeof Gauge }> }> = [
  {
    group: "Работа",
    items: [
      { id: "overview", label: "Обзор", icon: Gauge },
      { id: "sessions", label: "Сессии", icon: MessageSquareText },
      { id: "tasks", label: "Задачи", icon: Zap },
    ],
  },
  {
    group: "Настройки",
    items: [
      { id: "agents", label: "Агенты", icon: Bot },
      { id: "skills", label: "Навыки", icon: Sparkles },
      { id: "commands", label: "Команды", icon: SquareTerminal },
      { id: "providers", label: "Провайдеры", icon: Plug },
      { id: "secrets", label: "Секреты", icon: KeyRound },
      { id: "mcp", label: "MCP-серверы", icon: Network },
      { id: "instructions", label: "AGENTS.md", icon: FileCode2 },
      { id: "settings", label: "Настройки проекта", icon: Settings },
    ],
  },
];

type ThemePreset = { id: string; name: string; mode?: "light"; colors: [string, string, string, string, string, string, string, string, string, string] };

export const themes: ThemePreset[] = [
  { id: "opencode", name: "OpenCode", colors: ["#0b0d10", "#12161b", "#1b2128", "#f4efe9", "#9199a5", "#ff8a4c", "#7aa2ff", "#56d39b", "#ff5f6d", "#4cc9f0"] },
  { id: "opencode-light", name: "OpenCode Light", mode: "light", colors: ["#f7f3ec", "#fffaf2", "#ebe4d9", "#251f1a", "#756b61", "#1769aa", "#b35c00", "#238636", "#c62836", "#006d77"] },
  { id: "amoled", name: "AMOLED", colors: ["#000000", "#050505", "#101014", "#f7f7fb", "#92929d", "#00e5ff", "#ff4fd8", "#39ff88", "#ff3b5c", "#7c5cff"] },
  { id: "aura", name: "Aura", colors: ["#15141b", "#1a1826", "#252238", "#edecee", "#8c8a9e", "#a277ff", "#ffca85", "#61ffca", "#ff6767", "#82e2ff"] },
  { id: "ayu", name: "Ayu", colors: ["#0a0d12", "#121720", "#1c2430", "#e6e1d8", "#8993a2", "#f2b84b", "#ff7a45", "#b7e35b", "#ff6673", "#49bdf2"] },
  { id: "carbonfox", name: "Carbonfox", colors: ["#101214", "#1b1f23", "#272c32", "#f4f7fb", "#939ba7", "#4f9cff", "#c58aff", "#38c172", "#ff5260", "#25c2d7"] },
  { id: "catppuccin", name: "Catppuccin Mocha", colors: ["#181622", "#211d2e", "#302a40", "#f2e9ff", "#9c90ad", "#d8a7ff", "#ff9bcf", "#8fe3b0", "#ff7a90", "#74c7ec"] },
  { id: "catppuccin-frappe", name: "Catppuccin Frappé", colors: ["#252b3d", "#30384e", "#3d4861", "#e7ecff", "#9ba7c2", "#7dc4ff", "#f0a6ca", "#a8d98f", "#f28f9d", "#8bd5ca"] },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", colors: ["#16202e", "#1d2a3b", "#293a50", "#edf5ff", "#879bb4", "#a88bff", "#f5bde6", "#7ee0b8", "#ff7f8f", "#6fd3ff"] },
  { id: "cobalt2", name: "Cobalt2", colors: ["#193549", "#1f4662", "#254f6d", "#ffffff", "#9caeb8", "#ffc600", "#ff9d00", "#3ad900", "#ff628c", "#80fcff"] },
  { id: "cursor", name: "Cursor", colors: ["#141414", "#1d1d1d", "#282828", "#f2f2f2", "#969696", "#5ea3ff", "#d38cff", "#70d49b", "#ff6b6b", "#55d6e8"] },
  { id: "dracula", name: "Dracula", colors: ["#1e1f29", "#282a36", "#383a4a", "#f8f8f2", "#9a9caf", "#bd93f9", "#ff79c6", "#50fa7b", "#ff5555", "#8be9fd"] },
  { id: "everforest", name: "Everforest", colors: ["#202923", "#2a342d", "#354139", "#e3d9b7", "#939b82", "#a7c080", "#d699b6", "#83c092", "#e67e80", "#7fbbb3"] },
  { id: "flexoki", name: "Flexoki Light", mode: "light", colors: ["#f2f0e5", "#fffcf0", "#e6e4d9", "#100f0f", "#6f6e69", "#d14d41", "#8b7ec8", "#66800b", "#af3029", "#24837b"] },
  { id: "github", name: "GitHub Light", mode: "light", colors: ["#f6f8fa", "#ffffff", "#eaeef2", "#1f2328", "#656d76", "#0969da", "#8250df", "#1a7f37", "#cf222e", "#0969da"] },
  { id: "gruvbox", name: "Gruvbox", colors: ["#1d2021", "#282828", "#3c3836", "#ebdbb2", "#a89984", "#fabd2f", "#d3869b", "#b8bb26", "#fb4934", "#83a598"] },
  { id: "kanagawa", name: "Kanagawa", colors: ["#16161d", "#1f1f28", "#2a2a37", "#dcd7ba", "#8a8980", "#e6c384", "#957fb8", "#98bb6c", "#e82424", "#7fb4ca"] },
  { id: "lucent-orng", name: "Lucent Orange", colors: ["#120c08", "#1d120c", "#2c1b11", "#fff3e8", "#a78b7a", "#ff7a1a", "#ffc05c", "#78dba9", "#ff5252", "#6cb6ff"] },
  { id: "material", name: "Material Ocean", colors: ["#101a20", "#17242c", "#21333d", "#eeffff", "#8296a0", "#26c6da", "#c792ea", "#c3e88d", "#ff5370", "#82aaff"] },
  { id: "matrix", name: "Matrix", colors: ["#000000", "#031008", "#082415", "#b7ffbf", "#3d9b55", "#00ff41", "#9cff57", "#39ff14", "#ff3b3b", "#00cc88"] },
  { id: "mercury", name: "Mercury Light", mode: "light", colors: ["#f4f4f2", "#ffffff", "#e8e8e4", "#181817", "#6e6e68", "#343434", "#d12f6a", "#39845a", "#c9363e", "#2b6f9f"] },
  { id: "monokai", name: "Monokai Pro", colors: ["#191a16", "#272822", "#3a3b32", "#f8f8f2", "#9b9b8d", "#a6e22e", "#f92672", "#66d9a3", "#f92672", "#66d9ef"] },
  { id: "nightowl", name: "Night Owl", colors: ["#00111d", "#011b2b", "#082a3d", "#d6deeb", "#728b98", "#4ea5ff", "#c792ea", "#addb67", "#ef5350", "#7fdbca"] },
  { id: "nord", name: "Nord", colors: ["#242933", "#2e3440", "#3b4252", "#eceff4", "#8792a5", "#88c0d0", "#b48ead", "#a3be8c", "#bf616a", "#81a1c1"] },
  { id: "one-dark", name: "One Dark", colors: ["#181b20", "#21252b", "#2c313a", "#d7dae0", "#8b929d", "#61afef", "#c678dd", "#98c379", "#e06c75", "#56b6c2"] },
  { id: "osaka-jade", name: "Osaka Jade", colors: ["#081510", "#10221a", "#18352a", "#d8e4c2", "#819685", "#43c98b", "#c5a3ff", "#8fbc8f", "#e46876", "#55d7d0"] },
  { id: "palenight", name: "Palenight", colors: ["#202235", "#292d46", "#373c5c", "#e6e8f4", "#9095b2", "#82aaff", "#c792ea", "#c3e88d", "#f07178", "#89ddff"] },
  { id: "rosepine", name: "Rosé Pine Dawn", mode: "light", colors: ["#faf4ed", "#fffaf3", "#f2e9e1", "#575279", "#797593", "#907aa9", "#d7827e", "#56949f", "#b4637a", "#286983"] },
  { id: "shadesofpurple", name: "Shades of Purple", colors: ["#211d46", "#2d2759", "#40376f", "#ffffff", "#b7abef", "#fad000", "#ff9d00", "#a5ff90", "#ff628c", "#80ffea"] },
  { id: "solarized", name: "Solarized Deep", colors: ["#001f27", "#002b36", "#073f4a", "#eee8d5", "#839496", "#268bd2", "#b58900", "#859900", "#dc322f", "#2aa198"] },
  { id: "synthwave84", name: "SynthWave '84", colors: ["#1b1630", "#27203f", "#3c2d59", "#fff7ff", "#a99bbb", "#ff5fd2", "#f9c74f", "#72f1b8", "#fe4450", "#36f9f6"] },
  { id: "tokyonight", name: "Tokyo Night", colors: ["#10121d", "#1a1b2e", "#252945", "#d5dcff", "#7f89ad", "#7aa2f7", "#bb9af7", "#9ece6a", "#f7768e", "#7dcfff"] },
  { id: "vercel", name: "Vercel Mono", colors: ["#000000", "#0a0a0a", "#1a1a1a", "#fafafa", "#8f8f8f", "#ffffff", "#a1a1aa", "#46a758", "#e5484d", "#52a9ff"] },
  { id: "vesper", name: "Vesper", colors: ["#0d0b0a", "#171412", "#241f1b", "#fff8f2", "#998b82", "#ffc799", "#a0a0ff", "#99ffe4", "#ff8080", "#8abeb7"] },
  { id: "zenburn", name: "Zenburn", colors: ["#30332f", "#3f3f3f", "#515348", "#f0ead2", "#a09c88", "#f0dfaf", "#dc8cc3", "#8fb28f", "#cc7373", "#8cd0d3"] },
  { id: "cyberpunk", name: "Cyberpunk Neon", colors: ["#090014", "#160522", "#25103a", "#f9f4ff", "#9b86b4", "#ff2bd6", "#f9f871", "#00ff9f", "#ff3864", "#00d9ff"] },
  { id: "horizon", name: "Horizon", colors: ["#15161d", "#1c1e26", "#2b2d38", "#f0e9e9", "#99909a", "#e95678", "#fab795", "#29d398", "#ec6a88", "#26bbd9"] },
  { id: "iceberg", name: "Iceberg", colors: ["#10121a", "#161821", "#22263a", "#d5d8e2", "#7c829d", "#84a0c6", "#a093c7", "#b4be82", "#e27878", "#89b8c2"] },
  { id: "moonlight", name: "Moonlight II", colors: ["#191b2d", "#222436", "#333755", "#e2e8ff", "#929ac0", "#82aaff", "#c099ff", "#c3e88d", "#ff757f", "#86e1fc"] },
  { id: "oxocarbon", name: "Oxocarbon", colors: ["#0d0d0d", "#161616", "#292929", "#f2f4f8", "#929292", "#ee5396", "#be95ff", "#42be65", "#ff7eb6", "#3ddbd9"] },
  { id: "poimandres", name: "Poimandres", colors: ["#151823", "#1b1e28", "#293142", "#e4f0fb", "#818aa8", "#5de4c7", "#a6accd", "#5de4a0", "#d0679d", "#89ddff"] },
  { id: "red-alert", name: "Red Alert", colors: ["#120507", "#20090d", "#351218", "#fff0f0", "#b27b82", "#ff364b", "#ff9e64", "#7bd88f", "#ff4655", "#67d8ef"] },
  { id: "seoul256", name: "Seoul 256 Light", mode: "light", colors: ["#e7e2df", "#f2eeeb", "#d8d1cd", "#3a3434", "#7e7373", "#a64f5f", "#775a91", "#4d7b5c", "#b23b46", "#47718d"] },
  { id: "snazzy", name: "Snazzy", colors: ["#1e2028", "#282a36", "#3b3e4c", "#f7f7f2", "#9698a3", "#ff5c57", "#ffb86c", "#5af78e", "#ff5c57", "#9aedfe"] },
  { id: "papercolor", name: "PaperColor Light", mode: "light", colors: ["#e8e6df", "#f7f5ed", "#d9d6cc", "#2c2c2c", "#6f6f68", "#005faf", "#8700af", "#008700", "#af0000", "#0087af"] },
];

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState(() => { migrateBrowserStorage(); return window.localStorage.getItem("control-project"); });
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => normalizeTheme(window.localStorage.getItem("control-theme")));
  const [refreshKey, setRefreshKey] = useState(0);

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
      setView(viewFromPath(location.pathname));
    }
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, []);

  function navigate(next: View) {
    setView(next);
    history.pushState({}, "", next === "overview" ? "/" : `/${next}`);
    setMobileOpen(false);
  }

  const project = projects.find((item) => item.id === activeId) ?? null;

  if (loading) return <FullState icon={<RefreshCw className="spin" />} title="Запуск OpenCode Control" detail="Загружаем проекты и состояние OpenCode." />;
  if (error && projects.length === 0) return <FullState icon={<CircleStop />} title="OpenCode Control недоступен" detail={error} />;

  return (
    <div className="control-shell">
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><SquareTerminal size={19} /></div>
          <div><strong>OpenCode</strong><span>Control</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Закрыть навигацию" title="Закрыть навигацию"><X /></button>
        </div>

        <button className="project-switcher" aria-haspopup="dialog" onClick={() => setAddOpen(true)}>
          <span className="project-avatar">{project?.name.slice(0, 2).toUpperCase() ?? "＋"}</span>
          <span><small>Текущий проект</small><strong>{project?.name ?? "Добавить проект"}</strong></span>
          <ChevronDown size={16} />
        </button>

        <nav>
          {nav.map((section) => (
            <div className="nav-section" key={section.group}>
              <p>{section.group}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)} disabled={!project}>
                    <Icon size={17} /><span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="theme-toggle" onClick={() => setThemeOpen(true)}>
            <Palette size={16} />
            Тема: {themes.find((item) => item.id === theme)?.name ?? "OpenCode"}
          </button>
          <span>Local 1.0.0</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Открыть навигацию" title="Открыть навигацию"><Menu /></button>
          <div className="breadcrumbs"><span>{project?.name ?? "Рабочая область"}</span><b>/</b><strong>{labelFor(view)}</strong></div>
          <div className="topbar-actions">
            {project && <ServerControl project={project} onChange={() => setRefreshKey((value) => value + 1)} />}
            <button className="icon-button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="Обновить данные" title="Обновить данные"><RefreshCw size={17} /></button>
          </div>
        </header>

        <div className="content">
          {project?.server.last_error && <details className="server-diagnostic"><summary>{project.server.last_error.summary}</summary><div><span>Фаза: {project.server.last_error.phase}{project.server.last_error.exit_code != null ? ` · exit ${project.server.last_error.exit_code}` : ""}</span>{project.server.last_error.detail && <pre>{project.server.last_error.detail}</pre>}<code>{project.server.last_error.log_path}</code></div></details>}
          {!project ? (
            <Welcome onAdd={() => setAddOpen(true)} />
          ) : (
            <ViewErrorBoundary key={`${project.id}:${view}`}><ViewContent view={view} project={project} refreshKey={refreshKey} onProjectChange={() => setRefreshKey((value) => value + 1)} navigate={navigate} /></ViewErrorBoundary>
          )}
        </div>
      </main>

      {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Закрыть навигацию" />}
      {addOpen && <ProjectDialog projects={projects} onClose={() => setAddOpen(false)} onCreated={(created) => { setActiveId(created.id); setAddOpen(false); setRefreshKey((value) => value + 1); }} onSelect={(id) => { setActiveId(id); setAddOpen(false); }} />}
      {themeOpen && <ThemeDialog value={theme} onChange={(next) => { setTheme(next); setThemeOpen(false); }} onClose={() => setThemeOpen(false)} />}
    </div>
  );
}

class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message || "Неизвестная ошибка интерфейса" }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("OpenCode Control view failed", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="view-error"><CircleStop /><h1>Раздел не удалось открыть</h1><p>{this.state.error}</p><button className="primary-button" onClick={() => location.reload()}><RefreshCw size={15} /> Перезагрузить Control</button></div>;
  }
}

function ViewContent({ view, project, refreshKey, onProjectChange, navigate }: { view: View; project: Project; refreshKey: number; onProjectChange: () => void; navigate: (view: View) => void }) {
  if (view === "overview") return <Overview project={project} refreshKey={refreshKey} navigate={navigate} />;
  if (view === "sessions") return <Sessions project={project} refreshKey={refreshKey} />;
  if (view === "tasks") return <Tasks project={project} refreshKey={refreshKey} />;
  if (view === "agents") return <MarkdownCollection project={project} kind="agents" refreshKey={refreshKey} />;
  if (view === "skills") return <MarkdownCollection project={project} kind="skills" />;
  if (view === "commands") return <Commands project={project} refreshKey={refreshKey} />;
  if (view === "providers") return <Providers project={project} refreshKey={refreshKey} />;
  if (view === "secrets") return <SecretsManager />;
  if (view === "mcp") return <Mcp project={project} refreshKey={refreshKey} />;
  if (view === "instructions") return <Instructions project={project} />;
  return <ProjectSettings project={project} onChange={onProjectChange} />;
}

function Overview({ project, refreshKey, navigate }: { project: Project; refreshKey: number; navigate: (view: View) => void }) {
  const resource = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey, 3000);
  const snapshot = resource.data;
  const allSessions = snapshot?.sessions ?? [];
  const sessions = allSessions.filter((session) => !session.parentID);
  const childCount = allSessions.length - sessions.length;
  const totalTokens = allSessions.reduce((sum, session) => sum + (session.tokens?.input ?? 0) + (session.tokens?.output ?? 0) + (session.tokens?.reasoning ?? 0), 0);
  const totalCost = allSessions.reduce((sum, session) => sum + (session.cost ?? 0), 0);
  const active = allSessions.filter((session) => statusOf(snapshot, session.id) !== "idle").length;
  const connectedMcp = Object.values(snapshot?.mcp ?? {}).filter((item) => item.status === "connected").length;

  return (
    <Page title="Центр управления" description="Сессии, расходы и состояние OpenCode в одном месте." action={<button className="primary-button" onClick={() => navigate("tasks")}><Play size={16} /> Запустить задачу</button>}>
      {resource.error && <Banner tone="danger">{resource.error}</Banner>}
      {snapshot?.state === "stopped" && <Banner tone="notice">Запустите сервер OpenCode, чтобы загрузить сессии, агентов и состояние MCP.</Banner>}
      <section className="metric-grid">
        <Metric icon={<MessageSquareText />} label="Сессии" value={String(sessions.length)} detail={`${active} активных · ${childCount} запусков подагентов`} accent="orange" />
        <Metric icon={<Cpu />} label="Токены" value={compact(totalTokens)} detail="ввод + вывод + рассуждения" accent="blue" />
        <Metric icon={<Activity />} label="Расходы" value={`$${totalCost.toFixed(3)}`} detail="по данным OpenCode" accent="green" />
        <Metric icon={<Network />} label="MCP подключено" value={`${connectedMcp}/${Object.keys(snapshot?.mcp ?? {}).length}`} detail="соединения Runtime" accent="purple" />
      </section>
      <div className="overview-grid">
        <Panel title="Последние сессии" icon={<MessageSquareText size={17} />} action={<button className="text-button" onClick={() => navigate("sessions")}>Показать все</button>}>
          <SessionRows sessions={sessions.slice(0, 5)} snapshot={snapshot ?? undefined} empty="Запустите задачу или создайте первую сессию." />
        </Panel>
        <Panel title="Runtime" icon={<SquareTerminal size={17} />}>
          <dl className="runtime-list">
            <div><dt>Сервер</dt><dd><Status value={snapshot?.server.state === "running" ? "connected" : snapshot?.server.state ?? "stopped"} /></dd></div>
            <div><dt>Адрес</dt><dd className="mono">{snapshot?.server.endpoint ?? "не запущен"}</dd></div>
            <div><dt>OpenCode</dt><dd>{snapshot?.health?.version ?? "неизвестно"}</dd></div>
            <div><dt>Агенты</dt><dd>{snapshot?.agents.length ?? 0} обнаружено</dd></div>
            <div><dt>Папка проекта</dt><dd className="mono truncate" title={project.root}>{project.root}</dd></div>
          </dl>
        </Panel>
      </div>
    </Page>
  );
}

function Sessions({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const resource = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey, 3000);
  const commands = useResource<CommandItem[]>(`/api/v1/projects/${project.id}/commands`, refreshKey);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [showChildren, setShowChildren] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function abort(session: Session) {
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/abort`, { method: "POST", ...jsonBody({}) });
      setNotice({ tone: "success", text: `Остановка сессии «${session.title ?? session.id}» запрошена` });
      resource.reload();
    } catch (reason) {
      setNotice({ tone: "danger", text: message(reason) });
    }
  }
  async function remove(session: Session) {
    const warning = session.parentID ? "OpenCode удалит эту дочернюю сессию и её данные." : "OpenCode также удалит дочерние subagent-сессии этой сессии.";
    if (!confirm(`Удалить сессию «${session.title ?? session.id}»? ${warning}`)) return;
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setNotice({ tone: "success", text: "Сессия удалена" });
      if (selectedSessionId === session.id) setSelectedSessionId(null);
      resource.reload();
    } catch (reason) { setNotice({ tone: "danger", text: message(reason) }); }
  }

  const allSessions = resource.data?.sessions ?? [];
  const selected = allSessions.find((session) => session.id === selectedSessionId) ?? null;
  const childCount = allSessions.filter((session) => session.parentID).length;
  const sessions = showChildren ? allSessions : allSessions.filter((session) => !session.parentID);
  return (
    <Page title="Сессии" description="Основные диалоги показаны сразу. Отдельно можно открыть дочерние сессии, в которых работают подагенты." action={<button className="primary-button" onClick={() => setComposer(true)}><Plus size={16} /> Новая сессия</button>}>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {resource.error && <Banner tone="danger">{resource.error}</Banner>}
      <ScopeGuide><strong>Основные сессии: {allSessions.length - childCount}</strong><span>Дочерние сессии подагентов: {childCount}</span><label className="toggle-field"><input type="checkbox" checked={showChildren} onChange={(event) => setShowChildren(event.target.checked)} /> Показать дочерние сессии</label></ScopeGuide>
      <Panel className="table-panel">
        <div className="data-table session-table">
          <div className="table-head"><span>Сессия</span><span>Агент / модель</span><span>Использование</span><span>Статус</span><span /></div>
          {sessions.map((session) => (
            <div className={`table-row ${session.parentID ? "child-session" : ""}`} role="button" tabIndex={0} key={session.id} onClick={() => setSelectedSessionId(session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedSessionId(session.id); }}>
              <span><strong>{session.title ?? "Сессия без названия"}</strong><small>{session.control_task ? `Задача: ${session.control_task.title}` : session.parentID ? "Дочерняя сессия без задачи Control" : "Самостоятельная или CLI-сессия"} · {relativeTime(session.time?.updated)}</small></span>
              <span><strong>{session.agent ?? "по умолчанию"}</strong><small>{modelOf(session)}</small></span>
              <span><strong>{compact(sessionLifetimeTokens(session))} токенов</strong><small>за все время · $${(session.cost ?? 0).toFixed(4)}</small></span>
              <span><Status value={sessionStatus(resource.data, session)} /></span>
              <span className="row-actions"><button className="icon-button danger" onClick={(event) => { event.stopPropagation(); void abort(session); }} aria-label="Остановить сессию"><CircleStop size={16} /></button><button className="icon-button danger" onClick={(event) => { event.stopPropagation(); void remove(session); }} aria-label="Удалить сессию"><Trash2 size={15} /></button></span>
            </div>
          ))}
        </div>
        {sessions.length === 0 && <Empty icon={<MessageSquareText />} title="Сессий пока нет" detail="Создайте сессию или запустите задачу. Здесь появятся ее статус и расход токенов." />}
      </Panel>
      {composer && <SessionComposer project={project} agents={resource.data?.agents ?? []} commands={commands.data ?? []} providers={resource.data?.providers?.available ?? []} config={resource.data?.config} defaultModel={selectedDefaultModel(resource.data)} onClose={() => setComposer(false)} onCreated={() => { setComposer(false); resource.reload(); }} />}
      {selected && <SessionDrawer project={project} session={selected} status={sessionStatus(resource.data, selected)} taskStatus={selected.control_task?.status} agents={resource.data?.agents ?? []} providers={resource.data?.providers?.available ?? []} mcp={resource.data?.mcp ?? {}} config={resource.data?.config} initialModel={modelIdOf(selected) || resource.data?.config?.model || ""} onDelete={() => void remove(selected)} onClose={() => setSelectedSessionId(null)} />}
    </Page>
  );
}

function Tasks({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const tasks = useResource<Task[]>(`/api/v1/projects/${project.id}/tasks`, refreshKey, 3000);
  const snapshot = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey, 5000);
  const commands = useResource<CommandItem[]>(`/api/v1/projects/${project.id}/commands`, refreshKey);
  const [open, setOpen] = useState(false);
  const [sessionTask, setSessionTask] = useState<Task | null>(null);
  const [scheduleTask, setScheduleTask] = useState<Task | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  async function abort(task: Task) {
    try {
      await api(`/api/v1/projects/${project.id}/tasks/${task.id}/abort`, { method: "POST", ...jsonBody({}) });
      setActionError(null);
      tasks.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  async function rerun(task: Task) {
    try {
      await api(`/api/v1/projects/${project.id}/tasks/${task.id}/rerun`, { method: "POST", ...jsonBody({}) });
      setActionError(null); tasks.reload(); snapshot.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  async function toggleSchedule(task: Task) {
    try {
      await api(`/api/v1/projects/${project.id}/tasks/${task.id}/schedule`, { method: "PATCH", ...jsonBody({ enabled: !task.schedule_enabled }) });
      setActionError(null); tasks.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  async function remove(task: Task) {
    const count = taskSessionIds(task).length;
    if (!confirm(`Удалить задачу «${task.title}» и ${count} связанных сессий? OpenCode также удалит их дочерние subagent-сессии.`)) return;
    try {
      await api(`/api/v1/projects/${project.id}/tasks/${task.id}`, { method: "DELETE" });
      setActionError(null); setSelectedSessionId(null); tasks.reload(); snapshot.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  async function removeSession(session: Session) {
    if (!confirm(`Удалить сессию «${session.title ?? session.id}» из OpenCode и отвязать её от задачи?`)) return;
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setSelectedSessionId(null); setActionError(null); tasks.reload(); snapshot.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  const selectedSession = snapshot.data?.sessions.find((item) => item.id === selectedSessionId) ?? null;
  const selectedTask = tasks.data?.find((task) => selectedSessionId !== null && taskSessionIds(task).includes(selectedSessionId));
  return (
    <Page title="Задачи" description="Задача OpenCode Control — это контролируемый запуск агента. Для неё создаётся отдельная основная сессия OpenCode, куда отправляется ваше описание работы." action={<button className="primary-button" onClick={() => setOpen(true)}><Play size={16} /> Запустить задачу</button>}>
      {tasks.error && <Banner tone="danger">{tasks.error}</Banner>}
      {actionError && <Banner tone="danger">{actionError}</Banner>}
      <div className="context-summary task-context-summary">
        <div><small>Проект</small><strong>{project.name}</strong></div>
        <div><small>Что учитывается</small><strong>Настройки, AGENTS.md и навыки</strong><span>Сначала общие, затем проектные</span></div>
        <div><small>Запуск по умолчанию</small><strong>{snapshot.data?.config?.default_agent ?? "build"}</strong><span>{snapshot.data?.config?.model ?? "последняя выбранная модель"}</span></div>
      </div>
      <div className="task-list">
        {(tasks.data ?? []).map((task) => (
          <article className="task-card" key={task.id}>
            <div className="task-status-rail" data-status={task.status} />
            <div className="task-main">
              <div className="task-title-row"><TaskStatus value={task.status} /><span className="task-time">{relativeTime(Date.parse(task.created_at))}</span><h3>{task.title}</h3></div>
              <p title={task.error ?? task.prompt}>{task.error ?? task.prompt}</p>
              {task.cron && <div className="task-schedule"><span><small>Расписание</small><strong>{describeCron(task.cron)}</strong></span><span><small>Часовой пояс</small><strong>{task.timezone}</strong></span><span><small>История диалога</small><strong>{task.cron_session_mode === "reuse" ? "продолжать предыдущую" : "новая для каждого запуска"}</strong></span><span><small>Последний запуск</small><strong title={task.last_scheduled_run?.error ?? undefined}>{scheduledRunLabel(task.last_scheduled_run?.status)}</strong></span><span><small>Следующий запуск</small><strong>{task.schedule_enabled ? formatScheduleTime(task.next_run_at) : "приостановлен"}</strong></span></div>}
            </div>
            <div className="task-meta">
              <span className="task-fact"><Bot size={15} /><small>Агент</small><strong>{task.agent ?? snapshot.data?.config?.default_agent ?? "build"}</strong></span>
              <span className="task-fact"><BrainCircuit size={15} /><small>Рассуждение</small><strong>{task.variant || "по умолчанию"}</strong></span>
              <span className="task-fact"><Cpu size={15} /><small>Модель</small><strong title={task.model ?? (modelIdOf(snapshot.data?.sessions.find((item) => item.id === task.session_id)) || snapshot.data?.config?.model || "по умолчанию")}>{task.model ?? (modelIdOf(snapshot.data?.sessions.find((item) => item.id === task.session_id)) || snapshot.data?.config?.model || "по умолчанию")}</strong></span>
              <span className="task-fact"><MessageSquareText size={15} /><small>Сессии</small><strong>{taskSessionIds(task).length}</strong></span>
            </div>
            <div className="task-card-footer">
              <div className="task-session-links">{taskSessionIds(task).map((sessionId, index) => { const session = snapshot.data?.sessions.find((item) => item.id === sessionId); return <button className="secondary-button compact-button" key={sessionId} onClick={() => setSelectedSessionId(sessionId)}>{session?.title ?? `Сессия ${index + 1}`}</button>; })}</div>
              <div className="task-actions"><button className="secondary-button compact-button" onClick={() => setSessionTask(task)}><Plus size={13} /> Новая сессия</button><button className="secondary-button compact-button" onClick={() => setScheduleTask(task)}><Settings size={13} /> Настроить запуск</button>{task.cron && <button className="secondary-button compact-button" onClick={() => void toggleSchedule(task)}>{task.schedule_enabled ? "Приостановить расписание" : "Возобновить расписание"}</button>}{["queued", "dispatching", "running"].includes(task.status) ? <button className="danger-button compact-button" onClick={() => void abort(task)}><CircleStop size={13} /> Остановить</button> : <><button className="secondary-button compact-button" onClick={() => void rerun(task)}><Play size={13} /> Запустить повторно</button><button className="icon-button danger" title="Удалить задачу и связанные сессии" onClick={() => void remove(task)} aria-label="Удалить задачу и сессии"><Trash2 size={14} /></button></>}</div>
            </div>
          </article>
        ))}
        {(tasks.data?.length ?? 0) === 0 && <Empty icon={<Zap />} title="Запущенных задач нет" detail="Нажмите «Запустить задачу», опишите результат и при необходимости выберите агента и модель." />}
      </div>
      {open && <TaskComposer project={project} agents={snapshot.data?.agents ?? []} commands={commands.data ?? []} providers={snapshot.data?.providers?.available ?? []} config={snapshot.data?.config} defaultModel={selectedDefaultModel(snapshot.data)} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); tasks.reload(); snapshot.reload(); }} />}
      {sessionTask && <SessionComposer project={project} task={sessionTask} agents={snapshot.data?.agents ?? []} commands={commands.data ?? []} providers={snapshot.data?.providers?.available ?? []} config={snapshot.data?.config} defaultModel={sessionTask.model ?? selectedDefaultModel(snapshot.data)} onClose={() => setSessionTask(null)} onCreated={() => { setSessionTask(null); tasks.reload(); snapshot.reload(); }} />}
      {scheduleTask && <TaskScheduleEditor project={project} task={scheduleTask} agents={snapshot.data?.agents ?? []} commands={commands.data ?? []} onClose={() => setScheduleTask(null)} onSaved={() => { setScheduleTask(null); tasks.reload(); }} />}
      {selectedSession && <SessionDrawer project={project} session={selectedSession} status={statusOf(snapshot.data, selectedSession.id)} taskStatus={selectedTask?.status ?? selectedSession.control_task?.status} agents={snapshot.data?.agents ?? []} providers={snapshot.data?.providers?.available ?? []} mcp={snapshot.data?.mcp ?? {}} config={snapshot.data?.config} initialAgent={selectedTask?.agent ?? selectedSession.agent ?? ""} initialModel={selectedTask?.model || modelIdOf(selectedSession) || snapshot.data?.config?.model || ""} onDelete={() => void removeSession(selectedSession)} onClose={() => setSelectedSessionId(null)} />}
    </Page>
  );
}

function MarkdownCollection({ project, kind, refreshKey = 0 }: { project: Project; kind: "agents" | "skills"; refreshKey?: number }) {
  const resource = useResource<WorkspaceItem[]>(`/api/v1/projects/${project.id}/${kind}`, 0);
  const runtime = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey);
  const [editing, setEditing] = useState<WorkspaceItem | "new" | null>(null);
  const [inspecting, setInspecting] = useState<WorkspaceItem | null>(null);
  const [showInternal, setShowInternal] = useState(false);
  const noun = kind === "agents" ? "агента" : "навык";
  const Icon = kind === "agents" ? Bot : Sparkles;
  const files = resource.data ?? [];
  const known = new Set(files.map((item) => item.id));
  const runtimeAgents = runtime.data?.agents ?? [];
  const hiddenCount = runtimeAgents.filter((agent) => agent.hidden).length;
  const runtimeOnly: WorkspaceItem[] = kind === "agents" ? runtimeAgents.filter((agent) => !known.has(agent.name) && (showInternal || !agent.hidden)).map((agent) => ({ id: agent.name, description: localizedAgentDescription(agent.name, agent.description), mode: agent.mode, model: agentModel(agent), content: "", scope: "runtime", source: agent.native ? "Встроен в OpenCode" : "Объединенная конфигурация или плагин", editable: false, internal: agent.hidden })) : [];
  const items = [...files, ...runtimeOnly].sort((left, right) => left.id.localeCompare(right.id));
  return (
    <Page title={kind === "agents" ? "Агенты" : "Навыки"} description={kind === "agents" ? "Агент определяет роль, инструменты и модель. AGENTS.md отдельно задает общие правила работы и язык ответов." : "Навык — дополнительная инструкция, которую агент загружает только для подходящей задачи."} action={<button className="primary-button" onClick={() => setEditing("new")}><Plus size={16} /> Создать {noun}</button>}>
      {resource.error && <Banner tone="danger">{resource.error}</Banner>}
      {kind === "agents" ? <div className="context-summary resource-context-summary"><div><small>Основной агент</small><strong>Ведет диалог и задачу</strong><span>Доступен для прямого выбора</span></div><div><small>Подагент</small><strong>Выполняет отдельную часть</strong><span>Запускается основным агентом</span></div><div><small>Область действия</small><strong>Для проекта или для всех</strong><span>Проектная версия имеет приоритет</span></div>{hiddenCount > 0 && <label className="toggle-field"><input type="checkbox" checked={showInternal} onChange={(event) => setShowInternal(event.target.checked)} /> Показать служебных: {hiddenCount}</label>}</div> : <div className="context-summary resource-context-summary"><div><small>Навык проекта</small><strong>Только для {project.name}</strong><span>Имеет приоритет над одноименным общим</span></div><div><small>Общий навык</small><strong>Для всех проектов</strong><span>Хранится в конфигурации OpenCode</span></div><div><small>Как агент находит навык</small><strong>По полю <code>name</code></strong><span>Имя совпадает с каталогом навыка</span></div></div>}
      <details className="task-help creation-guide"><summary>{kind === "agents" ? "Как создать и использовать своего агента" : "Как создать, импортировать и использовать навык"}</summary>{kind === "agents" ? <ol><li>Выберите область <strong>Для проекта</strong>, если роль нужна только в <code>{project.root}</code>, или <strong>Для всех проектов</strong>.</li><li>В поле <code>description</code> объясните, когда выбирать специалиста. В теле файла задайте обязанности, ограничения и проверки.</li><li><code>mode: primary</code> создает агента для прямого выбора, <code>mode: subagent</code> — специалиста для отдельной части работы, а <code>mode: all</code> включает оба варианта.</li><li>После сохранения OpenCode Control автоматически перезапустит сервер OpenCode под своим управлением.</li></ol> : <ol><li>Нажмите <strong>Создать навык</strong>: его можно написать вручную или импортировать на вкладке <strong>По HTTPS</strong>.</li><li>Вставьте ссылку на каталог GitHub вида <code>github.com/…/tree/…/skill</code> либо на файл <code>github.com/…/blob/…/SKILL.md</code>. В обоих случаях Control загрузит весь родительский каталог навыка.</li><li>Вместе с <code>SKILL.md</code> будут установлены все составляющие: <code>scripts/</code>, <code>references/</code>, <code>data/</code>, <code>templates/</code> и assets. Перед установкой preview покажет commit, полный manifest и размеры файлов; скрипты при импорте не запускаются.</li><li><strong>Для проекта</strong> сохраняет bundle в <code>.opencode/skills/&lt;name&gt;/</code> выбранного проекта; <strong>Для всех проектов</strong> — в <code>~/.config/opencode/skills/&lt;name&gt;/</code>.</li><li>Поле <code>name:</code> должно совпадать с именем каталога, а в <code>description</code> нужно точно указать, какую задачу решает навык и когда агенту его загружать.</li></ol>}</details>
      <div className="resource-grid">
        {items.map((item) => (
          <button className={`resource-card ${item.editable === false ? "readonly" : ""}`} key={`${item.scope}-${item.id}`} onClick={() => { if (item.editable !== false) setEditing(item); else if (kind === "agents") setInspecting(item); }}>
            <span className="resource-icon"><Icon size={19} /></span>
            <div><h3>{kind === "skills" ? item.effective_name ?? item.id : item.id}</h3><p>{item.description || (kind === "agents" ? "Пользовательская конфигурация агента" : "Пользовательская конфигурация навыка")}</p></div>
            <div className="resource-tags"><span className={`scope-${item.scope ?? "project"}`}>{scopeLabel(item.scope)}</span>{kind === "skills" && item.effective_name && item.effective_name !== item.id && <span title="Имя каталога навыка">каталог: {item.id}</span>}{item.mode && <span>{modeLabel(item.mode)}</span>}{item.model && <span>{item.model}</span>}<span title={item.source}>{shortSource(item.source)}</span></div>
          </button>
        ))}
        {items.length === 0 && <Empty icon={<Icon />} title={kind === "agents" ? "Агенты не найдены" : "Навыков пока нет"} detail={kind === "agents" ? "Создайте первого агента. Control автоматически обновит работающий сервер OpenCode." : "Создайте первый навык. Control автоматически обновит работающий сервер OpenCode."} />}
      </div>
      {editing && <MarkdownEditor project={project} kind={kind} item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); resource.reload(); }} />}
      {inspecting && <AgentInfo item={inspecting} onClose={() => setInspecting(null)} />}
    </Page>
  );
}

function Commands({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const resource = useResource<CommandItem[]>(`/api/v1/projects/${project.id}/commands`, refreshKey);
  const runtime = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey);
  const [editing, setEditing] = useState<CommandItem | "new" | null>(null);
  const items = resource.data ?? [];
  const commandItems = items.filter((item) => item.kind !== "skill");
  const runtimeSkills = items.filter((item) => item.kind === "skill");
  return <Page title="Команды" description="Slash Command — сохранённый prompt-шаблон OpenCode. Введите /имя аргументы в чате, чтобы выполнить повторяемую работу в текущей Session." action={<button className="primary-button" onClick={() => setEditing("new")}><Plus size={16} /> Создать команду</button>}>
    {resource.error && <Banner tone="danger">{resource.error}</Banner>}
    <div className="context-summary command-context-summary"><div><small>Вызов</small><strong><code>/review авторизация</code></strong><span>Enter запускает Command в текущей Session</span></div><div><small>Область</small><strong>Проект или глобально</strong><span>Проектная версия имеет приоритет</span></div><div><small>Аргументы</small><strong><code>$ARGUMENTS</code>, <code>$1</code>, <code>$2</code></strong><span>Подставляются нативно OpenCode</span></div><div><small>Shell</small><strong><code>{"!`command`"}</code></strong><span>Выполняется OpenCode без дополнительного вопроса</span></div></div>
    <details className="task-help creation-guide command-guide"><summary>Как работают Slash Commands</summary><ol><li>Command хранится в <code>.opencode/commands/&lt;имя&gt;.md</code> или глобально в <code>~/.config/opencode/commands/</code>.</li><li>Введите <code>/имя аргументы</code> в чате. Control вызывает нативный endpoint OpenCode, а ответ появляется в той же Session.</li><li><code>$ARGUMENTS</code> получает всю строку аргументов; <code>$1</code>, <code>$2</code> — отдельные позиции.</li><li>Frontmatter выбирает agent, model, variant и режим subtask. Без этих полей используются настройки Session.</li><li>Конструкция <code>{"!`shell`"}</code> выполняется OpenCode только при запуске Command; сохранение файла в Control shell не выполняет.</li></ol></details>
    <section className="command-section"><header><div><p className="eyebrow">Текущая конфигурация</p><h2>Доступные Commands</h2><span>Project, global и системные Commands OpenCode. Введите их имя в чате после символа /.</span></div></header><div className="command-grid">{commandItems.map((item) => <article className="command-card" key={`${item.scope}-${item.id}`}><button className="command-card-main" onClick={() => item.editable !== false && setEditing(item)} disabled={item.editable === false}><span className="command-slash">/{item.id}</span><h3>{commandDisplayDescription(item)}</h3><p>{commandPurpose(item.id)}</p></button><div className="resource-tags"><span className={`scope-${item.scope ?? "project"}`}>{scopeLabel(item.scope)}</span>{item.agent && <span>{item.agent}</span>}{item.model && <span>{item.model}</span>}{item.subtask && <span>subtask</span>}{item.has_arguments && <span>аргументы</span>}{item.has_shell && <span className="command-shell-tag">Shell</span>}{item.editable === false && <span>системная</span>}</div></article>)}{commandItems.length === 0 && <Empty icon={<SquareTerminal />} title="Commands пока не активированы" detail="Установите стартовый набор или создайте собственную команду." />}</div></section>
    {runtimeSkills.length > 0 && <details className="task-help command-runtime-skills"><summary>Runtime Skills, доступные через slash: {runtimeSkills.length}</summary><div>{runtimeSkills.map((item) => <span key={item.id}><code>/{item.id}</code><small>{commandDisplayDescription(item)}</small></span>)}</div></details>}
    {editing && <CommandEditor project={project} item={editing} agents={runtime.data?.agents ?? []} providers={runtime.data?.providers?.available ?? []} config={runtime.data?.config} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); resource.reload(); }} />}
  </Page>;
}

function SecretsManager() {
  const resource = useResource<SecretInfo[]>("/api/v1/secrets", 0);
  const [selected, setSelected] = useState<SecretInfo | "new" | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function copyReference(secret: SecretInfo) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API недоступен");
      await navigator.clipboard.writeText(secret.reference);
      setCopied(secret.name);
      window.setTimeout(() => setCopied((current) => current === secret.name ? null : current), 1800);
    } catch (reason) { setError(message(reason)); }
  }
  async function remove(secret: SecretInfo) {
    if (!confirm(`Удалить secret «${secret.name}»? Конфигурации со ссылкой на него перестанут работать.`)) return;
    try {
      await api(`/api/v1/secrets/${encodeURIComponent(secret.name)}`, { method: "DELETE" });
      setError(null);
      resource.reload();
    } catch (reason) { setError(message(reason)); }
  }
  return <Page title="Секреты" description="Единое локальное хранилище API-ключей и других чувствительных данных для всех проектов OpenCode." action={<button className="primary-button" onClick={() => setSelected("new")}><Plus size={15} /> Добавить secret</button>}>
    {(error || resource.error) && <Banner tone="danger">{error || resource.error}</Banner>}
    <Banner tone="notice">Чтобы изменить secret, задайте новое значение. Используйте скопированный секрет формата <code>{`{file:~/.config/opencode/secrets/...}`}</code> в <code>opencode.json(c)</code> через CLI или в разделе «Настройки проекта».</Banner>
    <ScopeGuide><strong>Общее хранилище</strong><span>Действует для всех проектов</span><code>~/.config/opencode/secrets/</code></ScopeGuide>
    <Panel className="secret-panel">
      <div className="secret-list">
        {(resource.data ?? []).map((secret) => <article className="secret-row" key={secret.name}>
          <span className="secret-icon"><KeyRound size={17} /></span>
          <span className="secret-identity"><strong>{secret.name}</strong><small>{secret.path}</small></span>
          <code className="secret-mask">••••••••••••</code>
          <code className="secret-reference">{secret.reference}</code>
          <span className="secret-actions"><button className="secondary-button compact-button" onClick={() => void copyReference(secret)}><Copy size={13} /> {copied === secret.name ? "Скопировано" : "Reference"}</button><button className="secondary-button compact-button" onClick={() => setSelected(secret)}>Заменить</button><button className="icon-button" aria-label={`Удалить ${secret.name}`} title={`Удалить ${secret.name}`} onClick={() => void remove(secret)}><Trash2 size={14} /></button></span>
        </article>)}
        {resource.data?.length === 0 && <Empty icon={<KeyRound />} title="Секретов пока нет" detail="Добавьте API-ключ, затем скопируйте безопасную ссылку в конфигурацию provider или MCP." />}
      </div>
    </Panel>
    {selected && <SecretDialog existing={selected === "new" ? null : selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); resource.reload(); }} />}
  </Page>;
}

function SecretDialog({ existing, onClose, onSaved }: { existing: SecretInfo | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/api/v1/secrets/${encodeURIComponent(name)}`, { method: "PUT", ...jsonBody({ value }) });
      onSaved();
    } catch (reason) { setError(message(reason)); setBusy(false); }
  }
  return <Modal title={existing ? `Заменить ${existing.name}` : "Добавить secret"} subtitle="Значение записывается локально и больше не показывается в Control." onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <Field label="Имя файла" hint="1–64 символа: a-z, 0-9, дефис или подчеркивание."><input className="mono" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} disabled={Boolean(existing)} required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxLength={64} placeholder="context7_api_key" /></Field>
      <Field label={existing ? "Новое значение" : "Значение"} hint="Старое значение нельзя посмотреть. Control не добавляет перевод строки в конец файла."><input type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} required maxLength={65_536} placeholder="Вставьте API-ключ" /></Field>
      <Banner tone="notice">После сохранения используйте <code>{`{file:~/.config/opencode/secrets/${name || "имя"}}`}</code>.</Banner>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" disabled={busy || !name || !value}>{busy ? "Сохранение…" : existing ? "Заменить значение" : "Сохранить secret"}</button></div>
    </form>
  </Modal>;
}

function Providers({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const resource = useResource<ProviderAuthEntry[]>(`/api/v1/projects/${project.id}/providers/auth`, refreshKey);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProviderAuthEntry | null>(null);
  const [custom, setCustom] = useState(false);
  const normalized = query.trim().toLowerCase();
  const entries = [...(resource.data ?? [])]
    .filter((entry) => !normalized || entry.name.toLowerCase().includes(normalized) || entry.id.toLowerCase().includes(normalized))
    .sort((left, right) => providerAuthRank(left.id) - providerAuthRank(right.id) || left.name.localeCompare(right.name));
  return <Page title="Провайдеры" description="Подключайте готовых провайдеров или добавляйте Ollama и другие API, совместимые с OpenAI." action={<button className="primary-button" onClick={() => setCustom(true)}><Plus size={16} /> Добавить своего провайдера</button>}>
    {resource.error && <Banner tone="danger">Не удалось получить каталог OpenCode: {resource.error}</Banner>}
    {project.endpoint && <Banner tone="notice">Для безопасности авторизация доступна только на сервере под управлением OpenCode Control. У этого проекта указан внешний адрес OpenCode.</Banner>}
    <div className="provider-toolbar"><div className="theme-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти провайдера" /></div><span>{entries.filter((entry) => entry.connected).length} подключено</span></div>
    <div className="provider-list">
      {entries.map((entry) => <button className={`provider-row${entry.configured ? " configured" : ""}`} key={entry.id} onClick={() => { if (!entry.configured) setSelected(entry); }}><span className="provider-mark"><Plug size={17} /></span><span><strong>{entry.name}</strong><small>{entry.id} · {entry.configured ? "opencode.json" : entry.methods.map((method) => method.label).join(" / ")}</small></span><span className={entry.connected || entry.configured ? "provider-connected" : "provider-connect"}>{entry.connected ? <><Check size={14} /> Подключён</> : entry.configured ? <><Check size={14} /> Настроен</> : "Подключить"}</span></button>)}
      {!resource.error && entries.length === 0 && <Empty icon={<Plug />} title="Провайдеры не найдены" detail={normalized ? "Измените поисковый запрос." : "Запустите сервер OpenCode, чтобы получить доступные способы подключения."} />}
    </div>
    {selected && <ProviderConnectDialog project={project} entry={selected} onClose={() => setSelected(null)} onConnected={() => { setSelected(null); resource.reload(); }} />}
    {custom && <CustomProviderDialog project={project} onClose={() => setCustom(false)} onSaved={() => { setCustom(false); resource.reload(); }} />}
  </Page>;
}

function CustomProviderDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<"ollama" | "custom">("ollama");
  const [id, setId] = useState("ollama");
  const [name, setName] = useState("Ollama (local)");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function selectKind(next: "ollama" | "custom") {
    setKind(next);
    if (next === "ollama") { setId("ollama"); setName("Ollama (local)"); setBaseUrl("http://localhost:11434/v1"); setApiKey(""); }
    else { setId(""); setName(""); setBaseUrl("https://api.example.com/v1"); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const modelIds = models.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    if (modelIds.length === 0) { setError("Добавьте хотя бы один model ID, например qwen3-coder:30b."); return; }
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(id)}/configuration`, { method: "PUT", ...jsonBody({ name, base_url: baseUrl, models: modelIds, api_key: apiKey || null }) });
      onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <Modal title="Добавить своего провайдера" subtitle="OpenCode Control добавит настройки провайдера в проектный opencode.json и перезапустит сервер OpenCode." onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="custom-provider-kinds" role="tablist" aria-label="Тип своего провайдера"><button type="button" role="tab" aria-selected={kind === "ollama"} className={kind === "ollama" ? "selected" : ""} onClick={() => selectKind("ollama")}>Ollama</button><button type="button" role="tab" aria-selected={kind === "custom"} className={kind === "custom" ? "selected" : ""} onClick={() => selectKind("custom")}>Совместимый с OpenAI</button></div>
    <p className="custom-provider-mode-note">{kind === "ollama" ? "Локальный Ollama без ключа API. Укажите модели из команды ollama list." : "Произвольный API, совместимый с OpenAI. Ключ доступа необязателен."}</p>
    <form className="form-stack provider-auth-form custom-provider-form" onSubmit={(event) => void save(event)}><div className="form-row"><Field label="ID провайдера" hint="Латиницей; станет префиксом модели."><input className="mono" value={id} onChange={(event) => setId(event.target.value)} required placeholder="myprovider" /></Field><Field label="Название"><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Мой провайдер" /></Field></div><Field label="Базовый URL"><input className="mono" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder="https://api.example.com/v1" /></Field><Field label="ID моделей" hint="По одному на строку или через запятую. Для Ollama используйте имя из ollama list."><textarea className="code-editor provider-models" value={models} onChange={(event) => setModels(event.target.value)} required placeholder={kind === "ollama" ? "qwen3-coder:30b\nllama3.3:70b" : "my-model\nmy-fast-model"} /></Field>{kind === "custom" && <Field label="Ключ API" hint="Необязательно. Ключ хранится в учетных данных OpenCode, а не в opencode.json."><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Необязательно" /></Field>}<Banner tone="notice">Ollama должен быть запущен отдельно. Для вызова инструментов обычно нужен контекст модели не меньше 16k–32k.</Banner><div className="modal-actions custom-provider-actions"><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" disabled={busy || !id || !name || !baseUrl}>{busy ? "Сохранение…" : "Добавить провайдера"}</button></div></form>
  </Modal>;
}

function ProviderConnectDialog({ project, entry, onClose, onConnected }: { project: Project; entry: ProviderAuthEntry; onClose: () => void; onConnected: () => void }) {
  const [methodIndex, setMethodIndex] = useState(0);
  const [key, setKey] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [authorization, setAuthorization] = useState<{ url: string; method: "auto" | "code"; instructions?: string | null } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = entry.methods[methodIndex] ?? entry.methods[0];
  async function connectApi(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await api(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(entry.id)}/auth`, { method: "PUT", ...jsonBody({ key, metadata: inputs }) }); setKey(""); onConnected(); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function authorize() {
    setBusy(true);
    try {
      const value = await api<{ url: string; method: "auto" | "code"; instructions?: string | null }>(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(entry.id)}/oauth/authorize`, { method: "POST", ...jsonBody({ method: methodIndex, inputs }) });
      setAuthorization(value); setError(null); window.open(value.url, "_blank", "noopener,noreferrer");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function complete() {
    setBusy(true);
    try { await api(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(entry.id)}/oauth/callback`, { method: "POST", ...jsonBody({ method: methodIndex, code: code || null }) }); onConnected(); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <Modal title={`Подключить ${entry.name}`} subtitle="Авторизация сохраняется самим OpenCode глобально для текущего пользователя." onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="auth-methods">{entry.methods.map((candidate, index) => <button type="button" className={index === methodIndex ? "selected" : ""} key={`${candidate.type}-${candidate.label}`} onClick={() => { setMethodIndex(index); setAuthorization(null); setError(null); }}><span>{candidate.type === "api" ? <KeyRound size={16} /> : <Plug size={16} />}</span><strong>{candidate.label}</strong><small>{candidate.type === "api" ? "Ключ API" : "Вход через браузер"}</small></button>)}</div>
    {method?.type === "api" ? <form className="form-stack provider-auth-form" onSubmit={(event) => void connectApi(event)}><Field label="Ключ API" hint="Ключ отправляется напрямую локальному OpenCode и не сохраняется в Control."><input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} required placeholder="Вставьте ключ провайдера" /></Field>{(method.prompts ?? []).map((prompt) => <Field key={prompt.key} label={prompt.message}>{prompt.type === "select" ? <select value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))}><option value="">Выберите значение</option>{prompt.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))} placeholder={prompt.placeholder} />}</Field>)}<button className="primary-button" disabled={busy || !key}>{busy ? "Подключение…" : "Подключить"}</button></form> : <div className="form-stack provider-auth-form">
      {(method?.prompts ?? []).map((prompt) => <Field key={prompt.key} label={prompt.message}>{prompt.type === "select" ? <select value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))}><option value="">Выберите значение</option>{prompt.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))} placeholder={prompt.placeholder} />}</Field>)}
      {!authorization ? <button className="primary-button" type="button" onClick={() => void authorize()} disabled={busy}>{busy ? "Открывается…" : "Продолжить в браузере"}</button> : <div className="oauth-complete"><p>{authorization.instructions ?? "Завершите вход в открывшемся окне, затем подтвердите подключение."}</p><a href={authorization.url} target="_blank" rel="noreferrer">Открыть страницу входа ещё раз</a>{authorization.method === "code" && <Field label="Код подтверждения"><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Вставьте код" /></Field>}<button className="primary-button" type="button" onClick={() => void complete()} disabled={busy || (authorization.method === "code" && !code)}>{busy ? "Проверка…" : "Завершить подключение"}</button></div>}
    </div>}
  </Modal>;
}

function Mcp({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const runtime = useResource<Snapshot>(`/api/v1/projects/${project.id}/snapshot`, refreshKey, 3000);
  const configured = useResource<Record<string, unknown>>(`/api/v1/projects/${project.id}/mcp/configuration`, refreshKey);
  const global = useResource<Record<string, unknown>>(`/api/v1/projects/${project.id}/mcp/global`, refreshKey);
  const effective = useResource<Record<string, unknown>>(`/api/v1/projects/${project.id}/mcp/effective`, refreshKey);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const names = Array.from(new Set([...Object.keys(configured.data ?? {}), ...Object.keys(global.data ?? {}), ...Object.keys(effective.data ?? {}), ...Object.keys(runtime.data?.mcp ?? {})])).sort();
  return (
    <Page title="MCP-серверы" description="Подключения, через которые OpenCode получает дополнительные инструменты: документацию, Excel, поиск и другое." action={<button className="primary-button" onClick={() => setEditing("new")}><Plus size={16} /> Добавить MCP</button>}>
      {(runtime.error || configured.error || global.error || effective.error) && <Banner tone="danger">{runtime.error || configured.error || global.error || effective.error}</Banner>}
      <div className="context-summary mcp-context-summary"><div><small>Для всех проектов</small><strong>Базовая настройка</strong><span>Используется, пока проект ее не заменит</span></div><div><small>Для проекта</small><strong>Локальная настройка</strong><span>Добавляет MCP или заменяет одноименную общую</span></div><div><small>Сейчас в OpenCode</small><strong>Фактическое подключение</strong><span>Работает ли MCP в запущенном сервере проекта</span></div></div>
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
          const configState = effective.data === null ? "Состояние настройки неизвестно" : !hasSavedConfig ? "Нет сохраненной настройки" : displayedConfig.enabled === false ? "Отключен в настройках" : "Включен в настройках";
          const source = local ? (inherited ? "Настройка проекта заменяет общую" : "Настроен только для проекта") : inherited ? "Унаследован из общих настроек" : "Обнаружен только в запущенном OpenCode";
          return <button className="resource-card mcp-card" key={name} onClick={() => setEditing(name)}><span className="resource-icon"><Network size={19} /></span><div><h3>{name}</h3><p>{source}</p><code className="mcp-target" title={mcpTarget(displayedConfig)}>{mcpTarget(displayedConfig)}</code><div className="resource-tags">{inherited && <span className="scope-global">для всех проектов</span>}{local && <span className="scope-project">для проекта</span>}<span className={hasSavedConfig && displayedConfig.enabled !== false ? "state-enabled" : displayedConfig.enabled === false ? "state-disabled" : ""}>{configState}</span></div></div><Status value={status} /></button>;
        })}
        {names.length === 0 && <Empty icon={<Network />} title="MCP-серверов нет" detail="Добавьте локальную команду или удалённый URL, чтобы расширить инструменты OpenCode." />}
      </div>
      {editing && <McpEditor project={project} name={editing} localConfig={editing === "new" ? {} : (configured.data?.[editing] as Record<string, unknown> ?? {})} globalConfig={editing === "new" ? {} : (global.data?.[editing] as Record<string, unknown> ?? {})} effectiveConfig={editing === "new" ? {} : (effective.data?.[editing] as Record<string, unknown> ?? {})} status={editing === "new" ? undefined : runtime.data?.mcp?.[editing]} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); configured.reload(); global.reload(); effective.reload(); runtime.reload(); }} />}
    </Page>
  );
}

function Instructions({ project }: { project: Project }) {
  const resource = useResource<{ content: string; path: string; project_exists?: boolean; global_content: string; global_path: string; global_exists: boolean }>(`/api/v1/projects/${project.id}/instructions`, 0);
  const [content, setContent] = useState("");
  const [globalContent, setGlobalContent] = useState("");
  const [saved, setSaved] = useState(false);
  const [globalSaved, setGlobalSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectAvailable = resource.data ? resource.data.project_exists ?? Boolean(resource.data.content) : false;
  useEffect(() => { if (resource.data) { setContent(resource.data.content ?? ""); setGlobalContent(resource.data.global_content ?? ""); } }, [resource.data]);
  async function save() {
    try {
      await api(`/api/v1/projects/${project.id}/instructions`, { method: "PUT", ...jsonBody({ content }) });
      setError(null); setSaved(true); resource.reload(); window.setTimeout(() => setSaved(false), 1800);
    } catch (reason) { setError(message(reason)); }
  }
  async function saveGlobal() {
    try {
      await api(`/api/v1/projects/${project.id}/instructions/global`, { method: "PUT", ...jsonBody({ content: globalContent }) });
      setError(null); setGlobalSaved(true); resource.reload(); window.setTimeout(() => setGlobalSaved(false), 1800);
    } catch (reason) { setError(message(reason)); }
  }
  return <Page title="Общие инструкции (AGENTS.md)" description="Это не агент. Здесь задаются правила для всех агентов: язык ответа, стиль работы, обязательные проверки и ограничения.">
    {resource.error && <Banner tone="danger">{resource.error}</Banner>}
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="instruction-flow" aria-label="Порядок применения инструкций"><div><span>1</span><small>Общие правила</small><strong>Глобальный AGENTS.md</strong><p>Применяется во всех проектах</p></div><i>+</i><div><span>2</span><small>Правила репозитория</small><strong>Проектный AGENTS.md</strong><p>Дополняет общие правила в этом проекте</p></div><i>=</i><div><span>3</span><small>Итог</small><strong>Единые инструкции</strong><p>Их получают встроенные и ваши агенты</p></div></div>
    <div className="instruction-stack">
      <div className="editor-layout"><div className="editor-gutter"><FileCode2 /><h3>Проектный AGENTS.md</h3><p>Правила конкретного репозитория: архитектура, команды тестов и ограничения. Если файла нет, Control создаст его при сохранении.</p><div className="path-chip">{resource.data?.path ?? `${project.root}/AGENTS.md`}</div><div className="resource-tags"><span className="scope-project">только этот проект</span><span className={projectAvailable ? "state-enabled" : "state-pending"}>{projectAvailable ? "файл создан" : "не создан"}</span></div><button className="primary-button instruction-save" onClick={() => void save()} disabled={!resource.data}>{saved ? "Сохранено" : "Сохранить проектный файл"}</button></div><textarea aria-label="Проектный AGENTS.md" className="code-editor large" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} placeholder="# Инструкции проекта&#10;&#10;- Всегда отвечай пользователю на русском языке.&#10;- Перед изменениями изучи код проекта.&#10;- После изменений запускай тесты." /></div>
      <div className="editor-layout inherited-instructions"><div className="editor-gutter"><FileCode2 /><h3>Глобальный AGENTS.md</h3><p>Базовые правила для всех проектов пользователя. Если файла нет, Control создаст его при сохранении.</p><div className="path-chip">{resource.data?.global_path ?? "~/.config/opencode/AGENTS.md"}</div><div className="resource-tags"><span className="scope-global">все проекты</span><span className={resource.data?.global_exists ? "state-enabled" : "state-pending"}>{resource.data?.global_exists ? "файл создан" : "не создан"}</span></div><button className="primary-button instruction-save" onClick={() => void saveGlobal()} disabled={!resource.data}>{globalSaved ? "Сохранено" : "Сохранить глобальный файл"}</button></div><textarea aria-label="Глобальный AGENTS.md" className="code-editor large" value={globalContent} onChange={(event) => setGlobalContent(event.target.value)} spellCheck={false} placeholder="# Общие инструкции&#10;&#10;- Всегда отвечай на русском языке." /></div>
    </div>
  </Page>;
}

function ProjectSettings({ project, onChange }: { project: Project; onChange: () => void }) {
  const config = useResource<{ project: Record<string, unknown>; project_path: string; global: Record<string, unknown>; global_path: string }>(`/api/v1/projects/${project.id}/configuration`, 0);
  const [raw, setRaw] = useState("{}");
  const [globalRaw, setGlobalRaw] = useState("{}");
  const [name, setName] = useState(project.name);
  const [endpoint, setEndpoint] = useState(project.endpoint ?? "");
  const [error, setError] = useState<string | null>(null);
  const [editorErrors, setEditorErrors] = useState<{ project: string | null; global: string | null }>({ project: null, global: null });
  const [savedScope, setSavedScope] = useState<"project" | "global" | null>(null);
  const [savingScope, setSavingScope] = useState<"project" | "global" | null>(null);
  const initialized = useRef(false);
  useEffect(() => { if (config.data && !initialized.current) { initialized.current = true; setRaw(JSON.stringify(config.data.project, null, 2)); setGlobalRaw(JSON.stringify(config.data.global, null, 2)); } }, [config.data]);
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
      setEditorErrors((current) => ({ ...current, [scope]: null })); setError(null); setSavedScope(scope); window.setTimeout(() => setSavedScope(null), 1800); config.reload();
    } catch (reason) { setEditorErrors((current) => ({ ...current, [scope]: message(reason) })); }
    finally { setSavingScope(null); }
  }
  async function saveIdentity() {
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        ...jsonBody({
          name,
          endpoint: endpoint || null,
          clear_endpoint: !endpoint,
        }),
      });
      setError(null);
      onChange();
    } catch (reason) { setError(message(reason)); }
  }
  async function remove() {
    if (!confirm(`Удалить проект «${project.name}» из OpenCode Control? Файлы проекта останутся на месте.`)) return;
    await api(`/api/v1/projects/${project.id}`, { method: "DELETE" }); onChange();
  }
  return <Page title="Настройки проекта" description="Проектная и общая конфигурация OpenCode с понятным приоритетом." action={<button className="primary-button" onClick={() => void save("project")} disabled={!config.data || savingScope !== null}>{savingScope === "project" ? "Сохранение…" : savedScope === "project" ? "Сохранено" : "Сохранить проектную"}</button>}>
    {(error || config.error) && <Banner tone="danger">{error || config.error}</Banner>}
    <div className="context-summary settings-context-summary"><div><small>Общая конфигурация</small><strong>Для всех проектов</strong><span>{config.data?.global_path ?? "~/.config/opencode/opencode.json"}</span></div><div><small>Приоритет настроек</small><strong>Проектные поверх общих</strong><span>OpenCode объединяет оба уровня</span></div><div><small>После сохранения</small><strong>Runtime обновляется</strong><span>Control перезапустит управляемые серверы</span></div></div>
    <div className="settings-identity"><Panel title="Данные проекта"><div className="form-stack"><div className="form-row"><Field label="Отображаемое название"><input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Адрес внешнего сервера" hint="Пусто: сервером управляет Control."><input className="mono" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4096" /></Field></div><Field label="Папка проекта"><input className="mono" value={project.root} readOnly /></Field><button className="secondary-button settings-identity-save" onClick={() => void saveIdentity()}>Сохранить данные проекта</button></div></Panel></div>
    <div className="config-editor-stack"><Panel title="Проектная конфигурация"><div className="config-editor-heading"><span><strong>{config.data?.project_path ?? `${project.root}/opencode.json`}</strong><small>Действует только в этом проекте и перекрывает общие значения.</small></span><button className="secondary-button" onClick={() => void save("project")} disabled={!config.data || savingScope !== null}>{savingScope === "project" ? "Сохранение…" : savedScope === "project" ? "Сохранено" : "Сохранить"}</button></div>{editorErrors.project && <Banner tone="danger">Не удалось сохранить проектную конфигурацию: {editorErrors.project}</Banner>}<textarea aria-label="Проектная конфигурация OpenCode" aria-invalid={Boolean(editorErrors.project)} className={`code-editor settings-editor${editorErrors.project ? " invalid" : ""}`} value={raw} onChange={(event) => { setRaw(event.target.value); setEditorErrors((current) => ({ ...current, project: null })); }} spellCheck={false} /></Panel><Panel title="Общая конфигурация"><div className="config-editor-heading"><span><strong>{config.data?.global_path ?? "~/.config/opencode/opencode.json"}</strong><small>Используется на этой машине для всех проектов текущего пользователя.</small></span><button className="secondary-button" onClick={() => void save("global")} disabled={!config.data || savingScope !== null}>{savingScope === "global" ? "Сохранение…" : savedScope === "global" ? "Сохранено" : "Сохранить общую"}</button></div>{editorErrors.global && <Banner tone="danger">Не удалось сохранить общую конфигурацию: {editorErrors.global}</Banner>}<textarea aria-label="Общая конфигурация OpenCode" aria-invalid={Boolean(editorErrors.global)} className={`code-editor settings-editor${editorErrors.global ? " invalid" : ""}`} value={globalRaw} onChange={(event) => { setGlobalRaw(event.target.value); setEditorErrors((current) => ({ ...current, global: null })); }} spellCheck={false} /></Panel></div>
    <Panel className="danger-zone"><div><div><strong>Удалить проект из Control</strong><p>Control остановит управляемый сервер и забудет проект. Файлы репозитория останутся на месте.</p></div><button className="danger-button" onClick={() => void remove()}><Trash2 size={15} /> Удалить проект</button></div></Panel>
  </Page>;
}

function ServerControl({ project, onChange }: { project: Project; onChange: () => void }) {
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
  return <button title={title} aria-label={running ? "Остановить сервер OpenCode" : external ? "Внешний сервер OpenCode" : "Запустить сервер OpenCode"} className={`server-control ${running || external ? "online" : ""} compatibility-${compatibility?.state ?? "unknown"}`} onClick={() => void toggle()} disabled={busy || external}><span className="status-dot" />{error || lastError ? "Ошибка сервера" : busy ? "Выполняется…" : running ? "Сервер работает" : external ? "Внешний сервер" : "Запустить сервер"}{compatibility?.version && <small>{compatibility.version}</small>}{running ? <CircleStop size={14} /> : <Play size={14} />}</button>;
}

function ProjectDialog({ projects, onClose, onCreated, onSelect }: { projects: Project[]; onClose: () => void; onCreated: (project: Project) => void; onSelect: (id: string) => void }) {
  const [name, setName] = useState(""); const [root, setRoot] = useState(""); const [endpoint, setEndpoint] = useState(""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { const project = await api<Project>("/api/v1/projects", { method: "POST", ...jsonBody({ name, root, endpoint: endpoint || null }) }); onCreated(project); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal title="Проекты" subtitle="Выберите проект или добавьте новую локальную рабочую область." onClose={onClose}><div className="project-list">{projects.map((project) => <button key={project.id} onClick={() => onSelect(project.id)}><span className="project-avatar">{project.name.slice(0, 2).toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.root}</small></span><Status value={project.server.state === "running" ? "connected" : project.server.state} /></button>)}</div><div className="modal-divider"><span>Добавить проект</span></div><form className="form-stack" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}<Field label="Название"><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="API платежей" /></Field><Field label="Папка проекта"><input className="mono" value={root} onChange={(event) => setRoot(event.target.value)} required placeholder="/Users/you/code/payments" /></Field><Field label="Адрес существующего OpenCode" hint="Необязательно. Оставьте пустым, чтобы сервером управлял Control."><input className="mono" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4096" /></Field><button className="primary-button full" disabled={busy}>{busy ? "Добавление…" : "Добавить проект"}</button></form></Modal>;
}

function SessionComposer({ project, task, agents, commands, providers, config, defaultModel, onClose, onCreated }: { project: Project; task?: Task; agents: Agent[]; commands: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; defaultModel?: string; onClose: () => void; onCreated: () => void }) {
  const savedSelection = rememberedComposerSelection(project.id, agents);
  const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [agent, setAgent] = useState(() => task?.agent ?? savedSelection.agent); const [model, setModel] = useState(task?.model ?? (savedSelection.model || config?.model || defaultModel || "")); const [variant, setVariant] = useState(task ? task.variant ?? "" : savedSelection.variant); const [attachments, setAttachments] = useState<Attachment[]>([]); const [createdSessionId, setCreatedSessionId] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { const invocation = slashCommand(prompt); if (invocation && !commands.some((item) => item.id === invocation.name)) throw new Error(`Команда /${invocation.name} не найдена.`); if (invocation && attachments.length) throw new Error("Slash Command нельзя отправить вместе с файлами."); let sessionId = createdSessionId; if (!sessionId) { const endpoint = task ? `/api/v1/projects/${project.id}/tasks/${task.id}/sessions` : `/api/v1/projects/${project.id}/sessions`; const session = await api<Session>(endpoint, { method: "POST", ...jsonBody({ title: title || null }) }); sessionId = session.id; setCreatedSessionId(sessionId); } if (invocation) { await api(`/api/v1/projects/${project.id}/sessions/${sessionId}/commands/${encodeURIComponent(invocation.name)}`, { method: "POST", ...jsonBody({ arguments: invocation.arguments, agent: agent || null, model: model || null, ...(variant ? { variant } : {}) }) }); } else if (prompt.trim() || attachments.length) { const mentions = mentionedAgents(prompt, agents); await api(`/api/v1/projects/${project.id}/sessions/${sessionId}/prompt`, { method: "POST", ...jsonBody({ prompt: prompt.trim(), agent: agent || null, model: model || null, ...(variant ? { variant } : {}), attachments, ...(mentions.length ? { mentions } : {}) }) }); } rememberComposerSelection(project.id, agent, model, variant); onCreated(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal composer title={task ? "Новая сессия в задаче" : "Новая сессия"} subtitle={task ? `Связанный диалог для «${task.title}»` : project.name} onClose={onClose}><form className="form-stack compact-composer-form" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}<Field label="Название"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={task ? `${task.title} · дополнительный диалог` : "Название сессии"} /></Field><PromptBox prompt={prompt} onPromptChange={setPrompt} attachments={attachments} onAttachmentsChange={setAttachments} onError={setError} agent={agent} onAgentChange={setAgent} model={model} onModelChange={setModel} variant={variant} onVariantChange={setVariant} agents={agents} commands={commands} providers={providers} config={config} placeholder="Первое сообщение…" submitLabel={task ? "Создать связанную сессию" : "Создать сессию"} busy={busy} allowEmpty mentionsEnabled />{createdSessionId && error && <Banner tone="notice">Сессия уже создана. Повторная отправка продолжит её без дубля.</Banner>}</form></Modal>;
}

type ScheduleKind = "minutes" | "hours" | "daily" | "days";

function TaskComposer({ project, agents, commands, providers, config, defaultModel, onClose, onCreated }: { project: Project; agents: Agent[]; commands: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; defaultModel?: string; onClose: () => void; onCreated: () => void }) {
  const savedSelection = rememberedComposerSelection(project.id, agents);
  const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [agent, setAgent] = useState(() => savedSelection.agent); const [model, setModel] = useState(savedSelection.model || config?.model || defaultModel || ""); const [variant, setVariant] = useState(savedSelection.variant); const [attachments, setAttachments] = useState<Attachment[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false); const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("daily"); const [interval, setInterval] = useState(1); const [time, setTime] = useState("09:00"); const [minute, setMinute] = useState(0); const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [cronSessionMode, setCronSessionMode] = useState<"new" | "reuse">("new");
  const cron = scheduleCron(scheduleKind, interval, time, minute);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { const invocation = slashCommand(prompt); if (invocation && !commands.some((item) => item.id === invocation.name)) throw new Error(`Команда /${invocation.name} не найдена.`); if (invocation && attachments.length) throw new Error("Slash Command нельзя запустить вместе с файлами."); const mentions = mentionedAgents(prompt, agents); await api(`/api/v1/projects/${project.id}/tasks`, { method: "POST", ...jsonBody({ title, prompt, agent: agent || null, model: model || null, ...(variant ? { variant } : {}), ...(mentions.length ? { mentions } : {}), attachments: scheduled ? [] : attachments, cron: scheduled ? cron : null, timezone, cron_session_mode: cronSessionMode }) }); rememberComposerSelection(project.id, agent, model, variant); onCreated(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal composer title="Запустить задачу" subtitle={project.root} onClose={onClose}>
    <form className="form-stack compact-composer-form" onSubmit={(event) => void submit(event)}>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="form-row compact-launch-row"><Field label="Название"><input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="Что нужно сделать?" /></Field><Field label="Запуск"><select value={scheduled ? "schedule" : "now"} onChange={(event) => { const next = event.target.value === "schedule"; setScheduled(next); if (next) setAttachments([]); }}><option value="now">Сейчас</option><option value="schedule">По расписанию</option></select></Field></div>
      {scheduled && <><ScheduleBuilder scheduleKind={scheduleKind} setScheduleKind={setScheduleKind} interval={interval} setInterval={setInterval} time={time} setTime={setTime} minute={minute} setMinute={setMinute} timezone={timezone} setTimezone={setTimezone} cron={cron} notice /><Field label="Контекст запусков" hint="Новая сессия не отправляет модели историю прошлых запусков и экономит input-токены."><select value={cronSessionMode} onChange={(event) => setCronSessionMode(event.target.value as "new" | "reuse")}><option value="new">Новая сессия для каждого запуска</option><option value="reuse">Продолжать предыдущую сессию</option></select></Field></>}
      <PromptBox prompt={prompt} onPromptChange={setPrompt} attachments={attachments} onAttachmentsChange={setAttachments} onError={setError} agent={agent} onAgentChange={setAgent} model={model} onModelChange={setModel} variant={variant} onVariantChange={setVariant} agents={agents} commands={commands} providers={providers} config={config} placeholder="Опишите задачу, ограничения и проверку результата…" submitLabel={scheduled ? "Создать расписание" : "Запустить агента"} busy={busy} required attachmentsEnabled={!scheduled} mentionsEnabled />
    </form>
  </Modal>;
}

function ScheduleBuilder({ scheduleKind, setScheduleKind, interval, setInterval, time, setTime, minute, setMinute, timezone, setTimezone, cron, notice = false }: { scheduleKind: ScheduleKind; setScheduleKind: (value: ScheduleKind) => void; interval: number; setInterval: (value: number) => void; time: string; setTime: (value: string) => void; minute: number; setMinute: (value: number) => void; timezone: string; setTimezone: (value: string) => void; cron: string; notice?: boolean }) {
  return <div className="schedule-builder">
    <Field label="Как часто"><select value={scheduleKind} onChange={(event) => { const next = event.target.value as ScheduleKind; setScheduleKind(next); setInterval(next === "minutes" ? 15 : next === "days" ? 2 : 1); }}><option value="minutes">Каждые несколько минут</option><option value="hours">Каждые несколько часов</option><option value="daily">Каждый день</option><option value="days">Каждые несколько дней</option></select></Field>
    {scheduleKind === "minutes" && <Field label="Интервал в минутах" hint="От 1 до 59 минут"><input type="number" min="1" max="59" value={interval} onChange={(event) => setInterval(Math.min(59, Math.max(1, Number(event.target.value) || 1)))} /></Field>}
    {scheduleKind === "hours" && <div className="form-row"><Field label="Интервал в часах" hint="От 1 до 23 часов"><input type="number" min="1" max="23" value={interval} onChange={(event) => setInterval(Math.min(23, Math.max(1, Number(event.target.value) || 1)))} /></Field><Field label="На какой минуте часа"><select value={minute} onChange={(event) => setMinute(Number(event.target.value))}><option value="0">в 00 минут</option><option value="15">в 15 минут</option><option value="30">в 30 минут</option><option value="45">в 45 минут</option></select></Field></div>}
    {scheduleKind === "days" && <div className="form-row"><Field label="Интервал в днях" hint="2 означает через день"><input type="number" min="2" max="31" value={interval} onChange={(event) => setInterval(Math.min(31, Math.max(2, Number(event.target.value) || 2)))} /></Field><Field label="Время запуска"><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></Field></div>}
    {scheduleKind === "daily" && <Field label="Время запуска"><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></Field>}
    <Field label="Часовой пояс" hint="IANA timezone, например Europe/Moscow"><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required placeholder="Europe/Moscow" /></Field>
    <div className="schedule-summary"><strong>{describeCron(cron)}</strong><span>Часовой пояс: {timezone}</span><small>OpenCode Control должен работать, а Mac не должен спать или быть выключен.</small></div>
    {notice && <Banner tone="notice">Файлы для регулярных задач не сохраняются; добавьте нужные материалы в проект.</Banner>}
  </div>;
}

function TaskScheduleEditor({ project, task, agents, commands, onClose, onSaved }: { project: Project; task: Task; agents: Agent[]; commands: CommandItem[]; onClose: () => void; onSaved: () => void }) {
  const parsed = parseScheduleCron(task.cron ?? "");
  const [mode, setMode] = useState<"manual" | "cron">(task.cron ? "cron" : "manual");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(parsed?.kind ?? "daily");
  const [interval, setInterval] = useState(parsed?.interval ?? 1);
  const [time, setTime] = useState(parsed?.time ?? "09:00");
  const [minute, setMinute] = useState(parsed?.minute ?? 0);
  const [timezone, setTimezone] = useState(task.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
  const [cronSessionMode, setCronSessionMode] = useState<"new" | "reuse">(task.cron_session_mode ?? "new");
  const [customCron, setCustomCron] = useState(parsed ? "" : task.cron ?? "");
  const [prompt, setPrompt] = useState(task.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cron = customCron || scheduleCron(scheduleKind, interval, time, minute);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const mentions = mentionedAgents(prompt, agents);
      const payload = mode === "manual" ? { mode: "manual", prompt, mentions } : { mode: "cron", prompt, mentions, cron, timezone, cron_session_mode: cronSessionMode, enabled: task.cron ? Boolean(task.schedule_enabled) : true };
      await api(`/api/v1/projects/${project.id}/tasks/${task.id}/schedule`, { method: "PATCH", ...jsonBody(payload) });
      onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <Modal composer title="Режим запуска" subtitle={task.title} onClose={onClose}><form className="form-stack compact-composer-form" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}<Field label="Задание для каждого запуска"><SchedulePromptEditor value={prompt} onChange={setPrompt} agents={agents} commands={commands} /></Field><Field label="Режим"><select value={mode} onChange={(event) => setMode(event.target.value as "manual" | "cron")}><option value="manual">Ручной</option><option value="cron">По расписанию</option></select></Field>{mode === "cron" && <>{customCron ? <div className="schedule-builder"><Field label="Cron-выражение" hint="Можно сохранить текущее выражение как есть."><input className="mono" value={customCron} onChange={(event) => setCustomCron(event.target.value)} required /></Field><Field label="Часовой пояс"><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></Field><div className="schedule-summary"><strong>{describeCron(customCron)}</strong><span>{timezone}</span></div><button type="button" className="text-button" onClick={() => setCustomCron("")}>Открыть конструктор</button></div> : <ScheduleBuilder scheduleKind={scheduleKind} setScheduleKind={setScheduleKind} interval={interval} setInterval={setInterval} time={time} setTime={setTime} minute={minute} setMinute={setMinute} timezone={timezone} setTimezone={setTimezone} cron={cron} />}<Field label="Контекст запусков" hint="Для независимых проверок выбирайте новую сессию: история не растёт от запуска к запуску."><select value={cronSessionMode} onChange={(event) => setCronSessionMode(event.target.value as "new" | "reuse")}><option value="new">Новая сессия для каждого запуска</option><option value="reuse">Продолжать предыдущую сессию</option></select></Field></>}{mode === "manual" && <p className="compact-form-note">Расписание будет удалено. Ручной запуск останется доступен в карточке задачи.</p>}<div className="modal-actions compact-modal-actions"><button type="button" className="text-button" onClick={onClose}>Отмена</button><button className="primary-button" disabled={busy || !prompt.trim()}>{busy ? "Сохраняется…" : "Сохранить"}</button></div></form></Modal>;
}

function SchedulePromptEditor({ value, onChange, agents, commands }: { value: string; onChange: (value: string) => void; agents: Agent[]; commands: CommandItem[] }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const mentionOptions = mention ? agents.filter((item) => !item.hidden && item.mode !== "primary" && item.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8) : [];
  const commandQuery = /^\/([a-z0-9_-]*)$/u.exec(value)?.[1]?.toLowerCase();
  const commandOptions = commandQuery === undefined ? [] : commands.filter((item) => item.id.toLowerCase().includes(commandQuery) || commandDisplayDescription(item).toLowerCase().includes(commandQuery)).slice(0, 8);
  function updateMention(next: string, cursor: number | null) { const before = next.slice(0, cursor ?? next.length); const match = /(?:^|\s)@([\w-]*)$/u.exec(before); setMention(match ? { start: before.lastIndexOf("@"), query: match[1] } : null); setMentionIndex(0); }
  function selectMention(agent: Agent) { if (!mention) return; const cursor = textarea.current?.selectionStart ?? value.length; const next = `${value.slice(0, mention.start)}@${agent.name} ${value.slice(cursor)}`; onChange(next); setMention(null); requestAnimationFrame(() => { const position = mention.start + agent.name.length + 2; textarea.current?.focus(); textarea.current?.setSelectionRange(position, position); }); }
  function selectCommand(item: CommandItem) { onChange(`/${item.id} `); setCommandIndex(0); requestAnimationFrame(() => textarea.current?.focus()); }
  function keyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) { if (mentionOptions.length) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length); } else if (event.key === "Enter") { event.preventDefault(); selectMention(mentionOptions[mentionIndex]); } return; } if (commandOptions.length) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commandOptions.length) % commandOptions.length); } else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectCommand(commandOptions[commandIndex]); } } }
  return <div className="schedule-prompt-editor"><textarea ref={textarea} value={value} onChange={(event) => { onChange(event.target.value); updateMention(event.target.value, event.target.selectionStart); }} onKeyDown={keyDown} required placeholder="Что выполнять при каждом запуске?" />{mentionOptions.length > 0 && <div className="agent-mention-menu" role="listbox" aria-label="Выбор подагента">{mentionOptions.map((agent, index) => <button type="button" role="option" aria-selected={index === mentionIndex} className={index === mentionIndex ? "selected" : ""} key={agent.name} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(agent)}><Bot size={14} /><span><strong>@{agent.name}</strong><small>{localizedAgentDescription(agent.name, agent.description)}</small></span></button>)}</div>}{commandOptions.length > 0 && <div className="agent-mention-menu command-palette" role="listbox" aria-label="Выбор Slash Command">{commandOptions.map((item, index) => <button type="button" role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCommand(item)}>{item.kind === "skill" ? <Sparkles size={14} /> : <SquareTerminal size={14} />}<span><strong>/{item.id}</strong><small>{commandDisplayDescription(item)}</small></span></button>)}</div>}</div>;
}

type PromptBoxProps = { prompt: string; onPromptChange: (value: string) => void; attachments: Attachment[]; onAttachmentsChange: (value: Attachment[]) => void; onError: (value: string | null) => void; agent: string; onAgentChange: (value: string) => void; model: string; onModelChange: (value: string) => void; variant: string; onVariantChange: (value: string) => void; agents: Agent[]; commands?: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; placeholder: string; submitLabel: string; busy: boolean; required?: boolean; attachmentsEnabled?: boolean; allowEmpty?: boolean; mentionsEnabled?: boolean; active?: boolean; stopping?: boolean; onStop?: () => void };

function PromptBox({ prompt, onPromptChange, attachments, onAttachmentsChange, onError, agent, onAgentChange, model, onModelChange, variant, onVariantChange, agents, commands = [], providers, config, placeholder, submitLabel, busy, required = false, attachmentsEnabled = true, allowEmpty = false, mentionsEnabled = false, active = false, stopping = false, onStop }: PromptBoxProps) {
  const [dragActive, setDragActive] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandMenu = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mentionOptions = mention ? agents.filter((item) => !item.hidden && item.mode !== "primary" && item.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8) : [];
  const commandQuery = /^\/([a-z0-9_-]*)$/u.exec(prompt)?.[1]?.toLowerCase();
  const commandOptions = commandQuery === undefined ? [] : commands.filter((item) => item.id.toLowerCase().includes(commandQuery) || commandDisplayDescription(item).toLowerCase().includes(commandQuery)).slice(0, 8);
  const commandOptionIds = commandOptions.map((item) => item.id).join("|");
  const effectiveAgent = agents.find((candidate) => candidate.name === (agent || config?.default_agent));
  const effectiveModel = model || agentModel(effectiveAgent) || config?.model || "";
  const variants = modelVariants(providers, effectiveModel);
  function changeAgent(value: string) { onAgentChange(value); if (!model) onVariantChange(""); }
  function changeModel(value: string) { onModelChange(value); onVariantChange(""); }
  useEffect(() => { commandMenu.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [commandIndex, commandOptionIds]);
  function updateMention(value: string, cursor: number | null) {
    if (!mentionsEnabled || cursor === null) { setMention(null); return; }
    const match = value.slice(0, cursor).match(/(?:^|[\s([{"'])@([^\s@]*)$/u);
    if (!match) { setMention(null); return; }
    setMention({ start: cursor - (match[1]?.length ?? 0) - 1, query: match[1] ?? "" });
    setMentionIndex(0);
  }
  function selectMention(item: Agent) {
    if (!mention) return;
    const cursor = textarea.current?.selectionStart ?? mention.start + mention.query.length + 1;
    const insertion = `@${item.name} `;
    const next = `${prompt.slice(0, mention.start)}${insertion}${prompt.slice(cursor)}`;
    const nextCursor = mention.start + insertion.length;
    onPromptChange(next); setMention(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(nextCursor, nextCursor); });
  }
  function selectCommand(item: CommandItem) { onPromptChange(`/${item.id} `); setCommandIndex(0); requestAnimationFrame(() => textarea.current?.focus()); }
  async function dropFiles(files: File[]) {
    if (!attachmentsEnabled) return;
    try { onAttachmentsChange(await appendAttachments(attachments, files)); onError(null); }
    catch (reason) { onError(message(reason)); }
  }
  return <div className={`composer-box prompt-box ${dragActive ? "drag-active" : ""}`} onDragEnter={(event) => { if (!attachmentsEnabled) return; event.preventDefault(); setDragActive(true); }} onDragOver={(event) => { if (!attachmentsEnabled) return; event.preventDefault(); setDragActive(true); }} onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => { if (!attachmentsEnabled) return; event.preventDefault(); setDragActive(false); void dropFiles(Array.from(event.dataTransfer.files)); }}>
    <textarea ref={textarea} aria-label={placeholder} value={prompt} onChange={(event) => { onPromptChange(event.target.value); updateMention(event.target.value, event.target.selectionStart); setCommandIndex(0); }} onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={(event) => { if (commandOptions.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) { event.preventDefault(); if (event.key === "ArrowDown") setCommandIndex((current) => (current + 1) % commandOptions.length); else if (event.key === "ArrowUp") setCommandIndex((current) => (current - 1 + commandOptions.length) % commandOptions.length); else if (event.key === "Escape") onPromptChange(""); else selectCommand(commandOptions[commandIndex] ?? commandOptions[0]); return; } if (mentionOptions.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) { event.preventDefault(); if (event.key === "ArrowDown") setMentionIndex((current) => (current + 1) % mentionOptions.length); else if (event.key === "ArrowUp") setMentionIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length); else if (event.key === "Escape") setMention(null); else selectMention(mentionOptions[mentionIndex] ?? mentionOptions[0]); return; } if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return; event.preventDefault(); if (!busy && !active && (allowEmpty || prompt.trim() || attachments.length > 0)) event.currentTarget.form?.requestSubmit(); }} rows={5} required={required} placeholder={dragActive ? "Отпустите файлы здесь…" : placeholder} />
    {commandOptions.length > 0 && <div ref={commandMenu} className="agent-mention-menu command-palette" role="listbox" aria-label="Выбор Slash Command">{commandOptions.map((item, index) => <button type="button" role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""} key={item.id} onMouseEnter={() => setCommandIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCommand(item)}>{item.kind === "skill" ? <Sparkles size={14} /> : <SquareTerminal size={14} />}<span><strong>/{item.id}</strong><small>{commandDisplayDescription(item)}</small></span>{item.has_shell && <em>Shell</em>}</button>)}</div>}
    {mention && mentionOptions.length > 0 && <div className="agent-mention-menu" role="listbox" aria-label="Выбор подагента">{mentionOptions.map((item, index) => <button type="button" role="option" aria-selected={index === mentionIndex} className={index === mentionIndex ? "selected" : ""} key={item.name} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(item)}><Bot size={14} /><span><strong>@{item.name}</strong><small>{localizedAgentDescription(item.name, item.description)}</small></span></button>)}</div>}
    {attachmentsEnabled && <FileAttachments compact value={attachments} onChange={onAttachmentsChange} onError={onError} />}
    <div className="composer-controls"><AgentPicker compact agents={agents} value={agent} onChange={changeAgent} />{variants.length > 0 && <VariantPicker compact variants={variants} value={variants.includes(variant) ? variant : ""} onChange={onVariantChange} model={effectiveModel} />}<ModelPicker compact providers={providers} configuredProviders={config?.configured_providers ?? []} value={model} onChange={changeModel} />{active ? <button type="button" className="composer-send composer-stop" aria-label="Остановить ответ" title="Остановить ответ" onClick={onStop} disabled={stopping}>{stopping ? <RefreshCw className="spin" size={16} /> : <Square size={14} fill="currentColor" />}</button> : <button className="composer-send" aria-label={submitLabel} title={submitLabel} disabled={busy || (!allowEmpty && !prompt.trim() && attachments.length === 0)}>{busy ? <RefreshCw className="spin" size={16} /> : <ArrowUp size={17} />}</button>}</div>
  </div>;
}

function FileAttachments({ value, onChange, onError, compact = false }: { value: Attachment[]; onChange: (value: Attachment[]) => void; onError: (value: string | null) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  async function add(nextFiles: File[]) {
    try {
      onChange(await appendAttachments(value, nextFiles));
      onError(null);
    } catch (reason) { onError(message(reason)); }
    finally { if (input.current) input.current.value = ""; }
  }
  function drag(event: DragEvent<HTMLDivElement>) { event.preventDefault(); event.stopPropagation(); setDragActive(true); }
  function drop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); event.stopPropagation(); setDragActive(false); void add(Array.from(event.dataTransfer.files)); }
  return <div className={`attachment-field ${compact ? "compact-attachment-field" : ""} ${dragActive ? "drag-active" : ""}`} onDragEnter={drag} onDragOver={drag} onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={drop}><input ref={input} className="file-input" type="file" multiple onChange={(event) => void add(Array.from(event.target.files ?? []))} /><button type="button" className="secondary-button attachment-button" aria-label="Прикрепить файлы" title="Прикрепить файлы" onClick={() => input.current?.click()} disabled={value.length >= 4}><Paperclip size={16} /><span>Добавить файлы</span></button><small>{dragActive ? "Отпустите файлы здесь" : "До 4 файлов по 5 MB · поддержка формата зависит от модели"}</small>{value.length > 0 && <div className="attachment-list">{value.map((item, index) => <div className="attachment-preview" key={`${item.filename}-${index}`}>{item.mime.startsWith("image/") ? <img src={item.data_url} alt="" /> : <span className="attachment-file-icon"><File size={16} /></span>}<span title={item.filename}>{item.filename}</span><button type="button" aria-label={`Удалить ${item.filename}`} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></div>)}</div>}</div>;
}

type TimeRange = { start?: number; end?: number };
type ToolState = { status: "pending" | "running" | "completed" | "error"; title?: string; command?: string; input?: string; output?: string; error?: string; workdir?: string; exit_code?: number; truncated?: boolean; full_output?: boolean; time?: TimeRange };
type SessionPart = { type?: string; text?: string; mime?: string; filename?: string; tool?: string; state?: ToolState; time?: TimeRange; duration?: number; reason?: string; agent?: string; name?: string; files?: string[]; attempt?: number; error?: string; cost?: number; tokens?: MessageTokens };
type MessageTokens = { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
type SessionMessage = { info?: { id?: string; role?: string; tokens?: MessageTokens; time?: { created?: number; completed?: number }; agent?: string; modelID?: string; providerID?: string; variant?: string; cost?: number; finish?: string; error?: string }; parts?: SessionPart[] };
type SessionTodo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: "high" | "medium" | "low" };
type SessionPermission = { id: string; permission: string; patterns: string[] };

const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return <Suspense fallback={<div className="message-markdown">{content}</div>}><MarkdownRenderer content={content} /></Suspense>;
});

function SessionPartView({ part, index, now }: { part: SessionPart; index: number; now: number }) {
  if (part.type === "text" && part.text) return <MessageMarkdown content={part.text} />;
  if (part.type === "file") return <div className="message-files"><span><File size={12} /> {part.filename ?? part.mime ?? "файл"}</span></div>;
  if (part.type === "reasoning" && part.text) return <details className="reasoning-event"><summary>{part.time?.start !== undefined ? `Рассуждение · ${formatMilliseconds((part.time.end ?? now) - part.time.start)}` : "Рассуждение"}</summary><MessageMarkdown content={part.text} /></details>;
  if (part.type === "subtask") return <div className="cli-event"><Bot size={13} /><span><strong>Подагент {part.agent ?? ""}</strong>{part.text}</span></div>;
  if (part.type === "patch") return <div className="cli-event"><FileCode2 size={13} /><span><strong>Изменены файлы</strong>{part.files?.join(", ") || "Список файлов недоступен"}</span></div>;
  if (part.type === "agent") return <div className="cli-event"><Bot size={13} /><span>Агент: <strong>{part.name ?? "по умолчанию"}</strong></span></div>;
  if (part.type === "retry") return <div className="cli-event retry-event"><RefreshCw size={13} /><span><strong>Повтор {part.attempt ?? ""}</strong>{part.error ?? "OpenCode повторяет запрос"}</span></div>;
  if (part.type === "compaction") return <div className="step-divider"><span>Контекст сжат</span></div>;
  if (part.type === "snapshot") return <div className="cli-event"><Check size={13} /><span>Снимок состояния сохранён</span></div>;
  if (part.type === "step-start") return <div className="step-divider"><span>Шаг агента</span></div>;
  if (part.type === "step-finish") return <div className="step-finish"><Check size={12} /> {part.reason ?? "Шаг завершён"}{part.tokens?.output !== undefined ? ` · ${compact(part.tokens.output)} токенов` : ""}{part.cost !== undefined ? ` · $${part.cost.toFixed(4)}` : ""}{part.duration !== undefined ? ` · ${formatDuration(part.duration)} всего` : ""}</div>;
  if (part.type !== "tool" || !part.tool || !part.state) return null;
  const native = new Set(["bash", "shell", "read", "write", "edit", "glob", "grep", "task", "skill", "webfetch", "todowrite", "question"]);
  const isMcp = part.tool.includes("_") && !native.has(part.tool);
  const isShell = part.tool === "bash" || part.tool === "shell";
  const duration = part.state.time?.start !== undefined ? formatDuration((part.state.time.end ?? now) - part.state.time.start) : null;
  const details = [isMcp ? `MCP / ${part.tool}` : part.tool, duration, part.state.exit_code !== undefined ? `exit ${part.state.exit_code}` : null, isShell ? part.state.workdir : null].filter(Boolean).join(" · ");
  return <details className={`tool-event ${part.state.status} ${isShell ? "shell-tool" : ""}`}>
    <summary><span className="tool-event-icon">{isMcp ? <Network size={14} /> : <SquareTerminal size={14} />}</span><span><strong>{isShell && part.state.command ? `$ ${part.state.command}` : part.state.title || part.tool}</strong><small>{details}</small></span><Status value={part.state.status} /></summary>
    {!isShell && part.state.command && <pre className="tool-command"><code>{part.state.command}</code></pre>}
    {!part.state.command && part.state.input && <pre className="tool-command"><code>{part.state.input}</code></pre>}
    {part.state.output && <pre className="tool-output"><code>{part.state.output}</code></pre>}
    {isShell && part.state.status === "running" && !part.state.output && <div className="tool-output-waiting">Вывод пока не поступил…</div>}
    {part.state.truncated && <div className="tool-output-notice">OpenCode сохранил только часть вывода.</div>}
    {part.state.error && <pre className="tool-error"><code>{part.state.error}</code></pre>}
    <span className="sr-only">tool-{index}</span>
  </details>;
}

function PermissionRequestCard({ permission, onReply }: { permission: SessionPermission; onReply: (reply: "once" | "always" | "reject") => void }) {
  return <section className="permission-request-card"><header><CircleStop size={15} /><span><strong>Требуется разрешение</strong><small>{permission.permission}</small></span></header>{permission.patterns.length > 0 && <div className="permission-patterns">{permission.patterns.map((pattern) => <code key={pattern}>{pattern}</code>)}</div>}<div className="permission-request-actions"><button className="primary-button" onClick={() => onReply("once")}>Разрешить один раз</button><button className="secondary-button" onClick={() => onReply("always")}>Разрешать всегда</button><button className="text-button danger-text" onClick={() => onReply("reject")}>Отклонить</button></div></section>;
}

function GitDiffViewer({ project, path, revision }: { project: Project; path: string; revision: string }) {
  const diff = useResource<{ path: string; diff: string }>(`/api/v1/projects/${project.id}/git/diff?path=${encodeURIComponent(path)}`, revision);
  if (diff.error) return <Banner tone="danger">{diff.error}</Banner>;
  if (!diff.data) return <div className="git-loading">Загрузка diff…</div>;
  const lines = (diff.data.diff || "Изменений в рабочем дереве нет.").split("\n");
  return <pre className="git-diff"><code>{lines.map((line, index) => {
    let kind = "context";
    if (line.startsWith("@@")) kind = "hunk";
    else if (line.startsWith("+") && !line.startsWith("+++")) kind = "added";
    else if (line.startsWith("-") && !line.startsWith("---")) kind = "removed";
    else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) kind = "meta";
    return <span className={`git-diff-line ${kind}`} key={`${index}-${line}`}>{line || " "}</span>;
  })}</code></pre>;
}

function gitChangeLabel(status: string) {
  if (status === "??") return "Новый";
  if (status.includes("U")) return "Конфликт";
  if (status.includes("R")) return "Переименован";
  if (status.includes("D")) return "Удалён";
  if (status.includes("A")) return "Добавлен";
  if (status.includes("M")) return "Изменён";
  return "Изменение";
}

function SessionGitPanel({ project, state, onReload, onClose }: { project: Project; state: GitState; onReload: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<"changes" | "commits">("changes");
  const [selected, setSelected] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [checkedPaths, setCheckedPaths] = useState<string[]>([]);
  const [selectedCommitHash, setSelectedCommitHash] = useState("");
  const [diffFocused, setDiffFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [width, setWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("control-git-panel-width"));
    return saved >= 400 ? saved : 480;
  });
  const selectedPath = state.changes.some((item) => item.path === selected) ? selected : state.changes[0]?.path;
  function resize(nextWidth: number) {
    const workspaceWidth = document.querySelector<HTMLElement>(".session-workspace.with-git")?.clientWidth || window.innerWidth;
    const next = Math.min(Math.max(nextWidth, 380), Math.max(380, workspaceWidth - 480));
    setWidth(next);
    window.localStorage.setItem("control-git-panel-width", String(next));
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const left = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const move = (next: PointerEvent) => resize(next.clientX - left);
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
  const stagedChanges = state.changes.filter((change) => change.staged);
  const unstagedChanges = state.changes.filter((change) => change.unstaged);
  const checkedChanges = state.changes.filter((change) => checkedPaths.includes(change.path));
  const checkedStaged = checkedChanges.filter((change) => change.staged);
  const checkedUnstaged = checkedChanges.filter((change) => change.unstaged);
  const selectedCommit = state.commits.find((commit) => commit.hash === selectedCommitHash) ?? state.commits[0];
  function togglePath(path: string) {
    setCheckedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  }
  async function updateIndex(action: "stage" | "unstage", paths: string[]) {
    if (!paths.length) return;
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/git/${action}`, { method: "POST", ...jsonBody({ paths }) });
      setError(null); onReload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function commit(event: FormEvent) {
    event.preventDefault();
    if (!commitMessage.trim() || stagedChanges.length === 0) return;
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/git/commit`, { method: "POST", ...jsonBody({ message: commitMessage.trim(), paths: stagedChanges.map((item) => item.path) }) });
      setCommitMessage(""); setError(null); onReload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function revertCommit(commit: GitState["commits"][number]) {
    if (!confirm(`Создать новый коммит, отменяющий изменения ${commit.short_hash} «${commit.subject}»? Ветка не будет переключена на старую версию.`)) return;
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/git/revert`, { method: "POST", ...jsonBody({ commit: commit.hash }) });
      setError(null); onReload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function resetToCommit(commit: GitState["commits"][number]) {
    if (!confirm(`Переместить текущую ветку на ${commit.short_hash} «${commit.subject}» через git reset --hard? Действие доступно только при чистом рабочем дереве; перед переходом будет создана backup-ветка.`)) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const result = await api<{ backup_branch: string }>(`/api/v1/projects/${project.id}/git/reset`, { method: "POST", ...jsonBody({ commit: commit.hash }) });
      setNotice(`Ветка перемещена на ${commit.short_hash}. Резервная ветка: ${result.backup_branch}`);
      onReload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  const revision = state.revision ?? state.changes.map((item) => `${item.status}:${item.path}`).join("|");
  return <aside className={`git-panel${diffFocused ? " diff-focused" : ""}`} style={{ width }}>
    <div className="git-panel-resize" role="separator" aria-label="Изменить ширину Git-панели" aria-orientation="vertical" tabIndex={0} onPointerDown={startResize} onDoubleClick={() => resize(440)} onKeyDown={(event) => { if (event.key === "ArrowLeft") resize(width - 30); if (event.key === "ArrowRight") resize(width + 30); }} />
    <header><span><GitBranch size={15} /><strong>{state.branch || "detached HEAD"}</strong></span><button className="icon-button" aria-label="Скрыть Git-панель" onClick={onClose}><X size={14} /></button></header>
    <div className="git-index-toolbar"><div className="git-index-summary"><label><input type="checkbox" aria-label="Выбрать все изменения" checked={state.changes.length > 0 && checkedChanges.length === state.changes.length} onChange={(event) => setCheckedPaths(event.target.checked ? state.changes.map((item) => item.path) : [])} /><span><strong>Подготовка</strong><small>В коммите {stagedChanges.length} · вне {unstagedChanges.length} · выбрано {checkedChanges.length}</small></span></label></div><div className="git-index-actions"><button className="index-add" aria-label="Добавить выбранные" title="Добавить отмеченные файлы в будущий коммит" disabled={busy || checkedUnstaged.length === 0} onClick={() => void updateIndex("stage", checkedUnstaged.map((item) => item.path))}><Plus size={13} /> Выбр.</button><button aria-label="Убрать выбранные" title="Убрать отмеченные файлы из будущего коммита, сохранив изменения" disabled={busy || checkedStaged.length === 0} onClick={() => void updateIndex("unstage", checkedStaged.map((item) => item.path))}><Minus size={13} /> Выбр.</button><button className="index-add" aria-label="Добавить все" title="Добавить все изменённые файлы в будущий коммит" disabled={busy || unstagedChanges.length === 0} onClick={() => void updateIndex("stage", unstagedChanges.map((item) => item.path))}><Plus size={13} /> Все</button><button aria-label="Очистить индекс" title="Убрать все файлы из будущего коммита, не удаляя изменения" disabled={busy || stagedChanges.length === 0} onClick={() => void updateIndex("unstage", stagedChanges.map((item) => item.path))}><Minus size={13} /> Все</button></div></div>
    <details className="git-help"><summary role="button" aria-label="Справка по Git-панели" title="Как пользоваться Git-панелью"><CircleHelp size={16} /></summary><ol><li>Отметьте нужные файлы и нажмите <strong>Добавить выбранные</strong>.</li><li><strong>Убрать выбранные</strong> исключает файлы из коммита, но сохраняет изменения на диске.</li><li>Введите сообщение снизу и нажмите <strong>Создать коммит</strong>.</li><li><strong>Перейти сюда</strong> перемещает локальную ветку на выбранный коммит и сохраняет прежнее состояние в backup-ветке.</li><li><strong>Обратить</strong> создаёт новый обратный коммит и подходит для уже опубликованной ветки.</li></ol></details>
    <div className="git-tabs"><button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>Изменения <span>{state.changes.length}</span></button><button className={tab === "commits" ? "active" : ""} onClick={() => setTab("commits")}>Коммиты</button></div>
    {tab === "changes" ? <>
      <div className="git-file-list">{state.changes.map((change) => <div className="git-file-row" key={change.path}><input type="checkbox" aria-label={`Выбрать ${change.path}`} checked={checkedPaths.includes(change.path)} onChange={() => togglePath(change.path)} /><button className={change.path === selectedPath ? "active" : ""} onClick={() => setSelected(change.path)}><span className="git-change-kind" data-status={change.status.trim() || "M"}>{gitChangeLabel(change.status)}</span><span title={change.path}>{change.path}</span></button><span className="git-file-actions">{change.unstaged && <button className="index-add" aria-label={`Добавить ${change.path}`} title="Добавить файл в будущий коммит" disabled={busy} onClick={() => void updateIndex("stage", [change.path])}><Plus size={14} /></button>}{change.staged && <button aria-label={`Убрать ${change.path}`} title="Убрать файл из будущего коммита" disabled={busy} onClick={() => void updateIndex("unstage", [change.path])}><Minus size={14} /></button>}</span></div>)}{state.changes.length === 0 && <p>Рабочее дерево чистое</p>}</div>
      <section className="git-diff-panel"><header><span><FileCode2 size={15} /><strong>{selectedPath || "Изменения файла"}</strong></span><span className="git-diff-tools"><small>Относительно HEAD</small><button aria-label={diffFocused ? "Вернуть Git-панель" : "Развернуть diff"} title={diffFocused ? "Показать файлы и действия" : "Оставить только код"} onClick={() => setDiffFocused((current) => !current)}>{diffFocused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></span></header><div className="git-diff-wrap">{selectedPath ? <GitDiffViewer project={project} path={selectedPath} revision={revision} /> : <p>Выберите изменённый файл</p>}</div></section>
      {state.changes.length > 0 && <form className="git-commit-form" onSubmit={(event) => void commit(event)}>{error && <small>{error}</small>}<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={stagedChanges.length ? `Сообщение для ${stagedChanges.length} файлов` : "Сначала добавьте файлы в коммит"} maxLength={500} /><button className="primary-button" disabled={busy || stagedChanges.length === 0 || !commitMessage.trim()}><GitCommitHorizontal size={14} /> {busy ? "…" : "Создать коммит"}</button></form>}
    </> : <div className="git-commit-list">{error && <small className="git-action-error">{error}</small>}{notice && <small className="git-action-notice">{notice}</small>}<div className="git-history-note"><strong>Перейти сюда</strong><span>перемещает ветку через <code>reset --hard</code> и создаёт backup-ветку. Только для локальной истории.</span><strong>Обратить</strong><span>создаёт новый обратный коммит. Безопаснее для уже опубликованной ветки.</span></div>{selectedCommit && <div className="git-history-selection"><span><small>Выбран коммит</small><strong>{selectedCommit.short_hash} · {selectedCommit.subject}</strong></span><div className="git-commit-actions"><button className="git-reset-action" aria-label={`Перейти к ${selectedCommit.short_hash}`} title="Переместить ветку через git reset --hard с созданием backup-ветки" disabled={busy} onClick={() => void resetToCommit(selectedCommit)}>Перейти сюда</button><button aria-label={`Обратить изменения ${selectedCommit.short_hash}`} title="Создать новый коммит, отменяющий изменения этого коммита" disabled={busy} onClick={() => void revertCommit(selectedCommit)}>Обратить</button></div></div>}{state.commits.map((commit) => <article className={commit.hash === selectedCommit?.hash ? "active" : ""} key={commit.hash} role="button" tabIndex={0} onClick={() => setSelectedCommitHash(commit.hash)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedCommitHash(commit.hash); }}><code>{commit.short_hash}</code><span className="git-commit-info"><strong>{commit.subject}</strong><small>{commit.author} · {relativeTime(commit.timestamp)}</small></span></article>)}{state.commits.length === 0 && <p>Коммитов пока нет</p>}</div>}
  </aside>;
}

function SessionDrawer({ project, session, status, taskStatus, agents, providers, mcp, config, initialAgent = "", initialModel, onDelete, onClose }: { project: Project; session: Session; status: string; taskStatus?: string; agents: Agent[]; providers: ProviderSummary[]; mcp: Record<string, { status?: string; error?: string }>; config?: RuntimeConfig; initialAgent?: string; initialModel: string; onDelete?: () => void; onClose: () => void }) {
  const messageResource = useResource<SessionMessage[]>(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/messages`, session.id, 3000);
  // The message article is also the container for provider errors, including errors without parts.
  const messages = { ...messageResource, data: messageResource.data?.map((entry) => entry.info?.error && !entry.parts?.length ? { ...entry, parts: [{ type: "text", text: "" }] } : entry) ?? null };
  const todos = useResource<SessionTodo[]>(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/todos`, session.id, 3000);
  const permissions = useResource<SessionPermission[]>(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/permissions`, session.id, 1000);
  const git = useResource<GitState>(`/api/v1/projects/${project.id}/git`, session.id, 3000);
  const commands = useResource<CommandItem[]>(`/api/v1/projects/${project.id}/commands`, project.id);
  const [savedSelection] = useState(() => readSessionSelection(project.id, session.id));
  const [selectionRestored, setSelectionRestored] = useState(() => savedSelection !== null);
  const [agent, setAgent] = useState(() => { const candidate = (savedSelection?.agent ?? initialAgent) || session.agent || ""; return agents.some((item) => !item.hidden && item.mode !== "subagent" && item.name === candidate) ? candidate : ""; }); const [model, setModel] = useState(() => savedSelection?.model ?? initialModel); const [variant, setVariant] = useState(() => savedSelection?.variant ?? (session.model?.variant === "default" ? "" : session.model?.variant ?? "")); const [busy, setBusy] = useState(false); const [aborting, setAborting] = useState(false); const [aborted, setAborted] = useState(false); const [taskStatusOverride, setTaskStatusOverride] = useState<string | null>(null); const [pendingFrom, setPendingFrom] = useState<{ id?: string; count: number } | null>(null); const [showScrollToBottom, setShowScrollToBottom] = useState(false); const [error, setError] = useState<string | null>(null); const [now, setNow] = useState(0); const [drawerWidth, setDrawerWidth] = useState(() => Math.min(Math.max(Number(window.localStorage.getItem("control-session-drawer-width")) || 960, 560), window.innerWidth - 16)); const [gitVisibility, setGitVisibility] = useState<"auto" | "shown" | "hidden">("auto");
  const streamRef = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(true);
  const stickToBottom = useRef(true);
  const scrollingToBottom = useRef(false);
  const messageCount = messages.data?.length ?? 0;
  const lastMessage = messages.data?.[messageCount - 1];
  const contextTokens = latestContextTokens(messages.data ?? []);
  const activeTodos = (todos.data ?? []).filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  const mcpEntries = Object.entries(mcp).filter(([, value]) => value.status === "connected").sort(([left], [right]) => left.localeCompare(right));
  const liveStatus = runtimeStatus(messages.data ?? [], now);
  const linkedTaskStatus = taskStatusOverride ?? taskStatus ?? session.control_task?.status;
  const stopped = aborted || linkedTaskStatus === "aborted";
  const failed = linkedTaskStatus === "failed" || status === "failed" || status === "error" || liveStatus === "failed";
  const observedStatus = failed ? "failed" : activeSessionStatus(status) ? status : liveStatus ?? status;
  const effectiveStatus = stopped ? "aborted" : busy || pendingFrom ? "busy" : observedStatus;
  const responseActive = !stopped && (busy || aborting || pendingFrom !== null || activeSessionStatus(observedStatus));
  const gitVisible = git.data?.available === true && (gitVisibility === "shown" || (gitVisibility === "auto" && git.data.changes.length > 0));
  useEffect(() => { setTaskStatusOverride(null); }, [taskStatus, session.control_task?.status]);
  useEffect(() => {
    if (selectionRestored || messages.data === null) return;
    const previous = latestUserSelection(messages.data);
    if (previous?.agent && agents.some((item) => !item.hidden && item.mode !== "subagent" && item.name === previous.agent)) setAgent(previous.agent);
    if (previous?.model) setModel(previous.model);
    if (previous?.variant) setVariant(previous.variant === "default" ? "" : previous.variant);
    setSelectionRestored(true);
  }, [agents, messages.data, selectionRestored]);
  useEffect(() => {
    if (!pendingFrom || !lastMessage) return;
    const changed = messageCount !== pendingFrom.count || lastMessage.info?.id !== pendingFrom.id;
    if (changed && lastMessage.info?.role === "assistant" && messageFinished(lastMessage)) setPendingFrom(null);
  }, [lastMessage, messageCount, pendingFrom]);
  useLayoutEffect(() => {
    if (messages.data === null) return;
    let frame = 0;
    let settlingFrames = initialScroll.current ? 4 : 1;
    const alignToLatest = () => {
      const stream = streamRef.current;
      if (!stream) return;
      if (initialScroll.current || stickToBottom.current) {
        stream.scrollTop = stream.scrollHeight;
        setShowScrollToBottom(false);
        settlingFrames -= 1;
        if (initialScroll.current && settlingFrames > 0) { frame = requestAnimationFrame(alignToLatest); return; }
        initialScroll.current = false;
        return;
      }
      setShowScrollToBottom(!scrollAtBottom(stream));
    };
    frame = requestAnimationFrame(alignToLatest);
    return () => cancelAnimationFrame(frame);
  }, [messages.data]);
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let frame = 0;
    const keepLatestVisible = () => {
      if (!stickToBottom.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        stream.scrollTop = stream.scrollHeight;
        setShowScrollToBottom(false);
      });
    };
    const mutations = new MutationObserver(keepLatestVisible);
    mutations.observe(stream, { childList: true, subtree: true, characterData: true });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepLatestVisible);
    sizes?.observe(stream);
    const trackPosition = () => { const atBottom = scrollAtBottom(stream); if (scrollingToBottom.current && !atBottom) return; scrollingToBottom.current = false; stickToBottom.current = atBottom; setShowScrollToBottom(!atBottom); };
    stream.addEventListener("scroll", trackPosition, { passive: true });
    void document.fonts?.ready.then(keepLatestVisible);
    keepLatestVisible();
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); sizes?.disconnect(); stream.removeEventListener("scroll", trackPosition); };
  }, []);
  useEffect(() => { setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  async function submit(prompt: string, attachments: Attachment[]) {
    if (!prompt.trim() && !attachments.length) return;
    const baseline = { id: lastMessage?.info?.id, count: messageCount };
    setBusy(true);
    try {
      const invocation = slashCommand(prompt);
      if (invocation) {
        if (attachments.length) throw new Error("Slash Commands нельзя отправлять вместе с файлами.");
        if (!(commands.data ?? []).some((item) => item.id === invocation.name)) throw new Error(`Команда /${invocation.name} не найдена.`);
        await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/commands/${encodeURIComponent(invocation.name)}`, { method: "POST", ...jsonBody({ arguments: invocation.arguments, agent: agent || null, model: model || null, ...(variant ? { variant } : {}) }) });
      } else {
        const mentions = mentionedAgents(prompt, agents);
        await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/prompt`, { method: "POST", ...jsonBody({ prompt: prompt.trim(), agent: agent || null, model: model || null, ...(variant ? { variant } : {}), attachments, ...(mentions.length ? { mentions } : {}) }) });
      }
      rememberSessionSelection(project.id, session.id, agent, model, variant);
      setPendingFrom(baseline); setAborted(false); setTaskStatusOverride("running"); setError(null); messages.reload();
      return true;
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
    return false;
  }
  async function abort() {
    setAborting(true);
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/abort`, { method: "POST", ...jsonBody({}) });
      setPendingFrom(null); setAborted(true); setTaskStatusOverride("aborted"); setError(null); messages.reload();
    } catch (reason) { setError(message(reason)); }
    finally { setAborting(false); }
  }
  function scrollToBottom() {
    const stream = streamRef.current;
    if (!stream) return;
    stickToBottom.current = true;
    scrollingToBottom.current = true;
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    setShowScrollToBottom(false);
  }
  async function replyPermission(permissionId: string, reply: "once" | "always" | "reject") {
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/permissions/${encodeURIComponent(permissionId)}/reply`, { method: "POST", ...jsonBody({ reply }) });
      setError(null); permissions.reload(); messages.reload();
    } catch (reason) { setError(message(reason)); }
  }
  function resizeDrawer(width: number) {
    const next = Math.min(Math.max(width, 560), window.innerWidth - 16);
    setDrawerWidth(next);
    window.localStorage.setItem("control-session-drawer-width", String(next));
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const move = (next: PointerEvent) => resizeDrawer(window.innerWidth - next.clientX);
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
  return <div className="drawer-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className={`drawer drawer-with-composer resizable-drawer${gitVisible ? " git-visible" : ""}`} style={{ "--drawer-width": `${drawerWidth}px` } as CSSProperties} role="dialog" aria-modal="true" aria-label={`Сессия ${session.title ?? session.id}`} onClick={(event) => event.stopPropagation()}><div className="drawer-resize-handle" role="separator" aria-label="Изменить ширину окна сессии" aria-orientation="vertical" tabIndex={0} onPointerDown={startResize} onDoubleClick={() => resizeDrawer(960)} onKeyDown={(event) => { if (event.key === "ArrowLeft") resizeDrawer(drawerWidth + 40); if (event.key === "ArrowRight") resizeDrawer(drawerWidth - 40); }} />
      <header><div className="drawer-title"><div className="drawer-title-row"><Status value={effectiveStatus} /><h2>{session.control_task?.title ?? session.title ?? "Сессия без названия"}</h2></div></div><div className="drawer-header-actions">{git.data?.available && !gitVisible && <button className="icon-button" title="Показать Git-панель" aria-label="Показать Git-панель" onClick={() => setGitVisibility("shown")}><GitBranch size={15} /></button>}{onDelete && <button className="icon-button danger" title="Удалить сессию" aria-label="Удалить сессию" onClick={onDelete}><Trash2 size={15} /></button>}<button className="icon-button" title="Закрыть сессию" aria-label="Закрыть сессию" onClick={onClose}><X /></button></div></header>
      <div className="drawer-metrics"><span><i><Activity size={16} /></i><span><small>Контекст</small><b>{contextTokens === null ? "—" : new Intl.NumberFormat("ru-RU").format(contextTokens)}</b></span></span><span><i><CircleDollarSign size={16} /></i><span><small>Стоимость</small><b>${(session.cost ?? 0).toFixed(4)}</b></span></span><span><i><Bot size={16} /></i><span><small>Агент</small><b>{agent || "по умолчанию"}</b></span></span><span><i><Cpu size={16} /></i><span><small>Модель</small><b>{model || "по умолчанию"}</b></span></span></div>
       <div className={`session-workspace ${gitVisible ? "with-git" : ""}`}>{git.data?.available && gitVisible && <SessionGitPanel project={project} state={git.data} onReload={() => { setGitVisibility("shown"); git.reload(); }} onClose={() => setGitVisibility("hidden")} />}<div className="session-conversation"><div className="session-chat-content"><div className="message-stream-wrap"><div className="message-stream" ref={streamRef} onScroll={(event) => setShowScrollToBottom(!scrollAtBottom(event.currentTarget))}>{messages.error && <Banner tone="danger">Не удалось открыть предпросмотр: {messages.error}</Banner>}{(messages.data ?? []).map((entry, index) => entry.parts?.length ? <article className={`message ${entry.info?.role ?? "assistant"}`} key={entry.info?.id ?? index}><small className="message-meta"><span>{entry.info?.role === "user" ? "Вы" : entry.info?.agent ?? "OpenCode"}{entry.info?.role !== "user" && (entry.info?.providerID || entry.info?.modelID) ? ` · ${[entry.info.providerID, entry.info.modelID].filter(Boolean).join("/")}` : ""}</span><span className="message-turn-stats">{entry.info?.tokens?.output !== undefined && `${compact(entry.info.tokens.output)} токенов`}{entry.info?.cost !== undefined && ` · $${entry.info.cost.toFixed(4)}`}{entry.info?.time?.created !== undefined && <time> · {formatDuration((entry.info.time.completed ?? now) - entry.info.time.created)}</time>}</span></small>{entry.info?.error && <div className="message-error"><CircleStop size={13} /> {entry.info.error}</div>}{entry.parts.map((part, partIndex) => <SessionPartView part={part} index={partIndex} now={now} key={`${part.type}-${partIndex}`} />)}</article> : null)}{messages.data?.length === 0 && !messages.error && <Empty icon={<MessageSquareText />} title="Сообщений нет" detail="Отправьте первое сообщение в форме ниже." />}</div>{showScrollToBottom && <button type="button" className="chat-scroll-bottom" aria-label="Перейти к последнему сообщению" title="Перейти к последнему сообщению" onClick={scrollToBottom}><ArrowDown size={18} /></button>}</div>
        <aside className="session-inspector">
          <section><header><Network size={14} /><strong>MCP в Runtime</strong><span>{mcpEntries.length}</span></header><div className="runtime-list-compact">{mcpEntries.map(([name, value]) => <div key={name}><i data-status={value.status} /><span>{name}</span><small>{statusLabel(value.status ?? "unknown")}</small></div>)}{mcpEntries.length === 0 && <p>Подключенных MCP нет</p>}</div></section>
          {activeTodos.length > 0 && <section><header><Check size={14} /><strong>План работы</strong><span>{activeTodos.length}</span></header><div className="todo-list">{activeTodos.map((todo, index) => <div className={todo.status} key={`${todo.content}-${index}`}><span className="todo-index">{index + 1}</span><span><strong>{todo.content}</strong><small>{todo.status === "in_progress" ? "Выполняется" : "Ожидает"} · {priorityLabel(todo.priority)}</small></span></div>)}</div></section>}
          {(todos.error || permissions.error) && <p className="inspector-error">Не удалось обновить данные Runtime</p>}
        </aside>
        </div>
      {(permissions.data?.length ?? 0) > 0 && <div className="session-runtime-dock"><div className="permission-dock">{permissions.data?.map((permission) => <PermissionRequestCard key={permission.id} permission={permission} onReply={(reply) => void replyPermission(permission.id, reply)} />)}</div></div>}
      <SessionReplyComposer error={error} permissionsError={permissions.error} agent={agent} onAgentChange={setAgent} model={model} onModelChange={setModel} variant={variant} onVariantChange={setVariant} agents={agents} commands={commands.data ?? []} providers={providers} config={config} busy={busy} active={responseActive} stopping={aborting} onStop={() => void abort()} onSubmit={submit} onError={setError} /></div></div>
    </aside>
  </div>;
}

function SessionReplyComposer({ error, permissionsError, agent, onAgentChange, model, onModelChange, variant, onVariantChange, agents, commands, providers, config, busy, active, stopping, onStop, onSubmit, onError }: { error: string | null; permissionsError: string | null; agent: string; onAgentChange: (value: string) => void; model: string; onModelChange: (value: string) => void; variant: string; onVariantChange: (value: string) => void; agents: Agent[]; commands: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; busy: boolean; active: boolean; stopping: boolean; onStop: () => void; onSubmit: (prompt: string, attachments: Attachment[]) => Promise<boolean | undefined>; onError: (value: string | null) => void }) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSubmit(prompt, attachments)) { setPrompt(""); setAttachments([]); }
  }
  return <form className="session-reply" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}{permissionsError && <Banner tone="danger">Не удалось проверить разрешения: {permissionsError}</Banner>}<PromptBox prompt={prompt} onPromptChange={setPrompt} attachments={attachments} onAttachmentsChange={setAttachments} onError={onError} agent={agent} onAgentChange={onAgentChange} model={model} onModelChange={onModelChange} variant={variant} onVariantChange={onVariantChange} agents={agents} commands={commands} providers={providers} config={config} placeholder="Продолжите диалог в этой же сессии…" submitLabel="Отправить в эту сессию" busy={busy} active={active} stopping={stopping} onStop={onStop} mentionsEnabled /></form>;
}

function CommandEditor({ project, item, agents, providers, config, onClose, onSaved }: { project: Project; item: CommandItem | "new"; agents: Agent[]; providers: ProviderSummary[]; config?: RuntimeConfig; onClose: () => void; onSaved: () => void }) {
  const initialContent = item === "new" ? commandTemplate() : item.content;
  const initialMetadata = commandMetadata(initialContent);
  const [id, setId] = useState(item === "new" ? "" : item.id);
  const [scope, setScope] = useState<"project" | "global">(item === "new" ? "project" : item.scope === "global" ? "global" : "project");
  const [description, setDescription] = useState(initialMetadata.description ?? "");
  const [agent, setAgent] = useState(initialMetadata.agent ?? "");
  const [model, setModel] = useState(initialMetadata.model ?? "");
  const [variant, setVariant] = useState(initialMetadata.variant ?? "");
  const [subtask, setSubtask] = useState(initialMetadata.subtask);
  const [body, setBody] = useState(commandBody(initialContent));
  const [error, setError] = useState<string | null>(null);
  const content = commandDocument({ description, agent, model, variant, subtask, body });
  const shell = commandShell(body);
  const effectiveAgent = agents.find((candidate) => candidate.name === (agent || config?.default_agent));
  const effectiveModel = model || agentModel(effectiveAgent) || config?.model || "";
  const variants = providers.flatMap((provider) => provider.model_variants?.[effectiveModel] ?? []);
  function changeAgent(value: string) { setAgent(value); setSubtask(agents.find((candidate) => candidate.name === value)?.mode === "subagent"); if (!model) setVariant(""); }
  function changeModel(value: string) { setModel(value); setVariant(""); }
  async function save() { try { await api(`/api/v1/projects/${project.id}/commands/${encodeURIComponent(id)}`, { method: "PUT", ...jsonBody({ content, scope }) }); onSaved(); } catch (reason) { setError(message(reason)); } }
  async function remove() { if (item === "new" || !confirm(`Удалить /${id}?`)) return; try { await api(`/api/v1/projects/${project.id}/commands/${encodeURIComponent(id)}?scope=${scope}`, { method: "DELETE" }); onSaved(); } catch (reason) { setError(message(reason)); } }
  const location = scope === "global" ? `~/.config/opencode/commands/${id || "<имя>"}.md` : `${project.root}/.opencode/commands/${id || "<имя>"}.md`;
  return <Modal wide title={item === "new" ? "Создать Slash Command" : `Редактировать /${id}`} subtitle={`${scope === "global" ? "Для всех проектов" : `Только для ${project.name}`} · ${location}`} onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="form-row command-editor-fields"><Field label="Имя команды" hint="В чате вызывается как /имя."><div className="command-name-input"><span>/</span><input className="mono" value={id} onChange={(event) => setId(event.target.value)} disabled={item !== "new"} placeholder="review" /></div></Field><Field label="Область действия"><select value={scope} onChange={(event) => setScope(event.target.value as "project" | "global")} disabled={item !== "new"}><option value="project">Только проект {project.name}</option><option value="global">Все проекты</option></select></Field></div>
    <Field label="Описание" hint="Показывается в списке и command palette."><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Что делает эта команда" /></Field>
    <div className={`command-options${variants.length ? " with-variants" : ""}`}><div className="command-agent-options"><AgentPicker agents={agents} value={agent} onChange={changeAgent} includeSubagents /><label className="command-subtask"><input type="checkbox" checked={subtask} onChange={(event) => setSubtask(event.target.checked)} /><strong>Выполнить в дочерней Session</strong></label></div><ModelPicker providers={providers} configuredProviders={config?.configured_providers ?? []} value={model} onChange={changeModel} />{variants.length > 0 && <Field label="Режим рассуждений"><select value={variants.includes(variant) ? variant : ""} onChange={(event) => setVariant(event.target.value)}><option value="">По умолчанию</option>{variants.map((name) => <option value={name} key={name}>{name}</option>)}</select></Field>}</div>
    <Field label="Инструкция агенту"><textarea aria-label="Инструкция Slash Command" className="code-editor modal-editor command-editor" value={body} onChange={(event) => setBody(event.target.value)} placeholder={"Например:\n\nПроверь текущие изменения. Найди ошибки и покажи их по критичности.\nДополнительный фокус: $ARGUMENTS"} spellCheck={false} /></Field>
    <details className="task-help command-arguments-help"><summary>Как использовать $ARGUMENTS, $1 и $2</summary><div className="command-argument-grid"><section><header><code>$ARGUMENTS</code><span>Вся строка после имени команды</span></header><dl><div><dt>Шаблон</dt><dd><code>Исправь: $ARGUMENTS</code></dd></div><div><dt>Ввод</dt><dd><code>/fix ошибка входа</code></dd></div><div><dt>Результат</dt><dd><code>Исправь: ошибка входа</code></dd></div></dl></section><section><header><code>$1, $2, …</code><span>Отдельные аргументы по порядку</span></header><dl><div><dt>Шаблон</dt><dd><code>Проверь $1. Фокус: $2</code></dd></div><div><dt>Ввод</dt><dd><code>/audit backend "авторизация и токены"</code></dd></div><div><dt>Результат</dt><dd><code>Проверь backend. Фокус: авторизация и токены</code></dd></div></dl></section><p className="command-argument-note"><strong>Подсказка:</strong> кавычки объединяют несколько слов в один аргумент. Если placeholders нет, OpenCode добавит введённый текст в конец инструкции.</p></div></details>
    {shell.length > 0 && <Banner tone="notice">При запуске OpenCode выполнит shell без дополнительного подтверждения: {shell.map((command) => <code key={command}>{command}</code>)}</Banner>}
    <div className="modal-actions">{item !== "new" && <button className="danger-button" onClick={() => void remove()}><Trash2 size={15} /> Удалить</button>}<span /><button className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" onClick={() => void save()} disabled={!id.trim() || !body.trim()}>Сохранить /{id || "command"}</button></div>
  </Modal>;
}

function MarkdownEditor({ project, kind, item, onClose, onSaved }: { project: Project; kind: "agents" | "skills"; item: WorkspaceItem | "new"; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState(item === "new" ? "" : item.id); const [scope, setScope] = useState<"project" | "global">(item === "new" || item.scope === "runtime" ? "project" : item.scope ?? "project"); const [content, setContent] = useState(item === "new" ? templateFor(kind) : item.content); const [error, setError] = useState<string | null>(null);
  const [creationMode, setCreationMode] = useState<"manual" | "https">("manual");
  const effectiveName = kind === "skills" ? skillNameOf(content) || id : id;
  const agentMode = kind === "agents" ? agentModeOf(content) : "";
  const modeHint = agentMode === "primary" ? "Доступен для прямого выбора." : agentMode === "all" ? "Доступен напрямую и как подагент." : "Запускается основным агентом.";
  function changeId(value: string) { setId(value); if (kind === "skills") setContent((current) => setSkillName(current, value)); }
  async function save() { try { const next = kind === "skills" ? setSkillName(content, id) : content; if (kind === "skills" && item !== "new") await api(`/api/v1/projects/${project.id}/skills/${encodeURIComponent(item.id)}`, { method: "PATCH", ...jsonBody({ name: id, content: next, source_scope: item.scope ?? "project", target_scope: scope }) }); else await api(`/api/v1/projects/${project.id}/${kind}/${encodeURIComponent(id)}`, { method: "PUT", ...jsonBody({ content: next, scope }) }); onSaved(); } catch (reason) { setError(message(reason)); } }
  async function remove() { if (item === "new" || !confirm(`Удалить ${id}?`)) return; try { const savedScope = item.scope === "global" ? "global" : "project"; await api(`/api/v1/projects/${project.id}/${kind}/${encodeURIComponent(item.id)}?scope=${savedScope}`, { method: "DELETE" }); onSaved(); } catch (reason) { setError(message(reason)); } }
  const location = scope === "global" ? (kind === "agents" ? `~/.config/opencode/agents/${id || "<id>"}.md` : `~/.config/opencode/skills/${id || "<name>"}/SKILL.md`) : (kind === "agents" ? `${project.root}/.opencode/agents/${id || "<id>"}.md` : `${project.root}/.opencode/skills/${id || "<name>"}/SKILL.md`);
  const skillCreation = kind === "skills" && item === "new";
  return <Modal wide title={skillCreation ? "Добавить навык" : `${item === "new" ? "Создать" : "Редактировать"} ${kind === "agents" ? "агента" : "навык"}`} subtitle={skillCreation ? "Создайте SKILL.md вручную или безопасно импортируйте готовый файл по HTTPS." : `${scope === "global" ? "Для всех проектов" : "Только для проекта"} · ${location}`} onClose={onClose}>
    {skillCreation && <div className="skill-create-tabs" role="tablist" aria-label="Способ добавления навыка"><button type="button" role="tab" aria-selected={creationMode === "manual"} className={creationMode === "manual" ? "active" : ""} onClick={() => setCreationMode("manual")}><FileCode2 size={15} /> Вручную</button><button type="button" role="tab" aria-selected={creationMode === "https"} className={creationMode === "https" ? "active" : ""} onClick={() => setCreationMode("https")}><Download size={15} /> По HTTPS</button></div>}
    {skillCreation && creationMode === "https" ? <SkillImportForm project={project} onClose={onClose} onSaved={onSaved} /> : <>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className={`form-row ${kind === "agents" ? "agent-editor-fields" : ""}`}>
      <Field label={kind === "skills" ? "Имя навыка" : "Идентификатор латиницей"}><input className="mono" value={id} onChange={(event) => changeId(event.target.value)} disabled={item !== "new" && kind !== "skills"} placeholder={kind === "agents" ? "security-reviewer" : "release-notes"} /></Field>
      {kind === "agents" && <Field label="Режим агента" hint={modeHint}><select value={agentMode} onChange={(event) => setContent(setAgentMode(content, event.target.value as AgentMode))}><option value="primary">Основной (primary)</option><option value="subagent">Подагент (subagent)</option><option value="all">Оба режима (all)</option></select></Field>}
      <Field label="Область действия" hint={scope === "global" ? "Будет доступен во всех проектах пользователя." : "Будет доступен только в выбранном проекте."}><select value={scope} onChange={(event) => setScope(event.target.value as "project" | "global")} disabled={item !== "new" && kind !== "skills"}><option value="project">Для проекта</option><option value="global">Для всех проектов</option></select></Field>
    </div>
    {kind === "skills" && <Banner tone={effectiveName !== id && item !== "new" ? "danger" : "notice"}>OpenCode видит этот навык под именем <code>{effectiveName || "name не указан"}</code>{effectiveName !== id && item !== "new" ? `, а каталог называется ${id}. Обращайтесь к навыку по значению name.` : "."}</Banner>}
    <textarea aria-label={kind === "agents" ? "Markdown агента" : "Markdown навыка"} className="code-editor modal-editor" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
    <Banner tone="notice">После сохранения Control применит изменение и автоматически обновит работающий сервер OpenCode проекта.</Banner>
    <div className="modal-actions">{item !== "new" && <button className="danger-button" onClick={() => void remove()}><Trash2 size={15} /> Удалить</button>}<span /><button className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" onClick={() => void save()} disabled={!id}>Сохранить</button></div>
    </>}
  </Modal>;
}

function SkillImportForm({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<"project" | "global">("project");
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [conflictAction, setConflictAction] = useState<"skip" | "overwrite" | "rename">("skip");
  const [renameTo, setRenameTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function changeUrl(value: string) { setUrl(value); setPreview(null); setError(null); }
  function changeScope(value: "project" | "global") { setScope(value); setPreview(null); setError(null); }
  async function loadPreview() {
    setBusy(true); setError(null);
    try {
      const value = await api<SkillImportPreview>(`/api/v1/projects/${project.id}/skill-imports/preview`, { method: "POST", ...jsonBody({ url, scope }) });
      setPreview(value); setRenameTo(value.name); setConflictAction("skip");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function previewRename() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const value = await api<SkillImportPreview>(`/api/v1/projects/${project.id}/skill-imports/${encodeURIComponent(preview.preview_id)}/rename`, { method: "POST", ...jsonBody({ name: renameTo }) });
      setPreview(value); setRenameTo(value.name); setConflictAction("skip");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function install() {
    if (!preview || conflictAction === "rename") return;
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/projects/${project.id}/skill-imports/confirm`, { method: "POST", ...jsonBody({ preview_id: preview.preview_id, conflict_policy: conflictAction === "overwrite" ? "overwrite" : "skip" }) });
      onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <div className="skill-import-flow">
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="skill-import-source"><Field label="Ссылка на Skill" hint="Поддерживаются GitHub-каталоги /tree/…, файлы /blob/…/SKILL.md и прямые HTTPS-ссылки."><input type="url" value={url} onChange={(event) => changeUrl(event.target.value)} placeholder="https://github.com/owner/repository/tree/main/path/to/skill" /></Field><Field label="Область действия"><select value={scope} onChange={(event) => changeScope(event.target.value as "project" | "global")}><option value="project">Только проект {project.name}</option><option value="global">Все проекты</option></select></Field><button className="primary-button skill-preview-button" onClick={() => void loadPreview()} disabled={busy || !url.trim()}>{busy && !preview ? "Загрузка…" : "Проверить и показать"}</button></div>
    {!preview && <div className="skill-import-empty"><Download size={24} /><strong>Сначала получите безопасный preview</strong><p>Control проверит HTTPS, redirects, публичный адрес, размеры и структуру Skill. Для GitHub-каталога будут загружены все scripts, references, data, templates и assets, но ничего не будет выполнено.</p><code>Можно вставить URL самого каталога Skill из адресной строки GitHub</code></div>}
    {preview && <>
      <div className="skill-import-facts"><div><small>Навык</small><strong>{preview.name}</strong><span>{preview.description}</span></div><div><small>Куда будет сохранён</small><strong>{preview.scope === "global" ? "Для всех проектов" : `Проект ${project.name}`}</strong><span title={preview.target_path}>{preview.target_path}</span></div><div><small>Bundle</small><strong>{preview.file_count} файлов · {(preview.bytes / 1024).toFixed(1)} KiB</strong><span className="mono" title={preview.commit ?? preview.sha256}>{preview.commit ? `commit ${preview.commit.slice(0, 12)}` : `SHA-256 ${preview.sha256.slice(0, 12)}`}</span></div></div>
      <div className="skill-import-origin"><span><small>Исходная ссылка</small><code>{preview.source_url}</code></span>{preview.final_url !== preview.source_url && <span><small>После {preview.redirects} redirect</small><code>{preview.final_url}</code></span>}</div>
      <Banner tone="danger">Проверьте содержимое внимательно. После установки этот Skill становится инструкцией для агента и может предлагать использование файлов, сети или инструментов.</Banner>
      {preview.file_count > 1 && <section className="skill-bundle-manifest"><header><strong>Файлы Skill</strong><span>Скрипты сохранятся рядом с SKILL.md, но не выполняются при установке.</span></header><div>{preview.files.map((file) => <span key={file.path}><code>{file.path}</code><small>{file.executable ? "исполняемый · " : ""}{(file.bytes / 1024).toFixed(1)} KiB</small></span>)}</div></section>}
      {preview.conflict.has_conflict && <section className="skill-conflict"><header><strong>Найден конфликт имени</strong><span>{preview.conflict.target_exists ? "Целевой файл уже существует." : "OpenCode уже видит навык с таким именем из другого источника."}</span></header>{preview.conflict.matches.map((item) => <code key={`${item.scope}-${item.source}-${item.id}`}>{item.scope === "global" ? "global" : "project"} · {item.name} · {item.source}</code>)}<div className="skill-conflict-actions"><label><input type="radio" checked={conflictAction === "skip"} onChange={() => setConflictAction("skip")} /> <span><strong>Пропустить</strong><small>Ничего не менять</small></span></label><label><input type="radio" checked={conflictAction === "overwrite"} onChange={() => setConflictAction("overwrite")} /> <span><strong>{preview.conflict.target_exists ? "Перезаписать" : "Установить с приоритетом"}</strong><small>Только в native-путь OpenCode Control</small></span></label><label><input type="radio" checked={conflictAction === "rename"} onChange={() => setConflictAction("rename")} /> <span><strong>Переименовать</strong><small>Изменить каталог и name</small></span></label></div>{conflictAction === "rename" && <div className="skill-rename"><input className="mono" value={renameTo} onChange={(event) => setRenameTo(event.target.value)} placeholder="новое-имя" /><button className="secondary-button" onClick={() => void previewRename()} disabled={busy || !renameTo.trim() || renameTo === preview.name}>Показать итоговый preview</button></div>}</section>}
      <div className="skill-preview-grid"><section><header><strong>Отображение Markdown</strong><span>HTML и изображения заблокированы</span></header><div className="skill-rendered-preview"><MessageMarkdown content={preview.markdown} /></div></section><section><header><strong>Исходный SKILL.md</strong><span>Полный текст, который будет сохранён</span></header><textarea aria-label="Исходный импортируемый SKILL.md" className="code-editor" value={preview.content} readOnly spellCheck={false} /></section></div>
      <div className="modal-actions"><span /><button className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" onClick={() => void install()} disabled={busy || conflictAction === "rename"}>{busy ? "Применение…" : preview.conflict.has_conflict && conflictAction === "skip" ? "Пропустить импорт" : `Установить ${preview.name}`}</button></div>
    </>}
  </div>;
}

function AgentInfo({ item, onClose }: { item: WorkspaceItem; onClose: () => void }) {
  return <Modal title={`Агент: ${item.id}`} subtitle={item.internal ? "Служебный агент OpenCode" : "Встроенный или унаследованный агент"} onClose={onClose}>
    <div className="agent-explanation"><Bot /><p>{item.description}</p><dl><div><dt>Тип</dt><dd>{modeLabel(item.mode)}</dd></div><div><dt>Область</dt><dd>{scopeLabel(item.scope)}</dd></div><div><dt>Модель</dt><dd>{item.model ?? "наследует модель основной сессии"}</dd></div><div><dt>Источник</dt><dd>{item.source ?? "Runtime OpenCode"}</dd></div></dl><Banner tone="notice">Этого агента создал OpenCode, а не Control. Встроенный агент общий для всех проектов. Чтобы изменить поведение только здесь, создайте агента для проекта с собственными инструкциями на русском языке.</Banner></div>
  </Modal>;
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
  async function applyConfiguration(action: () => Promise<unknown>) { await action(); onSaved(); }
  async function save() { try { const parsed = JSON.parse(raw) as Record<string, unknown>; await applyConfiguration(() => api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(id)}`, { method: "PUT", ...jsonBody({ config: parsed, scope }) })); } catch (reason) { setError(message(reason)); } }
  async function setEnabled(changedScope: "project" | "global", enabled: boolean) { try { await applyConfiguration(() => api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(id)}/enabled`, { method: "PATCH", ...jsonBody({ enabled, scope: changedScope }) })); } catch (reason) { setError(message(reason)); } }
  async function remove(changedScope: "project" | "global") { if (name === "new" || !confirm(changedScope === "global" ? `Удалить общую настройку MCP ${name}? Она исчезнет из всех проектов без собственной настройки.` : `Удалить настройку MCP ${name} для проекта? После этого снова будет использоваться общая настройка, если она существует.`)) return; try { await applyConfiguration(() => api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(name)}?scope=${changedScope}`, { method: "DELETE" })); } catch (reason) { setError(message(reason)); } }
  async function connect() { try { await api(`/api/v1/projects/${project.id}/mcp/${encodeURIComponent(id)}/connect`, { method: "POST", ...jsonBody({}) }); onSaved(); } catch (reason) { setError(message(reason)); } }
  const runtimeStatus = status?.status ?? "unknown";
  let commonStdioFormat = false;
  try { const candidate = JSON.parse(raw) as Record<string, unknown>; commonStdioFormat = candidate.transport === "stdio" && typeof candidate.command === "string"; } catch { /* The save action reports JSON syntax errors. */ }
  const scopeConfigured = scope === "global" ? hasGlobal : hasProject;
  const scopeEnabled = scope === "global" ? globalEnabled : projectEnabled;
  const scopeTitle = scope === "global" ? "Общая настройка" : `Настройка проекта ${project.name}`;
  const scopeDescription = scope === "global" ? "Используется во всех проектах без собственной настройки." : hasProject ? "Имеет приоритет над общей настройкой только в этом проекте." : hasGlobal ? "Сейчас проект наследует общую настройку. Изменение создаст локальное переопределение." : "Настройка будет действовать только в этом проекте.";
  return <Modal wide title={name === "new" ? "Добавить MCP-сервер" : `MCP: ${name}`} subtitle={name === "new" ? "Настройте MCP только для выбранного проекта или сразу для всех проектов." : "Настройки определяют желаемое состояние, а OpenCode показывает фактическое подключение прямо сейчас."} onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    {status?.status === "failed" && <Banner tone="danger">Конфигурация разрешает MCP, но OpenCode не смог подключиться. Проверьте команду или URL и повторите подключение.</Banner>}
    {name !== "new" && <div className="mcp-state-grid">
      <div><small>Для всех проектов</small><strong>{hasGlobal ? (globalEnabled ? "Включено" : "Выключено") : "Не настроено"}</strong><span>{hasGlobal ? "Базовая настройка" : "Общей настройки нет"}</span></div>
      <div><small>Для этого проекта</small><strong>{hasProject ? (projectEnabled ? "Включено" : "Выключено") : "Наследуется"}</strong><span>{hasProject ? "Локальное переопределение" : hasGlobal ? "Используется общая настройка" : "Настройки нет"}</span></div>
      <div className={`runtime-${runtimeStatus}`}><small>Сейчас в OpenCode</small><strong>{statusLabel(runtimeStatus)}</strong><span>{runtimeStatus === "connected" ? "MCP доступен агентам проекта" : "Фактическое состояние процесса"}</span></div>
    </div>}
    <Banner tone="notice">Изменения применяются автоматически. Если OpenCode запущен через Control, подключение обновится сразу — никаких дополнительных действий не требуется.</Banner>
    <div className="form-row"><Field label="Имя сервера"><input className="mono" value={id} onChange={(event) => setId(event.target.value)} disabled={name !== "new"} placeholder="playwright" /></Field><Field label="Где действует настройка"><select value={scope} onChange={(event) => selectScope(event.target.value as "project" | "global")}><option value="project">Только проект {project.name}</option><option value="global">Все проекты</option></select></Field></div>
    <textarea aria-label="JSON-конфигурация MCP-сервера" className="code-editor modal-editor short" value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} />
    {commonStdioFormat && <Banner tone="notice">Обнаружен стандартный stdio-формат. Control автоматически преобразует <code>command</code> и <code>args</code> в конфигурацию OpenCode перед сохранением.</Banner>}
    <Banner tone="notice">Прямые значения секретов показаны как <code>[REDACTED]</code> и не затираются при сохранении. Ссылки <code>{`{file:...}`}</code> и <code>{`{env:...}`}</code> остаются видимыми.</Banner>
    {name !== "new" && <div className="mcp-scope-control"><div><small>{scope === "global" ? "Все проекты" : "Только этот проект"}</small><strong>{scopeTitle}</strong><p>{scopeDescription}</p></div><div className="mcp-scope-buttons"><button className="secondary-button" onClick={() => void setEnabled(scope, !scopeEnabled)}>{scopeEnabled ? (scope === "global" ? "Выключить для всех" : "Выключить для проекта") : (scope === "global" ? "Включить для всех" : "Включить для проекта")}</button>{scopeConfigured && <button className={scope === "project" && hasGlobal ? "secondary-button" : "danger-button"} onClick={() => void remove(scope)}>{scope === "project" && hasGlobal ? <RefreshCw size={15} /> : <Trash2 size={15} />} {scope === "global" ? "Удалить общую настройку" : hasGlobal ? "Использовать общую настройку" : "Удалить настройку проекта"}</button>}</div></div>}
    {name !== "new" && runtimeStatus !== "connected" && effectiveEnabled && <div className="mcp-runtime-retry"><div><strong>OpenCode сейчас не подключен</strong><span>Это фактическое состояние запущенного сервера, а не отдельная настройка.</span></div><button className="secondary-button" onClick={() => void connect()}>Повторить подключение</button></div>}
    <div className="modal-actions"><span /><button className="secondary-button" onClick={onClose}>Закрыть</button><button className="primary-button" onClick={() => void save()} disabled={!id}>Сохранить {scope === "global" ? "для всех проектов" : "для проекта"}</button></div>
  </Modal>;
}

function ThemeDialog({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = themes.filter((theme) => theme.name.toLowerCase().includes(query.trim().toLowerCase()) || theme.id.includes(query.trim().toLowerCase()));
  return <Modal title="Темы" subtitle="Палитры OpenCode, адаптированные для Control." onClose={onClose}><div className="theme-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск темы" /></div><div className="theme-list" role="listbox">{filtered.map((theme) => <button type="button" role="option" aria-selected={theme.id === value} className={theme.id === value ? "selected" : ""} key={theme.id} onClick={() => onChange(theme.id)}><span className="theme-swatches">{theme.colors.slice(0, 3).map((color) => <i key={color} style={{ background: color }} />)}</span><span><strong>{theme.name}</strong><small>{theme.id}</small></span>{theme.id === value && <Check size={16} />}</button>)}{filtered.length === 0 && <p className="picker-empty">Темы не найдены.</p>}</div></Modal>;
}

function Welcome({ onAdd }: { onAdd: () => void }) { return <div className="welcome"><div className="welcome-art"><div className="orbit one" /><div className="orbit two" /><SquareTerminal /></div><p className="eyebrow">Локальное управление агентами</p><h1>Весь OpenCode<br />в одном окне.</h1><p>Добавьте проект, чтобы управлять сервером, сессиями, агентами, навыками, MCP и инструкциями без постоянного переключения между терминалом и файлами конфигурации.</p><button className="primary-button large-button" onClick={onAdd}><FolderGit2 size={18} /> Добавить первый проект</button><div className="welcome-features"><span><Bot /> Управление агентами</span><span><Network /> Настройка MCP</span><span><Braces /> Нативная конфигурация</span></div></div>; }

function Page({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) { return <><div className="page-heading"><div><p className="eyebrow">OpenCode Control</p><h1>{title}</h1><p>{description}</p></div>{action}</div>{children}</>; }
function Panel({ title, icon, action, className = "", children }: { title?: string; icon?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) { return <section className={`panel ${className}`}>{title && <header className="panel-heading"><h2>{icon}{title}</h2>{action}</header>}{children}</section>; }
function ScopeGuide({ children }: { children: ReactNode }) { return <div className="scope-guide">{children}</div>; }

function PickerMenuPortal({ anchor, className = "", preferredWidth = 420, children }: { anchor: RefObject<HTMLDivElement | null>; className?: string; preferredWidth?: number; children: ReactNode }) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    function position() {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(preferredWidth, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      if (rect.top > Math.min(360, window.innerHeight * .52)) setStyle({ position: "fixed", left, top: "auto", bottom: window.innerHeight - rect.top + 7, width, maxHeight: Math.max(160, rect.top - 20), visibility: "visible" });
      else setStyle({ position: "fixed", left, top: rect.bottom + 7, bottom: "auto", width, maxHeight: Math.max(160, window.innerHeight - rect.bottom - 20), visibility: "visible" });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [anchor, preferredWidth]);
  return createPortal(<div className={`picker-menu picker-portal ${className}`} role="listbox" style={style} onPointerDown={(event) => event.stopPropagation()}>{children}</div>, document.body);
}

function AgentPicker({ agents, value, onChange, compact = false, includeSubagents = false }: { agents: Agent[]; value: string; onChange: (value: string) => void; compact?: boolean; includeSubagents?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useOutsideClose(open, () => setOpen(false));
  const visible = agents.filter((agent) => !agent.hidden && (includeSubagents || agent.mode !== "subagent"));
  const selected = visible.find((agent) => agent.name === value);
  return <div className={`field picker-field ${compact ? "compact-picker" : ""}`} ref={root}>{!compact && <span>Агент</span>}<button type="button" className="picker-trigger" aria-label={`Агент: ${selected?.name ?? "по умолчанию"}`} aria-expanded={open} onClick={() => setOpen((current) => !current)}>{compact && <Bot size={15} />}<span><strong>{selected?.name ?? "По умолчанию"}</strong>{!compact && <small>{selected ? modeLabel(selected.mode) : "build или агент по умолчанию из конфигурации"}</small>}</span><ChevronDown size={15} /></button>{open && <PickerMenuPortal anchor={root}><button type="button" className={!value ? "selected" : ""} onClick={() => { onChange(""); setOpen(false); }}><span><strong>Использовать агента по умолчанию</strong><small>Обычно build</small></span></button>{visible.map((agent) => <button type="button" role="option" aria-selected={value === agent.name} className={value === agent.name ? "selected" : ""} key={agent.name} onClick={() => { onChange(agent.name); setOpen(false); }}><span><strong>{agent.name}</strong><small>{modeLabel(agent.mode)} · {localizedAgentDescription(agent.name, agent.description)}</small></span></button>)}</PickerMenuPortal>}{!compact && <small>{includeSubagents ? "Подагент автоматически включает запуск в дочерней Session." : "Основной агент ведет задачу. Подагенты обычно запускаются им автоматически."}</small>}</div>;
}

function ModelPicker({ providers, configuredProviders, value, onChange, compact = false }: { providers: ProviderSummary[]; configuredProviders: string[]; value: string; onChange: (value: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useOutsideClose(open, () => setOpen(false));
  const query = search.trim().toLowerCase();
  const groups = [...providers].sort((left, right) => providerRank(left.id, configuredProviders) - providerRank(right.id, configuredProviders) || left.id.localeCompare(right.id)).map((provider) => ({ ...provider, models: provider.models.filter((model) => !query || model.toLowerCase().includes(query)) })).filter((provider) => provider.models.length > 0);
  const count = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  function openList() { setSearch(""); setOpen(true); }
  return <div className={`field picker-field ${compact ? "compact-picker model-picker" : ""}`} ref={root}>{!compact && <span>Модель</span>}<button type="button" className="picker-trigger model-trigger" aria-label={`Модель: ${value || "по умолчанию"}`} aria-expanded={open} onClick={() => { if (open) setOpen(false); else openList(); }}>{compact && <Cpu size={15} />}<span><strong>{value || "По умолчанию"}</strong></span><ChevronDown size={15} /></button>{open && <PickerMenuPortal anchor={root} className="model-menu" preferredWidth={540}><label className="picker-search"><Search size={14} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск модели" /></label><button type="button" className={!value ? "selected" : ""} onClick={() => { onChange(""); setSearch(""); setOpen(false); }}><span><strong>Не переопределять модель</strong><small>Использовать модель агента или текущую модель OpenCode</small></span></button>{groups.map((provider) => <section className="model-group" key={provider.id}><header><span>{provider.name ?? provider.id}</span><small>{providerSource(provider.id, configuredProviders)}</small></header>{provider.models.map((model) => <button type="button" role="option" aria-selected={value === model} className={value === model ? "selected" : ""} key={model} onClick={() => { onChange(model); setSearch(""); setOpen(false); }}><span><strong>{model}</strong>{provider.default_model === model && <small>модель провайдера по умолчанию</small>}</span></button>)}</section>)}{groups.length === 0 && <p className="picker-empty">Среди подключенных провайдеров совпадений нет.</p>}</PickerMenuPortal>}{!compact && <small>{count} моделей из {providers.length} подключенных или настроенных провайдеров.</small>}</div>;
}

function VariantPicker({ variants, value, onChange, model, compact = false }: { variants: string[]; value: string; onChange: (value: string) => void; model: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useOutsideClose(open, () => setOpen(false));
  return <div className={`field picker-field variant-picker ${compact ? "compact-picker" : ""}`} ref={root}>{!compact && <span>Режим рассуждений</span>}<button type="button" className="picker-trigger" aria-label={`Рассуждение: ${value || "по умолчанию"}`} title={`Режим рассуждений для ${model}`} aria-expanded={open} onClick={() => setOpen((current) => !current)}>{compact && <BrainCircuit size={15} />}<span><strong>{value || "По умолчанию"}</strong></span><ChevronDown size={15} /></button>{open && <PickerMenuPortal anchor={root} preferredWidth={260}><button type="button" role="option" aria-selected={!value} className={!value ? "selected" : ""} onClick={() => { onChange(""); setOpen(false); }}><span><strong>По умолчанию</strong></span></button>{variants.map((variant) => <button type="button" role="option" aria-selected={value === variant} className={value === variant ? "selected" : ""} key={variant} onClick={() => { onChange(variant); setOpen(false); }}><span><strong>{variant}</strong></span></button>)}</PickerMenuPortal>}</div>;
}

function useOutsideClose(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function pointerDown(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) close(); }
    function keyDown(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => { document.removeEventListener("pointerdown", pointerDown); document.removeEventListener("keydown", keyDown); };
  }, [open, close]);
  return root;
}
function Metric({ icon, label, value, detail, accent }: { icon: ReactNode; label: string; value: string; detail: string; accent: string }) { return <article className={`metric ${accent}`}><div className="metric-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>; }
function Banner({ tone, children }: { tone: "danger" | "success" | "notice"; children: ReactNode }) { return <div className={`banner ${tone}`}>{children}</div>; }
function Status({ value }: { value: string }) { return <span className="status" data-status={value}><i />{statusLabel(value)}</span>; }
function TaskStatus({ value }: { value: string }) { const labels: Record<string, string> = { queued: "В очереди", dispatching: "Запускается", running: "Выполняется", scheduled: "По расписанию", paused: "Расписание на паузе", completed: "Завершена", failed: "Ошибка", aborted: "Остановлена" }; return <span className="status" data-status={value}><i />{labels[value] ?? value.replaceAll("_", " ")}</span>; }
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="empty"><span>{icon}</span><h3>{title}</h3><p>{detail}</p></div>; }
function FullState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="full-state"><div className="brand-mark">{icon}</div><h1>{title}</h1><p>{detail}</p></div>; }
function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Modal({ title, subtitle, wide = false, composer = false, onClose, children }: { title: string; subtitle?: string; wide?: boolean; composer?: boolean; onClose: () => void; children: ReactNode }) { const dialog = useRef<HTMLElement>(null); const closeDialog = useEffectEvent(onClose); useEffect(() => { dialog.current?.focus(); function keydown(event: KeyboardEvent) { if (event.key === "Escape") closeDialog(); } window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown); }, []); return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} tabIndex={-1} className={`modal ${wide ? "wide" : ""} ${composer ? "composer-modal" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Закрыть окно" title="Закрыть окно" onClick={onClose}><X /></button></header><div className="modal-body">{children}</div></section></div>; }

function SessionRows({ sessions, snapshot, empty }: { sessions: Session[]; snapshot?: Snapshot; empty: string }) { if (!sessions.length) return <Empty icon={<MessageSquareText />} title="Активных сессий нет" detail={empty} />; return <div className="session-rows">{sessions.map((session) => <div key={session.id}><span className="session-icon"><MessageSquareText size={16} /></span><span><strong>{session.title ?? "Сессия без названия"}</strong><small>{session.agent ?? "по умолчанию"} · {modelOf(session)}</small></span><span><Status value={sessionStatus(snapshot, session)} /><small>{relativeTime(session.time?.updated)}</small></span></div>)}</div>; }

function useResource<T>(url: string, dependency: unknown, interval?: number) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [nonce, setNonce] = useState(0);
  useEffect(() => { setData(null); setError(null); }, [url, dependency]);
  useEffect(() => { let active = true; let polling = true; let sequence = 0; setError(null); async function load() { const request = ++sequence; try { const value = await api<T>(url); if (active && request === sequence) { setData(value); setError(null); } } catch (reason) { if (reason instanceof ApiError && reason.status === 404) polling = false; if (active && request === sequence) setError(message(reason)); } } void load(); const timer = interval ? window.setInterval(() => { if (polling) void load(); }, interval) : undefined; return () => { active = false; if (timer) window.clearInterval(timer); }; }, [url, dependency, interval, nonce]);
  return { data, error, reload: () => setNonce((value) => value + 1) };
}

function viewFromPath(path: string): View { const candidate = path.split("/")[1] as View; return nav.flatMap((group) => group.items).some((item) => item.id === candidate) ? candidate : "overview"; }
function labelFor(view: View) { return nav.flatMap((group) => group.items).find((item) => item.id === view)?.label ?? "Обзор"; }
function message(reason: unknown) { return reason instanceof Error ? reason.message : "Непредвиденная ошибка"; }
function jsonEditorError(reason: unknown, source: string) { const detail = message(reason); const position = /position\s+(\d+)/i.exec(detail); if (!position) return `Некорректный JSON: ${detail}`; const offset = Math.min(Number(position[1]), source.length); const before = source.slice(0, offset); const line = before.split("\n").length; const column = offset - before.lastIndexOf("\n"); return `Некорректный JSON, строка ${line}, столбец ${column}: ${detail}`; }
function compact(value: number) { return new Intl.NumberFormat("ru-RU", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function statusOf(snapshot: Snapshot | null | undefined, sessionId: string) { const status = snapshot?.statuses[sessionId]; return status?.type ?? status?.status ?? "idle"; }
function sessionStatus(snapshot: Snapshot | null | undefined, session: Session) { const taskStatus = session.control_task?.status; return taskStatus === "aborted" || taskStatus === "failed" ? taskStatus : statusOf(snapshot, session.id); }

function modelIdOf(session?: Session) { const id = session?.model?.modelID ?? session?.model?.id; return id ? `${session?.model?.providerID ? `${session.model.providerID}/` : ""}${id}` : ""; }
function modelOf(session: Session) { return modelIdOf(session) || "модель по умолчанию"; }
function taskSessionIds(task: Task) { return task.session_ids?.length ? task.session_ids : task.session_id ? [task.session_id] : []; }
function sessionLifetimeTokens(session: Session) { return (session.tokens?.input ?? 0) + (session.tokens?.output ?? 0) + (session.tokens?.reasoning ?? 0); }
function latestContextTokens(messages: SessionMessage[]) { for (let index = messages.length - 1; index >= 0; index -= 1) { const message = messages[index]; const tokens = message.info?.role === "assistant" ? message.info.tokens : undefined; if (!tokens) continue; const total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0); if (total > 0) return total; } return null; }
function messageFinished(message: SessionMessage) { return message.info?.time?.completed !== undefined || Boolean(message.info?.error) || Boolean(message.parts?.some((part) => part.type === "step-finish")); }
function runtimeStatus(messages: SessionMessage[], now: number) { for (let index = messages.length - 1; index >= 0; index -= 1) { const entry = messages[index]; if (entry.info?.error) return "failed"; const unfinished = entry.info?.role === "user" || (entry.info?.role === "assistant" && !messageFinished(entry)); if (!unfinished) { if (entry.info?.role === "assistant") return null; continue; } const created = entry.info?.time?.created; return created !== undefined && now > 0 && now - created > 15 * 60 * 1000 ? null : "busy"; } return null; }
function activeSessionStatus(value: string | null) { return value !== null && ["busy", "queued", "dispatching", "running", "pending", "retry"].includes(value); }
function scrollAtBottom(element: HTMLElement) { return element.scrollHeight - element.scrollTop - element.clientHeight < 48; }
function formatDuration(milliseconds: number) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); if (seconds < 60) return `${seconds} с`; const minutes = Math.floor(seconds / 60); const rest = seconds % 60; if (minutes < 60) return `${minutes} мин ${String(rest).padStart(2, "0")} с`; const hours = Math.floor(minutes / 60); return `${hours} ч ${String(minutes % 60).padStart(2, "0")} мин`; }
function formatMilliseconds(milliseconds: number) { return `${Math.max(0, Math.round(milliseconds))} мс`; }
function rememberedAgent(projectId: string, agents: Agent[]) { const saved = window.localStorage.getItem(`control-agent:${projectId}`) ?? ""; return agents.some((agent) => !agent.hidden && agent.mode !== "subagent" && agent.name === saved) ? saved : ""; }
function rememberAgent(projectId: string, agent: string) { if (agent) window.localStorage.setItem(`control-agent:${projectId}`, agent); else window.localStorage.removeItem(`control-agent:${projectId}`); }
function rememberedComposerSelection(projectId: string, agents: Agent[]) { try { const value = JSON.parse(window.localStorage.getItem(`control-composer-selection:${projectId}`) ?? "null") as unknown; if (value && typeof value === "object") { const saved = value as { agent?: unknown; model?: unknown; variant?: unknown }; const agent = typeof saved.agent === "string" && agents.some((item) => !item.hidden && item.mode !== "subagent" && item.name === saved.agent) ? saved.agent : rememberedAgent(projectId, agents); return { agent, model: typeof saved.model === "string" ? saved.model : "", variant: typeof saved.variant === "string" ? saved.variant : "" }; } } catch { /* Ignore malformed browser state. */ } return { agent: rememberedAgent(projectId, agents), model: "", variant: "" }; }
function rememberComposerSelection(projectId: string, agent: string, model: string, variant: string) { rememberAgent(projectId, agent); window.localStorage.setItem(`control-composer-selection:${projectId}`, JSON.stringify({ agent, model, variant })); }
function readSessionSelection(projectId: string, sessionId: string): { agent: string; model: string; variant: string } | null { try { const value = JSON.parse(window.localStorage.getItem(`control-session-selection:${projectId}:${sessionId}`) ?? "null") as unknown; return value && typeof value === "object" && typeof (value as { agent?: unknown }).agent === "string" && typeof (value as { model?: unknown }).model === "string" ? { agent: (value as { agent: string }).agent, model: (value as { model: string }).model, variant: typeof (value as { variant?: unknown }).variant === "string" ? (value as { variant: string }).variant : "" } : null; } catch { return null; } }
function rememberSessionSelection(projectId: string, sessionId: string, agent: string, model: string, variant: string) { window.localStorage.setItem(`control-session-selection:${projectId}:${sessionId}`, JSON.stringify({ agent, model, variant })); }
function migrateBrowserStorage() { const exact = [["studio-project", "control-project"], ["studio-theme", "control-theme"], ["studio-session-drawer-width", "control-session-drawer-width"], ["studio-git-panel-width", "control-git-panel-width"]] as const; for (const [legacy, current] of exact) { const value = window.localStorage.getItem(legacy); if (value !== null && window.localStorage.getItem(current) === null) window.localStorage.setItem(current, value); if (value !== null) window.localStorage.removeItem(legacy); } const legacyKeys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)).filter((key): key is string => key !== null); for (const legacy of legacyKeys) { const current = legacy.startsWith("studio-agent:") ? legacy.replace(/^studio-agent:/, "control-agent:") : legacy.startsWith("studio-session-selection:") ? legacy.replace(/^studio-session-selection:/, "control-session-selection:") : null; if (!current) continue; const value = window.localStorage.getItem(legacy); if (value !== null && window.localStorage.getItem(current) === null) window.localStorage.setItem(current, value); window.localStorage.removeItem(legacy); } }
function latestUserSelection(messages: SessionMessage[]) { for (let index = messages.length - 1; index >= 0; index -= 1) { const info = messages[index].info; if (info?.role !== "user") continue; return { agent: info.agent, model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined, variant: info.variant }; } return null; }
function mentionedAgents(prompt: string, agents: Agent[]) { return agents.filter((agent) => !agent.hidden && agent.mode !== "primary").filter((agent) => new RegExp(`(^|[\\s([{"'])@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s.,!?;:)}\\]"'])`, "u").test(prompt)).map((agent) => agent.name); }
function attachmentMime(file: File) { if (file.type) return file.type; const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ""; const text = new Set([".txt", ".md", ".markdown", ".json", ".jsonl", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".csv", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sh", ".zsh", ".sql", ".log"]); return text.has(extension) ? "text/plain" : "application/octet-stream"; }
async function appendAttachments(current: Attachment[], files: File[]) { if (!files.length) return current; if (current.length + files.length > 4) throw new Error("Можно прикрепить не более 4 файлов."); for (const file of files) { if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} больше 5 MB.`); } const encoded = await Promise.all(files.map((file) => new Promise<Attachment>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const mime = attachmentMime(file); const data = String(reader.result).replace(/^data:[^;,]*;base64,/, `data:${mime};base64,`); resolve({ filename: file.name, mime, data_url: data }); }; reader.onerror = () => reject(new Error(`Не удалось прочитать ${file.name}`)); reader.readAsDataURL(file); }))); return [...current, ...encoded]; }
function agentModel(agent?: Snapshot["agents"][number]) { return typeof agent?.model === "string" ? agent.model : agent?.model?.modelID ? `${agent.model.providerID ? `${agent.model.providerID}/` : ""}${agent.model.modelID}` : undefined; }
function modelVariants(providers: ProviderSummary[], model: string) { return providers.flatMap((provider) => provider.model_variants?.[model] ?? []); }
function selectedDefaultModel(snapshot?: Snapshot | null) { const session = [...(snapshot?.sessions ?? [])].filter((item) => !item.parentID && (item.model?.modelID || item.model?.id)).sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0))[0]; return session ? modelOf(session) : undefined; }
function providerSource(providerId: string, configuredProviders: string[]) { if (configuredProviders.includes(providerId)) return "из opencode.json(c); доступность локального сервера не проверяется"; if (providerId === "opencode") return "встроенный OpenCode/Zen"; return "подключён и авторизован в OpenCode"; }
function providerRank(providerId: string, configuredProviders: string[]) { if (providerId === "openai") return 0; if (providerId === "opencode") return 1; if (configuredProviders.includes(providerId)) return 2; return 3; }
function providerAuthRank(providerId: string) { const popular = ["opencode", "openai", "github-copilot", "anthropic", "google"]; const index = popular.indexOf(providerId); return index < 0 ? popular.length : index; }
function localizedAgentDescription(name: string, fallback?: string) { const descriptions: Record<string, string> = { build: "Основной рабочий агент. Читает и изменяет файлы, запускает команды и выполняет поставленную задачу.", plan: "Основной агент для анализа и составления плана. Изменение файлов ограничено разрешениями.", general: "Универсальный подагент для самостоятельной части сложной задачи. Основной агент может запускать несколько таких параллельно.", explore: "Быстрый подагент для поиска файлов, чтения кода и исследования проекта без изменений.", scout: "Подагент для поиска внешней документации и изучения зависимостей." }; return descriptions[name] ?? fallback ?? "Служебный агент OpenCode. Обычно запускается автоматически и не требует настройки."; }
function commandDisplayDescription(item: CommandItem) { if (item.id === "init") return "Создать или обновить AGENTS.md для проекта"; if (item.id === "customize-opencode") return "Служебный Skill для настройки самого OpenCode"; if (item.id === "context7-mcp") return "Skill для поиска актуальной документации библиотек и API"; return item.description || "Команда OpenCode"; }
function commandPurpose(id: string) { const purposes: Record<string, string> = { init: "Одноразово изучает проект и готовит компактные инструкции для будущих агентов.", review: "Проверяет изменения без редактирования файлов.", fix: "Ищет root cause и делает минимальное исправление.", test: "Запускает и диагностирует релевантные проверки.", plan: "Исследует задачу и готовит план без изменений.", explain: "Объясняет код, зависимости и поток данных.", "commit-check": "Проверяет рабочее дерево перед commit." }; return purposes[id] ?? "Пользовательский prompt-шаблон OpenCode."; }
function commandTemplate() { return `---\ndescription: Опишите назначение команды\nagent: build\nsubtask: false\n---\n\nВыполни следующую задачу пользователя:\n\n$ARGUMENTS\n\nСначала изучи контекст проекта. После работы проверь результат и кратко отчитайся.\n`; }
function commandMetadata(content: string) { const header = content.startsWith("---\n") ? content.slice(4, content.indexOf("\n---\n", 4) < 0 ? 4 : content.indexOf("\n---\n", 4)) : ""; const values: Record<string, string> = {}; header.split("\n").forEach((line) => { const index = line.indexOf(":"); if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^["']|["']$/g, ""); }); return { description: values.description, agent: values.agent, model: values.model, variant: values.variant, subtask: values.subtask === "true" }; }
function commandBody(content: string) { if (!content.startsWith("---\n")) return content; const end = content.indexOf("\n---\n", 4); return end < 0 ? content : content.slice(end + 5).trimStart(); }
function commandDocument({ description, agent, model, variant, subtask, body }: { description: string; agent: string; model: string; variant: string; subtask: boolean; body: string }) { const fields = [["description", description], ["agent", agent], ["model", model], ["variant", variant]].filter((entry) => entry[1]).map(([key, value]) => `${key}: ${JSON.stringify(value)}`); fields.push(`subtask: ${subtask}`); return `---\n${fields.join("\n")}\n---\n\n${body.trim()}\n`; }
function commandShell(content: string) { return [...content.matchAll(/!`([^`]+)`/g)].map((match) => match[1]); }
function slashCommand(value: string) { const match = value.trim().match(/^\/([a-z0-9][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/u); return match ? { name: match[1], arguments: match[2] ?? "" } : null; }

function scheduledRunLabel(status?: NonNullable<Task["last_scheduled_run"]>["status"]) { const labels: Record<string, string> = { pending: "ожидает", claimed: "подготовка", session_created: "сессия создана", running: "выполняется", ambiguous: "требует проверки", completed: "завершён", failed: "ошибка", skipped: "пропущен: предыдущий активен", cancelled: "отменён", aborted: "остановлен" }; return status ? labels[status] ?? status : "ещё не запускался"; }
function modeLabel(mode?: string | null) { if (mode === "primary") return "основной"; if (mode === "subagent") return "подагент"; if (mode === "all") return "основной и подагент"; return "не указан"; }
function scopeLabel(scope?: WorkspaceItem["scope"]) { if (scope === "project") return "для проекта"; if (scope === "global") return "для всех проектов"; if (scope === "runtime") return "Runtime"; return "встроенный"; }
function shortSource(source?: string) { if (!source) return "Runtime"; const home = source.replace(/^\/Users\/[^/]+/, "~"); const parts = home.split("/"); return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : home; }
function normalizeTheme(value: string | null) { if (value === "light") return "opencode-light"; if (value === "dark") return "opencode"; return themes.some((theme) => theme.id === value) ? value! : "opencode"; }
function applyTheme(id: string) { const theme = themes.find((item) => item.id === id) ?? themes[0]; const [background, panel, element, text, muted, primary, accent, success, error, info] = theme.colors; const style = document.documentElement.style; const values: Record<string, string> = { "--bg": background, "--surface": panel, "--surface-2": element, "--surface-3": `color-mix(in srgb, ${element} 82%, ${text})`, "--line": `color-mix(in srgb, ${muted} 28%, ${background})`, "--line-strong": `color-mix(in srgb, ${muted} 48%, ${background})`, "--text": text, "--muted": muted, "--faint": `color-mix(in srgb, ${muted} 78%, ${background})`, "--accent": primary, "--accent-2": accent, "--accent-soft": `color-mix(in srgb, ${primary} 14%, transparent)`, "--accent-contrast": contrastText(primary), "--green": success, "--green-contrast": contrastText(success), "--blue": info, "--purple": accent, "--danger": error, "--danger-contrast": contrastText(error), "--sidebar-bg": `color-mix(in srgb, ${background} 82%, ${panel})`, "--editor-bg": `color-mix(in srgb, ${background} 92%, #000)` }; Object.entries(values).forEach(([key, value]) => style.setProperty(key, value)); document.documentElement.dataset.theme = id; document.documentElement.style.colorScheme = theme.mode === "light" ? "light" : "dark"; }
export function contrastText(hex: string) { const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0]; const linear = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]; return luminance > .179 ? "#090a0c" : "#ffffff"; }
function relativeTime(value?: number) { if (!value) return "время неизвестно"; const milliseconds = value > 100_000_000_000 ? value : value * 1000; const minutes = Math.max(0, Math.floor((Date.now() - milliseconds) / 60000)); if (minutes < 1) return "только что"; if (minutes < 60) return new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(-minutes, "minute"); if (minutes < 1440) return new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(-Math.floor(minutes / 60), "hour"); return new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(-Math.floor(minutes / 1440), "day"); }
function mcpTarget(config: Record<string, unknown>) { if (typeof config.url === "string") return config.url; if (Array.isArray(config.command)) return config.command.join(" "); return "настроен без указанного адреса"; }
function statusLabel(value: string) { const labels: Record<string, string> = { running: "Выполняется", connected: "Подключен", completed: "Завершена", busy: "Выполняется", in_progress: "Выполняется", queued: "В очереди", failed: "Ошибка", aborted: "Остановлено", dispatching: "Запускается", scheduled: "По расписанию", paused: "Приостановлено", stopped: "Остановлен", external: "Внешний", idle: "Завершена", pending: "Ожидает", retry: "Повторная попытка", error: "Ошибка", disabled: "Отключен", unknown: "Неизвестно" }; return labels[value] ?? "Неизвестно"; }
function priorityLabel(value: SessionTodo["priority"]) { return value === "high" ? "высокий приоритет" : value === "medium" ? "средний приоритет" : "низкий приоритет"; }
function formatScheduleTime(value?: string | null) { if (!value) return "не рассчитан"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short" }).format(date); }
function scheduleCron(kind: "minutes" | "hours" | "daily" | "days", interval: number, time: string, minute: number) { const [hour = 9, clockMinute = 0] = time.split(":").map(Number); if (kind === "minutes") return `*/${interval} * * * *`; if (kind === "hours") return `${minute} */${interval} * * *`; if (kind === "days") return `${clockMinute} ${hour} */${interval} * *`; return `${clockMinute} ${hour} * * *`; }
function parseScheduleCron(cron: string): { kind: ScheduleKind; interval: number; time: string; minute: number } | null { let match = cron.match(/^\*\/(\d+) \* \* \* \*$/); if (match) return { kind: "minutes", interval: Number(match[1]), time: "09:00", minute: 0 }; match = cron.match(/^(\d+) \*\/(\d+) \* \* \*$/); if (match) return { kind: "hours", interval: Number(match[2]), time: "09:00", minute: Number(match[1]) }; match = cron.match(/^(\d+) (\d+) \*\/(\d+) \* \*$/); if (match) return { kind: "days", interval: Number(match[3]), time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`, minute: 0 }; match = cron.match(/^(\d+) (\d+) \* \* \*$/); if (match) return { kind: "daily", interval: 1, time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`, minute: 0 }; return null; }
function describeCron(cron: string) { let match = cron.match(/^\*\/(\d+) \* \* \* \*$/); if (match) { const value = Number(match[1]); return value === 1 ? "Каждую минуту" : `Каждые ${value} ${plural(value, "минуту", "минуты", "минут")}`; } match = cron.match(/^(\d+) \*\/(\d+) \* \* \*$/); if (match) { const hours = Number(match[2]); return `${hours === 1 ? "Каждый час" : `Каждые ${hours} ${plural(hours, "час", "часа", "часов")}`} в ${match[1].padStart(2, "0")} минут`; } match = cron.match(/^(\d+) (\d+) \* \* \*$/); if (match) return `Каждый день в ${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`; match = cron.match(/^(\d+) (\d+) \*\/(\d+) \* \*$/); if (match) { const days = Number(match[3]); const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`; return days === 2 ? `Через день в ${time}` : `Каждые ${days} ${plural(days, "день", "дня", "дней")} в ${time}`; } return `Расписание: ${cron}`; }
function plural(value: number, one: string, few: string, many: string) { const lastTwo = value % 100; const last = value % 10; if (lastTwo >= 11 && lastTwo <= 14) return many; if (last === 1) return one; if (last >= 2 && last <= 4) return few; return many; }
function skillNameOf(content: string) { const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1]; return frontmatter?.match(/^\s*name\s*:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim() ?? ""; }
function setSkillName(content: string, name: string) { const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/); if (!match) return `---\nname: ${name}\ndescription: Опишите, когда использовать этот навык\n---\n\n${content}`; const body = match[1]; const nextBody = /^\s*name\s*:/m.test(body) ? body.replace(/^\s*name\s*:.*$/m, `name: ${name}`) : `name: ${name}\n${body}`; return content.replace(match[0], `---\n${nextBody}\n---\n`); }
type AgentMode = "primary" | "subagent" | "all";
function agentModeOf(content: string): AgentMode | "" { const value = content.match(/^---\n[\s\S]*?^\s*mode\s*:\s*["']?([^\n"']+)["']?\s*$[\s\S]*?^---(?:\n|$)/m)?.[1]?.trim(); return value === "primary" || value === "subagent" || value === "all" ? value : ""; }
function setAgentMode(content: string, mode: AgentMode) { const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/); if (!match) return `---\nmode: ${mode}\n---\n\n${content}`; const body = match[1]; const nextBody = /^\s*mode\s*:/m.test(body) ? body.replace(/^\s*mode\s*:.*$/m, `mode: ${mode}`) : `${body}\nmode: ${mode}`; return content.replace(match[0], `---\n${nextBody}\n---\n`); }
function templateFor(kind: "agents" | "skills") { return kind === "agents" ? `---\ndescription: Опишите по-русски, для каких задач нужно использовать этого специалиста\nmode: subagent\n---\n\nТы специализированный агент этого проекта. Всегда отвечай пользователю на русском языке.\n\n## Обязанности\n\n- Выполняй только задачи своей специализации.\n- Перед работой изучай релевантные файлы проекта.\n- После изменений запускай подходящие проверки и сообщай результат.\n` : `---\nname: my-skill\ndescription: Опишите, что делает этот навык и когда агент должен его загружать\n---\n\n# Порядок работы\n\n1. Изучи контекст проекта.\n2. Выполни ограниченную задачу.\n3. Проверь результат и отчитайся на русском языке.\n`; }
