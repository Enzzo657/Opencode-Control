import type { UsageRow, UsageTokens } from "./types";

export type ChartGranularity = "auto" | "day" | "week" | "month";
export type ResolvedGranularity = Exclude<ChartGranularity, "auto">;
export type UsageBucket = UsageRow & { startId: string; endId: string };

const tokenKeys: Array<keyof UsageTokens> = ["input", "output", "reasoning", "cache_read", "cache_write"];

export function resolveGranularity(rows: UsageRow[], requested: ChartGranularity): ResolvedGranularity {
  if (requested !== "auto") return requested;
  if (rows.length < 2) return "day";
  const sorted = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  const first = parseDate(sorted[0].id);
  const last = parseDate(sorted[sorted.length - 1].id);
  if (!first || !last) return rows.length <= 45 ? "day" : rows.length <= 240 ? "week" : "month";
  const days = Math.max(1, Math.round((last.valueOf() - first.valueOf()) / 86_400_000) + 1);
  return days <= 45 ? "day" : days <= 240 ? "week" : "month";
}

export function buildUsageBuckets(rows: UsageRow[], granularity: ResolvedGranularity): UsageBucket[] {
  const sorted = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  if (granularity === "day") return sorted.map((row) => ({ ...row, startId: row.id, endId: row.id }));

  const buckets = new Map<string, UsageBucket>();
  for (const row of sorted) {
    const key = bucketKey(row.id, granularity);
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, {
        ...row,
        id: key,
        startId: row.id,
        endId: row.id,
        tokens: { ...row.tokens },
      });
      continue;
    }
    current.endId = row.id;
    current.tokens_total += row.tokens_total;
    current.cost += row.cost;
    current.messages += row.messages;
    current.sessions += row.sessions;
    for (const token of tokenKeys) current.tokens[token] += row.tokens[token];
  }
  return [...buckets.values()];
}

export function niceScale(values: number[], intervals = 4) {
  const maximum = Math.max(0, ...values);
  if (maximum === 0) return { maximum: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const roughStep = maximum / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const fraction = roughStep / magnitude;
  const niceFraction = [1, 2, 2.5, 3, 5, 10].find((candidate) => candidate >= fraction) ?? 10;
  const step = niceFraction * magnitude;
  return {
    maximum: step * intervals,
    ticks: Array.from({ length: intervals + 1 }, (_, index) => step * index),
  };
}

function bucketKey(id: string, granularity: ResolvedGranularity) {
  const date = parseDate(id);
  if (!date) return id;
  if (granularity === "month") return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`;
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseDate(id: string) {
  const date = new Date(`${id}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
