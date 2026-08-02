import { Bot, BrainCircuit, ChevronDown, Cpu, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { translate } from "./i18n";
import type { Agent, ProviderSummary } from "./types";
import { localizedAgentDescription, modeLabel } from "./workspace";

function PickerMenuPortal({ anchor, className = "", preferredWidth = 420, children }: { anchor: RefObject<HTMLDivElement | null>; className?: string; preferredWidth?: number; children: ReactNode }) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    function position() {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(preferredWidth, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      if (rect.top > Math.min(360, window.innerHeight * .52)) setStyle({ position: "fixed", left, top: "auto", bottom: window.innerHeight - rect.top + 7, width, maxHeight: Math.max(160, rect.top - 20), visibility: "visible" });
      else setStyle({ position: "fixed", left, top: rect.bottom + 7, bottom: "auto", width, maxHeight: Math.max(160, window.innerHeight - rect.bottom - 20), visibility: "visible" });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [anchor, preferredWidth]);
  return createPortal(<div className={`picker-menu picker-portal ${className}`} role="listbox" style={style} onPointerDown={(event) => event.stopPropagation()}>{children}</div>, document.body);
}

export function AgentPicker({ agents, value, onChange, compact = false, includeSubagents = false }: { agents: Agent[]; value: string; onChange: (value: string) => void; compact?: boolean; includeSubagents?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useOutsideClose(open, () => setOpen(false));
  const visible = agents.filter((agent) => !agent.hidden && (includeSubagents || agent.mode !== "subagent"));
  const selected = visible.find((agent) => agent.name === value);
  return <div className={`field picker-field ${compact ? "compact-picker" : ""}`} ref={root}>{!compact && <span>{translate("session.drawer.agent")}</span>}<button type="button" className="picker-trigger" aria-label={translate("agents.namedTitle", { value0: selected?.name ?? translate("common.default") })} aria-expanded={open} onClick={() => setOpen((current) => !current)}>{compact && <Bot size={15} />}<span><strong>{selected?.name ?? translate("commandEditor.defaultOption")}</strong>{!compact && <small>{selected ? modeLabel(selected.mode) : translate("picker.agent.defaultDescription")}</small>}</span><ChevronDown size={15} /></button>{open && <PickerMenuPortal anchor={root}><button type="button" className={!value ? "selected" : ""} onClick={() => { onChange(""); setOpen(false); }}><span><strong>{translate("picker.agent.useDefault")}</strong><small>{translate("picker.agent.defaultHint")}</small></span></button>{visible.map((agent) => <button type="button" role="option" aria-selected={value === agent.name} className={value === agent.name ? "selected" : ""} key={agent.name} onClick={() => { onChange(agent.name); setOpen(false); }}><span><strong>{agent.name}</strong><small>{modeLabel(agent.mode)} · {localizedAgentDescription(agent.name, agent.description)}</small></span></button>)}</PickerMenuPortal>}{!compact && <small>{includeSubagents ? translate("picker.agent.subagentHint") : translate("picker.agent.primaryHint")}</small>}</div>;
}

export function ModelPicker({ providers, configuredProviders, value, onChange, compact = false }: { providers: ProviderSummary[]; configuredProviders: string[]; value: string; onChange: (value: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useOutsideClose(open, () => setOpen(false));
  const query = search.trim().toLowerCase();
  const groups = [...providers].sort((left, right) => providerRank(left.id, configuredProviders) - providerRank(right.id, configuredProviders) || left.id.localeCompare(right.id)).map((provider) => ({ ...provider, models: provider.models.filter((model) => !query || model.toLowerCase().includes(query)) })).filter((provider) => provider.models.length > 0);
  const count = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  function openList() { setSearch(""); setOpen(true); }
  return <div className={`field picker-field ${compact ? "compact-picker model-picker" : ""}`} ref={root}>{!compact && <span>{translate("session.drawer.model")}</span>}<button type="button" className="picker-trigger model-trigger" aria-label={translate("picker.model.ariaLabel", { value0: value || translate("common.default") })} aria-expanded={open} onClick={() => { if (open) setOpen(false); else openList(); }}>{compact && <Cpu size={15} />}<span><strong>{value || translate("commandEditor.defaultOption")}</strong></span><ChevronDown size={15} /></button>{open && <PickerMenuPortal anchor={root} className="model-menu" preferredWidth={540}><label className="picker-search"><Search size={14} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={translate("picker.model.search")} /></label><button type="button" className={!value ? "selected" : ""} onClick={() => { onChange(""); setSearch(""); setOpen(false); }}><span><strong>{translate("picker.model.noOverride")}</strong><small>{translate("picker.model.inheritHint")}</small></span></button>{groups.map((provider) => <section className="model-group" key={provider.id}><header><span>{provider.name ?? provider.id}</span><small>{providerSource(provider.id, configuredProviders)}</small></header>{provider.models.map((model) => <button type="button" role="option" aria-selected={value === model} className={value === model ? "selected" : ""} key={model} onClick={() => { onChange(model); setSearch(""); setOpen(false); }}><span><strong>{model}</strong>{provider.default_model === model && <small>{translate("picker.model.providerDefault")}</small>}</span></button>)}</section>)}{groups.length === 0 && <p className="picker-empty">{translate("picker.model.noMatches")}</p>}</PickerMenuPortal>}{!compact && <small>{count}  {translate("picker.model.modelsFrom")} {providers.length}  {translate("picker.model.providerCountHint")}</small>}</div>;
}

export function VariantPicker({ variants, value, onChange, model, compact = false }: { variants: string[]; value: string; onChange: (value: string) => void; model: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useOutsideClose(open, () => setOpen(false));
  return <div className={`field picker-field variant-picker ${compact ? "compact-picker" : ""}`} ref={root}>{!compact && <span>{translate("commandEditor.reasoningModeLabel")}</span>}<button type="button" className="picker-trigger" aria-label={translate("picker.variant.ariaLabel", { value0: value || translate("common.default") })} title={translate("picker.variant.modelTitle", { value0: model })} aria-expanded={open} onClick={() => setOpen((current) => !current)}>{compact && <BrainCircuit size={15} />}<span><strong>{value || translate("commandEditor.defaultOption")}</strong></span><ChevronDown size={15} /></button>{open && <PickerMenuPortal anchor={root} preferredWidth={260}><button type="button" role="option" aria-selected={!value} className={!value ? "selected" : ""} onClick={() => { onChange(""); setOpen(false); }}><span><strong>{translate("commandEditor.defaultOption")}</strong></span></button>{variants.map((variant) => <button type="button" role="option" aria-selected={value === variant} className={value === variant ? "selected" : ""} key={variant} onClick={() => { onChange(variant); setOpen(false); }}><span><strong>{variant}</strong></span></button>)}</PickerMenuPortal>}</div>;
}

function useOutsideClose(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function pointerDown(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) close(); }
    function keyDown(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => { document.removeEventListener("pointerdown", pointerDown); document.removeEventListener("keydown", keyDown); };
  }, [open, close]);
  return root;
}

function providerSource(providerId: string, configuredProviders: string[]) { if (configuredProviders.includes(providerId)) return translate("picker.provider.configuredSource"); if (providerId === "opencode") return translate("picker.provider.builtInSource"); return translate("picker.provider.connectedSource"); }
function providerRank(providerId: string, configuredProviders: string[]) { if (providerId === "openai") return 0; if (providerId === "opencode") return 1; if (configuredProviders.includes(providerId)) return 2; return 3; }
