import { ArrowUp, Bot, File, Paperclip, RefreshCw, Sparkles, Square, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { commandDisplayDescription } from "./commands";
import { translate } from "./i18n";
import { AgentPicker, ModelPicker, VariantPicker } from "./Pickers";
import type { Agent, Attachment, CommandItem, ProviderSummary, RuntimeConfig } from "./types";
import { message } from "./useResource";
import { agentModel, localizedAgentDescription } from "./workspace";

type PromptBoxProps = { prompt: string; onPromptChange: (value: string) => void; attachments: Attachment[]; onAttachmentsChange: (value: Attachment[]) => void; onError: (value: string | null) => void; agent: string; onAgentChange: (value: string) => void; model: string; onModelChange: (value: string) => void; variant: string; onVariantChange: (value: string) => void; agents: Agent[]; commands?: CommandItem[]; providers: ProviderSummary[]; config?: RuntimeConfig; placeholder: string; submitLabel: string; busy: boolean; required?: boolean; attachmentsEnabled?: boolean; allowEmpty?: boolean; mentionsEnabled?: boolean; active?: boolean; stopping?: boolean; onStop?: () => void };

export function PromptBox({ prompt, onPromptChange, attachments, onAttachmentsChange, onError, agent, onAgentChange, model, onModelChange, variant, onVariantChange, agents, commands = [], providers, config, placeholder, submitLabel, busy, required = false, attachmentsEnabled = true, allowEmpty = false, mentionsEnabled = false, active = false, stopping = false, onStop }: PromptBoxProps) {
  const [dragActive, setDragActive] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandMenu = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mentionOptions = mention ? agents.filter((item) => !item.hidden && item.mode !== "primary" && item.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8) : [];
  const commandQuery = /^\/([a-z0-9_-]*)$/u.exec(prompt)?.[1]?.toLowerCase();
  const commandOptions = commandQuery === undefined ? [] : commands.filter((item) => item.id.toLowerCase().includes(commandQuery) || commandDisplayDescription(item).toLowerCase().includes(commandQuery)).slice(0, 8);
  const commandOptionIds = commandOptions.map((item) => item.id).join("|");
  const effectiveAgent = agents.find((candidate) => candidate.name === (agent || config?.default_agent));
  const effectiveModel = model || agentModel(effectiveAgent) || config?.model || "";
  const variants = modelVariants(providers, effectiveModel);
  function changeAgent(value: string) { onAgentChange(value); if (!model) onVariantChange(""); }
  function changeModel(value: string) { onModelChange(value); onVariantChange(""); }
  useEffect(() => { commandMenu.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [commandIndex, commandOptionIds]);
  function updateMention(value: string, cursor: number | null) {
    if (!mentionsEnabled || cursor === null) { setMention(null); return; }
    const match = value.slice(0, cursor).match(/(?:^|[\s([{"'])@([^\s@]*)$/u);
    if (!match) { setMention(null); return; }
    setMention({ start: cursor - (match[1]?.length ?? 0) - 1, query: match[1] ?? "" });
    setMentionIndex(0);
  }
  function selectMention(item: Agent) {
    if (!mention) return;
    const cursor = textarea.current?.selectionStart ?? mention.start + mention.query.length + 1;
    const insertion = `@${item.name} `;
    const next = `${prompt.slice(0, mention.start)}${insertion}${prompt.slice(cursor)}`;
    const nextCursor = mention.start + insertion.length;
    onPromptChange(next); setMention(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(nextCursor, nextCursor); });
  }
  function selectCommand(item: CommandItem) { onPromptChange(`/${item.id} `); setCommandIndex(0); requestAnimationFrame(() => textarea.current?.focus()); }
  async function dropFiles(files: File[]) {
    if (!attachmentsEnabled) return;
    try { onAttachmentsChange(await appendAttachments(attachments, files)); onError(null); }
    catch (reason) { onError(message(reason)); }
  }
  return <div className={`composer-box prompt-box ${dragActive ? "drag-active" : ""}`} onDragEnter={(event) => { if (!attachmentsEnabled) return; event.preventDefault(); setDragActive(true); }} onDragOver={(event) => { if (!attachmentsEnabled) return; event.preventDefault(); setDragActive(true); }} onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => { if (!attachmentsEnabled) return; event.preventDefault(); setDragActive(false); void dropFiles(Array.from(event.dataTransfer.files)); }}>
    <textarea ref={textarea} aria-label={placeholder} value={prompt} onChange={(event) => { onPromptChange(event.target.value); updateMention(event.target.value, event.target.selectionStart); setCommandIndex(0); }} onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={(event) => { if (commandOptions.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) { event.preventDefault(); if (event.key === "ArrowDown") setCommandIndex((current) => (current + 1) % commandOptions.length); else if (event.key === "ArrowUp") setCommandIndex((current) => (current - 1 + commandOptions.length) % commandOptions.length); else if (event.key === "Escape") onPromptChange(""); else selectCommand(commandOptions[commandIndex] ?? commandOptions[0]); return; } if (mentionOptions.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) { event.preventDefault(); if (event.key === "ArrowDown") setMentionIndex((current) => (current + 1) % mentionOptions.length); else if (event.key === "ArrowUp") setMentionIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length); else if (event.key === "Escape") setMention(null); else selectMention(mentionOptions[mentionIndex] ?? mentionOptions[0]); return; } if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return; event.preventDefault(); if (!busy && !active && (allowEmpty || prompt.trim() || attachments.length > 0)) event.currentTarget.form?.requestSubmit(); }} rows={5} required={required} placeholder={dragActive ? translate("prompt.dropFilesHere") : placeholder} />
    {commandOptions.length > 0 && <div ref={commandMenu} className="agent-mention-menu command-palette" role="listbox" aria-label={translate("prompt.commandOptionsAria")}>{commandOptions.map((item, index) => <button type="button" role="option" aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""} key={item.id} onMouseEnter={() => setCommandIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCommand(item)}>{item.kind === "skill" ? <Sparkles size={14} /> : <SquareTerminal size={14} />}<span><strong>/{item.id}</strong><small>{commandDisplayDescription(item)}</small></span>{item.has_shell && <em>Shell</em>}</button>)}</div>}
    {mention && mentionOptions.length > 0 && <div className="agent-mention-menu" role="listbox" aria-label={translate("prompt.agentOptionsAria")}>{mentionOptions.map((item, index) => <button type="button" role="option" aria-selected={index === mentionIndex} className={index === mentionIndex ? "selected" : ""} key={item.name} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(item)}><Bot size={14} /><span><strong>@{item.name}</strong><small>{localizedAgentDescription(item.name, item.description)}</small></span></button>)}</div>}
    {attachmentsEnabled && <FileAttachments compact value={attachments} onChange={onAttachmentsChange} onError={onError} />}
    <div className="composer-controls"><AgentPicker compact agents={agents} value={agent} onChange={changeAgent} />{variants.length > 0 && <VariantPicker compact variants={variants} value={variants.includes(variant) ? variant : ""} onChange={onVariantChange} model={effectiveModel} />}<ModelPicker compact providers={providers} configuredProviders={config?.configured_providers ?? []} value={model} onChange={changeModel} />{active ? <button type="button" className="composer-send composer-stop" aria-label={translate("prompt.stopResponse")} title={translate("prompt.stopResponse")} onClick={onStop} disabled={stopping}>{stopping ? <RefreshCw className="spin" size={16} /> : <Square size={14} fill="currentColor" />}</button> : <button className="composer-send" aria-label={submitLabel} title={submitLabel} disabled={busy || (!allowEmpty && !prompt.trim() && attachments.length === 0)}>{busy ? <RefreshCw className="spin" size={16} /> : <ArrowUp size={17} />}</button>}</div>
  </div>;
}

function FileAttachments({ value, onChange, onError, compact = false }: { value: Attachment[]; onChange: (value: Attachment[]) => void; onError: (value: string | null) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  async function add(nextFiles: File[]) {
    try {
      onChange(await appendAttachments(value, nextFiles));
      onError(null);
    } catch (reason) { onError(message(reason)); }
    finally { if (input.current) input.current.value = ""; }
  }
  function drag(event: DragEvent<HTMLDivElement>) { event.preventDefault(); event.stopPropagation(); setDragActive(true); }
  function drop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); event.stopPropagation(); setDragActive(false); void add(Array.from(event.dataTransfer.files)); }
  return <div className={`attachment-field ${compact ? "compact-attachment-field" : ""} ${dragActive ? "drag-active" : ""}`} onDragEnter={drag} onDragOver={drag} onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={drop}><input ref={input} className="file-input" type="file" multiple onChange={(event) => void add(Array.from(event.target.files ?? []))} /><button type="button" className="secondary-button attachment-button" aria-label={translate("attachments.attachFiles")} title={translate("attachments.attachFiles")} onClick={() => input.current?.click()} disabled={value.length >= 4}><Paperclip size={16} /><span>{translate("attachments.addFiles")}</span></button><small>{dragActive ? translate("attachments.dropFilesHere") : translate("attachments.limitHint")}</small>{value.length > 0 && <div className="attachment-list">{value.map((item, index) => <div className="attachment-preview" key={`${item.filename}-${index}`}>{item.mime.startsWith("image/") ? <img src={item.data_url} alt="" /> : <span className="attachment-file-icon"><File size={16} /></span>}<span title={item.filename}>{item.filename}</span><button type="button" aria-label={translate("attachments.removeFile", { value0: item.filename })} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></div>)}</div>}</div>;
}

function attachmentMime(file: File) { if (file.type) return file.type; const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ""; const text = new Set([".txt", ".md", ".markdown", ".json", ".jsonl", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".csv", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sh", ".zsh", ".sql", ".log"]); return text.has(extension) ? "text/plain" : "application/octet-stream"; }
async function appendAttachments(current: Attachment[], files: File[]) { if (!files.length) return current; if (current.length + files.length > 4) throw new Error(translate("attachments.tooManyFiles")); for (const file of files) { if (file.size > 5 * 1024 * 1024) throw new Error(translate("attachments.fileTooLarge", { value0: file.name })); } const encoded = await Promise.all(files.map((file) => new Promise<Attachment>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const mime = attachmentMime(file); const data = String(reader.result).replace(/^data:[^;,]*;base64,/, `data:${mime};base64,`); resolve({ filename: file.name, mime, data_url: data }); }; reader.onerror = () => reject(new Error(translate("attachments.readError", { value0: file.name }))); reader.readAsDataURL(file); }))); return [...current, ...encoded]; }
function modelVariants(providers: ProviderSummary[], model: string) { return providers.flatMap((provider) => provider.model_variants?.[model] ?? []); }
