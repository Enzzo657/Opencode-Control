import { useEffect, useState } from "react";
import type { Snapshot } from "./types";
import { useResource } from "./useResource";

export function useSnapshotResource(url: string, dependency: unknown, interval: number) {
  const resource = useResource<Snapshot>(url, dependency, interval);
  const [cached, setCached] = useState<{ url: string; data: Snapshot } | null>(null);
  const complete = resource.data?.state === "connected"
    && !resource.data.errors.includes("sessions_unavailable")
    && !resource.data.errors.includes("statuses_unavailable");

  useEffect(() => {
    if (resource.data && complete) setCached({ url, data: resource.data });
  }, [complete, resource.data, url]);

  const previous = cached?.url === url ? cached.data : null;
  const stale = Boolean(previous && (resource.error || (resource.data && !complete)));
  const data = stale && previous && resource.data
    ? { ...previous, state: resource.data.state, errors: resource.data.errors, server: resource.data.server }
    : stale && previous
      ? previous
      : resource.data;
  return { ...resource, data, stale };
}
