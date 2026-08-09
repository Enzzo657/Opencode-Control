import { Bot, BrainCircuit, CircleStop, Cpu, MessageSquareText, Play, Plus, Settings, Sparkles, SquareTerminal, Trash2, Zap } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, jsonBody } from "../api";
import { commandDisplayDescription } from "../commands";
import { localizedStatus, translate, useI18n } from "../i18n";
import { PromptBox } from "../PromptBox";
import { describeCron, formatScheduleTime, parseScheduleCron, scheduleCron, scheduledRunLabel, type ScheduleKind } from "../schedule";
import { mentionedAgents, modelIdOf, relativeTime, rememberComposerSelection, rememberedComposerSelection, selectedDefaultModel, sessionStatus, slashCommand, taskSessionIds } from "../sessionUtils";
import type { Agent, Attachment, CommandItem, Project, ProviderSummary, RuntimeConfig, Session, Snapshot, Task } from "../types";
import { Banner, Empty, Field, Modal, Page } from "../ui";
import { message, useResource } from "../useResource";
import { localizedAgentDescription } from "../workspace";
import { SessionComposer, SessionDrawer } from "./Sessions";

export function Tasks({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const { t } = useI18n();
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
    if (!confirm(t("tasks.deleteConfirm", { task: task.title, count }))) return;
    try {
      await api(`/api/v1/projects/${project.id}/tasks/${task.id}`, { method: "DELETE" });
      setActionError(null); setSelectedSessionId(null); tasks.reload(); snapshot.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  async function removeSession(session: Session) {
    if (!confirm(t("tasks.unlinkSessionConfirm", { session: session.title ?? session.id }))) return;
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setSelectedSessionId(null); setActionError(null); tasks.reload(); snapshot.reload();
    } catch (reason) { setActionError(message(reason)); }
  }
  const selectedSession = snapshot.data?.sessions.find((item) => item.id === selectedSessionId) ?? null;
  const selectedTask = tasks.data?.find((task) => selectedSessionId !== null && taskSessionIds(task).includes(selectedSessionId));
  return (
    <Page title={t("tasks.title")} description={t("tasks.description")} action={<button className="primary-button" onClick={() => setOpen(true)}><Play size={16} /> {t("tasks.run")}</button>}>
      {tasks.error && <Banner tone="danger">{tasks.error}</Banner>}
      {actionError && <Banner tone="danger">{actionError}</Banner>}
      <div className="context-summary task-context-summary">
        <div><small>{t("common.project")}</small><strong>{project.name}</strong></div>
        <div><small>{t("tasks.contextIncluded")}</small><strong>{t("tasks.contextValue")}</strong><span>{t("tasks.contextOrder")}</span></div>
        <div><small>{t("tasks.defaultLaunch")}</small><strong>{snapshot.data?.config?.default_agent ?? "build"}</strong><span>{snapshot.data?.config?.model ?? t("tasks.lastSelectedModel")}</span></div>
      </div>
      <div className="task-list">
        {(tasks.data ?? []).map((task) => (
          <article className="task-card" key={task.id}>
            <div className="task-status-rail" data-status={task.status} />
            <div className="task-main">
              <div className="task-title-row"><TaskStatus value={task.status} /><span className="task-time">{relativeTime(Date.parse(task.created_at))}</span><h3>{task.title}</h3></div>
              <p title={task.error ?? task.prompt}>{task.error ?? task.prompt}</p>
              {task.cron && <div className="task-schedule"><span><small>{t("tasks.schedule")}</small><strong>{describeCron(task.cron)}</strong></span><span><small>{t("tasks.timezone")}</small><strong>{task.timezone}</strong></span><span><small>{t("tasks.conversationHistory")}</small><strong>{t(task.cron_session_mode === "reuse" ? "tasks.reuseSession" : "tasks.newSessionEachRun")}</strong></span><span><small>{t("tasks.lastRun")}</small><strong title={task.last_scheduled_run?.error ?? undefined}>{scheduledRunLabel(task.last_scheduled_run?.status)}</strong></span><span><small>{t("tasks.nextRun")}</small><strong>{task.schedule_enabled ? formatScheduleTime(task.next_run_at) : t("tasks.schedulePaused")}</strong></span></div>}
            </div>
            <div className="task-meta">
              <span className="task-fact"><Bot size={15} /><small>{t("common.agent")}</small><strong>{task.agent ?? snapshot.data?.config?.default_agent ?? "build"}</strong></span>
              <span className="task-fact"><BrainCircuit size={15} /><small>{t("tasks.reasoning")}</small><strong>{task.variant || t("common.default")}</strong></span>
              <span className="task-fact"><Cpu size={15} /><small>{t("common.model")}</small><strong title={task.model ?? (modelIdOf(snapshot.data?.sessions.find((item) => item.id === task.session_id)) || snapshot.data?.config?.model || t("common.default"))}>{task.model ?? (modelIdOf(snapshot.data?.sessions.find((item) => item.id === task.session_id)) || snapshot.data?.config?.model || t("common.default"))}</strong></span>
              <span className="task-fact"><MessageSquareText size={15} /><small>{t("tasks.sessions")}</small><strong>{taskSessionIds(task).length}</strong></span>
            </div>
            <div className="task-card-footer">
              <div className="task-session-links">{taskSessionIds(task).map((sessionId, index) => { const session = snapshot.data?.sessions.find((item) => item.id === sessionId); return <button className="secondary-button compact-button" key={sessionId} onClick={() => setSelectedSessionId(sessionId)}>{session?.title ?? t("tasks.sessionNumber", { number: index + 1 })}</button>; })}</div>
              <div className="task-actions"><button className="secondary-button compact-button" onClick={() => setSessionTask(task)}><Plus size={13} /> {t("tasks.newSession")}</button><button className="secondary-button compact-button" onClick={() => setScheduleTask(task)}><Settings size={13} /> {t("tasks.configureLaunch")}</button>{task.cron && <button className="secondary-button compact-button" onClick={() => void toggleSchedule(task)}>{t(task.schedule_enabled ? "tasks.pauseSchedule" : "tasks.resumeSchedule")}</button>}{["queued", "dispatching", "running"].includes(task.status) ? <button className="danger-button compact-button" onClick={() => void abort(task)}><CircleStop size={13} /> {t("tasks.stop")}</button> : <><button className="secondary-button compact-button" onClick={() => void rerun(task)}><Play size={13} /> {t("tasks.rerun")}</button><button className="icon-button danger" title={t("tasks.deleteWithSessions")} onClick={() => void remove(task)} aria-label={t("tasks.deleteWithSessions")}><Trash2 size={14} /></button></>}</div>
            </div>
          </article>
        ))}
        {(tasks.data?.length ?? 0) === 0 && <Empty icon={<Zap />} title={t("tasks.empty")} detail={t("tasks.emptyDetail")} />}
      </div>
      {open && <TaskComposer project={project} agents={snapshot.data?.agents ?? []} commands={commands.data ?? []} providers={snapshot.data?.providers?.available ?? []} config={snapshot.data?.config} defaultModel={selectedDefaultModel(snapshot.data)} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); tasks.reload(); snapshot.reload(); }} />}
      {sessionTask && <SessionComposer project={project} task={sessionTask} agents={snapshot.data?.agents ?? []} commands={commands.data ?? []} providers={snapshot.data?.providers?.available ?? []} config={snapshot.data?.config} defaultModel={sessionTask.model ?? selectedDefaultModel(snapshot.data)} onClose={() => setSessionTask(null)} onCreated={() => { setSessionTask(null); tasks.reload(); snapshot.reload(); }} />}
      {scheduleTask && <TaskScheduleEditor project={project} task={scheduleTask} agents={snapshot.data?.agents ?? []} commands={commands.data ?? []} onClose={() => setScheduleTask(null)} onSaved={() => { setScheduleTask(null); tasks.reload(); }} />}
      {selectedSession && <SessionDrawer project={project} session={selectedSession} status={sessionStatus(snapshot.data, selectedSession)} taskStatus={selectedTask?.session_id === selectedSession.id ? selectedTask.status : selectedSession.control_task?.session_status} agents={snapshot.data?.agents ?? []} providers={snapshot.data?.providers?.available ?? []} mcp={snapshot.data?.mcp ?? {}} config={snapshot.data?.config} initialAgent={selectedTask?.agent ?? selectedSession.agent ?? ""} initialModel={selectedTask?.model || modelIdOf(selectedSession) || snapshot.data?.config?.model || ""} onDelete={() => void removeSession(selectedSession)} onClose={() => setSelectedSessionId(null)} />}
    </Page>
  );
}

