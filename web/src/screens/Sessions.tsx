import { Activity, ArrowDown, ArrowUp, Bot, Check, CircleDollarSign, CircleHelp, CircleStop, Cpu, File, FileCode2, GitBranch, GitCommitHorizontal, Maximize2, MessageSquareText, Minimize2, Minus, Network, Plus, RefreshCw, Search, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, jsonBody } from "../api";
import { intlLocale, localizedStatus, translate, useI18n } from "../i18n";
import { MessageMarkdown } from "../MessageMarkdown";
import { PromptBox } from "../PromptBox";
import { compact, mentionedAgents, modelIdOf, modelOf, readSessionSelection, relativeTime, rememberComposerSelection, rememberedComposerSelection, rememberSessionSelection, selectedDefaultModel, sessionLifetimeTokens, sessionStatus, slashCommand } from "../sessionUtils";
import type { Agent, Attachment, CommandItem, GitState, Project, ProviderSummary, RuntimeConfig, Session, Task } from "../types";
import { Banner, Empty, Field, Modal, Page, Panel, ScopeGuide, Status } from "../ui";
import { message, useResource } from "../useResource";
import { useSnapshotResource } from "../useSnapshotResource";

type SessionSearchTarget = { sessionId: string; messageId: string | null; query: string };

export function Sessions({ project, refreshKey, initialSearchTarget = null, onInitialSessionHandled }: { project: Project; refreshKey: number; initialSearchTarget?: SessionSearchTarget | null; onInitialSessionHandled?: () => void }) {
  const { t } = useI18n();
  const resource = useSnapshotResource(`/api/v1/projects/${project.id}/snapshot`, refreshKey, 3000);
  const commands = useResource<CommandItem[]>(`/api/v1/projects/${project.id}/commands`, refreshKey);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [showChildren, setShowChildren] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [drawerSearchTarget, setDrawerSearchTarget] = useState<SessionSearchTarget | null>(null);
  useEffect(() => {
    if (!initialSearchTarget || !resource.data?.sessions.some((session) => session.id === initialSearchTarget.sessionId)) return;
    setDrawerSearchTarget(initialSearchTarget);
    setSelectedSessionId(initialSearchTarget.sessionId);
    onInitialSessionHandled?.();
  }, [initialSearchTarget, onInitialSessionHandled, resource.data]);

  async function abort(session: Session) {
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}/abort`, { method: "POST", ...jsonBody({}) });
      setNotice({ tone: "success", text: t("sessions.abortRequested", { session: session.title ?? session.id }) });
      resource.reload();
    } catch (reason) {
      setNotice({ tone: "danger", text: message(reason) });
    }
  }
  async function remove(session: Session) {
    const warning = t(session.parentID ? "sessions.deleteChildWarning" : "sessions.deleteMainWarning");
    if (!confirm(t("sessions.deleteConfirm", { session: session.title ?? session.id, warning }))) return;
    try {
      await api(`/api/v1/projects/${project.id}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setNotice({ tone: "success", text: t("sessions.deleted") });
      if (selectedSessionId === session.id) setSelectedSessionId(null);
      resource.reload();
    } catch (reason) { setNotice({ tone: "danger", text: message(reason) }); }
  }

  const allSessions = resource.data?.sessions ?? [];
  const selected = allSessions.find((session) => session.id === selectedSessionId) ?? null;
  const childCount = allSessions.filter((session) => session.parentID).length;
  const sessions = showChildren ? allSessions : allSessions.filter((session) => !session.parentID);
  return (
    <Page title={t("sessions.title")} description={t("sessions.description")} action={<button className="primary-button" onClick={() => setComposer(true)}><Plus size={16} /> {t("sessions.new")}</button>}>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {resource.stale && <Banner tone="notice">{t("sessions.reconnecting")}</Banner>}
      {resource.error && <Banner tone="danger">{resource.error}</Banner>}
      <ScopeGuide><strong>{t("sessions.mainCount", { count: allSessions.length - childCount })}</strong><span>{t("sessions.childCount", { count: childCount })}</span><label className="toggle-field"><input type="checkbox" checked={showChildren} onChange={(event) => setShowChildren(event.target.checked)} /> {t("sessions.showChildren")}</label></ScopeGuide>
      <Panel className="table-panel">
        <div className="data-table session-table">
          <div className="table-head"><span>{t("sessions.columnSession")}</span><span>{t("sessions.columnAgentModel")}</span><span>{t("sessions.columnUsage")}</span><span>{t("sessions.columnStatus")}</span><span /></div>
          {sessions.map((session) => (
            <div className={`table-row ${session.parentID ? "child-session" : ""}`} role="button" tabIndex={0} key={session.id} onClick={() => setSelectedSessionId(session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedSessionId(session.id); }}>
              <span><strong>{session.title ?? t("common.unnamedSession")}</strong><small>{session.control_task ? t("sessions.task", { task: session.control_task.title }) : t(session.parentID ? "sessions.childWithoutTask" : "sessions.standalone")} · {relativeTime(session.time?.updated)}</small></span>
              <span><strong>{session.agent ?? t("common.default")}</strong><small>{modelOf(session)}</small></span>
              <span><strong>{t("sessions.tokens", { count: compact(sessionLifetimeTokens(session)) })}</strong><small>{t("sessions.allTimeCost", { cost: (session.cost ?? 0).toFixed(4) })}</small></span>
              <span><Status value={sessionStatus(resource.data, session)} /></span>
               <span className="row-actions"><button className="icon-button danger" disabled={resource.stale} onClick={(event) => { event.stopPropagation(); void abort(session); }} aria-label={t("sessions.abort")}><CircleStop size={16} /></button><button className="icon-button danger" disabled={resource.stale} onClick={(event) => { event.stopPropagation(); void remove(session); }} aria-label={t("sessions.delete")}><Trash2 size={15} /></button></span>
            </div>
          ))}
        </div>
        {sessions.length === 0 && <Empty icon={<MessageSquareText />} title={t("sessions.empty")} detail={t("sessions.emptyDetail")} />}
      </Panel>
      {composer && <SessionComposer project={project} agents={resource.data?.agents ?? []} commands={commands.data ?? []} providers={resource.data?.providers?.available ?? []} config={resource.data?.config} defaultModel={selectedDefaultModel(resource.data)} onClose={() => setComposer(false)} onCreated={() => { setComposer(false); resource.reload(); }} />}
      {selected && <SessionDrawer project={project} session={selected} status={sessionStatus(resource.data, selected)} taskStatus={selected.control_task?.session_status} agents={resource.data?.agents ?? []} providers={resource.data?.providers?.available ?? []} mcp={resource.data?.mcp ?? {}} config={resource.data?.config} initialModel={modelIdOf(selected) || resource.data?.config?.model || ""} searchTarget={drawerSearchTarget?.sessionId === selected.id ? drawerSearchTarget : null} onDelete={resource.stale ? undefined : () => void remove(selected)} onClose={() => { setSelectedSessionId(null); setDrawerSearchTarget(null); }} />}
    </Page>
  );
}

