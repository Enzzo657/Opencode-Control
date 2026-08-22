import { AlertTriangle, Bell, CheckCheck, CircleCheck, Clock3, Server, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, jsonBody } from "./api";
import { useI18n, type TranslationKey } from "./i18n";
import { relativeTime } from "./sessionUtils";
import type { ControlEvent, EventFeed, Project } from "./types";
import { message, useResource } from "./useResource";

const eventLabels: Record<string, TranslationKey> = {
  task_completed: "events.kind.taskCompleted",
  task_failed: "events.kind.taskFailed",
  task_aborted: "events.kind.taskAborted",
  scheduled_run_completed: "events.kind.runCompleted",
  scheduled_run_failed: "events.kind.runFailed",
  scheduled_run_stalled: "events.kind.runStalled",
  scheduled_run_aborted: "events.kind.runAborted",
  scheduled_run_cancelled: "events.kind.runCancelled",
  scheduled_run_skipped: "events.kind.runSkipped",
  permission_requested: "events.kind.permission",
  server_started: "events.kind.serverStarted",
  server_stopped: "events.kind.serverStopped",
  server_restarted: "events.kind.serverRestarted",
  server_failed: "events.kind.serverFailed",
};

export function EventCenter({ project, onOpen }: { project: Project | null; onOpen: (event: ControlEvent) => void | Promise<void> }) {
  const { t } = useI18n();
  const feed = useResource<EventFeed>(`/api/v1/events?limit=100${project ? `&sync_project_id=${encodeURIComponent(project.id)}` : ""}`, project?.id ?? "events", 5000);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"all" | "project">("project");
  const [filter, setFilter] = useState<"all" | "attention">("all");
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const visible = (feed.data?.events ?? []).filter((event) => {
    if (scope === "project" && project && event.project_id !== project.id) return false;
    return filter === "all" || event.read_at === null;
  });
  const scopedUnread = (feed.data?.events ?? []).filter((event) => event.read_at === null && (scope === "all" || event.project_id === project?.id)).length;

  useEffect(() => {
    if (!open) return;
    function pointerDown(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    function keyDown(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("keydown", keyDown);
    return () => { window.removeEventListener("pointerdown", pointerDown); window.removeEventListener("keydown", keyDown); };
  }, [open]);

  async function select(event: ControlEvent) {
    try {
      if (!event.read_at) await api(`/api/v1/events/${event.id}/read`, { method: "POST" });
      setError(null);
      setOpen(false);
      feed.reload();
      await onOpen(event);
    } catch (reason) { setError(message(reason)); }
  }

  async function readAll() {
    try {
      await api("/api/v1/events/read-all", { method: "POST", ...jsonBody({ project_id: scope === "project" ? project?.id ?? null : null }) });
      setError(null);
      feed.reload();
    } catch (reason) { setError(message(reason)); }
  }

  return <div className="event-center" ref={root}>
    <button className={`icon-button event-trigger ${feed.data?.unread ? "has-unread" : ""}`} onClick={() => setOpen((value) => !value)} aria-label={t("events.open")} title={t("events.open")} aria-expanded={open}>
      <Bell size={17} />
      {(feed.data?.unread ?? 0) > 0 && <b>{Math.min(feed.data!.unread, 99)}</b>}
    </button>
    {open && <section className="event-popover" aria-label={t("events.title")}>
      <header><span><strong>{t("events.title")}</strong><small>{t("events.subtitle")}</small></span><button className="icon-button" onClick={() => setOpen(false)} aria-label={t("common.close")}><X size={16} /></button></header>
      <div className="event-controls">
        <div className="event-segments" role="group" aria-label={t("events.scope")}><button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>{t("events.allProjects")}</button><button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")} disabled={!project}>{t("events.currentProject")}</button></div>
        <div className="event-segments" role="group" aria-label={t("events.filter")}><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>{t("events.all")}</button><button className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")}>{t("events.attention")}{scopedUnread > 0 && <b>{scopedUnread}</b>}</button></div>
      </div>
      {error && <p className="event-error">{error}</p>}
      <div className="event-list">
        {visible.map((event) => <button className={`event-row ${event.read_at ? "" : "unread"}`} key={event.id} onClick={() => void select(event)}>
          <EventIcon event={event} />
          <span><strong>{event.resource_title}</strong><small>{t(eventLabels[event.kind] ?? "events.kind.unknown")}</small>{event.detail && <em>{event.detail}</em>}</span>
          <span><small>{scope === "all" ? event.project_name : ""}</small><time>{relativeTime(Date.parse(event.occurred_at))}</time>{!event.read_at && <i />}</span>
        </button>)}
        {!feed.data && !feed.error && <div className="event-empty"><Clock3 /><span>{t("events.loading")}</span></div>}
        {feed.data && visible.length === 0 && <div className="event-empty"><CircleCheck /><strong>{t(filter === "attention" ? "events.noAttention" : "events.empty")}</strong><span>{t("events.emptyDetail")}</span></div>}
        {feed.error && <div className="event-empty danger"><AlertTriangle /><strong>{t("events.failed")}</strong><span>{feed.error}</span></div>}
      </div>
      <footer><span>{t("events.retention")}</span><button onClick={() => void readAll()} disabled={scopedUnread === 0}><CheckCheck size={14} /> {t("events.readAll")}</button></footer>
    </section>}
  </div>;
}

function EventIcon({ event }: { event: ControlEvent }) {
  if (event.kind === "permission_requested") return <span className="event-icon action"><ShieldAlert /></span>;
  if (event.kind.startsWith("server_")) return <span className={`event-icon ${event.severity}`}><Server /></span>;
  if (event.severity === "error") return <span className="event-icon error"><AlertTriangle /></span>;
  if (event.severity === "warning") return <span className="event-icon warning"><AlertTriangle /></span>;
  return <span className="event-icon info"><CircleCheck /></span>;
}
