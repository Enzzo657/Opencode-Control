import { Check, KeyRound, Plug, Plus, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, jsonBody } from "../api";
import { useI18n } from "../i18n";
import type { Project, ProviderAuthEntry } from "../types";
import { Banner, Empty, Field, Modal, Page } from "../ui";
import { message, useResource } from "../useResource";

export function Providers({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const { t } = useI18n();
  const resource = useResource<ProviderAuthEntry[]>(`/api/v1/projects/${project.id}/providers/auth`, refreshKey);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProviderAuthEntry | null>(null);
  const [custom, setCustom] = useState(false);
  const normalized = query.trim().toLowerCase();
  const entries = [...(resource.data ?? [])]
    .filter((entry) => !normalized || entry.name.toLowerCase().includes(normalized) || entry.id.toLowerCase().includes(normalized))
    .sort((left, right) => providerAuthRank(left.id) - providerAuthRank(right.id) || left.name.localeCompare(right.name));

  return <Page title={t("providers.title")} description={t("providers.description")} action={<button className="primary-button" onClick={() => setCustom(true)}><Plus size={16} /> {t("providers.add")}</button>}>
    {resource.error && <Banner tone="danger">{t("providers.catalogError", { error: resource.error })}</Banner>}
    {project.endpoint && <Banner tone="notice">{t("providers.externalNotice")}</Banner>}
    <div className="provider-toolbar"><div className="theme-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("providers.search")} /></div><span>{t("providers.connectedCount", { count: entries.filter((entry) => entry.connected).length })}</span></div>
    <div className="provider-list">
      {entries.map((entry) => <button className={`provider-row${entry.configured ? " configured" : ""}`} key={entry.id} onClick={() => { if (!entry.configured) setSelected(entry); }}><span className="provider-mark"><Plug size={17} /></span><span><strong>{entry.name}</strong><small>{entry.id} · {entry.configured ? "opencode.json" : entry.methods.map((method) => method.label).join(" / ")}</small></span><span className={entry.connected || entry.configured ? "provider-connected" : "provider-connect"}>{entry.connected ? <><Check size={14} /> {t("providers.connected")}</> : entry.configured ? <><Check size={14} /> {t("providers.configured")}</> : t("providers.connect")}</span></button>)}
      {!resource.error && entries.length === 0 && <Empty icon={<Plug />} title={t("providers.empty")} detail={t(normalized ? "providers.changeSearch" : "providers.startServer")} />}
    </div>
    {selected && <ProviderConnectDialog project={project} entry={selected} onClose={() => setSelected(null)} onConnected={() => { setSelected(null); resource.reload(); }} />}
    {custom && <CustomProviderDialog project={project} onClose={() => setCustom(false)} onSaved={() => { setCustom(false); resource.reload(); }} />}
  </Page>;
}

function CustomProviderDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"ollama" | "custom">("ollama");
  const [id, setId] = useState("ollama");
  const [name, setName] = useState("Ollama (local)");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectKind(next: "ollama" | "custom") {
    setKind(next);
    if (next === "ollama") {
      setId("ollama");
      setName("Ollama (local)");
      setBaseUrl("http://localhost:11434/v1");
      setApiKey("");
    } else {
      setId("");
      setName("");
      setBaseUrl("https://api.example.com/v1");
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const modelIds = models.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    if (modelIds.length === 0) {
      setError(t("providers.modelRequired"));
      return;
    }
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(id)}/configuration`, { method: "PUT", ...jsonBody({ name, base_url: baseUrl, models: modelIds, api_key: apiKey || null }) });
      onSaved();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return <Modal title={t("providers.add")} subtitle={t("providers.customSubtitle")} onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="custom-provider-kinds" role="tablist" aria-label={t("providers.customType")}><button type="button" role="tab" aria-selected={kind === "ollama"} className={kind === "ollama" ? "selected" : ""} onClick={() => selectKind("ollama")}>Ollama</button><button type="button" role="tab" aria-selected={kind === "custom"} className={kind === "custom" ? "selected" : ""} onClick={() => selectKind("custom")}>{t("providers.openAiCompatible")}</button></div>
    <p className="custom-provider-mode-note">{t(kind === "ollama" ? "providers.ollamaNote" : "providers.customNote")}</p>
    <form className="form-stack provider-auth-form custom-provider-form" onSubmit={(event) => void save(event)}><div className="form-row"><Field label={t("providers.id")} hint={t("providers.idHint")}><input className="mono" value={id} onChange={(event) => setId(event.target.value)} required placeholder="myprovider" /></Field><Field label={t("common.name")}><input value={name} onChange={(event) => setName(event.target.value)} required placeholder={t("providers.customNamePlaceholder")} /></Field></div><Field label={t("providers.baseUrl")}><input className="mono" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder="https://api.example.com/v1" /></Field><Field label={t("providers.modelIds")} hint={t("providers.modelIdsHint")}><textarea className="code-editor provider-models" value={models} onChange={(event) => setModels(event.target.value)} required placeholder={kind === "ollama" ? "qwen3-coder:30b\nllama3.3:70b" : "my-model\nmy-fast-model"} /></Field>{kind === "custom" && <Field label={t("providers.apiKey")} hint={t("providers.apiKeyOptionalHint")}><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("providers.optional")} /></Field>}<Banner tone="notice">{t("providers.ollamaContextNotice")}</Banner><div className="modal-actions custom-provider-actions"><button type="button" className="secondary-button" onClick={onClose}>{t("common.cancel")}</button><button className="primary-button" disabled={busy || !id || !name || !baseUrl}>{busy ? t("common.saving") : t("providers.addButton")}</button></div></form>
  </Modal>;
}

function ProviderConnectDialog({ project, entry, onClose, onConnected }: { project: Project; entry: ProviderAuthEntry; onClose: () => void; onConnected: () => void }) {
  const { t } = useI18n();
  const [methodIndex, setMethodIndex] = useState(0);
  const [key, setKey] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [authorization, setAuthorization] = useState<{ url: string; method: "auto" | "code"; instructions?: string | null } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = entry.methods[methodIndex] ?? entry.methods[0];

  async function connectApi(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(entry.id)}/auth`, { method: "PUT", ...jsonBody({ key, metadata: inputs }) });
      setKey("");
      onConnected();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function authorize() {
    setBusy(true);
    try {
      const value = await api<{ url: string; method: "auto" | "code"; instructions?: string | null }>(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(entry.id)}/oauth/authorize`, { method: "POST", ...jsonBody({ method: methodIndex, inputs }) });
      setAuthorization(value);
      setError(null);
      window.open(value.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    setBusy(true);
    try {
      await api(`/api/v1/projects/${project.id}/providers/${encodeURIComponent(entry.id)}/oauth/callback`, { method: "POST", ...jsonBody({ method: methodIndex, code: code || null }) });
      onConnected();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return <Modal title={t("providers.connectTitle", { name: entry.name })} subtitle={t("providers.authSubtitle")} onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="auth-methods">{entry.methods.map((candidate, index) => <button type="button" className={index === methodIndex ? "selected" : ""} key={`${candidate.type}-${candidate.label}`} onClick={() => { setMethodIndex(index); setAuthorization(null); setError(null); }}><span>{candidate.type === "api" ? <KeyRound size={16} /> : <Plug size={16} />}</span><strong>{candidate.label}</strong><small>{t(candidate.type === "api" ? "providers.apiKey" : "providers.browserLogin")}</small></button>)}</div>
    {method?.type === "api" ? <form className="form-stack provider-auth-form" onSubmit={(event) => void connectApi(event)}><Field label={t("providers.apiKey")} hint={t("providers.apiKeyHint")}><input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} required placeholder={t("providers.keyPlaceholder")} /></Field>{(method.prompts ?? []).map((prompt) => <Field key={prompt.key} label={prompt.message}>{prompt.type === "select" ? <select value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))}><option value="">{t("common.selectValue")}</option>{prompt.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))} placeholder={prompt.placeholder} />}</Field>)}<button className="primary-button" disabled={busy || !key}>{t(busy ? "providers.connecting" : "providers.connect")}</button></form> : <div className="form-stack provider-auth-form">
      {(method?.prompts ?? []).map((prompt) => <Field key={prompt.key} label={prompt.message}>{prompt.type === "select" ? <select value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))}><option value="">{t("common.selectValue")}</option>{prompt.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={inputs[prompt.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [prompt.key]: event.target.value }))} placeholder={prompt.placeholder} />}</Field>)}
      {!authorization ? <button className="primary-button" type="button" onClick={() => void authorize()} disabled={busy}>{t(busy ? "providers.opening" : "providers.continueBrowser")}</button> : <div className="oauth-complete"><p>{authorization.instructions ?? t("providers.oauthInstructions")}</p><a href={authorization.url} target="_blank" rel="noreferrer">{t("providers.openLoginAgain")}</a>{authorization.method === "code" && <Field label={t("providers.confirmationCode")}><input value={code} onChange={(event) => setCode(event.target.value)} placeholder={t("providers.codePlaceholder")} /></Field>}<button className="primary-button" type="button" onClick={() => void complete()} disabled={busy || (authorization.method === "code" && !code)}>{t(busy ? "providers.checking" : "providers.complete")}</button></div>}
    </div>}
  </Modal>;
}

function providerAuthRank(providerId: string) {
  const popular = ["opencode", "openai", "github-copilot", "anthropic", "google"];
  const index = popular.indexOf(providerId);
  return index < 0 ? popular.length : index;
}
