import { Check, Download, File, FileArchive, FileJson, FileText, FolderOpen, Images, MessageSquareText, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, apiBlob, jsonBody } from "../api";
import { ArtifactViewer } from "../ArtifactViewer";
import { useI18n } from "../i18n";
import { relativeTime } from "../sessionUtils";
import { ScopeSwitch } from "../ScopeSwitch";
import type { Artifact, ArtifactsResponse, Project } from "../types";
import { Banner, Empty, Modal, Page } from "../ui";
import { message, useResource } from "../useResource";

type ArtifactFilter = "all" | "images" | "documents" | "data" | "archives";
type ArtifactSort = "newest" | "oldest" | "largest" | "smallest" | "name";

export function Artifacts({ project, onOpenSession }: { project: Project; onOpenSession: (projectId: string, sessionId: string, messageId: string | null, query: string) => void }) {
  const { t } = useI18n();
  const initialParameters = new URLSearchParams(location.search);
  const [scope, setScope] = useState<"project" | "global">(() => initialParameters.get("scope") === "global" ? "global" : "project");
  const [filter, setFilter] = useState<ArtifactFilter>(() => artifactFilter(initialParameters.get("type")));
  const [sort, setSort] = useState<ArtifactSort>(() => artifactSort(initialParameters.get("sort")));
  const [active, setActive] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [trashTargets, setTrashTargets] = useState<Artifact[]>([]);
  const [trashing, setTrashing] = useState(false);
  const parameters = new URLSearchParams({ scope });
  if (scope === "project") parameters.set("project_id", project.id);
  const resource = useResource<ArtifactsResponse>(`/api/v1/artifacts?${parameters}`, project.id);
  const artifacts = resource.data?.artifacts ?? [];
  const visibleArtifacts = artifacts.filter((artifact) => matchesFilter(artifact, filter)).sort((left, right) => compareArtifacts(left, right, sort));
  useEffect(() => { const url = new URLSearchParams({ scope }); if (filter !== "all") url.set("type", filter); if (sort !== "newest") url.set("sort", sort); history.replaceState({}, "", `/artifacts?${url}`); }, [filter, scope, sort]);
  useEffect(() => { setActive(null); setSelecting(false); setSelected(new Set()); }, [filter, scope]);
  useEffect(() => { setActive(null); }, [sort]);

  function toggle(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function cancelSelection() { setSelecting(false); setSelected(new Set()); setDownloadError(null); }
  async function downloadSelected() {
    if (!selected.size || downloading) return;
    setDownloading(true);
    try {
      const blob = await apiBlob("/api/v1/artifacts/archive", { method: "POST", ...jsonBody({ artifact_ids: [...selected] }) });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "opencode-artifacts.zip";
      anchor.click();
      URL.revokeObjectURL(url);
      setDownloadError(null);
    } catch (reason) { setDownloadError(message(reason)); }
    finally { setDownloading(false); }
  }
  async function reveal(artifact: Artifact) {
    try { await api(`/api/v1/artifacts/${artifact.id}/reveal`, { method: "POST" }); setDownloadError(null); }
    catch (reason) { setDownloadError(message(reason)); }
  }
  async function trash() {
    if (!trashTargets.length || trashing) return;
    setTrashing(true);
    try {
      if (trashTargets.length === 1) await api(`/api/v1/artifacts/${trashTargets[0].id}/trash`, { method: "POST" });
      else await api("/api/v1/artifacts/trash", { method: "POST", ...jsonBody({ artifact_ids: trashTargets.map((item) => item.id) }) });
      setTrashTargets([]);
      setSelected(new Set());
      setSelecting(false);
      setActive(null);
      resource.reload();
      setDownloadError(null);
    } catch (reason) { setDownloadError(message(reason)); }
    finally { setTrashing(false); }
  }

  const pageAction = selecting
    ? <div className="artifact-selection-actions"><button className="secondary-button" onClick={cancelSelection}><X size={14} /> {t("common.cancel")}</button><button className="secondary-button" disabled={!selected.size || downloading} onClick={() => void downloadSelected()}><Download size={14} /> {downloading ? t("artifacts.preparingArchive") : t("artifacts.exportSelected", { count: selected.size })}</button><button className="danger-button" disabled={!selected.size} onClick={() => setTrashTargets(visibleArtifacts.filter((item) => selected.has(item.id)))}><Trash2 size={14} /> {t("artifacts.trashSelected", { count: selected.size })}</button></div>
    : <div className="artifact-page-actions"><button className="secondary-button" disabled={!visibleArtifacts.length} onClick={() => setSelecting(true)}><Check size={14} /> {t("artifacts.select")}</button><button className="secondary-button" onClick={resource.reload}><RefreshCw size={14} /> {t("app.refresh")}</button></div>;

  return <Page title={t("artifacts.title")} description={t("artifacts.description")} action={pageAction}>
    <div className="artifacts-toolbar"><ScopeSwitch value={scope} onChange={setScope} label={t("artifacts.scopeLabel")} />{selecting ? <button className="artifact-select-all" onClick={() => setSelected(selected.size === visibleArtifacts.length ? new Set() : new Set(visibleArtifacts.map((item) => item.id)))}>{selected.size === visibleArtifacts.length ? t("artifacts.clearSelection") : t("artifacts.selectAll")}</button> : resource.data && <span>{visibleArtifacts.length === artifacts.length ? t("artifacts.count", { count: artifacts.length }) : t("artifacts.filteredCount", { count: visibleArtifacts.length, total: artifacts.length })}</span>}</div>
    <div className="artifact-filterbar"><div className="artifact-filters" role="group" aria-label={t("artifacts.typeFilter")}>{(["all", "images", "documents", "data", "archives"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`artifacts.filter.${value}`)}</button>)}</div><label><span>{t("artifacts.sortLabel")}</span><select aria-label={t("artifacts.sortLabel")} value={sort} onChange={(event) => setSort(event.target.value as ArtifactSort)}><option value="newest">{t("artifacts.sort.newest")}</option><option value="oldest">{t("artifacts.sort.oldest")}</option><option value="largest">{t("artifacts.sort.largest")}</option><option value="smallest">{t("artifacts.sort.smallest")}</option><option value="name">{t("artifacts.sort.name")}</option></select></label></div>
    {resource.error && <Banner tone="danger">{resource.error}</Banner>}
    {downloadError && <Banner tone="danger">{downloadError}</Banner>}
    {resource.data?.partial && <Banner tone="notice">{t("artifacts.partial", { projects: resource.data.unavailable_projects.map((item) => item.name).join(", ") })}</Banner>}
    {!resource.data && !resource.error && <div className="screen-loading"><RefreshCw className="spin" /><span>{t("artifacts.loading")}</span></div>}
    {resource.data && artifacts.length === 0 && <div className="artifacts-empty"><Empty icon={<Images />} title={t("artifacts.emptyTitle")} detail={t("artifacts.emptyDetail")} /></div>}
    {resource.data && artifacts.length > 0 && visibleArtifacts.length === 0 && <div className="artifacts-empty"><Empty icon={<Images />} title={t("artifacts.filteredEmptyTitle")} detail={t("artifacts.filteredEmptyDetail")} /></div>}
    {visibleArtifacts.length > 0 && <div className={`artifacts-grid ${selecting ? "selecting" : ""}`}>{visibleArtifacts.map((artifact, index) => <ArtifactCard key={artifact.id} artifact={artifact} global={scope === "global"} selecting={selecting} selected={selected.has(artifact.id)} onToggle={() => toggle(artifact.id)} onPreview={() => setActive(index)} onReveal={() => void reveal(artifact)} onTrash={() => setTrashTargets([artifact])} onOpenMessage={artifact.session_id && artifact.message_id ? () => onOpenSession(artifact.project_id, artifact.session_id!, artifact.message_id!, "") : null} />)}</div>}
    {resource.data?.has_more && <p className="artifacts-limit">{t("artifacts.limit")}</p>}
    {active !== null && <ArtifactViewer artifacts={visibleArtifacts} active={active} onChange={setActive} onClose={() => setActive(null)} onReveal={(artifact) => void reveal(artifact)} onTrash={(artifact) => setTrashTargets([artifact])} />}
    {trashTargets.length > 0 && <Modal title={trashTargets.length === 1 ? t("artifacts.trashTitle", { name: trashTargets[0].name }) : t("artifacts.trashManyTitle", { count: trashTargets.length })} subtitle={t("artifacts.trashDetail")} onClose={() => { if (!trashing) setTrashTargets([]); }}><div className="artifact-trash-summary"><strong>{formatBytes(trashTargets.reduce((sum, item) => sum + item.size, 0))}</strong><span>{Array.from(new Set(trashTargets.map((item) => item.project_name))).join(", ")}</span></div><div className="modal-actions"><button className="secondary-button" disabled={trashing} onClick={() => setTrashTargets([])}>{t("common.cancel")}</button><button className="danger-button" disabled={trashing} onClick={() => void trash()}><Trash2 size={14} /> {trashing ? t("artifacts.trashing") : t("artifacts.moveToTrash")}</button></div></Modal>}
  </Page>;
}

