import { X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { localizedStatus, translate } from "./i18n";

export function Page({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return <>
    <div className="page-heading"><div><p className="eyebrow">OpenCode Control</p><h1>{title}</h1><p>{description}</p></div>{action}</div>
    {children}
  </>;
}

export function Panel({ title, icon, action, className = "", children }: { title?: string; icon?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel ${className}`}>{title && <header className="panel-heading"><h2>{icon}{title}</h2>{action}</header>}{children}</section>;
}

export function ScopeGuide({ children }: { children: ReactNode }) {
  return <div className="scope-guide">{children}</div>;
}

export function Banner({ tone, children }: { tone: "danger" | "success" | "notice"; children: ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="empty"><span>{icon}</span><h3>{title}</h3><p>{detail}</p></div>;
}

export function Status({ value }: { value: string }) {
  return <span className="status" data-status={value}><i />{localizedStatus(value)}</span>;
}

export function Modal({ title, subtitle, wide = false, composer = false, onClose, children }: { title: string; subtitle?: string; wide?: boolean; composer?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  const closeDialog = useEffectEvent(onClose);

  useEffect(() => {
    dialog.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} tabIndex={-1} className={`modal ${wide ? "wide" : ""} ${composer ? "composer-modal" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label={translate("modal.close")} title={translate("modal.close")} onClick={onClose}><X /></button></header><div className="modal-body">{children}</div></section></div>;
}
