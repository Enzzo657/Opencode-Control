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
import { createTranslator } from "../i18n";
import type { DashboardUsage, Project, Session, Snapshot, UsageRow } from "../types";

type DashboardProps = {
  project: Project;
  refreshKey: number;
  onOpenTasks: () => void;
  onOpenSessions: () => void;
};

const t = createTranslator("ru");

export function Dashboard({ project, refreshKey, onOpenTasks, onOpenSessions }: DashboardProps) {
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
        { id: "input", label: "Ввод", value: totals.tokens.input, color: "var(--blue)" },
        { id: "output", label: "Вывод", value: totals.tokens.output, color: "var(--green)" },
        {
          id: "reasoning",
          label: "Рассуждения",
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
      ? "сегодня"
      : period === "7d"
        ? "за 7 дней"
        : period === "30d"
          ? "за 30 дней"
          : "за всё время";
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
        <div className="dashboard-segment" aria-label="Область аналитики">
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
        <div className="dashboard-segment compact" aria-label="Период аналитики">
          {(["today", "7d", "30d", "all"] as const).map((value) => (
            <button
              key={value}
              className={period === value ? "active" : ""}
              onClick={() => setPeriod(value)}
            >
              {value === "today"
                ? "Сегодня"
                : value === "7d"
                  ? "7 дней"
                  : value === "30d"
                    ? "30 дней"
                    : "Всё время"}
            </button>
          ))}
        </div>
      </div>
      {usage.error && (
        <DashboardBanner tone="danger">Не удалось собрать аналитику: {usage.error}</DashboardBanner>
      )}
      {usage.data?.partial && (
        <DashboardBanner tone="notice">
          Показаны доступные данные OpenCode. {usage.data.unavailable_projects.length
            ? `Не удалось прочитать проектов: ${usage.data.unavailable_projects.map((item) => item.name).join(", ")}.`
            : "Часть истории Sessions недоступна."}
        </DashboardBanner>
      )}
      {scope === "project" && runtime.data?.state === "stopped" && (
        <DashboardBanner tone="notice">
          Запустите сервер OpenCode, чтобы загрузить usage, Sessions и состояние Runtime.
        </DashboardBanner>
      )}
      <section className="metric-grid">
        <DashboardMetric
          icon={<Cpu />}
          label={`Токены · ${periodLabel}`}
          value={totals ? compactNumber(totals.tokens_total) : "—"}
          detail={`${compactNumber(totals?.tokens.input ?? 0)} ввод · ${compactNumber(totals?.tokens.output ?? 0)} вывод · ${compactNumber(totals?.tokens.reasoning ?? 0)} reasoning`}
          accent="blue"
        />
        <DashboardMetric
          icon={<CircleDollarSign />}
          label={`Расходы · ${periodLabel}`}
          value={totals ? `$${totals.cost.toFixed(3)}` : "—"}
          detail="по данным сообщений OpenCode"
          accent="green"
        />
        <DashboardMetric
          icon={<MessageSquareText />}
          label="Сессии"
          value={totals ? String(totals.sessions) : "—"}
          detail={`${totals?.active ?? 0} активных · ${totals?.messages ?? 0} ответов`}
          accent="orange"
        />
        <DashboardMetric
          icon={<Activity />}
          label="Повторно из cache"
          value={totals ? compactNumber(totals.tokens.cache_read) : "—"}
          detail={`${cacheReuse}% входного контекста · ${compactNumber(totals?.tokens.cache_write ?? 0)} записано`}
          accent="purple"
        />
      </section>
      <div className="dashboard-analytics-grid">
        <DashboardPanel
          className="usage-chart-panel"
          title="Динамика использования"
          icon={<Activity size={17} />}
          action={<span className="panel-caption">timezone · {timezone}</span>}
        >
          <p className="usage-composition-note">
            Распределение обычных токенов и кешированного контекста. Cache виден здесь, но не
            входит в основной total и рейтинг моделей.
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
                  <strong>{compactNumber(item.value)}</strong>
                </span>
              ))}
            </div>
          </div>
          <div className="usage-bars" aria-label="Использование токенов по дням">
            {(usage.data?.daily ?? []).map((row) => (
              <div key={row.id}>
                <span className="usage-bar-track">
                  <i
                    style={{
                      height: `${Math.max(3, (row.tokens_total / maxDailyTokens) * 100)}%`,
                    }}
                  />
                </span>
                <strong>{compactNumber(row.tokens_total)}</strong>
                <small>
                  {new Intl.DateTimeFormat("ru-RU", {
                    day: "2-digit",
                    month: "short",
                  }).format(new Date(`${row.id}T12:00:00`))}
                </small>
              </div>
            ))}
            {usage.data && (usage.data.daily ?? []).length === 0 && (
              <div className="usage-chart-empty">За выбранный период usage не найден.</div>
            )}
          </div>
        </DashboardPanel>
        <DashboardPanel
          className="usage-ranking-panel"
          title="Модели"
          icon={<BrainCircuit size={17} />}
          action={<span className="panel-caption">токены · стоимость</span>}
        >
          <UsageRanking
            rows={usage.data?.models ?? []}
            maxTokens={maxModelTokens}
            empty="Нет данных по моделям за этот период."
          />
        </DashboardPanel>
      </div>
      <div className="overview-grid dashboard-bottom-grid">
        <DashboardPanel
          title={scope === "project" ? "Последние сессии проекта" : "Последние сессии всех проектов"}
          icon={<MessageSquareText size={17} />}
          action={
            scope === "project" ? (
              <button className="text-button" onClick={onOpenSessions}>
                Показать все
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
                  <strong>{session.title ?? "Сессия без названия"}</strong>
                  <small>
                    {scope === "global" ? `${session.project_name} · ` : ""}
                    {session.agent ?? "default"} · {dashboardModel(session)}
                  </small>
                </span>
                <span>
                  <DashboardStatus value={session.status} />
                  <small>{relativeTime(session.time?.updated)}</small>
                </span>
              </div>
            ))}
            {usage.data && recentSessions.length === 0 && (
              <DashboardEmpty
                icon={<MessageSquareText />}
                title="Сессий за период нет"
                detail="Измените период или запустите новую задачу."
              />
            )}
          </div>
        </DashboardPanel>
        {scope === "project" ? (
          <DashboardPanel title="Runtime проекта" icon={<SquareTerminal size={17} />}>
            <dl className="runtime-list">
              <div>
                <dt>Сервер</dt>
                <dd>
                  <DashboardStatus
                    value={
                      runtime.data?.server.state === "running"
                        ? "connected"
                        : runtime.data?.server.state ?? "stopped"
                    }
                  />
                </dd>
              </div>
              <div>
                <dt>Адрес</dt>
                <dd className="mono">{runtime.data?.server.endpoint ?? "не запущен"}</dd>
              </div>
              <div>
                <dt>OpenCode</dt>
                <dd>{runtime.data?.health?.version ?? "неизвестно"}</dd>
              </div>
              <div>
                <dt>MCP</dt>
                <dd>
                  {totals?.mcp_connected ?? 0}/{totals?.mcp_total ?? 0} подключено
                </dd>
              </div>
              <div>
                <dt>Папка</dt>
                <dd className="mono truncate" title={project.root}>
                  {project.root}
                </dd>
              </div>
            </dl>
          </DashboardPanel>
        ) : (
          <DashboardPanel
            title="Проекты"
            icon={<FolderGit2 size={17} />}
            action={<span className="panel-caption">usage за период</span>}
          >
            <UsageRanking
              rows={usage.data?.projects ?? []}
              maxTokens={Math.max(
                1,
                ...(usage.data?.projects ?? []).map((row) => row.tokens_total),
              )}
              empty="Нет доступных данных по проектам."
            />
          </DashboardPanel>
        )}
      </div>
    </DashboardPage>
  );
}