function ArtifactCard({ artifact, global, selecting, selected, onToggle, onPreview, onReveal, onTrash, onOpenMessage }: { artifact: Artifact; global: boolean; selecting: boolean; selected: boolean; onToggle: () => void; onPreview: () => void; onReveal: () => void; onTrash: () => void; onOpenMessage: (() => void) | null }) {
  const { t } = useI18n();
  const preview = artifact.kind === "image" && artifact.media_url
    ? <img src={artifact.media_url} alt={artifact.name} loading="lazy" />
    : <span className={`artifact-file-icon ${artifact.kind}`}>{artifactIcon(artifact.kind)}<b>{artifact.name.split(".").at(-1)?.toUpperCase()}</b></span>;
  return <article className={`artifact-card ${artifact.kind} ${selected ? "selected" : ""}`}>
    <button className="artifact-preview" onClick={selecting ? onToggle : onPreview} aria-label={selecting ? t("artifacts.toggleCard", { name: artifact.name }) : t("artifacts.open", { name: artifact.name })}>{preview}</button>
    {selecting && <button className="artifact-check" onClick={onToggle} aria-label={selected ? t("artifacts.deselect", { name: artifact.name }) : t("artifacts.selectOne", { name: artifact.name })} aria-pressed={selected}>{selected && <Check size={15} />}</button>}
    {!selecting && <span className="artifact-card-actions"><button className="reveal" onClick={onReveal} aria-label={t("artifacts.reveal", { name: artifact.name })} title={t("artifacts.revealShort")}><FolderOpen size={15} /></button><button className="danger" onClick={onTrash} aria-label={t("artifacts.trash", { name: artifact.name })} title={t("artifacts.trashShort")}><Trash2 size={15} /></button></span>}
    <div className="artifact-info"><strong title={artifact.name}>{artifact.name}</strong>{global && <span>{artifact.project_name}</span>}<small>{formatBytes(artifact.size)} · {artifact.mime}{artifact.created_at ? ` · ${relativeTime(artifact.created_at)}` : ""}</small>{onOpenMessage ? <button onClick={selecting ? onToggle : onOpenMessage}><MessageSquareText size={12} /> {artifact.session_title || t("common.unnamedSession")}</button> : <em>{t("artifacts.projectFile")}</em>}</div>
  </article>;
}

