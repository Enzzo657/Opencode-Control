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
});
