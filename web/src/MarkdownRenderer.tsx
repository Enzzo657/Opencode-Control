import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n";

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

type LocalImage = { name: string; source: string; download: string };

function LocalImageCard({ image, label }: { image: LocalImage; label: ReactNode }) {
  const { t } = useI18n();
  const [gallery, setGallery] = useState<LocalImage[]>([]);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (active === null) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
      if (event.key === "ArrowLeft") setActive((value) => value === null ? null : (value - 1 + gallery.length) % gallery.length);
      if (event.key === "ArrowRight") setActive((value) => value === null ? null : (value + 1) % gallery.length);
    };
    document.body.classList.add("lightbox-open");
    window.addEventListener("keydown", keydown);
    return () => { document.body.classList.remove("lightbox-open"); window.removeEventListener("keydown", keydown); };
  }, [active, gallery.length]);

  function open(event: MouseEvent<HTMLButtonElement>) {
    const scope = event.currentTarget.closest(".message") ?? event.currentTarget.closest(".message-markdown");
    const images = Array.from(scope?.querySelectorAll<HTMLElement>(".local-image-card") ?? []).map((card) => ({ name: card.dataset.name ?? "image", source: card.dataset.source ?? "", download: card.dataset.download ?? "" })).filter((item) => item.source);
    setGallery(images);
    setActive(Math.max(0, images.findIndex((item) => item.source === image.source)));
  }

  const current = active === null ? null : gallery[active];
  return <><span className="local-image-card" data-name={image.name} data-source={image.source} data-download={image.download}>
    <button type="button" className="local-image-preview" onClick={open} aria-label={t("markdown.enlargeImage", { name: image.name })}><img src={image.source} alt={typeof label === "string" ? label : image.name} loading="lazy" /></button>
    <a className="local-image-download" href={image.download} download aria-label={t("markdown.downloadNamedImage", { name: image.name })} title={t("markdown.downloadImage")}><Download size={16} /></a>
  </span>{current && createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label={t("markdown.imageViewer")} onMouseDown={(event) => { if (event.target === event.currentTarget) setActive(null); }}>
    <div className="image-lightbox-bar"><span>{gallery.length > 1 ? `${active! + 1} / ${gallery.length}` : current.name}</span><a href={current.download} download aria-label={t("markdown.downloadNamedImage", { name: current.name })} title={t("markdown.downloadImage")}><Download size={17} /></a><button type="button" onClick={() => setActive(null)} aria-label={t("common.close")}><X size={19} /></button></div>
    {gallery.length > 1 && <button type="button" className="image-lightbox-nav previous" onClick={() => setActive((active! - 1 + gallery.length) % gallery.length)} aria-label={t("markdown.previousImage")}><ChevronLeft size={28} /></button>}
    <img src={current.source} alt={current.name} />
    {gallery.length > 1 && <button type="button" className="image-lightbox-nav next" onClick={() => setActive((active! + 1) % gallery.length)} aria-label={t("markdown.nextImage")}><ChevronRight size={28} /></button>}
  </div>, document.body)}</>;
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
  return { name: path.split("/").at(-1) || "image", source: base, download: `${base}&download=true` };
}

function stripLocalImagePathNotes(content: string) {
  return content.replace(
    /(?:^|\n)\s*(?:Файл находится здесь|Файл сохранён здесь|File (?:is )?(?:located|saved) (?:here|at))\s*:\s*`[^`\n]+\.(?:png|jpe?g|gif|webp|avif|ico)`\s*\.?\s*(?=\n|$)/gim,
    "\n",
  );
}
