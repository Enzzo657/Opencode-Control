import { ChevronLeft, ChevronRight, FolderOpen, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";

export type LightboxImage = { name: string; source: string; projectId?: string; path?: string };

export function ImageLightbox({ images, active, onChange, onClose, onReveal, onTrash }: { images: LightboxImage[]; active: number; onChange: (index: number) => void; onClose: () => void; onReveal: (image: LightboxImage) => void; onTrash: (image: LightboxImage) => void }) {
  const { t } = useI18n();
  const current = images[active];
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onChange((active - 1 + images.length) % images.length);
      if (event.key === "ArrowRight") onChange((active + 1) % images.length);
    };
    document.body.classList.add("lightbox-open");
    window.addEventListener("keydown", keydown);
    return () => { document.body.classList.remove("lightbox-open"); window.removeEventListener("keydown", keydown); };
  }, [active, images.length, onChange, onClose]);
  if (!current) return null;
  return createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label={t("markdown.imageViewer")} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-lightbox-bar"><span>{images.length > 1 ? `${active + 1} / ${images.length}` : current.name}</span><button type="button" className="reveal" onClick={() => onReveal(current)} aria-label={t("artifacts.reveal", { name: current.name })} title={t("artifacts.revealShort")}><FolderOpen size={17} /></button><button type="button" className="danger" onClick={() => onTrash(current)} aria-label={t("artifacts.trash", { name: current.name })} title={t("artifacts.trashShort")}><Trash2 size={17} /></button><button type="button" onClick={onClose} aria-label={t("common.close")}><X size={19} /></button></div>
    {images.length > 1 && <button type="button" className="image-lightbox-nav previous" onClick={() => onChange((active - 1 + images.length) % images.length)} aria-label={t("markdown.previousImage")}><ChevronLeft size={28} /></button>}
    <img src={current.source} alt={current.name} />
    {images.length > 1 && <button type="button" className="image-lightbox-nav next" onClick={() => onChange((active + 1) % images.length)} aria-label={t("markdown.nextImage")}><ChevronRight size={28} /></button>}
  </div>, document.body);
}
