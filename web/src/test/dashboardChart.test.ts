import { describe, expect, it } from "vitest";
import { buildUsageBuckets, niceScale, resolveGranularity } from "../dashboardChart";
import type { UsageRow } from "../types";

function usage(id: string, tokens = 10): UsageRow {
  return {
    id,
    tokens: { input: tokens, output: 2, reasoning: 1, cache_read: 4, cache_write: 3 },
    tokens_total: tokens + 3,
    cost: 0.25,
    messages: 2,
    sessions: 1,
  };
}

describe("Dashboard chart buckets", () => {
  it("groups weeks from Monday and sums every metric", () => {
    const buckets = buildUsageBuckets([
      usage("2026-01-11"),
      usage("2026-01-05"),
      usage("2026-01-12"),
    ], "week");

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ id: "2026-01-05", startId: "2026-01-05", endId: "2026-01-11", tokens_total: 26, sessions: 2 });
    expect(buckets[0].tokens).toEqual({ input: 20, output: 4, reasoning: 2, cache_read: 8, cache_write: 6 });
    expect(buckets[1]).toMatchObject({ id: "2026-01-12", startId: "2026-01-12", endId: "2026-01-12" });
  });

  it("uses automatic day, week, and month granularity by date span", () => {
    expect(resolveGranularity([usage("2026-01-01"), usage("2026-02-01")], "auto")).toBe("day");
    expect(resolveGranularity([usage("2026-01-01"), usage("2026-04-01")], "auto")).toBe("week");
    expect(resolveGranularity([usage("2025-01-01"), usage("2026-01-01")], "auto")).toBe("month");
    expect(resolveGranularity([usage("2025-01-01"), usage("2026-01-01")], "day")).toBe("day");
  });

  it("groups monthly buckets without mixing cache into tokens_total", () => {
    const buckets = buildUsageBuckets([usage("2026-01-03"), usage("2026-01-28"), usage("2026-02-01")], "month");
    expect(buckets.map((bucket) => bucket.id)).toEqual(["2026-01-01", "2026-02-01"]);
    expect(buckets[0]).toMatchObject({ startId: "2026-01-03", endId: "2026-01-28", tokens_total: 26 });
    expect(buckets[0].tokens.cache_read).toBe(8);
  });

  it("builds a readable four-interval scale", () => {
    expect(niceScale([112_600])).toEqual({ maximum: 120_000, ticks: [0, 30_000, 60_000, 90_000, 120_000] });
    expect(niceScale([])).toEqual({ maximum: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  });
});