function artifactIcon(kind: Artifact["kind"]) { if (kind === "archive") return <FileArchive />; if (kind === "data") return <FileJson />; if (kind === "text" || kind === "pdf") return <FileText />; return <File />; }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function artifactFilter(value: string | null): ArtifactFilter { return ["images", "documents", "data", "archives"].includes(value ?? "") ? value as ArtifactFilter : "all"; }
function artifactSort(value: string | null): ArtifactSort { return ["oldest", "largest", "smallest", "name"].includes(value ?? "") ? value as ArtifactSort : "newest"; }
function matchesFilter(artifact: Artifact, filter: ArtifactFilter) { if (filter === "all") return true; if (filter === "images") return artifact.kind === "image"; if (filter === "documents") return artifact.kind === "pdf" || artifact.kind === "text"; if (filter === "data") return artifact.kind === "data"; return artifact.kind === "archive"; }
function compareArtifacts(left: Artifact, right: Artifact, sort: ArtifactSort) { if (sort === "name") return left.name.localeCompare(right.name); if (sort === "largest") return right.size - left.size; if (sort === "smallest") return left.size - right.size; const leftTime = left.created_at ?? left.modified_at; const rightTime = right.created_at ?? right.modified_at; return sort === "oldest" ? leftTime - rightTime : rightTime - leftTime; }
