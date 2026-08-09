import { ChevronLeft, ChevronRight, FolderOpen, Search, Trash2, WrapText, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { MessageMarkdown } from "./MessageMarkdown";
import type { Artifact } from "./types";
import { message } from "./useResource";

type TextPreview = { kind: string; format: "text" | "json" | "markdown"; name: string; mime: string; size: number; content: string; truncated: boolean };
type CsvPreview = { kind: string; format: "csv"; name: string; mime: string; size: number; columns: string[]; rows: string[][]; truncated: boolean };
type ArchivePreview = { kind: "archive"; name: string; mime: string; size: number; entries: Array<{ name: string; size: number; compressed_size: number; directory: boolean; unsafe: boolean }>; entry_count: number; total_size: number; truncated: boolean; suspicious: boolean };
type Preview = TextPreview | CsvPreview | ArchivePreview;

export function ArtifactViewer({ artifacts, active, onChange, onClose, onReveal, onTrash }: { artifacts: Artifact[]; active: number; onChange: (index: number) => void; onClose: () => void; onReveal: (artifact: Artifact) => void; onTrash: (artifact: Artifact) => void }) {
  const { t } = useI18n();
  const artifact = artifacts[active];
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const touchStart = useRef<number | null>(null);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onChange((active - 1 + artifacts.length) % artifacts.length);
      if (event.key === "ArrowRight") onChange((active + 1) % artifacts.length);
    };
    document.body.classList.add("lightbox-open");
    window.addEventListener("keydown", keydown);
    return () => { document.body.classList.remove("lightbox-open"); window.removeEventListener("keydown", keydown); };
  }, [active, artifacts.length, onChange, onClose]);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setQuery("");
    setMarkdownMode("preview");
    if (!artifact || artifact.kind === "image" || artifact.kind === "pdf") return;
    const controller = new AbortController();
    setLoading(true);
    void api<Preview>(`/api/v1/artifacts/${artifact.id}/preview`, { signal: controller.signal })
      .then(setPreview)
      .catch((reason) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [artifact]);

  if (!artifact) return null;
  const previewUrl = `/api/v1/artifacts/${artifact.id}/preview`;
  function move(direction: -1 | 1) { onChange((active + direction + artifacts.length) % artifacts.length); }
  function finishSwipe(end: number) { if (touchStart.current === null) return; const distance = end - touchStart.current; touchStart.current = null; if (Math.abs(distance) > 55) move(distance > 0 ? -1 : 1); }

  return <div className="artifact-viewer" role="dialog" aria-modal="true" aria-label={t("artifacts.viewer")} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={(event) => finishSwipe(event.changedTouches[0]?.clientX ?? 0)}>
    <header><span><strong>{artifact.name}</strong><small>{active + 1} / {artifacts.length} · {artifact.mime}</small></span><button className="reveal" onClick={() => onReveal(artifact)} aria-label={t("artifacts.reveal", { name: artifact.name })} title={t("artifacts.revealShort")}><FolderOpen size={17} /></button><button className="danger" onClick={() => onTrash(artifact)} aria-label={t("artifacts.trash", { name: artifact.name })} title={t("artifacts.trashShort")}><Trash2 size={17} /></button><button onClick={onClose} aria-label={t("common.close")}><X size={19} /></button></header>
    {artifacts.length > 1 && <button className="artifact-viewer-nav previous" onClick={() => move(-1)} aria-label={t("artifacts.previous")}><ChevronLeft /></button>}
    <main>{artifact.kind === "image" && artifact.media_url && <img className="artifact-viewer-image" src={artifact.media_url} alt={artifact.name} />}{artifact.kind === "pdf" && <iframe className="artifact-pdf" src={previewUrl} title={artifact.name} />}{loading && <div className="artifact-viewer-state">{t("artifacts.loadingPreview")}</div>}{error && <div className="artifact-viewer-state error">{error}</div>}{preview && <PreviewContent preview={preview} query={query} wrap={wrap} markdownMode={markdownMode} onQuery={setQuery} onWrap={() => setWrap((value) => !value)} onMarkdownMode={setMarkdownMode} />}</main>
    {artifacts.length > 1 && <button className="artifact-viewer-nav next" onClick={() => move(1)} aria-label={t("artifacts.next")}><ChevronRight /></button>}
  </div>;
}

function PreviewContent({ preview, query, wrap, markdownMode, onQuery, onWrap, onMarkdownMode }: { preview: Preview; query: string; wrap: boolean; markdownMode: "preview" | "source"; onQuery: (value: string) => void; onWrap: () => void; onMarkdownMode: (value: "preview" | "source") => void }) {
  const { t } = useI18n();
  if ("entries" in preview) return <div className="artifact-archive-preview"><div className="artifact-preview-summary"><strong>{t("artifacts.archiveEntries", { count: preview.entry_count })}</strong><span>{formatBytes(preview.total_size)}</span></div>{preview.suspicious && <p className="artifact-preview-warning">{t("artifacts.suspiciousArchive")}</p>}<div className="artifact-archive-list">{preview.entries.map((entry, index) => <div className={entry.unsafe ? "unsafe" : ""} key={`${entry.name}:${index}`}><span>{entry.directory ? "DIR" : "FILE"}</span><strong>{entry.name}</strong><small>{entry.directory ? "" : `${formatBytes(entry.size)} · ${formatBytes(entry.compressed_size)}`}</small></div>)}</div>{preview.truncated && <p className="artifact-preview-warning">{t("artifacts.previewTruncated")}</p>}</div>;
  if ("rows" in preview) return <div className="artifact-csv-preview"><div className="artifact-table-wrap"><table><thead><tr>{preview.columns.map((column, index) => <th key={`${column}:${index}`}>{column || `#${index + 1}`}</th>)}</tr></thead><tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{preview.columns.map((_, index) => <td key={index}>{row[index] ?? ""}</td>)}</tr>)}</tbody></table></div>{preview.truncated && <p className="artifact-preview-warning">{t("artifacts.previewTruncated")}</p>}</div>;
  const markdown = preview.format === "markdown";
  return <div className="artifact-text-preview"><div className="artifact-preview-tools"><label><Search size={13} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={t("artifacts.searchInFile")} /></label>{markdown && <div className="artifact-preview-tabs"><button className={markdownMode === "preview" ? "active" : ""} onClick={() => onMarkdownMode("preview")}>{t("artifacts.previewTab")}</button><button className={markdownMode === "source" ? "active" : ""} onClick={() => onMarkdownMode("source")}>{t("artifacts.sourceTab")}</button></div>}<button className={wrap ? "active" : ""} onClick={onWrap} aria-label={t("artifacts.toggleWrap")} title={t("artifacts.toggleWrap")}><WrapText size={14} /></button></div>{markdown && markdownMode === "preview" ? <div className="artifact-markdown-preview"><MessageMarkdown content={preview.content} /></div> : <pre className={wrap ? "wrap" : ""}>{highlight(preview.content, query)}</pre>}{preview.truncated && <p className="artifact-preview-warning">{t("artifacts.previewTruncated")}</p>}</div>;
}

function highlight(value: string, query: string) { if (!query) return value; const normalized = value.toLocaleLowerCase(); const needle = query.toLocaleLowerCase(); const output: Array<string | ReactNode> = []; let start = 0; let index = normalized.indexOf(needle); while (index >= 0) { output.push(value.slice(start, index), <mark key={index}>{value.slice(index, index + query.length)}</mark>); start = index + query.length; index = normalized.indexOf(needle, start); } output.push(value.slice(start)); return output; }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
