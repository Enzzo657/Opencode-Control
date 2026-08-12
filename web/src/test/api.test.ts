import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api";

describe("api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves an HTTP status on API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "Session does not exist" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )));

    const request = api("/api/v1/missing");

    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({ status: 404, message: "Session does not exist" });
  });

  it("renews an expired CSRF session and retries a write once", async () => {
    vi.resetModules();
    const calls: Array<{ path: string; token: string | null }> = [];
    let sessions = 0;
    let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const token = new Headers(init?.headers).get("X-CSRF-Token");
      calls.push({ path, token });
      if (path === "/api/v1/session") {
        sessions += 1;
        return new Response(JSON.stringify({ csrf_token: sessions === 1 ? "old" : "new" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      writes += 1;
      if (writes === 1) return new Response(JSON.stringify({ detail: { code: "csrf_session_expired", message: "expired" } }), { status: 403, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ saved: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { api: freshApi } = await import("../api");

    await expect(freshApi<{ saved: boolean }>("/api/v1/save", { method: "POST", body: "{}" })).resolves.toEqual({ saved: true });
    expect(calls).toEqual([
      { path: "/api/v1/session", token: null },
      { path: "/api/v1/save", token: "old" },
      { path: "/api/v1/session", token: null },
      { path: "/api/v1/save", token: "new" },
    ]);
  });
});