function UsageRanking({ rows, maxTokens, empty }: { rows: UsageRow[]; maxTokens: number; empty: string }) {
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
            <strong>{compactNumber(row.tokens_total)}</strong>
            <small>
              ${row.cost.toFixed(3)} · {row.sessions} сесс.
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

function DashboardStatus({ value }: { value: string }) {
  return <span className="status" data-status={value}><i />{statusLabel(value)}</span>;
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
          setError(reason instanceof Error ? reason.message : "Непредвиденная ошибка");
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

function compactNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
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

function dashboardModel(session: Session) {
  const id = session.model?.modelID ?? session.model?.id;
  return id ? `${session.model?.providerID ? `${session.model.providerID}/` : ""}${id}` : "модель по умолчанию";
}

function relativeTime(value?: number) {
  if (!value) return "время неизвестно";
  const milliseconds = value > 100_000_000_000 ? value : value * 1000;
  const minutes = Math.max(0, Math.floor((Date.now() - milliseconds) / 60000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(-minutes, "minute");
  if (minutes < 1440) return new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(-Math.floor(minutes / 60), "hour");
  return new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(-Math.floor(minutes / 1440), "day");
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    running: "Выполняется",
    connected: "Подключен",
    completed: "Завершена",
    busy: "Выполняется",
    queued: "В очереди",
    failed: "Ошибка",
    aborted: "Остановлено",
    dispatching: "Запускается",
    scheduled: "По расписанию",
    paused: "Приостановлено",
    stopped: "Остановлен",
    external: "Внешний",
    idle: "Завершена",
    pending: "Ожидает",
    retry: "Повторная попытка",
    error: "Ошибка",
    disabled: "Отключен",
  };
  return labels[value] ?? "Неизвестно";
}
