import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, contrastText, themes } from "../App";

const project = {
  id: "prj_test",
  name: "Checkout API",
  root: "/code/checkout",
  endpoint: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  server: { state: "running", managed: true, endpoint: "http://127.0.0.1:4100" },
};

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
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
          providers: { connected: ["openai"], available: [{ id: "openai", model_count: 2, models: ["openai/gpt-test", "openai/gpt-other"] }] },
          config: { model: "openai/gpt-test", default_agent: "build" },
          server: project.server,
        });
      }
      if (path.includes("/mcp/global")) return response({ context7: { type: "remote", url: "https://example.test/mcp", enabled: true } });
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response([]);
    }));
  });

  it("renders the project control room with runtime information", async () => {
    render(<App />);
    expect(await screen.findByText("Центр управления")).toBeInTheDocument();
    expect(screen.getAllByText("Checkout API").length).toBeGreaterThan(0);
    expect(await screen.findByText("Fix checkout")).toBeInTheDocument();
    expect(screen.getByText("1.18.1")).toBeInTheDocument();
    expect(screen.getByText("Подключен")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Checkout API/ }));
    expect(screen.getAllByText("Подключен")).toHaveLength(2);
    expect(screen.getByText("Local 1.0.0")).toBeInTheDocument();
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Настройки проекта" }));
    expect(await screen.findByText("/code/checkout/opencode.jsonc")).toBeInTheDocument();
    expect(screen.getAllByText("/home/dev/.config/opencode/opencode.jsonc")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Общая конфигурация OpenCode"), { target: { value: '{"model":"openai/new-global"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить общую" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/configuration") && init?.method === "PATCH");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    expect(await screen.findByRole("heading", { name: "Задачи" })).toBeInTheDocument();
    expect(screen.queryByText("Раздел не удалось открыть")).not.toBeInTheDocument();
  });

  it("keeps agent and connected-model pickers open until selection", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    fireEvent.click(screen.getByRole("button", { name: "Агент: по умолчанию" }));
    expect(screen.getByRole("option", { name: /build/ })).toBeInTheDocument();
    expect(screen.getByRole("listbox").closest(".modal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Модель: openai/gpt-test" }));
    expect(screen.getByPlaceholderText("Поиск модели")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /openai\/gpt-test/ })).toBeInTheDocument();
  });

  it("keeps the explicitly selected agent for the next task", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить задачу" }));
    fireEvent.click(screen.getByRole("button", { name: "Агент: по умолчанию" }));
    fireEvent.click(screen.getByRole("option", { name: /build/ }));
    fireEvent.change(screen.getByPlaceholderText("Что нужно сделать?"), { target: { value: "Первая задача" } });
    fireEvent.change(screen.getByPlaceholderText(/Опишите задачу/), { target: { value: "Проверить выбор агента" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить агента" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Запустить задачу" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Запустить задачу" }));
    expect(screen.getByRole("button", { name: "Агент: build" })).toBeInTheDocument();
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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

  it("replaces send with stop while the agent is active", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_live", role: "assistant", time: { created: Date.now() } }, parts: [{ type: "step-start" }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const stop = await screen.findByRole("button", { name: "Остановить ответ" });
    expect(screen.queryByRole("button", { name: "Отправить в эту сессию" })).not.toBeInTheDocument();
    fireEvent.click(stop);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/sessions/ses_1/abort") && init?.method === "POST")).toBe(true));
  });

  it("mentions a subagent with @ and sends a native mention", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    fireEvent.click(screen.getByRole("button", { name: "Агент: build" }));
    fireEvent.click(screen.getByRole("option", { name: /plan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Модель: openai/gpt-test" }));
    fireEvent.click(screen.getByRole("option", { name: /openai\/gpt-other/ }));
    const textarea = screen.getByPlaceholderText("Продолжите диалог в этой же сессии…");
    fireEvent.change(textarea, { target: { value: "Проверь ещё раз" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить в эту сессию" }));
    await waitFor(() => expect(window.localStorage.getItem(`control-session-selection:${project.id}:ses_1`)).toBe(JSON.stringify({ agent: "plan", model: "openai/gpt-other" })));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть сессию" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("button", { name: "Агент: plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Модель: openai/gpt-other" })).toBeInTheDocument();
  });

  it("shows one white task title without the session id", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fix checkout" }));
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("button", { name: "Отправить в эту сессию" })).toBeInTheDocument();
    expect(screen.getByText(/stop · 9 с всего/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Остановить ответ" })).not.toBeInTheDocument();
  });

  it("offers a manual jump to the latest message", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const stream = (await screen.findByRole("dialog", { name: "Сессия Fix checkout" })).querySelector<HTMLElement>(".message-stream")!;
    Object.defineProperties(stream, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 100 } });
    const scrollTo = vi.fn();
    stream.scrollTo = scrollTo;
    fireEvent.scroll(stream);
    fireEvent.click(await screen.findByRole("button", { name: "Перейти к последнему сообщению" }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" }));
  });

  it("adds dropped files from the whole chat composer", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    expect(await screen.findByRole("heading", { name: "Проверка" })).toBeInTheDocument();
    expect(screen.getByText("готово").tagName).toBe("STRONG");
    expect(screen.getByText("первый пункт").tagName).toBe("LI");
    expect(screen.getByText(/118.757/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("shows OpenCode reasoning and message errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/v1/projects")) return response([project]);
      if (path.includes("/snapshot")) return response({ state: "connected", errors: [], sessions: [{ id: "ses_1", title: "Fix checkout", agent: "build" }], statuses: {}, agents: [{ name: "build", mode: "primary" }], mcp: {}, providers: { connected: ["openai"], available: [{ id: "openai", model_count: 1, models: ["openai/gpt-test"] }] }, config: { model: "openai/gpt-test" }, server: project.server });
      if (path.includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_reason", role: "assistant", agent: "build", providerID: "openai", modelID: "gpt-test", error: "provider failed" }, parts: [{ type: "reasoning", text: "Проверяю варианты", time: { start: 1000, end: 2500 } }] }]);
      if (path.endsWith("/api/v1/session")) return response({ csrf_token: "csrf" });
      return response([]);
    }));
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Сессии" }));
    fireEvent.click(await screen.findByText("Fix checkout"));
    const reasoning = (await screen.findByText("Рассуждение · 1500 мс")).closest("details");
    expect(reasoning).not.toHaveAttribute("open");
    expect(screen.getByText("Проверяю варианты")).not.toBeVisible();
    expect(screen.getByText("provider failed")).toBeInTheDocument();
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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

  it("shows complete shell commands and output like the OpenCode CLI", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sessions/ses_1/messages")) return response([{ info: { id: "msg_shell", role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", command: "python3 script.py --all", workdir: "/tmp/project", output: "Fetching…\nfirst result\nlast result", full_output: true, exit_code: 0, time: { start: 1000, end: 7500 } } }] }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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

  it("resizes the session drawer with its left handle", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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

  it("restarts a managed server after an MCP project override", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    fireEvent.click((await screen.findByRole("heading", { name: "context7" })).closest("button")!);
    fireEvent.change(screen.getByLabelText("Где действует настройка"), { target: { value: "project" } });
    fireEvent.click(screen.getByRole("button", { name: "Выключить для проекта" }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      expect(calls.some(([input, init]) => String(input).includes("/mcp/context7/enabled") && init?.method === "PATCH")).toBe(true);
      expect(calls.some(([input, init]) => String(input).endsWith("/server/restart") && init?.method === "POST")).toBe(true);
    });
  });

  it("updates a global MCP and restarts all managed servers", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    fireEvent.click((await screen.findByRole("heading", { name: "context7" })).closest("button")!);
    expect(screen.getAllByText("Сейчас в OpenCode").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Отключить сейчас" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выключить для всех" }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      const toggle = calls.find(([input, init]) => String(input).includes("/mcp/context7/enabled") && init?.method === "PATCH");
      expect(JSON.parse(String(toggle?.[1]?.body))).toEqual({ enabled: false, scope: "global" });
      expect(calls.some(([input, init]) => String(input).endsWith("/api/v1/servers/restart") && init?.method === "POST")).toBe(true);
    });
  });

  it("does not show a Runtime-only MCP as configured", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "MCP-серверы" }));
    const runtimeOnly = (await screen.findByRole("heading", { name: "xlsx" })).closest("button")!;
    expect(runtimeOnly).toHaveTextContent("Обнаружен только в запущенном OpenCode");
    expect(runtimeOnly).toHaveTextContent("Нет сохраненной настройки");
    expect(runtimeOnly).not.toHaveTextContent("Включен в настройках");
  });

  it("pins the displayed default model when launching a task", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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

  it("switches an existing manual task to cron", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Настроить запуск" }));
    fireEvent.change(screen.getByLabelText("Режим"), { target: { value: "cron" } });
    fireEvent.change(screen.getByLabelText("Время запуска"), { target: { value: "07:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/tasks/task_1/schedule") && init?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ mode: "cron", cron: "45 7 * * *", enabled: true, cron_session_mode: "new" });
    });
  });

  it("explains when the browser is using an older Control backend", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/tasks") && init?.method === "POST") return new Response(JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "cron"], msg: "Extra inputs are not permitted" }, { type: "extra_forbidden", loc: ["body", "timezone"], msg: "Extra inputs are not permitted" }] }), { status: 422, headers: { "Content-Type": "application/json" } });
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Запустить повторно" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/tasks/task_1/rerun") && init?.method === "POST")).toBe(true));
  });

  it("shows the effective Skill name separately from its directory", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/skills")) return response([{ id: "parsers-news", effective_name: "hacker-news-parser", description: "Новости Hacker News", content: "---\nname: hacker-news-parser\n---\n", scope: "project", editable: true }]);
      return fallback(input, init);
    });
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Навыки" }));
    expect(await screen.findByRole("heading", { name: "hacker-news-parser" })).toBeInTheDocument();
    expect(screen.getByText("каталог: parsers-news")).toBeInTheDocument();
  });

  it("creates another session linked to an existing task", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
    fireEvent.click(screen.getByRole("button", { name: "Задачи" }));
    fireEvent.click(await screen.findByRole("button", { name: "Новая сессия" }));
    expect(screen.getByRole("dialog", { name: "Новая сессия в задаче" })).toHaveClass("composer-modal");
    expect(screen.getByRole("dialog", { name: "Новая сессия в задаче" })).not.toHaveClass("workspace-modal");
    fireEvent.change(screen.getByPlaceholderText(/Fix checkout task/), { target: { value: "Alternative checkout review" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать связанную сессию" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/tasks/task_1/sessions") && init?.method === "POST")).toBe(true));
  });

  it("migrates legacy Studio browser preferences to Control keys", async () => {
    window.localStorage.setItem("studio-project", project.id);
    window.localStorage.setItem("studio-theme", "aura");
    window.localStorage.setItem(`studio-agent:${project.id}`, "plan");
    window.localStorage.setItem(`studio-session-selection:${project.id}:ses_1`, JSON.stringify({ agent: "plan", model: "openai/gpt-other" }));
    window.localStorage.setItem("studio-session-drawer-width", "880");

    render(<App />);
    await screen.findByText("Центр управления");

    expect(window.localStorage.getItem("control-project")).toBe(project.id);
    expect(window.localStorage.getItem("control-theme")).toBe("aura");
    expect(window.localStorage.getItem(`control-agent:${project.id}`)).toBe("plan");
    expect(window.localStorage.getItem(`control-session-selection:${project.id}:ses_1`)).toBe(JSON.stringify({ agent: "plan", model: "openai/gpt-other" }));
    expect(window.localStorage.getItem("control-session-drawer-width")).toBe("880");
    expect(Object.keys(window.localStorage).some((key) => key.startsWith("studio-"))).toBe(false);
  });

  it("selects and persists an OpenCode-style theme", async () => {
    render(<App />);
    await screen.findByText("Центр управления");
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
    await screen.findByText("Центр управления");
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
