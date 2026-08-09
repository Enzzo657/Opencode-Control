import { FolderOpen, Trash2 } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, jsonBody } from "./api";
import { ImageLightbox, type LightboxImage } from "./ImageLightbox";
import { useI18n } from "./i18n";
import { Modal } from "./ui";
import { message } from "./useResource";

export default function MarkdownRenderer({ content, projectId, projectRoot }: { content: string; projectId?: string; projectRoot?: string }) {
  const { t } = useI18n();
  const renderedContent = projectId ? stripLocalImagePathNotes(content) : content;
  return <div className="message-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href, ...props }) => {
      const image = localImage(href, projectId, projectRoot);
      return image ? <LocalImageCard image={image} label={children} /> : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    img: ({ alt, src }) => {
      const image = localImage(src, projectId, projectRoot);
      return image ? <LocalImageCard image={image} label={alt || image.name} /> : <span className="blocked-image">{t("markdown.image", { alt: alt || t("markdown.noAlt") })}</span>;
    },
  }}>{renderedContent}</ReactMarkdown></div>;
}

type LocalImage = LightboxImage;

function LocalImageCard({ image, label }: { image: LocalImage; label: ReactNode }) {
  const { t } = useI18n();
  const [gallery, setGallery] = useState<LocalImage[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [trashTarget, setTrashTarget] = useState<LocalImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    const trashed = (event: Event) => { if ((event as CustomEvent<string>).detail === image.source) setRemoved(true); };
    window.addEventListener("local-artifact-trashed", trashed);
    return () => window.removeEventListener("local-artifact-trashed", trashed);
  }, [image.source]);

  function open(event: MouseEvent<HTMLButtonElement>) {
    const scope = event.currentTarget.closest(".message") ?? event.currentTarget.closest(".message-markdown");
    const images = Array.from(scope?.querySelectorAll<HTMLElement>(".local-image-card") ?? []).map((card) => ({ name: card.dataset.name ?? "image", source: card.dataset.source ?? "", projectId: card.dataset.project, path: card.dataset.path })).filter((item) => item.source);
    setGallery(images);
    setActive(Math.max(0, images.findIndex((item) => item.source === image.source)));
  }
  async function reveal(target: LocalImage) {
    if (!target.projectId || !target.path) return;
    try { await api(`/api/v1/projects/${target.projectId}/artifact/reveal`, { method: "POST", ...jsonBody({ path: target.path }) }); setError(null); }
    catch (reason) { setError(message(reason)); }
  }
  async function trash() {
    if (!trashTarget?.projectId || !trashTarget.path || busy) return;
    setBusy(true);
    try {
      await api(`/api/v1/projects/${trashTarget.projectId}/artifact/trash`, { method: "POST", ...jsonBody({ path: trashTarget.path }) });
      window.dispatchEvent(new CustomEvent("local-artifact-trashed", { detail: trashTarget.source }));
      setTrashTarget(null);
      setActive(null);
      setError(null);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  if (removed) return <span className="local-image-removed"><span>{t("artifacts.fileTrashed")}</span><strong>{image.name}</strong></span>;
  return <><span className="local-image-card" data-name={image.name} data-source={image.source} data-project={image.projectId} data-path={image.path}>
    <button type="button" className="local-image-preview" onClick={open} aria-label={t("markdown.enlargeImage", { name: image.name })}><img src={image.source} alt={typeof label === "string" ? label : image.name} loading="lazy" /></button>
    <span className="local-image-actions"><button className="reveal" onClick={() => void reveal(image)} aria-label={t("artifacts.reveal", { name: image.name })} title={t("artifacts.revealShort")}><FolderOpen size={16} /></button><button className="danger" onClick={() => setTrashTarget(image)} aria-label={t("artifacts.trash", { name: image.name })} title={t("artifacts.trashShort")}><Trash2 size={16} /></button></span>
  </span>{error && <span className="local-image-error">{error}</span>}{active !== null && <ImageLightbox images={gallery} active={active} onChange={setActive} onClose={() => setActive(null)} onReveal={(target) => void reveal(target)} onTrash={(target) => { setActive(null); setTrashTarget(target); }} />}{trashTarget && createPortal(<Modal title={t("artifacts.trashTitle", { name: trashTarget.name })} subtitle={t("artifacts.trashDetail")} onClose={() => { if (!busy) setTrashTarget(null); }}><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setTrashTarget(null)}>{t("common.cancel")}</button><button className="danger-button" disabled={busy} onClick={() => void trash()}><Trash2 size={14} /> {busy ? t("artifacts.trashing") : t("artifacts.moveToTrash")}</button></div></Modal>, document.body)}</>;
}

function localImage(href: string | undefined, projectId?: string, projectRoot?: string): LocalImage | null {
  if (!href || !projectId || !projectRoot || href.startsWith("#")) return null;
  let path = href;
  if (href.startsWith("file://")) {
    try { path = decodeURIComponent(new URL(href).pathname); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  try { path = decodeURIComponent(path.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!/\.(?:png|jpe?g|gif|webp|avif|ico)$/i.test(path)) return null;
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/media?path=${encodeURIComponent(path)}`;
  return { name: path.split("/").at(-1) || "image", source: base, projectId, path };
}

function stripLocalImagePathNotes(content: string) {
  return content.replace(
    /(?:^|\n)\s*(?:Файл находится здесь|Файл сохранён здесь|File (?:is )?(?:located|saved) (?:here|at))\s*:\s*`[^`\n]+\.(?:png|jpe?g|gif|webp|avif|ico)`\s*\.?\s*(?=\n|$)/gim,
    "\n",
  );
}
