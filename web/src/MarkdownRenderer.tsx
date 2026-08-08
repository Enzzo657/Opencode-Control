import { Download, ExternalLink, Image as ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n";

export default function MarkdownRenderer({ content, projectId, projectRoot }: { content: string; projectId?: string; projectRoot?: string }) {
  const { t } = useI18n();
  return <div className="message-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href, ...props }) => {
      const image = localImage(href, projectId, projectRoot);
      return image ? <LocalImageCard image={image} label={children} /> : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    img: ({ alt, src }) => {
      const image = localImage(src, projectId, projectRoot);
      return image ? <LocalImageCard image={image} label={alt || image.name} /> : <span className="blocked-image">{t("markdown.image", { alt: alt || t("markdown.noAlt") })}</span>;
    },
  }}>{content}</ReactMarkdown></div>;
}

type LocalImage = { name: string; path: string; source: string; download: string };

function LocalImageCard({ image, label }: { image: LocalImage; label: ReactNode }) {
  const { t } = useI18n();
  return <span className="local-image-card">
    <a className="local-image-preview" href={image.source} target="_blank" rel="noreferrer"><img src={image.source} alt={typeof label === "string" ? label : image.name} loading="lazy" /></a>
    <span className="local-image-info"><span className="local-image-title"><ImageIcon size={15} /><strong>{label}</strong></span><code title={image.path}>{image.path}</code><span className="local-image-actions"><a href={image.source} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {t("markdown.openImage")}</a><a href={image.download} download><Download size={13} /> {t("markdown.downloadImage")}</a></span></span>
  </span>;
}

function localImage(href: string | undefined, projectId?: string, projectRoot?: string): LocalImage | null {
  if (!href || !projectId || !projectRoot || href.startsWith("#")) return null;
  let path = href;
  if (href.startsWith("file://")) {
    try { path = decodeURIComponent(new URL(href).pathname); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  try { path = decodeURIComponent(path.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!/\.(?:png|jpe?g|gif|webp|avif|ico)$/i.test(path)) return null;
  const displayPath = path.startsWith("/") ? path : `${projectRoot.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/media?path=${encodeURIComponent(path)}`;
  return { name: path.split("/").at(-1) || "image", path: displayPath, source: base, download: `${base}&download=true` };
}