export function SessionComposer({ project, task, agents, commands, providers, config, defaultModel, onClose, onCreated }: { project: Project; task?: Task; agents: Agent[]; commands: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; defaultModel?: string; onClose: () => void; onCreated: () => void }) {
  const savedSelection = rememberedComposerSelection(project.id, agents);
  const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [agent, setAgent] = useState(() => task?.agent ?? savedSelection.agent); const [model, setModel] = useState(task?.model ?? (savedSelection.model || config?.model || defaultModel || "")); const [variant, setVariant] = useState(task ? task.variant ?? "" : savedSelection.variant); const [attachments, setAttachments] = useState<Attachment[]>([]); const [createdSessionId, setCreatedSessionId] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { const invocation = slashCommand(prompt); if (invocation && !commands.some((item) => item.id === invocation.name)) throw new Error(translate("prompt.commandNotFound", { value0: invocation.name })); if (invocation && attachments.length) throw new Error(translate("sessionComposer.commandWithFiles")); let sessionId = createdSessionId; if (!sessionId) { const endpoint = task ? `/api/v1/projects/${project.id}/tasks/${task.id}/sessions` : `/api/v1/projects/${project.id}/sessions`; const session = await api<Session>(endpoint, { method: "POST", ...jsonBody({ title: title || null }) }); sessionId = session.id; setCreatedSessionId(sessionId); } if (invocation) { await api(`/api/v1/projects/${project.id}/sessions/${sessionId}/commands/${encodeURIComponent(invocation.name)}`, { method: "POST", ...jsonBody({ arguments: invocation.arguments, agent: agent || null, model: model || null, ...(variant ? { variant } : {}) }) }); } else if (prompt.trim() || attachments.length) { const mentions = mentionedAgents(prompt, agents); await api(`/api/v1/projects/${project.id}/sessions/${sessionId}/prompt`, { method: "POST", ...jsonBody({ prompt: prompt.trim(), agent: agent || null, model: model || null, ...(variant ? { variant } : {}), attachments, ...(mentions.length ? { mentions } : {}) }) }); } rememberComposerSelection(project.id, agent, model, variant); onCreated(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal composer title={task ? translate("sessionComposer.taskTitle") : translate("sessionComposer.title")} subtitle={task ? translate("sessionComposer.taskSubtitle", { value0: task.title }) : project.name} onClose={onClose}><form className="form-stack compact-composer-form" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}<Field label={translate("common.name")}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={task ? translate("sessionComposer.taskNamePlaceholder", { value0: task.title }) : translate("sessionComposer.namePlaceholder")} /></Field><PromptBox prompt={prompt} onPromptChange={setPrompt} attachments={attachments} onAttachmentsChange={setAttachments} onError={setError} agent={agent} onAgentChange={setAgent} model={model} onModelChange={setModel} variant={variant} onVariantChange={setVariant} agents={agents} commands={commands} providers={providers} config={config} placeholder={translate("sessionComposer.promptPlaceholder")} submitLabel={task ? translate("sessionComposer.createForTask") : translate("sessionComposer.create")} busy={busy} allowEmpty mentionsEnabled />{createdSessionId && error && <Banner tone="notice">{translate("sessionComposer.alreadyCreatedNotice")}</Banner>}</form></Modal>;
}

type TimeRange = { start?: number; end?: number };
type ToolState = { status: "pending" | "running" | "completed" | "error"; title?: string; command?: string; input?: string; output?: string; error?: string; workdir?: string; exit_code?: number; truncated?: boolean; full_output?: boolean; time?: TimeRange };
type SessionPart = { type?: string; text?: string; mime?: string; filename?: string; tool?: string; state?: ToolState; time?: TimeRange; duration?: number; reason?: string; agent?: string; name?: string; files?: string[]; attempt?: number; error?: string; cost?: number; tokens?: MessageTokens };
type MessageTokens = { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
type SessionMessage = { info?: { id?: string; role?: string; tokens?: MessageTokens; time?: { created?: number; completed?: number }; agent?: string; modelID?: string; providerID?: string; variant?: string; cost?: number; finish?: string; error?: string }; parts?: SessionPart[] };
type SessionTodo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: "high" | "medium" | "low" };
type SessionPermission = { id: string; permission: string; patterns: string[] };

function SessionPartView({ part, index, now, project }: { part: SessionPart; index: number; now: number; project: Project }) {
  if (part.type === "text" && part.text) return <MessageMarkdown content={part.text} projectId={project.id} projectRoot={project.root} />;
  if (part.type === "file") return <div className="message-files"><span><File size={12} /> {part.filename ?? part.mime ?? translate("session.event.file")}</span></div>;
  if (part.type === "reasoning" && part.text) return <details className="reasoning-event"><summary>{part.time?.start !== undefined ? translate("session.event.reasoningDuration", { value0: formatMilliseconds((part.time.end ?? now) - part.time.start) }) : translate("session.event.reasoning")}</summary><MessageMarkdown content={part.text} projectId={project.id} projectRoot={project.root} /></details>;
  if (part.type === "subtask") return <div className="cli-event"><Bot size={13} /><span><strong>{translate("agents.subagent")} {part.agent ?? ""}</strong>{part.text}</span></div>;
  if (part.type === "patch") return <div className="cli-event"><FileCode2 size={13} /><span><strong>{translate("session.event.filesChanged")}</strong>{part.files?.join(", ") || translate("session.event.fileListUnavailable")}</span></div>;
  if (part.type === "agent") return <div className="cli-event"><Bot size={13} /><span>{translate("session.event.agent")} <strong>{part.name ?? translate("session.event.defaultAgent")}</strong></span></div>;
  if (part.type === "retry") return <div className="cli-event retry-event"><RefreshCw size={13} /><span><strong>{translate("session.event.retry")} {part.attempt ?? ""}</strong>{part.error ?? translate("session.event.retryFallback")}</span></div>;
  if (part.type === "compaction") return <div className="step-divider"><span>{translate("session.event.contextCompacted")}</span></div>;
  if (part.type === "snapshot") return <div className="cli-event"><Check size={13} /><span>{translate("session.event.snapshotSaved")}</span></div>;
  if (part.type === "step-start") return <div className="step-divider"><span>{translate("session.event.agentStep")}</span></div>;
  if (part.type === "step-finish") return <div className="step-finish"><Check size={12} /> {part.reason ?? translate("session.event.stepCompleted")}{part.tokens?.output !== undefined ? translate("session.event.outputTokens", { value0: compact(part.tokens.output) }) : ""}{part.cost !== undefined ? ` · $${part.cost.toFixed(4)}` : ""}{part.duration !== undefined ? translate("session.event.totalDuration", { value0: formatDuration(part.duration) }) : ""}</div>;
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
    {isShell && part.state.status === "running" && !part.state.output && <div className="tool-output-waiting">{translate("session.tool.outputPending")}</div>}
    {part.state.truncated && <div className="tool-output-notice">{translate("session.tool.outputTruncated")}</div>}
    {part.state.error && <pre className="tool-error"><code>{part.state.error}</code></pre>}
    <span className="sr-only">tool-{index}</span>
  </details>;
}

function PermissionRequestCard({ permission, onReply }: { permission: SessionPermission; onReply: (reply: "once" | "always" | "reject") => void }) {
  return <section className="permission-request-card"><header><CircleStop size={15} /><span><strong>{translate("session.permission.required")}</strong><small>{permission.permission}</small></span></header>{permission.patterns.length > 0 && <div className="permission-patterns">{permission.patterns.map((pattern) => <code key={pattern}>{pattern}</code>)}</div>}<div className="permission-request-actions"><button className="primary-button" onClick={() => onReply("once")}>{translate("session.permission.allowOnce")}</button><button className="secondary-button" onClick={() => onReply("always")}>{translate("session.permission.allowAlways")}</button><button className="text-button danger-text" onClick={() => onReply("reject")}>{translate("session.permission.reject")}</button></div></section>;
}

function GitDiffViewer({ project, path, revision }: { project: Project; path: string; revision: string }) {
  const diff = useResource<{ path: string; diff: string }>(`/api/v1/projects/${project.id}/git/diff?path=${encodeURIComponent(path)}`, revision);
  if (diff.error) return <Banner tone="danger">{diff.error}</Banner>;
  if (!diff.data) return <div className="git-loading">{translate("session.git.diffLoading")}</div>;
  const lines = (diff.data.diff || translate("session.git.noWorkingTreeChanges")).split("\n");
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
  if (status === "??") return translate("session.git.statusNew");
  if (status.includes("U")) return translate("session.git.statusConflict");
  if (status.includes("R")) return translate("session.git.statusRenamed");
  if (status.includes("D")) return translate("session.git.statusDeleted");
  if (status.includes("A")) return translate("session.git.statusAdded");
  if (status.includes("M")) return translate("session.git.statusChanged");
  return translate("session.git.statusChange");
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
    if (!confirm(translate("session.git.revertConfirm", { value0: commit.short_hash, value1: commit.subject }))) return;
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/git/revert`, { method: "POST", ...jsonBody({ commit: commit.hash }) });
      setError(null); onReload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function resetToCommit(commit: GitState["commits"][number]) {
    if (!confirm(translate("session.git.resetConfirm", { value0: commit.short_hash, value1: commit.subject }))) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const result = await api<{ backup_branch: string }>(`/api/v1/projects/${project.id}/git/reset`, { method: "POST", ...jsonBody({ commit: commit.hash }) });
      setNotice(translate("session.git.resetSuccess", { value0: commit.short_hash, value1: result.backup_branch }));
      onReload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  const revision = state.revision ?? state.changes.map((item) => `${item.status}:${item.path}`).join("|");
  return <aside className={`git-panel${diffFocused ? " diff-focused" : ""}`} style={{ width }}>
    <div className="git-panel-resize" role="separator" aria-label={translate("session.git.resizePanel")} aria-orientation="vertical" tabIndex={0} onPointerDown={startResize} onDoubleClick={() => resize(440)} onKeyDown={(event) => { if (event.key === "ArrowLeft") resize(width - 30); if (event.key === "ArrowRight") resize(width + 30); }} />
    <header><span><GitBranch size={15} /><strong>{state.branch || "detached HEAD"}</strong></span><button className="icon-button" aria-label={translate("session.git.hidePanel")} onClick={onClose}><X size={14} /></button></header>
    <div className="git-index-toolbar"><div className="git-index-summary"><label><input type="checkbox" aria-label={translate("session.git.selectAllChanges")} checked={state.changes.length > 0 && checkedChanges.length === state.changes.length} onChange={(event) => setCheckedPaths(event.target.checked ? state.changes.map((item) => item.path) : [])} /><span><strong>{translate("session.git.staging")}</strong><small>{translate("session.git.stagedCount")} {stagedChanges.length}  {translate("session.git.unstagedCount")} {unstagedChanges.length}  {translate("session.git.selectedCount")} {checkedChanges.length}</small></span></label></div><div className="git-index-actions"><button className="index-add" aria-label={translate("session.git.stageSelected")} title={translate("session.git.stageSelectedHint")} disabled={busy || checkedUnstaged.length === 0} onClick={() => void updateIndex("stage", checkedUnstaged.map((item) => item.path))}><Plus size={13} />  {translate("session.git.selectedShort")}</button><button aria-label={translate("session.git.unstageSelected")} title={translate("session.git.unstageSelectedHint")} disabled={busy || checkedStaged.length === 0} onClick={() => void updateIndex("unstage", checkedStaged.map((item) => item.path))}><Minus size={13} />  {translate("session.git.selectedShort")}</button><button className="index-add" aria-label={translate("session.git.stageAll")} title={translate("session.git.stageAllHint")} disabled={busy || unstagedChanges.length === 0} onClick={() => void updateIndex("stage", unstagedChanges.map((item) => item.path))}><Plus size={13} />  {translate("session.git.allShort")}</button><button aria-label={translate("session.git.clearIndex")} title={translate("session.git.clearIndexHint")} disabled={busy || stagedChanges.length === 0} onClick={() => void updateIndex("unstage", stagedChanges.map((item) => item.path))}><Minus size={13} />  {translate("session.git.allShort")}</button></div></div>
    <details className="git-help"><summary role="button" aria-label={translate("session.git.helpAria")} title={translate("session.git.helpTitle")}><CircleHelp size={16} /></summary><ol><li>{translate("session.git.helpSelectFiles")} <strong>{translate("session.git.stageSelected")}</strong>.</li><li><strong>{translate("session.git.unstageSelected")}</strong>  {translate("session.git.helpUnstage")}</li><li>{translate("session.git.helpCommitMessage")} <strong>{translate("session.git.createCommit")}</strong>.</li><li><strong>{translate("session.git.resetAction")}</strong>  {translate("session.git.resetExplanation")}</li><li><strong>{translate("session.git.revertAction")}</strong>  {translate("session.git.revertExplanation")}</li></ol></details>
    <div className="git-tabs"><button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>{translate("session.git.changesTab")} <span>{state.changes.length}</span></button><button className={tab === "commits" ? "active" : ""} onClick={() => setTab("commits")}>{translate("session.git.commitsTab")}</button></div>
    {tab === "changes" ? <>
      <div className="git-file-list">{state.changes.map((change) => <div className="git-file-row" key={change.path}><input type="checkbox" aria-label={translate("session.git.selectFile", { value0: change.path })} checked={checkedPaths.includes(change.path)} onChange={() => togglePath(change.path)} /><button className={change.path === selectedPath ? "active" : ""} onClick={() => setSelected(change.path)}><span className="git-change-kind" data-status={change.status.trim() || "M"}>{gitChangeLabel(change.status)}</span><span title={change.path}>{change.path}</span></button><span className="git-file-actions">{change.unstaged && <button className="index-add" aria-label={translate("session.git.stageFile", { value0: change.path })} title={translate("session.git.stageFileHint")} disabled={busy} onClick={() => void updateIndex("stage", [change.path])}><Plus size={14} /></button>}{change.staged && <button aria-label={translate("session.git.unstageFile", { value0: change.path })} title={translate("session.git.unstageFileHint")} disabled={busy} onClick={() => void updateIndex("unstage", [change.path])}><Minus size={14} /></button>}</span></div>)}{state.changes.length === 0 && <p>{translate("session.git.cleanWorkingTree")}</p>}</div>
      <section className="git-diff-panel"><header><span><FileCode2 size={15} /><strong>{selectedPath || translate("session.git.fileChanges")}</strong></span><span className="git-diff-tools"><small>{translate("session.git.relativeToHead")}</small><button aria-label={diffFocused ? translate("session.git.restorePanel") : translate("session.git.expandDiff")} title={diffFocused ? translate("session.git.showFilesAndActions") : translate("session.git.codeOnly")} onClick={() => setDiffFocused((current) => !current)}>{diffFocused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></span></header><div className="git-diff-wrap">{selectedPath ? <GitDiffViewer project={project} path={selectedPath} revision={revision} /> : <p>{translate("session.git.selectChangedFile")}</p>}</div></section>
      {state.changes.length > 0 && <form className="git-commit-form" onSubmit={(event) => void commit(event)}>{error && <small>{error}</small>}<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={stagedChanges.length ? translate("session.git.commitMessagePlaceholder", { value0: stagedChanges.length }) : translate("session.git.stageFilesFirst")} maxLength={500} /><button className="primary-button" disabled={busy || stagedChanges.length === 0 || !commitMessage.trim()}><GitCommitHorizontal size={14} /> {busy ? "…" : translate("session.git.createCommit")}</button></form>}
    </> : <div className="git-commit-list">{error && <small className="git-action-error">{error}</small>}{notice && <small className="git-action-notice">{notice}</small>}<div className="git-history-note"><strong>{translate("session.git.resetAction")}</strong><span>{translate("session.git.resetMovesBranch")} <code>reset --hard</code>  {translate("session.git.resetLocalHistoryNote")}</span><strong>{translate("session.git.revertAction")}</strong><span>{translate("session.git.revertPublishedHistoryNote")}</span></div>{selectedCommit && <div className="git-history-selection"><span><small>{translate("session.git.selectedCommit")}</small><strong>{selectedCommit.short_hash} · {selectedCommit.subject}</strong></span><div className="git-commit-actions"><button className="git-reset-action" aria-label={translate("session.git.resetToCommit", { value0: selectedCommit.short_hash })} title={translate("session.git.resetToCommitHint")} disabled={busy} onClick={() => void resetToCommit(selectedCommit)}>{translate("session.git.resetAction")}</button><button aria-label={translate("session.git.revertCommit", { value0: selectedCommit.short_hash })} title={translate("session.git.revertCommitHint")} disabled={busy} onClick={() => void revertCommit(selectedCommit)}>{translate("session.git.revertAction")}</button></div></div>}{state.commits.map((commit) => <article className={commit.hash === selectedCommit?.hash ? "active" : ""} key={commit.hash} role="button" tabIndex={0} onClick={() => setSelectedCommitHash(commit.hash)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedCommitHash(commit.hash); }}><code>{commit.short_hash}</code><span className="git-commit-info"><strong>{commit.subject}</strong><small>{commit.author} · {relativeTime(commit.timestamp)}</small></span></article>)}{state.commits.length === 0 && <p>{translate("session.git.noCommits")}</p>}</div>}
  </aside>;
}

export function SessionDrawer({ project, session, status, taskStatus, agents, providers, mcp, config, initialAgent = "", initialModel, searchTarget = null, onDelete, onClose }: { project: Project; session: Session; status: string; taskStatus?: string; agents: Agent[]; providers: ProviderSummary[]; mcp: Record<string, { status?: string; error?: string }>; config?: RuntimeConfig; initialAgent?: string; initialModel: string; searchTarget?: SessionSearchTarget | null; onDelete?: () => void; onClose: () => void }) {
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
  const positionedSearchTarget = useRef("");
  const [activeSearchMessageId, setActiveSearchMessageId] = useState(searchTarget?.messageId ?? null);
  useEffect(() => () => clearSearchHighlight(), []);
  useEffect(() => { setActiveSearchMessageId(searchTarget?.messageId ?? null); }, [searchTarget?.messageId]);
  const messageCount = messages.data?.length ?? 0;
  const lastMessage = messages.data?.[messageCount - 1];
  const matchingSearchMessageIds = searchTarget?.query ? (messages.data ?? []).flatMap((entry) => entry.info?.id && sessionMessageSearchText(entry).toLocaleLowerCase().includes(searchTarget.query.toLocaleLowerCase()) ? [entry.info.id] : []) : [];
  const activeSearchIndex = activeSearchMessageId ? matchingSearchMessageIds.indexOf(activeSearchMessageId) : -1;
  const contextTokens = latestContextTokens(messages.data ?? []);
  const activeTodos = (todos.data ?? []).filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  const mcpEntries = Object.entries(mcp).filter(([, value]) => value.status === "connected").sort(([left], [right]) => left.localeCompare(right));
  const liveStatus = runtimeStatus(messages.data ?? [], now);
  const displayedStatus = taskStatusOverride ?? taskStatus ?? status;
  const stopped = aborted || displayedStatus === "aborted";
  const failed = displayedStatus === "failed" || displayedStatus === "error" || liveStatus === "failed";
  const observedStatus = failed ? "failed" : activeSessionStatus(displayedStatus) ? displayedStatus : liveStatus ?? displayedStatus;
  const effectiveStatus = stopped ? "aborted" : busy || pendingFrom ? "busy" : observedStatus;
  const responseActive = !stopped && (busy || aborting || pendingFrom !== null || activeSessionStatus(observedStatus));
  const gitVisible = git.data?.available === true && (gitVisibility === "shown" || (gitVisibility === "auto" && git.data.changes.length > 0));
  useEffect(() => { setTaskStatusOverride(null); }, [taskStatus, session.control_task?.session_status]);
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
    const messageId = activeSearchMessageId;
    const stream = streamRef.current;
    if (!messageId || !searchTarget || messages.data === null || !stream) return;
    const targetKey = `${messageId}:${searchTarget.query}`;
    const target = Array.from(stream.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((item) => item.dataset.messageId === messageId);
    if (!target) return;
    if (positionedSearchTarget.current === targetKey) {
      const targetBounds = target.getBoundingClientRect();
      const streamBounds = stream.getBoundingClientRect();
      if (targetBounds.bottom > streamBounds.top && targetBounds.top < streamBounds.bottom) return;
    }
    initialScroll.current = false;
    stickToBottom.current = false;
    const position = () => {
      positionedSearchTarget.current = targetKey;
      const targetBounds = target.getBoundingClientRect();
      const streamBounds = stream.getBoundingClientRect();
      const top = Math.max(
        0,
        stream.scrollTop + targetBounds.top - streamBounds.top - stream.clientHeight / 3,
      );
      if (typeof stream.scrollTo === "function") stream.scrollTo({ top, behavior: "auto" });
      else stream.scrollTop = top;
      setShowScrollToBottom(!scrollAtBottom(stream));
      highlightSearchText(target, searchTarget.query);
    };
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        position();
      });
    });
    const settle = window.setTimeout(position, 300);
    const final = window.setTimeout(position, 800);
    stream.addEventListener("load", position, true);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.clearTimeout(final);
      stream.removeEventListener("load", position, true);
    };
  }, [activeSearchMessageId, messages.data, searchTarget]);
  useLayoutEffect(() => {
    if (messages.data === null) return;
    if (activeSearchMessageId) return;
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
  }, [activeSearchMessageId, messages.data]);
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
        if (attachments.length) throw new Error(translate("session.reply.commandWithFiles"));
        if (!(commands.data ?? []).some((item) => item.id === invocation.name)) throw new Error(translate("prompt.commandNotFound", { value0: invocation.name }));
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
  function moveSearchMatch(direction: -1 | 1) {
    if (matchingSearchMessageIds.length < 2) return;
    const current = activeSearchIndex >= 0 ? activeSearchIndex : 0;
    const nextId = matchingSearchMessageIds[(current + direction + matchingSearchMessageIds.length) % matchingSearchMessageIds.length];
    setActiveSearchMessageId(nextId);
    const parameters = new URLSearchParams(location.search);
    parameters.set("message", nextId);
    history.replaceState({}, "", `/sessions?${parameters}`);
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
    <aside className={`drawer drawer-with-composer resizable-drawer${gitVisible ? " git-visible" : ""}`} style={{ "--drawer-width": `${drawerWidth}px` } as CSSProperties} role="dialog" aria-modal="true" aria-label={translate("session.drawer.ariaLabel", { value0: session.title ?? session.id })} onClick={(event) => event.stopPropagation()}><div className="drawer-resize-handle" role="separator" aria-label={translate("session.drawer.resize")} aria-orientation="vertical" tabIndex={0} onPointerDown={startResize} onDoubleClick={() => resizeDrawer(960)} onKeyDown={(event) => { if (event.key === "ArrowLeft") resizeDrawer(drawerWidth + 40); if (event.key === "ArrowRight") resizeDrawer(drawerWidth - 40); }} />
      <header><div className="drawer-title"><div className="drawer-title-row"><Status value={effectiveStatus} /><h2>{session.control_task?.title ?? session.title ?? translate("session.drawer.untitled")}</h2></div></div><div className="drawer-header-actions">{git.data?.available && !gitVisible && <button className="icon-button" title={translate("session.drawer.showGitPanel")} aria-label={translate("session.drawer.showGitPanel")} onClick={() => setGitVisibility("shown")}><GitBranch size={15} /></button>}{onDelete && <button className="icon-button danger" title={translate("session.drawer.delete")} aria-label={translate("session.drawer.delete")} onClick={onDelete}><Trash2 size={15} /></button>}<button className="icon-button" title={translate("session.drawer.close")} aria-label={translate("session.drawer.close")} onClick={onClose}><X /></button></div></header>
      <div className="drawer-metrics"><span><i><Activity size={16} /></i><span><small>{translate("session.drawer.context")}</small><b>{contextTokens === null ? "—" : new Intl.NumberFormat(intlLocale()).format(contextTokens)}</b></span></span><span><i><CircleDollarSign size={16} /></i><span><small>{translate("session.drawer.cost")}</small><b>${(session.cost ?? 0).toFixed(4)}</b></span></span><span><i><Bot size={16} /></i><span><small>{translate("session.drawer.agent")}</small><b>{agent || translate("common.default")}</b></span></span><span><i><Cpu size={16} /></i><span><small>{translate("session.drawer.model")}</small><b>{model || translate("common.default")}</b></span></span></div>
       <div className={`session-workspace ${gitVisible ? "with-git" : ""}`}>{git.data?.available && gitVisible && <SessionGitPanel project={project} state={git.data} onReload={() => { setGitVisibility("shown"); git.reload(); }} onClose={() => setGitVisibility("hidden")} />}<div className="session-conversation"><div className="session-chat-content"><div className="message-stream-wrap"><div className="message-stream" ref={streamRef} onScroll={(event) => setShowScrollToBottom(!scrollAtBottom(event.currentTarget))}>{messages.error && <Banner tone="danger">{translate("session.drawer.previewError")} {messages.error}</Banner>}{(messages.data ?? []).map((entry, index) => entry.parts?.length ? <article className={`message ${entry.info?.role ?? "assistant"}${entry.info?.id === activeSearchMessageId ? " search-target" : ""}`} data-message-id={entry.info?.id} key={entry.info?.id ?? index}>{entry.info?.id === activeSearchMessageId && <div className="search-match-label"><Search size={13} /> {translate("search.matchInMessage")} <mark>{searchTarget?.query}</mark>{activeSearchIndex >= 0 && <span className="search-match-count">{activeSearchIndex + 1}/{matchingSearchMessageIds.length}</span>}<span className="search-match-actions"><button type="button" disabled={matchingSearchMessageIds.length < 2} onClick={() => moveSearchMatch(-1)} aria-label={translate("search.previousMatch")} title={translate("search.previousMatch")}><ArrowUp size={13} /></button><button type="button" disabled={matchingSearchMessageIds.length < 2} onClick={() => moveSearchMatch(1)} aria-label={translate("search.nextMatch")} title={translate("search.nextMatch")}><ArrowDown size={13} /></button></span></div>}<small className="message-meta"><span>{entry.info?.role === "user" ? translate("session.drawer.you") : entry.info?.agent ?? "OpenCode"}{entry.info?.role !== "user" && (entry.info?.providerID || entry.info?.modelID) ? ` · ${[entry.info.providerID, entry.info.modelID].filter(Boolean).join("/")}` : ""}</span><span className="message-turn-stats">{entry.info?.tokens?.output !== undefined && translate("session.drawer.tokens", { value0: compact(entry.info.tokens.output) })}{entry.info?.cost !== undefined && ` · $${entry.info.cost.toFixed(4)}`}{entry.info?.time?.created !== undefined && <time> · {formatDuration((entry.info.time.completed ?? now) - entry.info.time.created)}</time>}</span></small>{entry.info?.error && <div className="message-error"><CircleStop size={13} /> {entry.info.error}</div>}{entry.parts.map((part, partIndex) => <SessionPartView part={part} index={partIndex} now={now} project={project} key={`${part.type}-${partIndex}`} />)}</article> : null)}{messages.data?.length === 0 && !messages.error && <Empty icon={<MessageSquareText />} title={translate("session.drawer.noMessages")} detail={translate("session.drawer.noMessagesDetail")} />}</div>{showScrollToBottom && <button type="button" className="chat-scroll-bottom" aria-label={translate("session.drawer.latestMessage")} title={translate("session.drawer.latestMessage")} onClick={scrollToBottom}><ArrowDown size={18} /></button>}</div>
        <aside className="session-inspector">
          <section><header><Network size={14} /><strong>{translate("session.inspector.mcpRuntime")}</strong><span>{mcpEntries.length}</span></header><div className="runtime-list-compact">{mcpEntries.map(([name, value]) => <div key={name}><i data-status={value.status} /><span>{name}</span><small>{statusLabel(value.status ?? "unknown")}</small></div>)}{mcpEntries.length === 0 && <p>{translate("session.inspector.noMcpConnected")}</p>}</div></section>
          {activeTodos.length > 0 && <section><header><Check size={14} /><strong>{translate("session.inspector.workPlan")}</strong><span>{activeTodos.length}</span></header><div className="todo-list">{activeTodos.map((todo, index) => <div className={todo.status} key={`${todo.content}-${index}`}><span className="todo-index">{index + 1}</span><span><strong>{todo.content}</strong><small>{todo.status === "in_progress" ? translate("session.inspector.todoInProgress") : translate("session.inspector.todoWaiting")} · {priorityLabel(todo.priority)}</small></span></div>)}</div></section>}
          {(todos.error || permissions.error) && <p className="inspector-error">{translate("session.inspector.runtimeDataError")}</p>}
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
  return <form className="session-reply" onSubmit={(event) => void submit(event)}>{error && <Banner tone="danger">{error}</Banner>}{permissionsError && <Banner tone="danger">{translate("session.reply.permissionsError")} {permissionsError}</Banner>}<PromptBox prompt={prompt} onPromptChange={setPrompt} attachments={attachments} onAttachmentsChange={setAttachments} onError={onError} agent={agent} onAgentChange={onAgentChange} model={model} onModelChange={onModelChange} variant={variant} onVariantChange={onVariantChange} agents={agents} commands={commands} providers={providers} config={config} placeholder={translate("session.reply.placeholder")} submitLabel={translate("session.reply.submit")} busy={busy} active={active} stopping={stopping} onStop={onStop} mentionsEnabled /></form>;
}

function latestContextTokens(messages: SessionMessage[]) { for (let index = messages.length - 1; index >= 0; index -= 1) { const message = messages[index]; const tokens = message.info?.role === "assistant" ? message.info.tokens : undefined; if (!tokens) continue; const total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0); if (total > 0) return total; } return null; }
function sessionMessageSearchText(message: SessionMessage) { return (message.parts ?? []).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"); }

type SearchHighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };

function highlightSearchText(container: HTMLElement, query: string) {
  if (typeof CSS === "undefined") return;
  const registry = (CSS as unknown as { highlights?: SearchHighlightRegistry }).highlights;
  const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightConstructor || !query) return;
  if (!document.getElementById("session-search-highlight-style")) {
    const style = document.createElement("style");
    style.id = "session-search-highlight-style";
    style.textContent = "::highlight(session-search-hit){color:var(--text);background:color-mix(in srgb,var(--accent) 48%,transparent)}";
    document.head.append(style);
  }
  const ranges: Range[] = [];
  const needle = query.toLocaleLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent ?? "";
    const normalized = value.toLocaleLowerCase();
    let offset = normalized.indexOf(needle);
    while (offset >= 0) {
      const range = new Range();
      range.setStart(node, offset);
      range.setEnd(node, offset + query.length);
      ranges.push(range);
      offset = normalized.indexOf(needle, offset + query.length);
    }
    node = walker.nextNode();
  }
  registry.set("session-search-hit", new HighlightConstructor(...ranges));
}

function clearSearchHighlight() {
  if (typeof CSS === "undefined") return;
  (CSS as unknown as { highlights?: SearchHighlightRegistry }).highlights?.delete("session-search-hit");
}
function messageFinished(message: SessionMessage) { return message.info?.time?.completed !== undefined || Boolean(message.info?.error) || Boolean(message.parts?.some((part) => part.type === "step-finish")); }
function runtimeStatus(messages: SessionMessage[], now: number) { for (let index = messages.length - 1; index >= 0; index -= 1) { const entry = messages[index]; if (entry.info?.error) return "failed"; const unfinished = entry.info?.role === "user" || (entry.info?.role === "assistant" && !messageFinished(entry)); if (!unfinished) { if (entry.info?.role === "assistant") return null; continue; } const created = entry.info?.time?.created; return created !== undefined && now > 0 && now - created > 15 * 60 * 1000 ? null : "busy"; } return null; }
function latestUserSelection(messages: SessionMessage[]) { for (let index = messages.length - 1; index >= 0; index -= 1) { const info = messages[index].info; if (info?.role !== "user") continue; return { agent: info.agent, model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined, variant: info.variant }; } return null; }
function activeSessionStatus(value: string | null) { return value !== null && ["busy", "queued", "dispatching", "running", "pending", "retry"].includes(value); }
function scrollAtBottom(element: HTMLElement) { return element.scrollHeight - element.scrollTop - element.clientHeight < 48; }
function formatDuration(milliseconds: number) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); if (seconds < 60) return translate("session.format.seconds", { value0: seconds }); const minutes = Math.floor(seconds / 60); const rest = seconds % 60; if (minutes < 60) return translate("session.format.minutesSeconds", { value0: minutes, value1: String(rest).padStart(2, "0") }); const hours = Math.floor(minutes / 60); return translate("session.format.hoursMinutes", { value0: hours, value1: String(minutes % 60).padStart(2, "0") }); }
function formatMilliseconds(milliseconds: number) { return translate("session.format.milliseconds", { value0: Math.max(0, Math.round(milliseconds)) }); }
function statusLabel(value: string) { return localizedStatus(value); }
function priorityLabel(value: SessionTodo["priority"]) { return value === "high" ? translate("priority.high") : value === "medium" ? translate("priority.medium") : translate("priority.low"); }
