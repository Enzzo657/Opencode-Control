import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, contrastText, prepareChunkReload, themes } from "../App";

const project = {
  id: "prj_test",
  name: "Checkout API",
  root: "/code/checkout",
  endpoint: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  server: { state: "running", managed: true, endpoint: "http://127.0.0.1:4100" },
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dashboardUsage(scope: "project" | "global" = "project") {
  return {
    scope, period: "today", timezone: "UTC", generated_at: "2026-01-01T00:00:00Z", partial: false, unavailable_projects: [],
    totals: { id: "total", tokens: { input: 10, output: 4, reasoning: 2, cache_read: 3, cache_write: 1 }, tokens_total: 16, cost: 0.5, messages: 1, sessions: 1, active: 0, mcp_connected: 1, mcp_total: 2 },
    projects: [{ id: project.id, name: project.name, tokens: { input: 10, output: 4, reasoning: 2, cache_read: 3, cache_write: 1 }, tokens_total: 16, cost: 0.5, messages: 1, sessions: 1 }],
    models: [{ id: "openai/gpt-test", tokens: { input: 10, output: 4, reasoning: 2, cache_read: 3, cache_write: 1 }, tokens_total: 16, cost: 0.5, messages: 1, sessions: 1 }],
    providers: [], agents: [], daily: [{ id: "2026-01-01", tokens: { input: 10, output: 4, reasoning: 2, cache_read: 3, cache_write: 1 }, tokens_total: 16, cost: 0.5, messages: 1, sessions: 1 }],
    recent_sessions: [{ id: "ses_1", title: "Fix checkout", agent: "build", model: { providerID: "openai", modelID: "gpt-test" }, time: { updated: Date.now() }, project_id: project.id, project_name: project.name, status: "idle", cost: 0.5, tokens: { input: 10, output: 4, reasoning: 2 } }],
  };
}

function contrastRatio(left: string, right: string) {
  function luminance(hex: string) {
    const channels = hex.match(/[a-f\d]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  }
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

describe("OpenCode Control", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("control-locale", "ru");
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("confirm", vi.fn(() => true));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.endsWith("/api/v1/health")) return response({ healthy: true, version: "0.3.2", projects: 1 });
      if (path.includes("/api/v1/events") && (!init?.method || init.method === "GET")) return response({ events: [], unread: 0 });
      if (path.includes("/api/v1/events/") && init?.method === "POST") return response(path.endsWith("/read-all") ? { read: 0 } : { read: true });
      if (path.includes("/api/v1/dashboard")) return response(dashboardUsage(path.includes("scope=global") ? "global" : "project"));
      if (path.includes("/api/v1/search")) { const offset = Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0); return response({ query: "deploy", scope: path.includes("scope=global") ? "global" : "project", partial: false, unavailable_projects: [], indexed_sessions: offset ? 0 : 1, offset, has_more: offset === 0, results: [{ kind: "message", project_id: project.id, project_name: project.name, session_id: "ses_1", session_title: "Fix checkout", message_id: offset ? "msg_2" : "msg_1", role: "user", created_at: Date.now(), snippet: offset ? "Deploy through the release pipeline" : "Rotate deployment token" }] }); }
      if (path.includes("/api/v1/artifacts/archive")) return new Response("zip", { status: 200, headers: { "Content-Type": "application/zip" } });
      if (path.endsWith("/api/v1/artifacts/trash")) return response({ trashed_ids: ["artifact-1", "artifact-2"], errors: [] });
      if (/\/api\/v1\/artifacts\/[^/]+\/(?:reveal|trash)$/.test(path)) return response({ revealed: path.endsWith("/reveal"), trashed: path.endsWith("/trash") });
      if (/\/api\/v1\/projects\/[^/]+\/artifact\/(?:reveal|trash)$/.test(path)) return response({ revealed: path.endsWith("/reveal"), trashed: path.endsWith("/trash") });
      if (path.includes("/api/v1/artifacts/artifact-3/preview")) return response({ kind: "data", format: "csv", name: "data.csv", mime: "text/csv", size: 128, columns: ["id", "name"], rows: [["1", "test"]], truncated: false });
      if (path.includes("/api/v1/artifacts")) return response({ scope: path.includes("scope=global") ? "global" : "project", partial: false, unavailable_projects: [], indexed_sessions: 1, has_more: false, artifacts: [{ id: "artifact-1", kind: "image", name: "result.png", mime: "image/png", size: 2048, modified_at: Date.now(), created_at: Date.now(), project_id: project.id, project_name: project.name, session_id: "ses_1", session_title: "Fix checkout", message_id: "msg_1", media_url: `/api/v1/projects/${project.id}/media?path=result.png`, download_url: `/api/v1/projects/${project.id}/artifact?path=result.png` }, { id: "artifact-2", kind: "pdf", name: "report.pdf", mime: "application/pdf", size: 4096, modified_at: Date.now(), created_at: Date.now(), project_id: project.id, project_name: project.name, session_id: null, session_title: null, message_id: null, media_url: null, download_url: `/api/v1/projects/${project.id}/artifact?path=report.pdf` }, { id: "artifact-3", kind: "data", name: "data.csv", mime: "text/csv", size: 128, modified_at: Date.now(), created_at: Date.now(), project_id: project.id, project_name: project.name, session_id: null, session_title: null, message_id: null, media_url: null, download_url: `/api/v1/projects/${project.id}/artifact?path=data.csv` }] });
      if (path.endsWith("/tasks") && (!init?.method || init.method === "GET")) return response([{ id: "task_1", project_id: project.id, title: "Fix checkout task", prompt: "Fix it", agent: "build", model: "openai/gpt-test", status: "completed", session_id: "ses_1", session_ids: ["ses_1"], error: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
      if (path.includes("/snapshot")) {
        return response({
          state: "connected",
          errors: [],
          health: { healthy: true, version: "1.18.1" },
          sessions: [
            { id: "ses_1", title: "Fix checkout", agent: "build", cost: 0.12, tokens: { input: 100, output: 50 }, control_task: { id: "task_1", title: "Fix checkout task", status: "completed" } },
            { id: "ses_child", parentID: "ses_1", title: "Inspect API", agent: "explore", tokens: { input: 20, output: 10 }, control_task: { id: "task_1", title: "Fix checkout task", status: "completed" } },
          ],
          statuses: { ses_1: { type: "idle" } },
          agents: [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }, { name: "explore", mode: "subagent" }, { name: "general", mode: "subagent" }],
          mcp: { context7: { status: "connected" }, xlsx: { status: "disabled" } },
          providers: { connected: ["openai"], available: [{ id: "openai", model_count: 2, models: ["openai/gpt-test", "openai/gpt-other"], model_variants: { "openai/gpt-test": ["low", "high"] } }] },
          config: { model: "openai/gpt-test", default_agent: "build" },
          server: project.server,
        });
      }
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_1", role: "assistant", time: { created: Date.now(), completed: Date.now() } }, parts: [{ type: "text", text: "Rotate deployment token" }] }]);
      if (path.includes("/mcp/global")) return response({ context7: { type: "remote", url: "https://example.test/mcp", enabled: true } });
      if (path.endsWith("/api/v1/secrets") && (!init?.method || init.method === "GET")) return response([{ name: "context7_api_key", path: "/home/dev/.config/opencode/secrets/context7_api_key", reference: "{file:~/.config/opencode/secrets/context7_api_key}" }]);
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response([]);
    }));
  });

  it("renders the project control room with runtime information", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Дашборд" })).toBeInTheDocument();
    expect(screen.getAllByText("Checkout API").length).toBeGreaterThan(0);
    expect(await screen.findByText("Fix checkout")).toBeInTheDocument();
    expect(screen.getByText("1.18.1")).toBeInTheDocument();
    expect(screen.getByText("Подключен")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Текущий проект.*Checkout API/ }));
    expect(screen.getAllByText("Подключен")).toHaveLength(2);
    expect(screen.getByText("Control 0.3.2")).toBeInTheDocument();
  });

  it("announces a backend update without interrupting the open interface", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    let healthCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v1/health")) return response({ healthy: true, version: healthCalls++ === 0 ? "0.2.3" : "0.2.4", projects: 1 });
      return fallback(input, init);
    });

    render(<App />);
    expect(await screen.findByText("Control 0.2.3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Обновить данные" }));
    expect(await screen.findByText("Control обновлён: 0.2.3 → 0.2.4.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Обновить интерфейс" })).toBeInTheDocument();
  });

  it("reloads a failed dynamic import only once per chunk error", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const chunkError = new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:8765/assets/Tasks-old.js");
    expect(prepareChunkReload(chunkError, storage)).toBe(true);
    expect(prepareChunkReload(chunkError, storage)).toBe(false);
    expect(prepareChunkReload(new Error("server unavailable"), storage)).toBe(false);
    expect(prepareChunkReload(new Error("Failed to fetch dynamically imported module: http://127.0.0.1:8765/assets/Tasks-new.js"), storage)).toBe(true);
  });

  it("opens unread events and deep-links to their session", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/api/v1/events") && (!init?.method || init.method === "GET")) return response({ unread: 1, events: [{ id: "evt_failed", project_id: project.id, project_name: project.name, task_id: "task_1", session_id: "ses_1", run_id: null, permission_id: null, kind: "task_failed", severity: "error", resource_title: "Fix checkout", detail: "server unavailable", occurred_at: new Date().toISOString(), read_at: null }, { id: "evt_done", project_id: project.id, project_name: project.name, task_id: "task_1", session_id: "ses_1", run_id: null, permission_id: null, kind: "task_completed", severity: "info", resource_title: "Fix checkout", detail: null, occurred_at: new Date(Date.now() - 1000).toISOString(), read_at: new Date().toISOString() }] });
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    const trigger = await screen.findByRole("button", { name: "Открыть центр событий" });
    await waitFor(() => expect(trigger).toHaveTextContent("1"));
    fireEvent.click(trigger);
    expect(await screen.findByRole("region", { name: "События" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Текущий" })).toHaveClass("active");
    expect(screen.getByText("Задача завершилась с ошибкой")).toBeInTheDocument();
    expect(screen.getByText("server unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Fix checkout.*Задача завершилась с ошибкой/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/api/v1/events/evt_failed/read") && init?.method === "POST")).toBe(true));
    expect(await screen.findByRole("dialog", { name: "Сессия Fix checkout" })).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("session")).toBe("ses_1");
  });

  it("opens the Task instead of a deleted Session from an event", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/api/v1/events") && (!init?.method || init.method === "GET")) return response({ unread: 1, events: [{ id: "evt_stale", project_id: project.id, project_name: project.name, task_id: "task_1", session_id: "ses_missing", run_id: null, permission_id: null, kind: "task_failed", severity: "error", resource_title: "Fix checkout", detail: "server unavailable", occurred_at: new Date().toISOString(), read_at: null }] });
      if (path.includes("/sessions/ses_missing/messages")) return response({ detail: "session not found" }, 404);
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть центр событий" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix checkout.*Задача завершилась с ошибкой/ }));
    expect(await screen.findByRole("heading", { name: "Задачи" })).toBeInTheDocument();
    expect(location.pathname).toBe("/tasks");
    expect(new URLSearchParams(location.search).has("session")).toBe(false);
  });

  it("keeps per-session task outcomes consistent on Dashboard and Sessions", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/api/v1/dashboard")) {
        const payload = dashboardUsage();
        payload.recent_sessions = [
          { ...payload.recent_sessions[0], id: "ses_failed", title: "Failed run", status: "idle" },
          { ...payload.recent_sessions[0], id: "ses_completed", title: "Completed run", status: "idle" },
        ];
        return response(payload);
      }
      if (path.includes("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.sessions = [
          { ...payload.sessions[0], id: "ses_failed", title: "Failed run", time: { created: Date.parse("2026-01-02T10:00:00Z"), updated: Date.parse("2026-01-02T10:02:00Z") }, control_task: { id: "task_1", title: "Daily task", status: "failed", session_status: "failed", session_error: "server unavailable" } },
          { ...payload.sessions[0], id: "ses_completed", title: "Completed run", time: { created: Date.parse("2026-01-01T10:00:00Z"), updated: Date.parse("2026-01-01T10:01:00Z") }, control_task: { id: "task_1", title: "Daily task", status: "failed", session_status: "completed" } },
        ];
        payload.statuses = {};
        return response(payload);
      }
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    expect((await screen.findByText("Failed run")).closest(".dashboard-session-rows > div")).toHaveTextContent("Ошибка");
    expect(screen.getByText("Completed run").closest(".dashboard-session-rows > div")).toHaveTextContent("Завершена");

    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    const group = await screen.findByRole("button", { name: /Daily task.*Сессии · 2/ });
    expect(group).toHaveTextContent("Задача Control · 2 сессий");
    fireEvent.click(group);
    const sessionDialog = await screen.findByRole("dialog", { name: "Сессии задачи" });
    expect(sessionDialog).toHaveTextContent("Daily task · 2 сессий");
    const failedRow = screen.getByText("Failed run").closest(".task-session-browser-row");
    const completedRow = screen.getByText("Completed run").closest(".task-session-browser-row");
    expect(failedRow).toHaveTextContent(/2026.*за все время · \$0\.1200.*Ошибка/);
    expect(completedRow).toHaveTextContent(/2026.*за все время · \$0\.1200.*Завершена/);
    expect(sessionDialog).not.toHaveTextContent(/мин 00 с/);
  });

  it("switches Dashboard usage between project, global scope, and periods", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Дашборд" })).toBeInTheDocument();
    expect(await screen.findByText("openai/gpt-test")).toBeInTheDocument();
    expect(document.querySelector(".brand-mark .agent-core-mark")).not.toBeNull();
    expect(screen.getByText("Токены · сегодня")).toBeInTheDocument();
    expect(screen.getByText("Повторно из cache")).toBeInTheDocument();
    expect(screen.getByText(/Cache read показан отдельно/)).toBeInTheDocument();
    expect(screen.queryByText("Cache read")).not.toBeInTheDocument();
    expect(screen.queryByText("Cache write")).not.toBeInTheDocument();
    expect(screen.queryByText(/записано$/)).not.toBeInTheDocument();
    expect(document.querySelectorAll(".usage-composition-bar i")).toHaveLength(3);
    const usageHeading = screen.getByRole("heading", { name: "Динамика использования" });
    expect(usageHeading.querySelector("svg")).not.toBeNull();
    expect(usageHeading.parentElement?.classList.contains("panel-heading")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Все проекты" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/dashboard?scope=global"))).toBe(true));
    expect(screen.getByText("Использование OpenCode по всем проектам.")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("period=today"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "7 дней" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("period=7d"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Всё время" }));
    expect(await screen.findByRole("group", { name: "Масштаб графика" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Недели" }));
    expect(screen.getByRole("button", { name: "Недели" })).toHaveClass("active");
  });

  it("persists an English switch and updates the UI without reload", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    expect(screen.getByLabelText("Язык интерфейса: Русский")).toHaveTextContent("Русский");
    fireEvent.click(screen.getByLabelText("Язык интерфейса: Русский"));
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Tokens · today")).toBeInTheDocument();
    expect(window.localStorage.getItem("control-locale")).toBe("en");
    expect(screen.getByLabelText("Interface language: English")).toHaveTextContent("English");
    expect(document.documentElement.lang).toBe("en");
  });

  it("localizes both states of the secret copy action", async () => {
    window.localStorage.setItem("control-locale", "en");
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Secrets" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Interface language: English"));
    fireEvent.click(screen.getByRole("button", { name: "Русский" }));
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Язык интерфейса: Русский"));
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("renders the main navigation and Dashboard in persisted English", async () => {
    window.localStorage.setItem("control-locale", "en");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Project runtime")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    expect(await screen.findByRole("heading", { name: "Project settings" })).toBeInTheDocument();
    expect(screen.getByText("Project details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save shared config" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove project" })).toBeInTheDocument();
  });

  it("renders every primary screen in English", async () => {
    window.localStorage.setItem("control-locale", "en");
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    for (const [navigation, heading] of [
      ["Sessions", "Sessions"],
      ["Search", "Search"],
      ["Artifacts", "Artifacts"],
      ["Tasks", "Tasks"],
      ["Agents", "Agents"],
      ["Skills", "Skills"],
      ["Commands", "Commands"],
      ["Providers", "Providers"],
      ["Secrets", "Secrets"],
      ["MCP servers", "MCP servers"],
      ["AGENTS.md", "Shared instructions (AGENTS.md)"],
      ["Project settings", "Project settings"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: navigation }));
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
  });

  it("searches all projects and opens the matching session", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Поиск" }));
    expect(await screen.findByRole("heading", { name: "Поиск" })).toBeInTheDocument();
    const scopeSwitch = screen.getByRole("group", { name: "Область поиска" });
    const searchInput = screen.getByRole("textbox", { name: "Поиск по сессиям и сообщениям" });
    expect(scopeSwitch).toHaveClass("scope-switch");
    expect(scopeSwitch.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Текущий проект" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(searchInput, { target: { value: "deploy" } });
    await waitFor(() => expect(document.querySelector(".search-snippet")).toHaveTextContent("Rotate deployment token"));
    expect(screen.getByText("Локальный индекс обновлён: 1 сесс.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Все проекты" }));
    expect(screen.getByRole("button", { name: "Все проекты" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/api/v1/search?") && String(input).includes("scope=global"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Показать ещё" }));
    await waitFor(() => expect(Array.from(document.querySelectorAll(".search-snippet")).some((item) => item.textContent === "Deploy through the release pipeline")).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("offset=1"))).toBe(true);
    fireEvent.click(document.querySelector(".search-result")!);

    expect(await screen.findByRole("heading", { name: "Сессии" })).toBeInTheDocument();
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(/Fix checkout/);
    expect(await screen.findByText("Найдено в сообщении:")).toBeInTheDocument();
    expect(document.querySelector('[data-message-id="msg_1"]')).toHaveClass("search-target");
    expect(new URLSearchParams(location.search).get("message")).toBe("msg_1");
    expect(new URLSearchParams(location.search).get("q")).toBe("deploy");
  });

  it("opens Search with the keyboard and preserves its URL state", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("heading", { name: "Поиск" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск по сессиям и сообщениям" }), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Все проекты" }));
    await waitFor(() => expect(new URLSearchParams(location.search).get("q")).toBe("deploy"));
    expect(new URLSearchParams(location.search).get("scope")).toBe("global");
  });

  it("restores a message deep link and moves between matching messages", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([
        { info: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "Deploy the first revision" }] },
        { info: { id: "msg_2", role: "assistant", time: { created: 3, completed: 4 } }, parts: [{ type: "text", text: "Deploy the second revision" }] },
      ]);
      return fallback(input, init);
    });
    history.replaceState({}, "", `/sessions?project=${project.id}&session=ses_1&message=msg_1&q=deploy`);
    render(<App />);

    expect(await screen.findByRole("dialog")).toHaveAccessibleName(/Fix checkout/);
    await waitFor(() => expect(document.querySelector('[data-message-id="msg_1"]')).toHaveClass("search-target"));
    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Следующее совпадение" }));
    await waitFor(() => expect(document.querySelector('[data-message-id="msg_2"]')).toHaveClass("search-target"));
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("message")).toBe("msg_2");
  });

  it("browses project and global artifacts and opens the source message", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:artifacts") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Артефакты" }));
    expect(await screen.findByRole("heading", { name: "Артефакты" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Область артефактов" })).toHaveClass("scope-switch");
    expect(await screen.findByRole("img", { name: "result.png" })).toBeInTheDocument();
    expect(screen.getByText(/2.0 KiB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Показать result.png в Finder" })).toHaveClass("reveal");
    fireEvent.click(screen.getByRole("button", { name: "Показать result.png в Finder" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/api/v1/artifacts/artifact-1/reveal"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Переместить result.png в Корзину" }));
    expect(await screen.findByRole("dialog", { name: "Переместить result.png в Корзину?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));

    fireEvent.click(screen.getByRole("button", { name: "Все проекты" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/api/v1/artifacts?scope=global"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Данные" }));
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("type")).toBe("data");
    expect(screen.getByText("1 из 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    fireEvent.click(screen.getByRole("button", { name: "Выбрать все" }));
    expect(screen.getByRole("button", { name: "Экспортировать ZIP (1)" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Все", pressed: false }));
    fireEvent.change(screen.getByRole("combobox", { name: "Сортировка" }), { target: { value: "largest" } });
    expect(document.querySelector(".artifact-info strong")).toHaveTextContent("report.pdf");
    expect(new URLSearchParams(location.search).get("sort")).toBe("largest");
    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    fireEvent.click(screen.getByRole("button", { name: "Выбрать result.png" }));
    expect(screen.getByRole("button", { name: "Снять выбор result.png" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Снять выбор result.png" }));
    expect(screen.getByRole("button", { name: "Выбрать result.png" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Выбрать result.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Выбрать report.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Экспортировать ZIP (2)" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/api/v1/artifacts/archive") && String(init?.body).includes("artifact-2"))).toBe(true));
    await waitFor(() => expect(anchorClick).toHaveBeenCalled(), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "В Корзину (2)" }));
    expect(await screen.findByRole("dialog", { name: "Переместить 2 артефактов в Корзину?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Переместить в Корзину" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/api/v1/artifacts/trash"))).toBe(true));
    fireEvent.change(screen.getByRole("combobox", { name: "Сортировка" }), { target: { value: "newest" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть артефакт result.png" }));
    expect(await screen.findByRole("dialog", { name: "Просмотр артефактов" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Показать result.png в Finder" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Следующий артефакт" }));
    await waitFor(() => expect(document.querySelector(".artifact-pdf")).toHaveAttribute("title", "report.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Следующий артефакт" }));
    expect(await screen.findByRole("columnheader", { name: "id" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "test" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Fix checkout" }));

    expect(await screen.findByRole("dialog", { name: /Сессия Fix checkout/ })).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("message")).toBe("msg_1");
  });

  it("creates English resource templates when English is active", async () => {
    window.localStorage.setItem("control-locale", "en");
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create skill" }));
    const markdown = screen.getByLabelText("Markdown skill") as HTMLTextAreaElement;
    expect(markdown.value).toContain("# Workflow");
    expect(markdown.value).toContain("report in English");
    expect(markdown.value).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("edits project and global OpenCode configurations separately", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "stopped", errors: [], sessions: [], statuses: {}, agents: [], mcp: {}, providers: { connected: [], available: [] }, server: project.server });
      if (path.endsWith("/configuration") && (!init?.method || init.method === "GET")) return response({ project: { model: "openai/project" }, project_path: "/code/checkout/opencode.jsonc", global: { model: "openai/global" }, global_path: "/home/dev/.config/opencode/opencode.jsonc" });
      if (path.endsWith("/configuration") && init?.method === "PATCH") return response({});
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response([]);
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Настройки проекта" }));
    expect(await screen.findByText("/code/checkout/opencode.jsonc")).toBeInTheDocument();
    expect(screen.getAllByText("/home/dev/.config/opencode/opencode.jsonc")).toHaveLength(2);
    const globalEditor = screen.getByLabelText("Общая конфигурация OpenCode");
    fireEvent.change(globalEditor, { target: { value: '{"model":"openai/new-global"}' } });
    await waitFor(() => expect(globalEditor).toHaveValue('{"model":"openai/new-global"}'));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить общую" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        if (!String(input).endsWith("/configuration") || init?.method !== "PATCH") return false;
        return JSON.parse(String(init.body)).scope === "global";
      });
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ values: { model: "openai/new-global" }, scope: "global" });
    });
  });

  it("shows invalid JSON next to the configuration editor and saves after correction", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "stopped", errors: [], sessions: [], statuses: {}, agents: [], mcp: {}, providers: { connected: [], available: [] }, server: project.server });
      if (path.endsWith("/configuration") && (!init?.method || init.method === "GET")) return response({ project: {}, project_path: "/code/checkout/opencode.json", global: { provider: {} }, global_path: "/home/dev/.config/opencode/opencode.jsonc" });
      if (path.endsWith("/configuration") && init?.method === "PATCH") return response({});
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response([]);
    }));

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Настройки проекта" }));
    await screen.findAllByText("/home/dev/.config/opencode/opencode.jsonc");
    const editor = screen.getByLabelText("Общая конфигурация OpenCode");
    fireEvent.change(editor, { target: { value: '{\n  "provider": {\n    "ornith:35b": { "name:" "Ornith:35b-Local" }\n  }\n}' } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить общую" }));

    expect(await screen.findByText(/Не удалось сохранить общую конфигурацию: Некорректный JSON/)).toBeInTheDocument();
    expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/configuration") && init?.method === "PATCH")).toBe(false);

    fireEvent.change(editor, { target: { value: '{"provider":{"ornith:35b":{"name":"Ornith:35b-Local"}}}' } });
    expect(screen.queryByText(/Некорректный JSON/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить общую" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/configuration") && init?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ values: { provider: { "ornith:35b": { name: "Ornith:35b-Local" } } }, scope: "global" });
    });
  });

  it("manages file-backed secrets without receiving their values", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "stopped", errors: [], sessions: [], statuses: {}, agents: [], mcp: {}, providers: { connected: [], available: [] }, server: project.server });
      if (path.endsWith("/api/v1/secrets") && (!init?.method || init.method === "GET")) return response([{ name: "context7_api_key", path: "/home/dev/.config/opencode/secrets/context7_api_key", reference: "{file:~/.config/opencode/secrets/context7_api_key}" }]);
      if (path.endsWith("/api/v1/secrets/github_token") && init?.method === "PUT") return response({ name: "github_token", path: "/home/dev/.config/opencode/secrets/github_token", reference: "{file:~/.config/opencode/secrets/github_token}" });
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response({});
    }));

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Секреты" }));
    expect(await screen.findByText("context7_api_key")).toBeInTheDocument();
    expect(screen.getByText("{file:~/.config/opencode/secrets/context7_api_key}")).toBeInTheDocument();
    expect(screen.queryByText("ctx7-secret")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить secret" }));
    fireEvent.change(screen.getByPlaceholderText("context7_api_key"), { target: { value: "github_token" } });
    fireEvent.change(screen.getByPlaceholderText("Вставьте API-ключ"), { target: { value: "github-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить secret" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/v1/secrets/github_token") && init?.method === "PUT");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ value: "github-secret" });
      expect(new Headers(call?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    });
    expect(screen.queryByText("github-secret")).not.toBeInTheDocument();
  });

  it("shows consistent AGENTS.md status and themed save actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "stopped", errors: [], sessions: [], statuses: {}, agents: [], mcp: {}, providers: { connected: [], available: [] }, server: project.server });
      if (path.endsWith("/instructions")) return response({ content: "# Project", path: "/code/checkout/AGENTS.md", global_content: "", global_path: "/home/dev/.config/opencode/AGENTS.md", global_exists: false });
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response({});
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "AGENTS.md" }));
    expect(await screen.findByText("/code/checkout/AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText("файл создан")).toHaveClass("state-enabled");
    expect(screen.getByText("не создан")).toHaveClass("state-pending");
    expect(screen.getByRole("button", { name: "Сохранить проектный файл" })).toHaveClass("primary-button", "instruction-save");
    expect(screen.getByRole("button", { name: "Сохранить глобальный файл" })).toHaveClass("primary-button", "instruction-save");
  });

  it("renders onboarding when no projects are registered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([])));
    render(<App />);
    expect(await screen.findByText(/Весь OpenCode/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Добавить первый проект" })).toBeInTheDocument();
  });

  it("selects a native project folder and preserves a custom project name", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    let selections = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v1/system/select-directory") && init?.method === "POST") { const index = selections++; return index === 0 ? response({ path: "/code/Selected Project" }) : index === 1 ? response({ path: "/code/Another Project" }) : response({ detail: "native directory picker is unavailable" }, 501); }
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: /Текущий проект.*Checkout API/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Выбрать" }));
    expect(await screen.findByDisplayValue("/code/Selected Project")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Selected Project")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Selected Project"), { target: { value: "Custom workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(await screen.findByDisplayValue("/code/Another Project")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Custom workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(await screen.findByText("Системный выбор папки недоступен. Введите путь вручную.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/code/Another Project")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/api/v1/system/select-directory") && init?.method === "POST")).toHaveLength(3);
  });

  it("shows persistent startup diagnostics and OpenCode compatibility", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const diagnosticServer = { state: "stopped", managed: false, endpoint: null, compatibility: { state: "untested_newer", version: "1.19.0", message: "Newer OpenCode version" }, last_error: { phase: "startup", summary: "OpenCode exited during startup", timestamp: "now", log_path: "/tmp/project.log", exit_code: 1, detail: "Configuration is invalid" } };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v1/projects")) return response([{ ...project, server: diagnosticServer }]);
      if (String(input).endsWith(`/projects/${project.id}/server`)) return response(diagnosticServer);
      return fallback(input, init);
    });
    render(<App />);
    expect(await screen.findByText("OpenCode exited during startup")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Запустить сервер OpenCode" })).toHaveTextContent("1.19.0");
    fireEvent.click(screen.getByText("OpenCode exited during startup"));
    expect(screen.getByText("Configuration is invalid")).toBeInTheDocument();
    expect(screen.getByText("/tmp/project.log")).toBeInTheDocument();
  });

  it("separates main and child subagent sessions", async () => {
    render(<App />);
    expect(await screen.findByText("Fix checkout")).toBeInTheDocument();
    expect(screen.queryByText("Inspect API")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    expect(await screen.findByText("Дочерние сессии подагентов: 1")).toBeInTheDocument();
    expect(screen.queryByText("Inspect API")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Показать дочерние сессии" }));
    expect(await screen.findByText("Inspect API")).toBeInTheDocument();
    expect(screen.getAllByText(/Задача: Fix checkout task/).length).toBeGreaterThan(0);
  });

  it("deletes a session from Control", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    await screen.findByText("Fix checkout");
    fireEvent.click(screen.getByRole("button", { name: "Удалить сессию" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/sessions/ses_1") && init?.method === "DELETE")).toBe(true));
  });

  it("keeps Tasks usable with an older backend snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "connected", errors: [], sessions: [], statuses: {}, agents: [], mcp: {}, providers: {}, server: project.server });
      if (path.includes("/tasks")) return response([]);
      return response([]);
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    expect(await screen.findByRole("heading", { name: "Задачи" })).toBeInTheDocument();
    expect(screen.queryByText("Раздел не удалось открыть")).not.toBeInTheDocument();
  });

  it("shows the reasoning level on every task card", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    const card = (await screen.findByText("Fix checkout task")).closest(".task-card");
    expect(card?.querySelector(".task-meta")?.textContent).toContain("Рассуждениепо умолчанию");
  });

  it("keeps agent and connected-model pickers open until selection", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    fireEvent.click(screen.getByRole("button", { name: "Агент: по умолчанию" }));
    expect(screen.getByRole("option", { name: /build/ })).toBeInTheDocument();
    expect(screen.getByRole("listbox").closest(".modal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Модель: openai/gpt-test" }));
    expect(screen.getByPlaceholderText("Поиск модели")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /openai\/gpt-test/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Поиск модели").closest(".picker-menu")).toHaveClass("picker-portal");
    expect(screen.getByRole("button", { name: "Рассуждение: по умолчанию" })).toBeInTheDocument();
  });

  it("keeps the selected agent, model, and reasoning level for the next task", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    fireEvent.click(screen.getByRole("button", { name: "Агент: по умолчанию" }));
    fireEvent.click(screen.getByRole("option", { name: /build/ }));
    fireEvent.click(screen.getByRole("button", { name: "Рассуждение: по умолчанию" }));
    fireEvent.click(screen.getByRole("option", { name: /^high/ }));
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Первая задача" } });
    fireEvent.change(screen.getByPlaceholderText(/Опишите задачу/), { target: { value: "Проверить выбор агента" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить агента" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Запустить задачу" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Запустить задачу" }));
    expect(screen.getByRole("button", { name: "Агент: build" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Модель: openai/gpt-test" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Рассуждение: high" })).toBeInTheDocument();
  });

  it("offers Slash Commands and subagent mentions when creating a task", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/commands")) return response([{ id: "fix", description: "Исправить проблему", content: "Fix $ARGUMENTS", kind: "command" }]);
      if (path.endsWith("/tasks") && init?.method === "POST") return response({ id: "task_new" });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    const prompt = screen.getByPlaceholderText(/Опишите задачу/);
    fireEvent.change(prompt, { target: { value: "/f" } });
    fireEvent.click(await screen.findByRole("option", { name: /\/fix/ }));
    fireEvent.change(prompt, { target: { value: "@g", selectionStart: 2 } });
    expect(await screen.findByRole("option", { name: /@general/ })).toBeInTheDocument();
    fireEvent.change(prompt, { target: { value: "/fix авторизацию" } });
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Исправить авторизацию" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить агента" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/tasks") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ title: "Исправить авторизацию", prompt: "/fix авторизацию" });
    });
  });

  it("runs a Slash Command as the first message of a new session", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/commands")) return response([{ id: "fix", description: "Исправить проблему", content: "Fix $ARGUMENTS", kind: "command" }]);
      if (path.endsWith("/sessions") && init?.method === "POST") return response({ id: "ses_new" });
      if (path.includes("/sessions/ses_new/commands/fix") && init?.method === "POST") return response({});
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(screen.getByRole("button", { name: "Новая сессия" }));
    const prompt = screen.getByPlaceholderText("Первое сообщение…");
    fireEvent.change(prompt, { target: { value: "/f" } });
    fireEvent.click(await screen.findByRole("option", { name: /\/fix/ }));
    fireEvent.change(prompt, { target: { value: "/fix авторизацию" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать сессию" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/sessions/ses_new/commands/fix") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ arguments: "авторизацию", agent: null, model: null });
    });
  });

  it("connects a provider with an API key from Control", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/providers/auth")) return response([{ id: "openai", name: "OpenAI", connected: false, methods: [{ type: "api", label: "API key" }] }]);
      if (path.endsWith("/providers/openai/auth") && init?.method === "PUT") return response({ connected: true });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Провайдеры" }));
    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
    fireEvent.change(screen.getByPlaceholderText("Вставьте ключ провайдера"), { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/providers/openai/auth") && init?.method === "PUT");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ key: "test-secret", metadata: {} });
    });
  });

  it("adds Ollama as a configured provider", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/providers/auth")) return response([]);
      if (path.endsWith("/providers/ollama/configuration") && init?.method === "PUT") return response({ id: "ollama" });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Провайдеры" }));
    fireEvent.click(await screen.findByRole("button", { name: "Добавить своего провайдера" }));
    fireEvent.change(screen.getByPlaceholderText(/qwen3-coder/), { target: { value: "qwen3-coder:30b" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить провайдера" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/providers/ollama/configuration") && init?.method === "PUT");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: "Ollama (local)", base_url: "http://localhost:11434/v1", models: ["qwen3-coder:30b"], api_key: null });
    });
  });

  it("continues an existing session with another prompt", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "Проверь исправление тестами" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/sessions/ses_1/prompt") && init?.method === "POST")).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/sessions/ses_1/prompt") && init?.method === "POST");
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body).toMatchObject({ prompt: "Проверь исправление тестами", attachments: [] });
      expect(body).not.toHaveProperty("mentions");
    });
  });

  it("preserves sessions while OpenCode reconnects after a degraded snapshot", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    let degraded = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/snapshot") && degraded) return response({ state: "degraded", errors: ["statuses_unavailable"], sessions: [], statuses: {}, agents: [], mcp: {}, providers: { connected: [], available: [] }, server: { state: "running", managed: true, endpoint: "http://127.0.0.1:4096" } });
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("dialog", { name: "Сессия Fix checkout" })).toBeInTheDocument();

    degraded = true;
    fireEvent.click(screen.getByRole("button", { name: "Обновить данные" }));
    expect(await screen.findByText(/OpenCode переподключается/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Сессия Fix checkout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Остановить сессию" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Удалить сессию" })).toBeDisabled();

    degraded = false;
    fireEvent.click(screen.getByRole("button", { name: "Обновить данные" }));
    await waitFor(() => expect(screen.queryByText(/OpenCode переподключается/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Остановить сессию" })).toBeEnabled();
  });

  it("replaces a persisted failure with running when the session is continued", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.statuses = {};
        payload.sessions[0].control_task = { ...payload.sessions[0].control_task, status: "failed", session_status: "failed", session_error: "server unavailable" };
        return response(payload);
      }
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const dialog = await screen.findByRole("dialog", { name: "Сессия Fix checkout" });
    expect(dialog.querySelector('.status[data-status="failed"]')).toHaveTextContent("Ошибка");

    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "Продолжи выполнение" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));
    await waitFor(() => expect(dialog.querySelector('.status[data-status="busy"]')).toHaveTextContent("Выполняется"));
    expect(dialog.querySelector('.status[data-status="failed"]')).not.toBeInTheDocument();
  });

  it("shows a recovered session as completed after an earlier provider failure", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.statuses = {};
        payload.sessions[0].control_task = { ...payload.sessions[0].control_task, status: "scheduled", session_status: "failed", session_error: "server unavailable", session_updated_at: new Date(Date.now() - 45_000).toISOString() };
        return response(payload);
      }
      if (path.includes("/sessions/ses_1/messages")) return response([
        { info: { id: "msg_failed", role: "assistant", error: "server unavailable", time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "" }] },
        { info: { id: "msg_user", role: "user", time: { created: Date.now() - 30_000 } }, parts: [{ type: "text", text: "continue" }] },
        { info: { id: "msg_done", role: "assistant", finish: "stop", time: { created: Date.now() - 20_000, completed: Date.now() - 10_000 } }, parts: [{ type: "text", text: "Done" }, { type: "step-finish" }] },
      ]);
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const dialog = await screen.findByRole("dialog", { name: "Сессия Fix checkout" });
    await waitFor(() => expect(dialog.querySelector('.status[data-status="completed"]')).toHaveTextContent("Завершена"));
    expect(screen.getByText("server unavailable")).toBeInTheDocument();
  });

  it("replaces send with stop while the agent is active", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_live", role: "assistant", time: { created: Date.now() } }, parts: [{ type: "step-start" }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const stop = await screen.findByRole("button", { name: "Остановить ответ" });
    expect(screen.queryByRole("button", { name: "Отправить в эту сессию" })).not.toBeInTheDocument();
    fireEvent.click(stop);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/sessions/ses_1/abort") && init?.method === "POST")).toBe(true));
  });

  it("mentions a subagent with @ and sends a native mention", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "@ex", selectionStart: 3 } });
    const option = await screen.findByRole("option", { name: /@explore/ });
    expect(option.closest(".agent-mention-menu")?.previousElementSibling).toBe(textarea);
    fireEvent.click(option);
    fireEvent.change(textarea, { target: { value: "@explore найди реализацию" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/sessions/ses_1/prompt") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ prompt: "@explore найди реализацию", mentions: ["explore"] });
    });
  });

  it("remembers agent and model for each session", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    fireEvent.click(screen.getByRole("button", { name: "Агент: build" }));
    fireEvent.click(screen.getByRole("option", { name: /plan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Модель: openai/gpt-test" }));
    fireEvent.click(screen.getByRole("option", { name: /openai\/gpt-other/ }));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "Проверь ещё раз" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));
    await waitFor(() => expect(window.localStorage.getItem(`control-session-selection:${project.id}:ses_1`)).toBe(JSON.stringify({ agent: "plan", model: "openai/gpt-other", variant: "" })));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть сессию" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("button", { name: "Агент: plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Модель: openai/gpt-other" })).toBeInTheDocument();
  });

  it("shows one white task title without the session id", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const dialog = await screen.findByRole("dialog", { name: "Сессия Fix checkout" });
    expect(dialog).not.toHaveTextContent("ses_1");
    expect(dialog.querySelector(".drawer-title-row h2")).toHaveTextContent("Fix checkout task");
    expect(dialog.querySelector(".drawer-title-row h2")).not.toHaveAttribute("data-status");
    expect(dialog.querySelector('.status[data-status="idle"]')).toHaveTextContent("Завершена");
  });

  it("keeps an aborted task stopped and allows continuing its session", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/tasks") && (!init?.method || init.method === "GET")) return response([{ id: "task_1", project_id: project.id, title: "Fix checkout task", prompt: "Fix it", agent: "plan", model: "openai/gpt-other", status: "aborted", session_id: "ses_1", session_ids: ["ses_1"], error: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_waiting", role: "user", agent: "plan", model: { providerID: "openai", modelID: "gpt-other" } }, parts: [{ type: "text", text: "Последнее сообщение перед остановкой" }] }]);
      if (path.endsWith("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.statuses = { ses_1: { type: "busy" } };
        payload.sessions[0].control_task.status = "running";
        return response(payload);
      }
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сессии · 1" }));
    const sessionList = await screen.findByRole("dialog", { name: "Сессии задачи" });
    fireEvent.click(sessionList.querySelector<HTMLElement>(".task-session-browser-row")!);
    const dialog = await screen.findByRole("dialog", { name: "Сессия Fix checkout" });
    expect(dialog.querySelector('.status[data-status="aborted"]')).toHaveTextContent("Остановлено");
    expect(screen.getByRole("button", { name: "Отправить в эту сессию" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Остановить ответ" })).not.toBeInTheDocument();
  });

  it("treats step-finish as a completed response without completed time", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_done", role: "assistant", time: { created: Date.now() - 1000 } }, parts: [{ type: "step-start" }, { type: "step-finish", reason: "stop", duration: 9000 }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("button", { name: "Отправить в эту сессию" })).toBeInTheDocument();
    expect(screen.getByText(/stop · 9 с всего/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Остановить ответ" })).not.toBeInTheDocument();
  });

  it("offers a manual jump to the latest message", async () => {
    const scrollTo = vi.fn();
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const stream = (await screen.findByRole("dialog", { name: "Сессия Fix checkout" })).querySelector<HTMLElement>(".message-stream")!;
    Object.defineProperties(stream, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 100 } });
    Object.defineProperty(stream, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.scroll(stream);
    fireEvent.click(screen.getByRole("button", { name: "Перейти к последнему сообщению" }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" }));
  });

  it("adds dropped files from the whole chat composer", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const composer = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…").closest(".composer-box")!;
    const file = new File(["notes"], "review.md", { type: "text/markdown" });
    fireEvent.drop(composer, { dataTransfer: { files: [file] } });
    expect(await screen.findByText("review.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/sessions/ses_1/prompt") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ prompt: "", attachments: [{ filename: "review.md", mime: "text/markdown" }] });
    });
  });

  it("renders session messages as safe Markdown", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_1", role: "assistant", tokens: { input: 210, output: 864, reasoning: 1331, cache: { read: 116352, write: 0 } } }, parts: [{ type: "text", text: "# Проверка\n\n**готово**\n\n- первый пункт\n\n<script>alert(1)</script>" }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("heading", { name: "Проверка" })).toBeInTheDocument();
    expect(screen.getByText("готово").tagName).toBe("STRONG");
    expect(screen.getByText("первый пункт").tagName).toBe("LI");
    expect(screen.getByText(/118.757/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("opens local project images in an in-app gallery", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_image", role: "assistant" }, parts: [{ type: "text", text: "Создан [рисунок](output.png)\n\nФайл находится здесь: `/code/checkout/output.png`\n\n![вложенный](images/preview.webp)\n\n![remote](https://example.test/image.png)" }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));

    const images = await screen.findAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("src", expect.stringContaining(`/api/v1/projects/${project.id}/media?path=output.png`));
    expect(screen.queryByText("/code/checkout/output.png")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Открыть" })).not.toBeInTheDocument();
    const revealButtons = screen.getAllByRole("button", { name: /Показать .* в Finder/ });
    expect(revealButtons).toHaveLength(2);
    expect(revealButtons.every((button) => button.classList.contains("reveal"))).toBe(true);
    expect(screen.getAllByRole("button", { name: /Переместить .* в Корзину/ })).toHaveLength(2);
    fireEvent.click(revealButtons[0]);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes(`/api/v1/projects/${project.id}/artifact/reveal`) && String(init?.body).includes("output.png"))).toBe(true));
    expect(screen.getByText("Изображение: remote")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Увеличить изображение output.png" }));
    const viewer = await screen.findByRole("dialog", { name: "Просмотр изображений" });
    expect(viewer).toHaveTextContent("1 / 2");
    expect(viewer.querySelector("img")).toHaveAttribute("src", expect.stringContaining("path=output.png"));
    fireEvent.click(screen.getByRole("button", { name: "Следующее изображение" }));
    expect(viewer).toHaveTextContent("2 / 2");
    expect(viewer.querySelector("img")).toHaveAttribute("src", expect.stringContaining("images%2Fpreview.webp"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Просмотр изображений" })).not.toBeInTheDocument());
  });

  it("shows provider errors without message parts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "connected", errors: [], sessions: [{ id: "ses_1", title: "Fix checkout", agent: "build" }], statuses: { ses_1: { type: "busy" } }, agents: [{ name: "build", mode: "primary" }], mcp: {}, providers: { connected: ["openai"], available: [{ id: "openai", model_count: 1, models: ["openai/gpt-test"] }] }, config: { model: "openai/gpt-test" }, server: project.server });
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_error", role: "assistant", agent: "build", providerID: "openai", modelID: "gpt-test", error: "Forbidden" }, parts: [] }]);
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response([]);
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByText("Forbidden")).toBeInTheDocument();
    expect(screen.getByText("build · openai/gpt-test")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Сессия Fix checkout" }).querySelector('.status[data-status="failed"]')).toHaveTextContent("Ошибка");
    expect(screen.getByRole("button", { name: "Отправить в эту сессию" })).toBeInTheDocument();
  });

  it("does not keep a stale unfinished response running", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_stale", role: "assistant", time: { created: Date.now() - 16 * 60 * 1000 } }, parts: [{ type: "step-start" }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("button", { name: "Отправить в эту сессию" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Остановить ответ" })).not.toBeInTheDocument();
  });

  it("shows tools, active todos, permissions and MCP runtime", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_tool", role: "assistant" }, parts: [{ type: "tool", tool: "context7_query-docs", state: { status: "completed", title: "Получить документацию", output: "Готово" } }] }]);
      if (path.includes("/sessions/ses_1/todos")) return response([{ content: "Проверить файл", status: "in_progress", priority: "high" }, { content: "Старый пункт", status: "completed", priority: "low" }]);
      if (path.includes("/sessions/ses_1/permissions") && (!init?.method || init.method === "GET")) return response([{ id: "per_1", permission: "bash", patterns: ["npm test"] }]);
      if (path.includes("/permissions/per_1/reply") && init?.method === "POST") return response({ replied: true });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByText("Получить документацию")).toBeInTheDocument();
    expect(screen.getByText("MCP / context7_query-docs")).toBeInTheDocument();
    expect(await screen.findByText("Проверить файл")).toBeInTheDocument();
    expect(screen.queryByText("Старый пункт")).not.toBeInTheDocument();
    expect(screen.getByText("context7")).toBeInTheDocument();
    expect(screen.queryByText("xlsx")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Разрешить один раз" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/permissions/per_1/reply") && init?.method === "POST")).toBe(true));
  });

  it("answers and rejects pending OpenCode questions", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/sessions/ses_1/questions") && (!init?.method || init.method === "GET")) return response([{ id: "que_1", questions: [{ header: "Target", question: "Where should files go?", options: [{ label: "Current repo", description: "Write here" }], multiple: false, custom: true }, { header: "Features", question: "Which features?", options: [{ label: "Flux", description: "Use Flux" }, { label: "ESO", description: "Use External Secrets" }], multiple: true, custom: false }] }]);
      if (path.includes("/questions/que_1/reply") && init?.method === "POST") return response({ replied: true });
      if (path.includes("/questions/que_1/reject") && init?.method === "POST") return response({ rejected: true });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByText("Требуется ответ")).toBeInTheDocument();
    expect(screen.getByText("Where should files go?")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Введите другой вариант…"), { target: { value: "New GitOps repo" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Flux/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /ESO/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ответить и продолжить" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/questions/que_1/reply") && init?.method === "POST" && String(init.body).includes('[["New GitOps repo"],["Flux","ESO"]]'))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Отклонить вопрос" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/questions/que_1/reject") && init?.method === "POST")).toBe(true));
  });

  it("shows complete shell commands and output like the OpenCode CLI", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_shell", role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", command: "python3 script.py --all", workdir: "/tmp/project", output: "Fetching…\nfirst result\nlast result", full_output: true, exit_code: 0, time: { start: 1000, end: 7500 } } }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const command = await screen.findByText("$ python3 script.py --all");
    const tool = command.closest("details")!;
    expect(tool).not.toHaveAttribute("open");
    fireEvent.click(command);
    expect(tool).toHaveAttribute("open");
    expect(tool).toHaveTextContent("bash · 6 с · exit 0 · /tmp/project");
    expect(tool).toHaveTextContent("Fetching…");
    expect(tool).toHaveTextContent("last result");
    expect(tool).not.toHaveTextContent("output truncated");
  });

  it("derives busy status and elapsed time from an unfinished message", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_live", role: "assistant", time: { created: Date.now() - 5_000 } }, parts: [{ type: "step-start" }, { type: "tool", tool: "webfetch", state: { status: "running", title: "Загрузка", time: { start: Date.now() - 3_000 } } }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const dialog = await screen.findByRole("dialog", { name: /Сессия Fix checkout/ });
    await waitFor(() => expect(dialog.querySelector(".status")).toHaveTextContent("Выполняется"));
    const liveToolTitle = await screen.findByText(/webfetch · [3-9] с/);
    const liveTool = liveToolTitle.closest("details")!;
    expect(liveTool).not.toHaveAttribute("open");
    fireEvent.click(liveToolTitle);
    expect(liveTool).toHaveAttribute("open");
    expect(dialog.querySelector(".message")).not.toHaveTextContent("$");
  });

  it("stops superseded unfinished tools instead of accumulating elapsed time", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const started = Date.now() - 3_600_000;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([
        { info: { id: "msg_stale", role: "assistant", time: { created: started }, tokens: { output: 0 }, cost: 0 }, parts: [{ type: "step-start" }, { type: "tool", tool: "read", state: { status: "running", title: "Старое чтение", time: { start: started + 1_000 } } }] },
        { info: { id: "msg_next_user", role: "user", time: { created: started + 60_000 } }, parts: [{ type: "text", text: "Продолжить" }] },
        { info: { id: "msg_done", role: "assistant", time: { created: started + 61_000, completed: started + 63_000 } }, parts: [{ type: "text", text: "Готово" }, { type: "step-finish", reason: "stop" }] },
      ]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const staleTool = (await screen.findByText("Старое чтение")).closest("details")!;
    expect(staleTool).toHaveTextContent("read · 59 с");
    expect(staleTool.querySelector('.status[data-status="aborted"]')).toHaveTextContent("Остановлено");
    expect(staleTool).not.toHaveTextContent("Выполняется");
    expect(staleTool.closest(".message")).toHaveTextContent("1 мин 00 с");
    expect(screen.getByText("Продолжить").closest(".message")?.querySelector("time")).not.toHaveTextContent("мин");
  });

  it("resizes the session drawer with its left handle", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const handle = await screen.findByRole("separator", { name: "Изменить ширину окна сессии" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(Number(window.localStorage.getItem("control-session-drawer-width"))).toBeLessThan(960);
  });

  it("shows Git changes, diff and creates a commit", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    let staged = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/git") && (!init?.method || init.method === "GET")) return response({ available: true, branch: "main", changes: [{ path: "src/app.ts", status: staged ? "A " : "??", staged, unstaged: !staged }], commits: [{ hash: "abc", short_hash: "abc1234", author: "Dev", timestamp: 1_784_540_000, subject: "Previous change" }] });
      if (path.includes("/git/diff")) return response({ path: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
      if (path.endsWith("/git/stage") && init?.method === "POST") { staged = true; return response({}); }
      if (path.endsWith("/git/unstage") && init?.method === "POST") { staged = false; return response({}); }
      if (path.endsWith("/git/commit") && init?.method === "POST") return response({ committed: true, hash: "def" });
      if (path.endsWith("/git/revert") && init?.method === "POST") return response({ reverted: true, hash: "ghi" });
      if (path.endsWith("/git/reset") && init?.method === "POST") return response({ reset: true, hash: "abc", backup_branch: "control-backup/test-def5678" });
      if (path.includes("/sessions/ses_1/todos")) return response([{ content: "Проверить Git index", status: "in_progress", priority: "high" }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect((await screen.findAllByText("src/app.ts")).length).toBeGreaterThan(0);
    expect(screen.getByText("Новый")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: /Сессия Fix checkout/ });
    expect(dialog).toHaveClass("git-visible");
    const reply = dialog.querySelector(".session-conversation .session-reply");
    expect(reply).toBeInTheDocument();
    expect(reply?.querySelector(".attachment-button")).toBeInTheDocument();
    expect(reply?.querySelector('[aria-label^="Агент:"]')).toBeInTheDocument();
    expect(reply?.querySelector(".model-picker")).toBeInTheDocument();
    expect(reply?.querySelector(".composer-send")).toBeInTheDocument();
    await waitFor(() => expect(dialog.querySelector(".session-inspector")).toHaveTextContent("Проверить Git index"));
    expect(dialog.querySelector(".git-panel")?.parentElement).toHaveClass("session-workspace");
    for (let index = 0; index < 9; index += 1) fireEvent.keyDown(screen.getByRole("separator", { name: "Изменить ширину Git-панели" }), { key: "ArrowRight" });
    expect(Number(window.localStorage.getItem("control-git-panel-width"))).toBeGreaterThan(520);
    await waitFor(() => expect(document.querySelector(".git-diff")).toHaveTextContent("+new"));
    fireEvent.click(screen.getByRole("button", { name: "Развернуть diff" }));
    expect(dialog.querySelector(".git-panel")).toHaveClass("diff-focused");
    fireEvent.click(screen.getByRole("button", { name: "Вернуть Git-панель" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Выбрать src/app.ts" }));
    expect(screen.getByRole("button", { name: "Справка по Git-панели" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Добавить выбранные" }));
    await waitFor(() => expect(screen.getByText(/В коммите 1/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Убрать выбранные" }));
    await waitFor(() => expect(screen.getByText(/В коммите 0/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Добавить все" }));
    await waitFor(() => expect(screen.getByText(/В коммите 1/)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Сообщение для/), { target: { value: "Apply agent changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать коммит" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/git/commit") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ message: "Apply agent changes", paths: ["src/app.ts"] });
    });
    fireEvent.click(screen.getByRole("button", { name: "Коммиты" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти к abc1234" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/git/reset") && init?.method === "POST")).toBe(true));
    expect(await screen.findByText(/control-backup\/test-def5678/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Обратить изменения abc1234" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/git/revert") && init?.method === "POST")).toBe(true));
  });

  it("saves a new agent in the selected global scope", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Агенты" }));
    fireEvent.click(await screen.findByRole("button", { name: "Создать агента" }));
    fireEvent.change(screen.getByPlaceholderText("security-reviewer"), { target: { value: "reviewer" } });
    fireEvent.change(screen.getByLabelText(/Режим агента/), { target: { value: "primary" } });
    fireEvent.change(screen.getByLabelText(/Область действия/), { target: { value: "global" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/agents/reviewer") && init?.method === "PUT");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ scope: "global" });
      expect(JSON.parse(String(call?.[1]?.body)).content).toContain("mode: primary");
    });
  });

  it("applies an MCP project override in one backend operation", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    fireEvent.click((await screen.findByRole("heading", { name: "context7" })).closest("button")!);
    fireEvent.change(screen.getByLabelText("Где действует настройка"), { target: { value: "project" } });
    fireEvent.click(screen.getByRole("button", { name: "Выключить для проекта" }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      expect(calls.some(([input, init]) => String(input).includes("/mcp/context7/enabled") && init?.method === "PATCH")).toBe(true);
      expect(calls.some(([input, init]) => String(input).endsWith("/server/restart") && init?.method === "POST")).toBe(false);
    });
  });

  it("updates a global MCP in one backend operation", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    fireEvent.click((await screen.findByRole("heading", { name: "context7" })).closest("button")!);
    expect(screen.getAllByText("Сейчас в OpenCode").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Отключить сейчас" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выключить для всех" }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      const toggle = calls.find(([input, init]) => String(input).includes("/mcp/context7/enabled") && init?.method === "PATCH");
      expect(JSON.parse(String(toggle?.[1]?.body))).toEqual({ enabled: false, scope: "global" });
      expect(calls.some(([input, init]) => String(input).endsWith("/api/v1/servers/restart") && init?.method === "POST")).toBe(false);
    });
  });

  it("recognizes a copied stdio MCP descriptor", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    fireEvent.click(await screen.findByRole("button", { name: "Добавить MCP" }));
    fireEvent.change(screen.getByLabelText("Имя сервера"), { target: { value: "pencil" } });
    fireEvent.change(screen.getByLabelText("JSON-конфигурация MCP-сервера"), { target: { value: JSON.stringify({ name: "pencil", transport: "stdio", command: "/Applications/Pen.app/mcp-server", args: ["--app", "desktop"], env: {} }) } });
    expect(screen.getByText(/Обнаружен стандартный stdio-формат/)).toBeInTheDocument();
  });

  it("shows a structured MCP preflight error without a restart request", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/mcp/context7/enabled") && init?.method === "PATCH") return response({ detail: { state: "rejected", message: "OpenCode rejected the candidate configuration", preflight: { [project.id]: { valid: false, version: "1.18.5", error: "mcp.context7.url is invalid" } } } }, 422);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    fireEvent.click((await screen.findByRole("heading", { name: "context7" })).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Выключить для всех" }));
    expect(await screen.findByText(/mcp.context7.url is invalid/)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/servers/restart"))).toBe(false);
  });

  it("does not show a Runtime-only MCP as configured", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    const runtimeOnly = (await screen.findByRole("heading", { name: "xlsx" })).closest("button")!;
    expect(runtimeOnly).toHaveTextContent("Обнаружен только в запущенном OpenCode");
    expect(runtimeOnly).toHaveTextContent("Нет сохраненной настройки");
    expect(runtimeOnly).not.toHaveTextContent("Включен в настройках");
  });

  it("pins the displayed default model when launching a task", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    expect(screen.getByRole("button", { name: "Модель: openai/gpt-test" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Проверить оплату" } });
    fireEvent.change(screen.getByPlaceholderText(/Опишите задачу/), { target: { value: "Запустить тесты оплаты" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить агента" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/tasks") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ model: "openai/gpt-test" });
    });
  });

  it("creates a readable daily schedule", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Утренний отчёт" } });
    fireEvent.change(screen.getByPlaceholderText(/Опишите задачу/), { target: { value: "Подготовить отчёт" } });
    fireEvent.change(screen.getByLabelText("Запуск"), { target: { value: "schedule" } });
    fireEvent.change(screen.getByLabelText("Время запуска"), { target: { value: "08:30" } });
    expect(screen.getByText("Каждый день в 08:30")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Создать расписание" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/tasks") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ cron: "30 8 * * *", attachments: [], cron_session_mode: "new" });
    });
  });

  it("shows default Commands directly in the current configuration", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/commands")) return response([
        { id: "fix", description: "Исправить проблему", content: "Fix $ARGUMENTS", scope: "project", editable: true, kind: "command" },
        { id: "test", description: "Запустить проверки", content: "Test $ARGUMENTS", scope: "project", editable: true, kind: "command" },
      ]);
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Команды" }));

    expect(await screen.findByText("/fix")).toBeInTheDocument();
    expect(screen.getByText("/test")).toBeInTheDocument();
    expect(screen.queryByText("Активировать стандартные Commands?")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("starter-pack"))).toBe(false);
  });

  it("allows a Command to target a subagent and enables a child session", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/commands/research") && init?.method === "PUT") return response({});
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Команды" }));
    fireEvent.click(await screen.findByRole("button", { name: "Создать команду" }));
    fireEvent.change(screen.getByPlaceholderText("review"), { target: { value: "research" } });
    fireEvent.click(screen.getByRole("button", { name: "Агент: build" }));
    fireEvent.click(screen.getByRole("option", { name: /explore/ }));
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Агент: explore" }));
    fireEvent.click(screen.getByRole("option", { name: /build/ }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Агент: build" }));
    fireEvent.click(screen.getByRole("option", { name: /explore/ }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить /research" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/commands/research") && init?.method === "PUT");
      expect(JSON.parse(String(call?.[1]?.body)).content).toContain('agent: "explore"');
      expect(JSON.parse(String(call?.[1]?.body)).content).toContain("subtask: true");
    });
  });

  it("offers only variants supported by the effective command model", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Команды" }));
    fireEvent.click(await screen.findByRole("button", { name: "Создать команду" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Имя команды/ }), { target: { value: "reason" } });

    const variants = screen.getByRole("combobox", { name: /Режим рассуждений/ });
    expect(screen.getByRole("option", { name: "low" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "high" })).toBeInTheDocument();
    fireEvent.change(variants, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить /reason" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/commands/reason") && init?.method === "PUT");
      expect(JSON.parse(String(call?.[1]?.body)).content).toContain('variant: "high"');
    });
  });

  it("runs a selected Slash Command in the current session", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/commands")) return response([{ id: "review", description: "Проверить изменения", content: "Review $ARGUMENTS", scope: "project", has_arguments: true }]);
      if (path.includes("/commands/review") && init?.method === "POST") return response({});
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    fireEvent.click(screen.getByRole("button", { name: "Рассуждение: по умолчанию" }));
    fireEvent.click(screen.getByRole("option", { name: /^high/ }));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "/" } });
    fireEvent.click(await screen.findByRole("option", { name: /\/review/ }));
    fireEvent.change(textarea, { target: { value: "/review авторизация" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/sessions/ses_1/commands/review") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ arguments: "авторизация", agent: "build", model: "openai/gpt-test", variant: "high" });
    });
  });

  it("offers and runs a Runtime Skill from the Slash Command palette", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/commands")) return response([{ id: "hacker-news-summary", description: "Формирует дайджест Hacker News", content: "", scope: "runtime", kind: "skill" }]);
      if (path.includes("/commands/hacker-news-summary") && init?.method === "POST") return response({});
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "/h" } });
    fireEvent.click(await screen.findByRole("option", { name: /\/hacker-news-summary/ }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes("/sessions/ses_1/commands/hacker-news-summary") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ arguments: "", agent: "build", model: "openai/gpt-test" });
    });
  });

  it("keeps the keyboard-selected Slash Command visible", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/commands")) return response(Array.from({ length: 8 }, (_, index) => ({ id: `command-${index + 1}`, description: `Команда ${index + 1}`, content: "Run", kind: "command" })));
      return fallback(input, init);
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "/" } });
    await screen.findByRole("option", { name: /\/command-1/ });
    for (let index = 0; index < 7; index += 1) fireEvent.keyDown(textarea, { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /\/command-8/ })).toHaveAttribute("aria-selected", "true");
      expect(scrollIntoView).toHaveBeenCalled();
    });
  });

  it("switches an existing manual task to cron", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/commands")) return response([{ id: "hacker-news-summary", description: "Дайджест Hacker News", content: "", scope: "runtime", kind: "skill" }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Другие действия" }));
    expect(screen.getByRole("menuitem", { name: "Удалить задачу и связанные сессии" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Другие действия" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Настроить запуск" }));
    const prompt = screen.getByLabelText("Задание для каждого запуска");
    fireEvent.change(prompt, { target: { value: "/h" } });
    fireEvent.click(await screen.findByRole("option", { name: /\/hacker-news-summary/ }));
    fireEvent.change(prompt, { target: { value: "@g", selectionStart: 2 } });
    fireEvent.click(await screen.findByRole("option", { name: /@general/ }));
    fireEvent.change(prompt, { target: { value: "@general Сформировать новый отчёт" } });
    fireEvent.change(screen.getByLabelText("Режим"), { target: { value: "cron" } });
    fireEvent.change(screen.getByLabelText("Время запуска"), { target: { value: "07:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/tasks/task_1/schedule") && init?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ mode: "cron", prompt: "@general Сформировать новый отчёт", mentions: ["general"], cron: "45 7 * * *", enabled: true, cron_session_mode: "new" });
    });
  });

  it("explains when the browser is using an older Control backend", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/tasks") && init?.method === "POST") return new Response(JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "cron"], msg: "Extra inputs are not permitted" }, { type: "extra_forbidden", loc: ["body", "timezone"], msg: "Extra inputs are not permitted" }] }), { status: 422, headers: { "Content-Type": "application/json" } });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Отчёт" } });
    fireEvent.change(screen.getByPlaceholderText(/Опишите задачу/), { target: { value: "Сформировать отчёт" } });
    fireEvent.change(screen.getByLabelText("Запуск"), { target: { value: "schedule" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать расписание" }));
    expect(await screen.findByText(/Backend OpenCode Control ещё не обновлён/)).toBeInTheDocument();
  });

  it("adds a dropped spreadsheet to a task", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    const dropzone = screen.getByRole("button", { name: "Прикрепить файлы" }).closest(".attachment-field")!;
    const file = new File(["sheet"], "report.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(await screen.findByText("report.xlsx")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Проверить скриншот" } });
    fireEvent.change(screen.getByPlaceholderText(/Опишите задачу/), { target: { value: "Проверить интерфейс" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить агента" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/tasks") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body)).attachments[0]).toMatchObject({ filename: "report.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    });
  });

  it("reruns a completed task in place", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить повторно" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/tasks/task_1/rerun") && init?.method === "POST")).toBe(true));
  });

  it("shows a completed task as running while its linked session is busy", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.statuses = { ses_1: { type: "busy" } };
        return response(payload);
      }
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    expect(await screen.findByText("Выполняется")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Остановить" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Запустить повторно" })).not.toBeInTheDocument();
  });

  it("keeps a stalled runtime visible when opening a completed task session", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.statuses = { ses_1: { type: "stalled", error: "No message progress" } };
        return response(payload);
      }
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    expect(await screen.findByText("Нет прогресса")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Сессии · 1" }));
    const sessionList = await screen.findByRole("dialog", { name: "Сессии задачи" });
    fireEvent.click(sessionList.querySelector<HTMLElement>(".task-session-browser-row")!);
    const drawer = await screen.findByRole("dialog", { name: "Сессия Fix checkout" });
    expect(drawer.querySelector('.status[data-status="stalled"]')).toHaveTextContent("Нет прогресса");
    expect(screen.getByRole("button", { name: "Остановить ответ" })).toBeInTheDocument();
  });

  it("shows a later runtime failure on a task persisted as completed", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/snapshot")) {
        const original = await fallback(input, init);
        const payload = await original.json();
        payload.statuses = { ses_1: { type: "failed", error: "Provider failed" } };
        return response(payload);
      }
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    expect(await screen.findByText("Ошибка")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Запустить повторно" })).toBeInTheDocument();
  });

  it("shows the effective Skill name separately from its directory", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/skills")) return response([{ id: "parsers-news", effective_name: "hacker-news-parser", description: "Новости Hacker News", content: "---\nname: hacker-news-parser\n---\n", scope: "project", editable: true }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Навыки" }));
    expect(await screen.findByRole("heading", { name: "hacker-news-parser" })).toBeInTheDocument();
    expect(screen.getByText("каталог: parsers-news")).toBeInTheDocument();
  });

  it("keeps manual Skill creation and imports a reviewed HTTPS preview", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const preview = {
      preview_id: "preview_https_12345678901234567890123456789012",
      expires_at: "2026-01-01T00:05:00Z",
      source_url: "https://github.com/example/skills/blob/main/release/SKILL.md",
      final_url: "https://raw.githubusercontent.com/example/skills/main/release/SKILL.md",
      redirects: 0,
      content: "---\nname: release-notes\ndescription: Prepare release notes\n---\n\n# Release notes\n\nSummarize changes.\n",
      markdown: "# Release notes\n\nSummarize changes.\n",
      sha256: "a".repeat(64),
      bytes: 118,
      file_count: 1,
      files: [{ path: "SKILL.md", bytes: 118, sha256: "a".repeat(64), executable: false, kind: "root" }],
      name: "release-notes",
      description: "Prepare release notes",
      scope: "project",
      target_path: "/code/checkout/.opencode/skills/release-notes/SKILL.md",
      conflict: { target_exists: false, has_conflict: false, matches: [] },
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/skill-imports/preview") && init?.method === "POST") return response(preview);
      if (path.endsWith("/skill-imports/confirm") && init?.method === "POST") return response({ state: "imported", id: "release-notes" });
      if (path.endsWith("/skills")) return response([]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Навыки" }));
    expect(screen.getByText(/В обоих случаях Control загрузит весь родительский каталог/)).toBeInTheDocument();
    expect(screen.getByText(/scripts\//)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Создать навык" }));
    const manualMarkdown = screen.getByLabelText("Markdown навыка");
    fireEvent.change(screen.getByPlaceholderText("release-notes"), { target: { value: "security-review" } });
    expect((manualMarkdown as HTMLTextAreaElement).value).toContain("name: security-review");
    expect(screen.getByText(/OpenCode видит этот навык под именем/)).toHaveTextContent("security-review");
    fireEvent.click(screen.getByRole("tab", { name: /По HTTPS/ }));
    const urlInput = screen.getByPlaceholderText(/github.com\/owner/);
    expect(urlInput.closest(".skill-import-source")?.firstElementChild).toBe(urlInput.parentElement);
    fireEvent.change(screen.getByPlaceholderText(/github.com\/owner/), { target: { value: preview.source_url } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и показать" }));
    expect(await screen.findByText("Prepare release notes")).toBeInTheDocument();
    expect(screen.getByLabelText("Исходный импортируемый SKILL.md")).toHaveValue(preview.content);
    fireEvent.click(screen.getByRole("button", { name: "Установить release-notes" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/skill-imports/confirm") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ preview_id: preview.preview_id, conflict_policy: "skip" });
    });
  });

  it("requires a final preview when renaming a conflicting imported Skill", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const conflict = {
      preview_id: "preview_conflict_1234567890123456789012345678",
      expires_at: "2026-01-01T00:05:00Z",
      source_url: "https://example.test/SKILL.md",
      final_url: "https://example.test/SKILL.md",
      redirects: 0,
      content: "---\nname: release-notes\ndescription: Prepare releases\n---\n\n# Release\n",
      markdown: "# Release\n",
      sha256: "b".repeat(64), bytes: 90, name: "release-notes", description: "Prepare releases", scope: "project",
      file_count: 1, files: [{ path: "SKILL.md", bytes: 90, sha256: "b".repeat(64), executable: false, kind: "root" }],
      target_path: "/code/checkout/.opencode/skills/release-notes/SKILL.md",
      conflict: { target_exists: true, has_conflict: true, matches: [{ id: "release-notes", name: "release-notes", scope: "project", source: "/code/checkout/.opencode/skills", editable: true }] },
    };
    const renamed = { ...conflict, preview_id: "preview_renamed_12345678901234567890123456789", name: "release-summary", content: conflict.content.replace("release-notes", "release-summary"), target_path: "/code/checkout/.opencode/skills/release-summary/SKILL.md", conflict: { target_exists: false, has_conflict: false, matches: [] } };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/skill-imports/preview") && init?.method === "POST") return response(conflict);
      if (path.includes("/skill-imports/") && path.endsWith("/rename") && init?.method === "POST") return response(renamed);
      if (path.endsWith("/skill-imports/confirm") && init?.method === "POST") return response({ state: "imported", id: renamed.name });
      if (path.endsWith("/skills")) return response([]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Навыки" }));
    fireEvent.click(await screen.findByRole("button", { name: "Создать навык" }));
    fireEvent.click(screen.getByRole("tab", { name: /По HTTPS/ }));
    fireEvent.change(screen.getByPlaceholderText(/github.com\/owner/), { target: { value: conflict.source_url } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и показать" }));
    await screen.findByText("Найден конфликт имени");
    fireEvent.click(screen.getByLabelText(/Переименовать/));
    fireEvent.change(screen.getByDisplayValue("release-notes"), { target: { value: "release-summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать итоговый preview" }));
    expect(await screen.findByRole("button", { name: "Установить release-summary" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Установить release-summary" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/skill-imports/confirm") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body)).preview_id).toBe(renamed.preview_id);
    });
  });

  it("renames and moves an existing native Skill through its main fields", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/skills") && (!init?.method || init.method === "GET")) return response([{ id: "old-skill", effective_name: "old-skill", description: "Old", content: "---\nname: old-skill\ndescription: Old\n---\n\n# Old\n", scope: "project", editable: true }]);
      if (path.endsWith("/skills/old-skill") && init?.method === "PATCH") return response({ id: "new-skill", scope: "global" });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Навыки" }));
    fireEvent.click(await screen.findByRole("heading", { name: "old-skill" }));
    const name = screen.getByDisplayValue("old-skill");
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: "new-skill" } });
    fireEvent.change(screen.getByDisplayValue("Для проекта"), { target: { value: "global" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/skills/old-skill") && init?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ name: "new-skill", source_scope: "project", target_scope: "global" });
      expect(JSON.parse(String(call?.[1]?.body)).content).toContain("name: new-skill");
    });
  });

  it("creates another session linked to an existing task", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Новая сессия" }));
    expect(screen.getByRole("dialog", { name: "Новая сессия в задаче" })).toHaveClass("composer-modal");
    expect(screen.getByRole("dialog", { name: "Новая сессия в задаче" })).not.toHaveClass("workspace-modal");
    fireEvent.change(screen.getByPlaceholderText(/Fix checkout task/), { target: { value: "Alternative checkout review" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать связанную сессию" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/tasks/task_1/sessions") && init?.method === "POST")).toBe(true));
  });


  it("selects and persists an OpenCode-style theme", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: /Тема: OpenCode/ }));
    fireEvent.change(screen.getByPlaceholderText("Поиск темы"), { target: { value: "aura" } });
    fireEvent.click(screen.getByRole("option", { name: /Aura/ }));
    expect(document.documentElement.dataset.theme).toBe("aura");
    expect(window.localStorage.getItem("control-theme")).toBe("aura");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#a277ff");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#15141b");
  });

  it("keeps protected palettes intact and gives every theme readable controls", () => {
    expect(themes.find((theme) => theme.id === "aura")?.colors).toEqual(["#15141b", "#1a1826", "#252238", "#edecee", "#8c8a9e", "#a277ff", "#ffca85", "#61ffca", "#ff6767", "#82e2ff"]);
    expect(themes.find((theme) => theme.id === "cobalt2")?.colors).toEqual(["#193549", "#1f4662", "#254f6d", "#ffffff", "#9caeb8", "#ffc600", "#ff9d00", "#3ad900", "#ff628c", "#80fcff"]);
    expect(themes.find((theme) => theme.id === "cyberpunk")?.colors).toEqual(["#090014", "#160522", "#25103a", "#f9f4ff", "#9b86b4", "#ff2bd6", "#f9f871", "#00ff9f", "#ff3864", "#00d9ff"]);
    expect(new Set(themes.map((theme) => theme.colors.join(":"))).size).toBe(themes.length);
    expect(themes.filter((theme) => theme.mode === "light").length).toBeGreaterThanOrEqual(5);
    for (const theme of themes) {
      const [, panel, , text, , accent, , success, danger] = theme.colors;
      expect(contrastRatio(text, panel), `${theme.name}: основной текст`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(contrastText(accent), accent), `${theme.name}: основная кнопка`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(success, panel), `${theme.name}: успешный статус`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(danger, panel), `${theme.name}: опасный статус`).toBeGreaterThanOrEqual(3);
    }
  });

  it("does not steal input focus when polling rerenders an open modal", async () => {
    const view = render(<App />);
    await screen.findByRole("heading", { name: "Дашборд" });
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    const title = screen.getByPlaceholderText("Что нужно сделать?");
    title.focus();
    expect(title).toHaveFocus();
    view.rerender(<App />);
    expect(title).toHaveFocus();
  });

  it("clears project-scoped data immediately when switching projects", async () => {
    const second = { ...project, id: "prj_second", name: "Catalog API", root: "/code/catalog" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project, second]);
      if (path.includes("prj_test/snapshot")) {
        return response({ state: "connected", errors: [], sessions: [{ id: "old", title: "Old project session" }], statuses: {}, agents: [], mcp: {}, providers: {}, server: project.server });
      }
      if (path.includes("prj_second/snapshot")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return response({ state: "connected", errors: [], sessions: [], statuses: {}, agents: [], mcp: {}, providers: {}, server: second.server });
      }
      return response([]);
    }));
    render(<App />);
    expect(await screen.findByText("Old project session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Текущий проект/i }));
    fireEvent.click(screen.getByRole("button", { name: /Catalog API/i }));
    expect(screen.queryByText("Old project session")).not.toBeInTheDocument();
    expect(await screen.findAllByText("Catalog API")).not.toHaveLength(0);
  });
});
