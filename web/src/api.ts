import { translate } from "./i18n";

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function ensureSession(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/v1/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error(translate("api.sessionInit"));
  const payload = (await response.json()) as { csrf_token: string };
  csrfToken = payload.csrf_token;
  return csrfToken;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRF-Token", await ensureSession());
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new ApiError(formatError(payload?.detail, response.status), response.status, payload?.detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function apiBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Token", await ensureSession());
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new ApiError(formatError(payload?.detail, response.status), response.status, payload?.detail);
  }
  return response.blob();
}

function formatError(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const issues = detail.filter((item): item is { loc?: unknown[]; msg?: string; type?: string } => typeof item === "object" && item !== null);
    const staleScheduleFields = issues.some((item) => item.type === "extra_forbidden" && item.loc?.some((part) => part === "cron" || part === "timezone"));
    if (staleScheduleFields) return translate("api.staleSchedule");
    const staleMentions = issues.some((item) => item.type === "extra_forbidden" && item.loc?.includes("mentions"));
    if (staleMentions) return translate("api.staleMentions");
    const messages = issues.map((item) => { const field = item.loc?.filter((part) => part !== "body").join(" → "); return `${field ? `${field}: ` : ""}${item.msg ?? translate("api.invalidValue")}`; });
    if (messages.length) return messages.join(". ");
  }
  if (typeof detail === "object" && detail !== null) {
    const value = detail as { message?: unknown; preflight?: unknown; diagnostic?: unknown };
    const base = typeof value.message === "string" ? value.message : translate("api.requestFailed", { status });
    if (typeof value.preflight === "object" && value.preflight !== null) {
      const errors = Object.values(value.preflight as Record<string, unknown>).flatMap((entry) => typeof entry === "object" && entry !== null && typeof (entry as { error?: unknown }).error === "string" ? [(entry as { error: string }).error] : []);
      if (errors.length) return `${base}: ${Array.from(new Set(errors)).join("; ")}`;
    }
    if (typeof value.diagnostic === "object" && value.diagnostic !== null && typeof (value.diagnostic as { detail?: unknown }).detail === "string") return `${base}: ${(value.diagnostic as { detail: string }).detail}`;
    return base;
  }
  return translate("api.requestFailed", { status });
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
