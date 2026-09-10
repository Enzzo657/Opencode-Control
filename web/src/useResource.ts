import { startTransition, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { translate } from "./i18n";

export function useResource<T>(url: string, dependency: unknown, interval?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [url]);

  useEffect(() => {
    let active = true;
    let polling = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    setError(null);

    async function load() {
      controller = new AbortController();
      try {
        const value = await api<T>(url, { signal: controller.signal });
        if (active) startTransition(() => { setData(value); setError(null); });
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (reason instanceof ApiError && reason.status === 404) polling = false;
        if (active) setError(message(reason));
      } finally {
        controller = null;
        if (active && polling && interval) timer = window.setTimeout(() => void load(), document.hidden ? Math.max(interval, 15_000) : interval);
      }
    }

    void load();
    const visible = () => {
      if (document.hidden || !interval || !polling) return;
      if (timer) window.clearTimeout(timer);
      timer = undefined;
      if (!controller) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, dependency, interval, nonce]);

  return { data, error, reload: () => setNonce((value) => value + 1) };
}

export function message(reason: unknown) {
  return reason instanceof Error ? reason.message : translate("common.unknownError");
}
