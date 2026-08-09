import { ArrowUpRight, MessageSquareText, Search as SearchIcon } from "lucide-react";
import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { relativeTime } from "../sessionUtils";
import { ScopeSwitch } from "../ScopeSwitch";
import type { Project, SearchResponse, SearchResult } from "../types";
import { Banner, Empty, Page, Panel } from "../ui";
import { message } from "../useResource";

export function Search({ project, onOpenSession }: { project: Project; onOpenSession: (projectId: string, sessionId: string, messageId: string | null, query: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [scope, setScope] = useState<"project" | "global">(() => new URLSearchParams(location.search).get("scope") === "global" ? "global" : "project");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const deferredQuery = useDeferredValue(query.trim());
  const [settledQuery, setSettledQuery] = useState(query.trim());

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(deferredQuery), 250);
    return () => window.clearTimeout(timer);
  }, [deferredQuery]);

  useEffect(() => {
    const parameters = new URLSearchParams({ scope });
    if (query) parameters.set("q", query);
    history.replaceState({}, "", `/search?${parameters}`);
  }, [query, scope]);

  useEffect(() => {
    if (settledQuery.length < 2) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const parameters = new URLSearchParams({ q: settledQuery, scope });
    if (scope === "project") parameters.set("project_id", project.id);
    setLoading(true);
    void api<SearchResponse>(`/api/v1/search?${parameters}`, { signal: controller.signal })
      .then((next) => startTransition(() => { setResult(next); setError(null); }))
      .catch((reason) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, scope, settledQuery]);

  async function loadMore() {
    if (!result?.has_more || loadingMore) return;
    const parameters = new URLSearchParams({ q: result.query, scope, offset: String(result.results.length) });
    if (scope === "project") parameters.set("project_id", project.id);
    setLoadingMore(true);
    try {
      const next = await api<SearchResponse>(`/api/v1/search?${parameters}`);
      startTransition(() => setResult((current) => current && current.query === next.query ? { ...next, results: [...current.results, ...next.results], indexed_sessions: current.indexed_sessions + next.indexed_sessions } : next));
      setError(null);
    } catch (reason) { setError(message(reason)); }
    finally { setLoadingMore(false); }
  }

  return <Page title={t("search.title")} description={t("search.description")}>
    <div className="search-toolbar"><ScopeSwitch value={scope} onChange={setScope} label={t("search.scopeLabel")} /></div>
    <div className="search-controls"><label className="search-input"><SearchIcon size={19} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.inputLabel")} />{loading && <span>{t("search.indexing")}</span>}</label></div>
    {error && <Banner tone="danger">{error}</Banner>}
    {result?.partial && <Banner tone="notice">{t("search.partial", { projects: result.unavailable_projects.map((item) => item.name).join(", ") })}</Banner>}
    {result && result.indexed_sessions > 0 && <p className="search-index-note">{t("search.indexUpdated", { count: result.indexed_sessions })}</p>}
    <Panel className="search-results-panel">
      {result?.results.map((item) => <SearchResultRow key={`${item.kind}:${item.project_id}:${item.session_id}:${item.message_id ?? "title"}`} item={item} query={result.query} onOpen={() => onOpenSession(item.project_id, item.session_id, item.message_id, result.query)} />)}
      {!result && <Empty icon={<SearchIcon />} title={t("search.startTitle")} detail={t("search.startDetail")} />}
      {result?.results.length === 0 && <Empty icon={<MessageSquareText />} title={t("search.emptyTitle")} detail={t("search.emptyDetail", { query: result.query })} />}
      {result?.has_more && <div className="search-load-more"><button className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("search.loadingMore") : t("search.loadMore")}</button></div>}
    </Panel>
  </Page>;
}

function SearchResultRow({ item, query, onOpen }: { item: SearchResult; query: string; onOpen: () => void }) {
  const { t } = useI18n();
  return <button className="search-result" onClick={onOpen}>
    <span className={`search-result-kind ${item.kind}`}><MessageSquareText size={15} /></span>
    <span className="search-result-body">
      <span className="search-result-meta"><strong>{item.session_title || t("common.unnamedSession")}</strong><i>{item.project_name}</i><small>{item.kind === "session" ? t("search.sessionMatch") : item.role === "user" ? t("search.userMessage") : t("search.assistantMessage")}{item.created_at ? ` · ${relativeTime(item.created_at)}` : ""}</small></span>
      <span className="search-snippet">{highlight(item.snippet, query)}</span>
    </span>
    <ArrowUpRight size={16} />
  </button>;
}

function highlight(value: string, query: string) {
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}
