import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  BrainCircuit,
  CircleDollarSign,
  Cpu,
  FolderGit2,
  MessageSquareText,
  Play,
  SquareTerminal,
} from "lucide-react";
import { ApiError, api } from "../api";
import { createTranslator, intlLocale, localizedStatus, translate, useI18n, type Locale } from "../i18n";
import type { DashboardUsage, Project, Session, Snapshot, UsageRow } from "../types";

type DashboardProps = {
  project: Project;
  refreshKey: number;
  onOpenTasks: () => void;
  onOpenSessions: () => void;
};

export function Dashboard({ project, refreshKey, onOpenTasks, onOpenSessions }: DashboardProps) {
  const { locale, t } = useI18n();
  const [scope, setScope] = useState<"project" | "global">("project");
  const [period, setPeriod] = useState<"today" | "7d" | "30d" | "all">("today");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const usageUrl = `/api/v1/dashboard?scope=${scope}&project_id=${encodeURIComponent(project.id)}&period=${period}&timezone=${encodeURIComponent(timezone)}`;
  const usage = useDashboardResource<DashboardUsage>(usageUrl, refreshKey, 30000);
  const runtime = useDashboardResource<Snapshot>(
    `/api/v1/projects/${project.id}/snapshot`,
    refreshKey,
    5000,
  );
  const totals = usage.data?.totals;
  const maxModelTokens = Math.max(
    1,
    ...(usage.data?.models ?? []).map((row) => row.tokens_total),
  );
  const maxDailyTokens = Math.max(
    1,
    ...(usage.data?.daily ?? []).map((row) => row.tokens_total),
  );
  const tokenParts = totals
    ? [
        { id: "input", label: t("dashboard.input"), value: totals.tokens.input, color: "var(--blue)" },
        { id: "output", label: t("dashboard.output"), value: totals.tokens.output, color: "var(--green)" },
        {
          id: "reasoning",
          label: t("dashboard.reasoning"),
          value: totals.tokens.reasoning,
          color: "var(--accent)",
        },
        {
          id: "cache",
          label: "Cache read",
          value: totals.tokens.cache_read,
          color: "var(--purple)",
        },
        {
          id: "cache-write",
          label: "Cache write",
          value: totals.tokens.cache_write,
          color: "var(--faint)",
        },
      ]
    : [];
  const tokenPartTotal = tokenParts.reduce((sum, item) => sum + item.value, 0) || 1;
  const inputContext =
    (totals?.tokens.input ?? 0) +
    (totals?.tokens.cache_read ?? 0) +
    (totals?.tokens.cache_write ?? 0);
  const cacheReuse =
    inputContext > 0
      ? Math.round(((totals?.tokens.cache_read ?? 0) / inputContext) * 100)
      : 0;
  const periodLabel =
    period === "today"
      ? t("dashboard.period.today")
      : period === "7d"
        ? t("dashboard.period.7d")
        : period === "30d"
          ? t("dashboard.period.30d")
          : t("dashboard.period.all");
  const recentSessions =
    usage.data?.recent_sessions ??
    (scope === "project"
      ? (runtime.data?.sessions ?? [])
          .filter((session) => !session.parentID)
          .map((session) => ({
            ...session,
            project_id: project.id,
            project_name: project.name,
            status: dashboardSessionStatus(runtime.data, session),
          }))
      : []);

  return (
    <DashboardPage
      title={t("dashboard.title")}
      description={
        scope === "project"
          ? t("dashboard.projectDescription", { project: project.name })
          : t("dashboard.globalDescription")
      }
      action={
        <button className="primary-button" onClick={onOpenTasks}>
          <Play size={16} /> {t("dashboard.runTask")}
        </button>
      }
    >
      <div className="dashboard-toolbar">
        <div className="dashboard-segment" aria-label={t("dashboard.scopeLabel")}>
          <button
            className={scope === "project" ? "active" : ""}
            onClick={() => setScope("project")}
          >
            {t("dashboard.projectScope", { project: project.name })}
          </button>
          <button
            className={scope === "global" ? "active" : ""}
            onClick={() => setScope("global")}
          >
            {t("dashboard.globalScope")}
          </button>
        </div>
        <div className="dashboard-segment compact" aria-label={t("dashboard.periodLabel")}>
          {(["today", "7d", "30d", "all"] as const).map((value) => (
            <button
              key={value}
              className={period === value ? "active" : ""}
              onClick={() => setPeriod(value)}
            >
              {value === "today"
                ? t("dashboard.today")
                : value === "7d"
                  ? t("dashboard.7d")
                  : value === "30d"
                    ? t("dashboard.30d")
                    : t("dashboard.all")}
            </button>
          ))}
        </div>
      </div>
      {usage.error && (
        <DashboardBanner tone="danger">{t("dashboard.analyticsError", { error: usage.error })}</DashboardBanner>
      )}
      {usage.data?.partial && (
        <DashboardBanner tone="notice">
          {t("dashboard.partial")} {usage.data.unavailable_projects.length
            ? t("dashboard.unavailableProjects", { projects: usage.data.unavailable_projects.map((item) => item.name).join(", ") })
            : t("dashboard.sessionsUnavailable")}
        </DashboardBanner>
      )}
      {scope === "project" && runtime.data?.state === "stopped" && (
        <DashboardBanner tone="notice">
          {t("dashboard.startServer")}
        </DashboardBanner>
      )}
      <section className="metric-grid">
        <DashboardMetric
          icon={<Cpu />}
          label={t("dashboard.tokens", { period: periodLabel })}
          value={totals ? compactNumber(totals.tokens_total, locale) : "—"}
          detail={t("dashboard.tokenDetail", { input: compactNumber(totals?.tokens.input ?? 0, locale), output: compactNumber(totals?.tokens.output ?? 0, locale), reasoning: compactNumber(totals?.tokens.reasoning ?? 0, locale) })}
          accent="blue"
        />
        <DashboardMetric
          icon={<CircleDollarSign />}
          label={t("dashboard.cost", { period: periodLabel })}
          value={totals ? `$${totals.cost.toFixed(3)}` : "—"}
          detail={t("dashboard.costDetail")}
          accent="green"
        />
        <DashboardMetric
          icon={<MessageSquareText />}
          label={t("dashboard.sessions")}
          value={totals ? String(totals.sessions) : "—"}
          detail={t("dashboard.sessionDetail", { active: totals?.active ?? 0, messages: totals?.messages ?? 0 })}
          accent="orange"
        />
        <DashboardMetric
          icon={<Activity />}
          label={t("dashboard.cacheReuse")}
          value={totals ? compactNumber(totals.tokens.cache_read, locale) : "—"}
          detail={t("dashboard.cacheDetail", { percent: cacheReuse, written: compactNumber(totals?.tokens.cache_write ?? 0, locale) })}
          accent="purple"
        />
      </section>
      <div className="dashboard-analytics-grid">
        <DashboardPanel
          className="usage-chart-panel"
          title={t("dashboard.usageTrend")}
          icon={<Activity size={17} />}
          action={<span className="panel-caption">timezone · {timezone}</span>}
        >
          <p className="usage-composition-note">
            {t("dashboard.composition")}
          </p>
          <div className="usage-composition">
            <div className="usage-composition-bar">
              {tokenParts
                .filter((item) => item.value > 0)
                .map((item) => (
                  <i
                    key={item.id}
                    style={{
                      width: `${Math.max(1.5, (item.value / tokenPartTotal) * 100)}%`,
                      background: item.color,
                    }}
                  />
                ))}
            </div>
            <div className="usage-legend">
              {tokenParts.map((item) => (
                <span key={item.id}>
                  <i style={{ background: item.color }} />
                  <small>{item.label}</small>
                  <strong>{compactNumber(item.value, locale)}</strong>
                </span>
              ))}
            </div>
          </div>
          <div className="usage-bars" aria-label={t("dashboard.dailyUsage")}>
            {(usage.data?.daily ?? []).map((row) => (
              <div key={row.id}>
                <span className="usage-bar-track">
                  <i
                    style={{
                      height: `${Math.max(3, (row.tokens_total / maxDailyTokens) * 100)}%`,
                    }}
                  />
                </span>
                <strong>{compactNumber(row.tokens_total, locale)}</strong>
                <small>
                  {new Intl.DateTimeFormat(intlLocale(locale), {
                    day: "2-digit",
                    month: "short",
                  }).format(new Date(`${row.id}T12:00:00`))}
                </small>
              </div>
            ))}
            {usage.data && (usage.data.daily ?? []).length === 0 && (
              <div className="usage-chart-empty">{t("dashboard.noUsage")}</div>
            )}
          </div>
        </DashboardPanel>
        <DashboardPanel
          className="usage-ranking-panel"
          title={t("dashboard.models")}
          icon={<BrainCircuit size={17} />}
          action={<span className="panel-caption">{t("dashboard.tokensCost")}</span>}
        >
          <UsageRanking
            rows={usage.data?.models ?? []}
            maxTokens={maxModelTokens}
            empty={t("dashboard.noModels")}
            locale={locale}
          />
        </DashboardPanel>
      </div>
      <div className="overview-grid dashboard-bottom-grid">
        <DashboardPanel
          title={scope === "project" ? t("dashboard.recentProject") : t("dashboard.recentGlobal")}
          icon={<MessageSquareText size={17} />}
          action={
            scope === "project" ? (
              <button className="text-button" onClick={onOpenSessions}>
                {t("dashboard.showAll")}
              </button>
            ) : undefined
          }
        >
          <div className="dashboard-session-rows">
            {recentSessions.map((session) => (
              <div key={`${session.project_id}:${session.id}`}>
                <span className="session-icon">
                  <MessageSquareText size={16} />
                </span>
                <span>
                  <strong>{session.title ?? t("common.unnamedSession")}</strong>
                  <small>
                    {scope === "global" ? `${session.project_name} · ` : ""}
                    {session.agent ?? t("common.default")} · {dashboardModel(session, locale)}
                  </small>
                </span>
                <span>
                  <DashboardStatus value={session.status} locale={locale} />
                  <small>{relativeTime(session.time?.updated, locale)}</small>
                </span>
              </div>
            ))}
            {usage.data && recentSessions.length === 0 && (
              <DashboardEmpty
                icon={<MessageSquareText />}
                title={t("dashboard.noSessions")}
                detail={t("dashboard.noSessionsDetail")}
              />
            )}
          </div>
        </DashboardPanel>
        {scope === "project" ? (
          <DashboardPanel title={t("dashboard.projectRuntime")} icon={<SquareTerminal size={17} />}>
            <dl className="runtime-list">
              <div>
                <dt>{t("dashboard.server")}</dt>
                <dd>
                  <DashboardStatus locale={locale}
                    value={
                      runtime.data?.server.state === "running"
                        ? "connected"
                        : runtime.data?.server.state ?? "stopped"
                    }
                  />
                </dd>
              </div>
              <div>
                <dt>{t("dashboard.address")}</dt>
                <dd className="mono">{runtime.data?.server.endpoint ?? t("common.notRunning")}</dd>
              </div>
              <div>
                <dt>OpenCode</dt>
                <dd>{runtime.data?.health?.version ?? t("common.unknown")}</dd>
              </div>
              <div>
                <dt>MCP</dt>
                <dd>
                  {t("common.connectedCount", { connected: totals?.mcp_connected ?? 0, total: totals?.mcp_total ?? 0 })}
                </dd>
              </div>
              <div>
                <dt>{t("dashboard.folder")}</dt>
                <dd className="mono truncate" title={project.root}>
                  {project.root}
                </dd>
              </div>
            </dl>
          </DashboardPanel>
        ) : (
          <DashboardPanel
            title={t("dashboard.projects")}
            icon={<FolderGit2 size={17} />}
            action={<span className="panel-caption">{t("dashboard.usagePeriod")}</span>}
          >
            <UsageRanking
              rows={usage.data?.projects ?? []}
              maxTokens={Math.max(
                1,
                ...(usage.data?.projects ?? []).map((row) => row.tokens_total),
              )}
              empty={t("dashboard.noProjects")}
              locale={locale}
            />
          </DashboardPanel>
        )}
      </div>
    </DashboardPage>
  );
}

