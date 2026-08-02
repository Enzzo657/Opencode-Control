import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, jsonBody } from "../api";
import { useI18n } from "../i18n";
import type { SecretInfo } from "../types";
import { Banner, Empty, Field, Modal, Page, Panel, ScopeGuide } from "../ui";
import { message, useResource } from "../useResource";

export function Secrets() {
  const { t } = useI18n();
  const resource = useResource<SecretInfo[]>("/api/v1/secrets", 0);
  const [selected, setSelected] = useState<SecretInfo | "new" | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copyReference(secret: SecretInfo) {
    try {
      if (!navigator.clipboard) throw new Error(t("secrets.clipboardUnavailable"));
      await navigator.clipboard.writeText(secret.reference);
      setCopied(secret.name);
      window.setTimeout(() => setCopied((current) => current === secret.name ? null : current), 1800);
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function remove(secret: SecretInfo) {
    if (!confirm(t("secrets.deleteConfirm", { secret: secret.name }))) return;
    try {
      await api(`/api/v1/secrets/${encodeURIComponent(secret.name)}`, { method: "DELETE" });
      setError(null);
      resource.reload();
    } catch (reason) {
      setError(message(reason));
    }
  }

  return <Page title={t("secrets.title")} description={t("secrets.description")} action={<button className="primary-button" onClick={() => setSelected("new")}><Plus size={15} /> {t("secrets.add")}</button>}>
    {(error || resource.error) && <Banner tone="danger">{error || resource.error}</Banner>}
    <Banner tone="notice">{t("secrets.notice")} <code>{`{file:~/.config/opencode/secrets/...}`}</code> {t("secrets.noticeEnd")}</Banner>
    <ScopeGuide><strong>{t("secrets.sharedStore")}</strong><span>{t("secrets.allProjects")}</span><code>~/.config/opencode/secrets/</code></ScopeGuide>
    <Panel className="secret-panel">
      <div className="secret-list">
        {(resource.data ?? []).map((secret) => <article className="secret-row" key={secret.name}>
          <span className="secret-icon"><KeyRound size={17} /></span>
          <span className="secret-identity"><strong>{secret.name}</strong><small>{secret.path}</small></span>
          <code className="secret-mask">••••••••••••</code>
          <code className="secret-reference">{secret.reference}</code>
          <span className="secret-actions"><button className="secondary-button compact-button" onClick={() => void copyReference(secret)}><Copy size={13} /> {copied === secret.name ? t("secrets.copied") : t("secrets.copy")}</button><button className="secondary-button compact-button" onClick={() => setSelected(secret)}>{t("common.replace")}</button><button className="icon-button" aria-label={t("secrets.deleteNamed", { name: secret.name })} title={t("secrets.deleteNamed", { name: secret.name })} onClick={() => void remove(secret)}><Trash2 size={14} /></button></span>
        </article>)}
        {resource.data?.length === 0 && <Empty icon={<KeyRound />} title={t("secrets.empty")} detail={t("secrets.emptyDetail")} />}
      </div>
    </Panel>
    {selected && <SecretDialog existing={selected === "new" ? null : selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); resource.reload(); }} />}
  </Page>;
}

function SecretDialog({ existing, onClose, onSaved }: { existing: SecretInfo | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(existing?.name ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/api/v1/secrets/${encodeURIComponent(name)}`, { method: "PUT", ...jsonBody({ value }) });
      onSaved();
    } catch (reason) {
      setError(message(reason));
      setBusy(false);
    }
  }

  return <Modal title={existing ? t("secrets.replaceTitle", { name: existing.name }) : t("secrets.addTitle")} subtitle={t("secrets.dialogSubtitle")} onClose={onClose}>
    {error && <Banner tone="danger">{error}</Banner>}
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <Field label={t("secrets.fileName")} hint={t("secrets.fileNameHint")}><input className="mono" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} disabled={Boolean(existing)} required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxLength={64} placeholder="context7_api_key" /></Field>
      <Field label={t(existing ? "secrets.newValue" : "secrets.value")} hint={t("secrets.valueHint")}><input type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} required maxLength={65_536} placeholder={t("secrets.keyPlaceholder")} /></Field>
      <Banner tone="notice">{t("secrets.afterSave")} <code>{`{file:~/.config/opencode/secrets/${name || t("secrets.referenceName")}}`}</code>.</Banner>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{t("common.cancel")}</button><button className="primary-button" disabled={busy || !name || !value}>{busy ? t("common.saving") : t(existing ? "secrets.replaceValue" : "secrets.save")}</button></div>
    </form>
  </Modal>;
}
