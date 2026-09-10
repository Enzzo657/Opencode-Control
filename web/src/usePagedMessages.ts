import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { message } from "./useResource";

type IdentifiedMessage = { info?: { id?: string } };
type MessagePage<T> = { messages: T[]; next_cursor: string | null };

function mergeLatest<T extends IdentifiedMessage>(current: T[] | null, latest: T[]) {
  if (!current) return latest;
  const latestIds = new Set(latest.flatMap((entry) => entry.info?.id ? [entry.info.id] : []));
  return [...current.filter((entry) => !entry.info?.id || !latestIds.has(entry.info.id)), ...latest];
}

function prependOlder<T extends IdentifiedMessage>(current: T[] | null, older: T[]) {
  if (!current) return older;
  const currentIds = new Set(current.flatMap((entry) => entry.info?.id ? [entry.info.id] : []));
  return [...older.filter((entry) => !entry.info?.id || !currentIds.has(entry.info.id)), ...current];
}

export function usePagedMessages<T extends IdentifiedMessage>(url: string, dependency: unknown, interval?: number) {
  const [data, setData] = useState<T[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const latestLoader = useRef<(() => Promise<void>) | null>(null);
  const latestController = useRef<AbortController | null>(null);
  const olderController = useRef<AbortController | null>(null);
  const loadedOlder = useRef(false);

  useEffect(() => {
    setData(null);
    setNextCursor(null);
    setError(null);
    setLoadingOlder(false);
    loadedOlder.current = false;
  }, [url, dependency]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function loadLatest() {
      if (latestController.current) return;
      const controller = new AbortController();
      latestController.current = controller;
      try {
        const page = await api<MessagePage<T>>(`${url}?limit=100`, { signal: controller.signal });
        if (!active) return;
        startTransition(() => {
          setData((current) => mergeLatest(current, page.messages));
          if (!loadedOlder.current) setNextCursor(page.next_cursor);
          setUpdatedAt(Date.now());
          setError(null);
        });
      } catch (reason) {
        if ((reason as { name?: string })?.name !== "AbortError" && active) setError(message(reason));
      } finally {
        latestController.current = null;
        if (active && interval) timer = window.setTimeout(() => void loadLatest(), document.hidden ? Math.max(interval, 15_000) : interval);
      }
    }
    latestLoader.current = loadLatest;
    void loadLatest();
    const visible = () => {
      if (document.hidden || !interval) return;
      if (timer) window.clearTimeout(timer);
      timer = undefined;
      void loadLatest();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      latestLoader.current = null;
      latestController.current?.abort();
      olderController.current?.abort();
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, dependency, interval]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder || olderController.current) return false;
    const controller = new AbortController();
    olderController.current = controller;
    setLoadingOlder(true);
    try {
      const page = await api<MessagePage<T>>(`${url}?limit=100&before=${encodeURIComponent(nextCursor)}`, { signal: controller.signal });
      loadedOlder.current = true;
      startTransition(() => {
        setData((current) => prependOlder(current, page.messages));
        setNextCursor(page.next_cursor);
        setError(null);
      });
      return true;
    } catch (reason) {
      if ((reason as { name?: string })?.name !== "AbortError") setError(message(reason));
      return false;
    } finally {
      olderController.current = null;
      setLoadingOlder(false);
    }
  }, [loadingOlder, nextCursor, url]);

  return {
    data,
    error,
    loadingOlder,
    updatedAt,
    hasMore: nextCursor !== null,
    loadOlder,
    reload: () => void latestLoader.current?.(),
  };
}