function TaskComposer({ project, agents, commands, providers, config, defaultModel, onClose, onCreated }: { project: Project; agents: Agent[]; commands: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; defaultModel?: string; onClose: () => void; onCreated: () => void }) {
  const savedSelection = rememberedComposerSelection(project.id, agents);
  const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [agent, setAgent] = useState(() => savedSelection.agent); const [model, setModel] = useState(savedSelection.model || config?.model || defaultModel || ""); const [variant, setVariant] = useState(savedSelection.variant); const [attachments, setAttachments] = useState<Attachment[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false); const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("daily"); const [interval, setInterval] = useState(1); const [time, setTime] = useState("09:00"); const [minute, setMinute] = useState(0); const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [cronSessionMode, setCronSessionMode] = useState<"new" | "reuse">("new");
  const cron = scheduleCron(scheduleKind, interval, time, minute);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { const invocation = slashCommand(prompt); if (invocation && !commands.some((item) => item.id === invocation.name)) throw new Error(translate("prompt.commandNotFound", { value0: invocation.name })); if (invocation && attachments.length) throw new Error(translate("taskComposer.commandWithFiles")); const mentions = mentionedAgents(prompt, agents); await api(`/api/v1/projects/${project.id}/tasks`, { method: "POST", ...jsonBody({ title, prompt, agent: agent || null, model: model || null, ...(variant ? { variant } : {}), ...(mentions.length ? { mentions } : {}), attachments: scheduled ? [] : attachments, cron: scheduled ? cron : null, timezone, cron_session_mode: cronSessionMode }) }); rememberComposerSelection(project.id, agent, model, variant); onCreated(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal composer title={translate("taskComposer.title")} subtitle={project.root} onClose={onClose}>
    <form className="form-stack compact-composer-form" onSubmit={(event) => void submit(event)}>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="form-row compact-launch-row"><Field label={translate("common.name")}><input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder={translate("taskComposer.namePlaceholder")} /></Field><Field label={translate("taskComposer.launchLabel")}><select value={scheduled ? "schedule" : "now"} onChange={(event) => { const next = event.target.value === "schedule"; setScheduled(next); if (next) setAttachments([]); }}><option value="now">{translate("taskComposer.launchNow")}</option><option value="schedule">{translate("schedule.onSchedule")}</option></select></Field></div>
      {scheduled && <><ScheduleBuilder scheduleKind={scheduleKind} setScheduleKind={setScheduleKind} interval={interval} setInterval={setInterval} time={time} setTime={setTime} minute={minute} setMinute={setMinute} timezone={timezone} setTimezone={setTimezone} cron={cron} notice /><Field label={translate("schedule.sessionContext")} hint={translate("taskComposer.newSessionHint")}><select value={cronSessionMode} onChange={(event) => setCronSessionMode(event.target.value as "new" | "reuse")}><option value="new">{translate("schedule.newSessionEachRun")}</option><option value="reuse">{translate("schedule.reuseSession")}</option></select></Field></>}
      <PromptBox prompt={prompt} onPromptChange={setPrompt} attachments={attachments} onAttachmentsChange={setAttachments} onError={setError} agent={agent} onAgentChange={setAgent} model={model} onModelChange={setModel} variant={variant} onVariantChange={setVariant} agents={agents} commands={commands} providers={providers} config={config} placeholder={translate("taskComposer.promptPlaceholder")} submitLabel={scheduled ? translate("taskComposer.createSchedule") : translate("taskComposer.runAgent")} busy={busy} required attachmentsEnabled={!scheduled} mentionsEnabled />
    </form>
  </Modal>;
}

function ScheduleBuilder({ scheduleKind, setScheduleKind, interval, setInterval, time, setTime, minute, setMinute, timezone, setTimezone, cron, notice = false }: { scheduleKind: ScheduleKind; setScheduleKind: (value: ScheduleKind) => void; interval: number; setInterval: (value: number) => void; time: string; setTime: (value: string) => void; minute: number; setMinute: (value: number) => void; timezone: string; setTimezone: (value: string) => void; cron: string; notice?: boolean }) {
  return <div className="schedule-builder">
    <Field label={translate("schedule.frequency")}><select value={scheduleKind} onChange={(event) => { const next = event.target.value as ScheduleKind; setScheduleKind(next); setInterval(next === "minutes" ? 15 : next === "days" ? 2 : 1); }}><option value="minutes">{translate("schedule.everyFewMinutes")}</option><option value="hours">{translate("schedule.everyFewHours")}</option><option value="daily">{translate("schedule.daily")}</option><option value="days">{translate("schedule.everyFewDays")}</option></select></Field>
    {scheduleKind === "minutes" && <Field label={translate("schedule.minuteInterval")} hint={translate("schedule.minuteIntervalHint")}><input type="number" min="1" max="59" value={interval} onChange={(event) => setInterval(Math.min(59, Math.max(1, Number(event.target.value) || 1)))} /></Field>}
    {scheduleKind === "hours" && <div className="form-row"><Field label={translate("schedule.hourInterval")} hint={translate("schedule.hourIntervalHint")}><input type="number" min="1" max="23" value={interval} onChange={(event) => setInterval(Math.min(23, Math.max(1, Number(event.target.value) || 1)))} /></Field><Field label={translate("schedule.minuteOfHour")}><select value={minute} onChange={(event) => setMinute(Number(event.target.value))}><option value="0">{translate("schedule.atMinute00")}</option><option value="15">{translate("schedule.atMinute15")}</option><option value="30">{translate("schedule.atMinute30")}</option><option value="45">{translate("schedule.atMinute45")}</option></select></Field></div>}
    {scheduleKind === "days" && <div className="form-row"><Field label={translate("schedule.dayInterval")} hint={translate("schedule.dayIntervalHint")}><input type="number" min="2" max="31" value={interval} onChange={(event) => setInterval(Math.min(31, Math.max(2, Number(event.target.value) || 2)))} /></Field><Field label={translate("schedule.startTime")}><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></Field></div>}
    {scheduleKind === "daily" && <Field label={translate("schedule.startTime")}><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></Field>}
    <Field label={translate("schedule.timezone")} hint={translate("schedule.timezoneHint")}><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required placeholder="Europe/Moscow" /></Field>
    <div className="schedule-summary"><strong>{describeCron(cron)}</strong><span>{translate("schedule.timezonePrefix")} {timezone}</span><small>{translate("schedule.runtimeNotice")}</small></div>
    {notice && <Banner tone="notice">{translate("taskComposer.scheduledFilesNotice")}</Banner>}
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
  return <Modal composer title={translate("scheduleEditor.title")} subtitle={task.title} onClose={onClose}><form className="form-stack compact-composer-form" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}<Field label={translate("scheduleEditor.promptLabel")}><SchedulePromptEditor value={prompt} onChange={setPrompt} agents={agents} commands={commands} /></Field><Field label={translate("scheduleEditor.mode")}><select value={mode} onChange={(event) => setMode(event.target.value as "manual" | "cron")}><option value="manual">{translate("scheduleEditor.manual")}</option><option value="cron">{translate("schedule.onSchedule")}</option></select></Field>{mode === "cron" && <>{customCron ? <div className="schedule-builder"><Field label={translate("scheduleEditor.cronExpression")} hint={translate("scheduleEditor.customCronHint")}><input className="mono" value={customCron} onChange={(event) => setCustomCron(event.target.value)} required /></Field><Field label={translate("schedule.timezone")}><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></Field><div className="schedule-summary"><strong>{describeCron(customCron)}</strong><span>{timezone}</span></div><button type="button" className="text-button" onClick={() => setCustomCron("")}>{translate("scheduleEditor.openBuilder")}</button></div> : <ScheduleBuilder scheduleKind={scheduleKind} setScheduleKind={setScheduleKind} interval={interval} setInterval={setInterval} time={time} setTime={setTime} minute={minute} setMinute={setMinute} timezone={timezone} setTimezone={setTimezone} cron={cron} />}<Field label={translate("schedule.sessionContext")} hint={translate("scheduleEditor.newSessionHint")}><select value={cronSessionMode} onChange={(event) => setCronSessionMode(event.target.value as "new" | "reuse")}><option value="new">{translate("schedule.newSessionEachRun")}</option><option value="reuse">{translate("schedule.reuseSession")}</option></select></Field></>}{mode === "manual" && <p className="compact-form-note">{translate("scheduleEditor.manualModeNotice")}</p>}<div className="modal-actions compact-modal-actions"><button type="button" className="text-button" onClick={onClose}>{translate("common.cancel")}</button><button className="primary-button" disabled={busy || !prompt.trim()}>{busy ? translate("scheduleEditor.saving") : translate("common.save")}</button></div></form></Modal>;
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
  return <div className="schedule-prompt-editor"><textarea ref={textarea} value={value} onChange={(event) => { onChange(event.target.value); updateMention(event.target.value, event.target.selectionStart); }} onKeyDown={keyDown} required placeholder={translate("scheduleEditor.promptPlaceholder")} />{mentionOptions.length > 0 && <div className="agent-mention-menu" role="listbox" aria-label={translate("prompt.agentOptionsAria")}>{mentionOptions.map((agent, index) => <button type="button" role="option" aria-selected={index === mentionIndex} className={index === mentionIndex ? "selected" : ""} key={agent.name} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(agent)}><Bot size={14} /><span><strong>@{agent.name}</strong><small>{localizedAgentDescription(agent.name, agent.description)}</small></span></button>)}</div>}{commandOptions.length > 0 && <div className="agent-mention-menu command-palette" role="listbox" aria-label={translate("prompt.commandOptionsAria")}>{commandOptions.map((item, index) => <button type="button" role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCommand(item)}>{item.kind === "skill" ? <Sparkles size={14} /> : <SquareTerminal size={14} />}<span><strong>/{item.id}</strong><small>{commandDisplayDescription(item)}</small></span></button>)}</div>}</div>;
}

function TaskStatus({ value }: { value: string }) { return <span className="status" data-status={value}><i />{localizedStatus(value)}</span>; }
