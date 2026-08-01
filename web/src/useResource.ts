import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { translate } from "./i18n";

export function useResource<T>(url: string, dependency: unknown, interval?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [url, dependency]);

  useEffect(() => {
    let active = true;
    let polling = true;
    let sequence = 0;
    setError(null);

    async function load() {
      const request = ++sequence;
      try {
        const value = await api<T>(url);
        if (active && request === sequence) {
          setData(value);
          setError(null);
        }
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) polling = false;
        if (active && request === sequence) setError(message(reason));
      }
    }

    void load();
    const timer = interval ? window.setInterval(() => { if (polling) void load(); }, interval) : undefined;
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, [url, dependency, interval, nonce]);

  return { data, error, reload: () => setNonce((value) => value + 1) };
}

export function message(reason: unknown) {
  return reason instanceof Error ? reason.message : translate("common.unknownError");
}