function UsageRanking({ rows, maxTokens, empty, locale }: { rows: UsageRow[]; maxTokens: number; empty: string; locale: Locale }) {
  if (!rows.length) return <div className="usage-ranking-empty">{empty}</div>;
  return (
    <div className="usage-ranking">
      {rows.slice(0, 8).map((row, index) => (
        <div key={row.id}>
          <span className="usage-rank">{String(index + 1).padStart(2, "0")}</span>
          <span>
            <strong>{row.name ?? row.id}</strong>
            <i>
              <b style={{ width: `${Math.max(2, (row.tokens_total / maxTokens) * 100)}%` }} />
            </i>
          </span>
          <span>
            <strong>{compactNumber(row.tokens_total, locale)}</strong>
            <small>
              ${row.cost.toFixed(3)} · {createSessionCount(row.sessions, locale)}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

function DashboardPage({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return <div className="page"><header className="page-heading"><div><p className="eyebrow">OpenCode Control</p><h1>{title}</h1><p>{description}</p></div>{action}</header>{children}</div>;
}

function DashboardPanel({ title, icon, action, className = "", children }: { title: string; icon?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel ${className}`}><header className="panel-heading"><h2>{icon}{title}</h2>{action}</header>{children}</section>;
}

function DashboardMetric({ icon, label, value, detail, accent }: { icon: ReactNode; label: string; value: string; detail: string; accent: string }) {
  return <article className={`metric ${accent}`}><div className="metric-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function DashboardBanner({ tone, children }: { tone: "danger" | "notice"; children: ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

function DashboardStatus({ value, locale }: { value: string; locale: Locale }) {
  return <span className="status" data-status={value}><i />{localizedStatus(value, locale)}</span>;
}

function DashboardEmpty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="empty"><span>{icon}</span><h3>{title}</h3><p>{detail}</p></div>;
}

function useDashboardResource<T>(url: string, dependency: unknown, interval?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let polling = true;
    let sequence = 0;
    setData(null);
    setError(null);
    async function load() {
      const request = ++sequence;
      try {
        const value = await api<T>(url);
        if (active && request === sequence) {
          setData(value);
          setError(null);
        }
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) polling = false;
        if (active && request === sequence) {
          setError(reason instanceof Error ? reason.message : createFallbackError());
        }
      }
    }
    void load();
    const timer = interval
      ? window.setInterval(() => {
          if (polling) void load();
        }, interval)
      : undefined;
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, [url, dependency, interval]);
  return { data, error };
}

function compactNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(intlLocale(locale), {
    notation: value > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function dashboardSessionStatus(snapshot: Snapshot | null | undefined, session: Session) {
  const taskStatus = session.control_task?.status;
  if (taskStatus === "aborted" || taskStatus === "failed") return taskStatus;
  const status = snapshot?.statuses[session.id];
  return status?.type ?? status?.status ?? "idle";
}

function dashboardModel(session: Session, locale: Locale) {
  const id = session.model?.modelID ?? session.model?.id;
  return id ? `${session.model?.providerID ? `${session.model.providerID}/` : ""}${id}` : createTranslator(locale)("common.defaultModel");
}

function relativeTime(value: number | undefined, locale: Locale) {
  if (!value) return createTranslator(locale)("common.timeUnknown");
  const milliseconds = value > 100_000_000_000 ? value : value * 1000;
  const minutes = Math.max(0, Math.floor((Date.now() - milliseconds) / 60000));
  if (minutes < 1) return createTranslator(locale)("common.justNow");
  if (minutes < 60) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-minutes, "minute");
  if (minutes < 1440) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.floor(minutes / 60), "hour");
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.floor(minutes / 1440), "day");
}

function createSessionCount(count: number, locale: Locale) {
  return createTranslator(locale)("common.sessionsShort", { count });
}

function createFallbackError() {
  return translate("common.unknownError");
}
