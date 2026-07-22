let csrfToken: string | null = null;

async function ensureSession(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/v1/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Не удалось инициализировать сессию браузера");
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
    throw new Error(formatError(payload?.detail, response.status));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function formatError(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const issues = detail.filter((item): item is { loc?: unknown[]; msg?: string; type?: string } => typeof item === "object" && item !== null);
    const staleScheduleFields = issues.some((item) => item.type === "extra_forbidden" && item.loc?.some((part) => part === "cron" || part === "timezone"));
    if (staleScheduleFields) return "Backend Studio ещё не обновлён. Выполните uv run opencode-studio --restart --open.";
    const staleMentions = issues.some((item) => item.type === "extra_forbidden" && item.loc?.includes("mentions"));
    if (staleMentions) return "Backend Studio ещё не поддерживает @-подагентов. Перезапустите Studio: uv run opencode-studio --restart --open.";
    const messages = issues.map((item) => { const field = item.loc?.filter((part) => part !== "body").join(" → "); return `${field ? `${field}: ` : ""}${item.msg ?? "Некорректное значение"}`; });
    if (messages.length) return messages.join(". ");
  }
  return `Запрос не выполнен (${status})`;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
