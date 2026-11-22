// audit/usage.jsonl: append validated rows and flag stages whose rolling average grew too fast.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { dayNumber } from "./novelty.js";
import { assertSchema } from "./schema.js";
import type { ThresholdsConfig, UsageAlert, UsageEntry, UsageStage } from "./types.js";

export function appendUsage(usagePath: string, entry: UsageEntry, repoRoot?: string): void {
  assertSchema<UsageEntry>("usage-entry", entry, repoRoot);
  mkdirSync(dirname(usagePath), { recursive: true });
  appendFileSync(usagePath, `${JSON.stringify(entry)}\n`);
}

export function readUsage(usagePath: string, repoRoot?: string): UsageEntry[] {
  if (!existsSync(usagePath)) return [];
  return readFileSync(usagePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return assertSchema<UsageEntry>("usage-entry", JSON.parse(l), repoRoot);
      } catch (e) {
        throw new Error(`${usagePath}:${i + 1}: ${(e as Error).message}`);
      }
    });
}

export type UsageMetric = "tokens" | "cost_usd";

function metricOf(e: UsageEntry, metric: UsageMetric): number {
  return metric === "cost_usd"
    ? e.cost_usd
    : e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens;
}

/**
 * Per stage: average nightly total over the last N nights ending at `endDate` (default: newest
 * entry) vs the N nights before that, averaged over nights that ran the stage. Flags growth over
 * `alert_growth_pct`. Stages with no prior data or a zero prior average are skipped.
 */
export function computeUsageAlerts(
  entries: UsageEntry[],
  config: ThresholdsConfig["usage"] = { rolling_window_nights: 7, alert_growth_pct: 25 },
  opts: { endDate?: string; metric?: UsageMetric } = {},
): UsageAlert[] {
  if (!entries.length) return [];
  const metric = opts.metric ?? "tokens";
  const n = config.rolling_window_nights;
  const end = dayNumber(opts.endDate ?? entries.reduce((m, e) => (e.date > m ? e.date : m), entries[0]!.date));
  const perNight = new Map<UsageStage, { cur: Map<number, number>; prior: Map<number, number> }>();
  for (const e of entries) {
    const age = end - dayNumber(e.date);
    if (age < 0 || age >= 2 * n) continue;
    let s = perNight.get(e.stage);
    if (!s) perNight.set(e.stage, (s = { cur: new Map(), prior: new Map() }));
    const bucket = age < n ? s.cur : s.prior;
    const day = dayNumber(e.date);
    bucket.set(day, (bucket.get(day) ?? 0) + metricOf(e, metric));
  }
  const avg = (m: Map<number, number>): number => [...m.values()].reduce((a, b) => a + b, 0) / m.size;
  const alerts: UsageAlert[] = [];
  for (const [stage, { cur, prior }] of perNight) {
    if (!cur.size || !prior.size) continue;
    const p = avg(prior);
    const c = avg(cur);
    if (p <= 0) continue;
    const pct = ((c - p) / p) * 100;
    if (pct > config.alert_growth_pct) {
      alerts.push({ stage, prior_7d_avg: p, current_7d_avg: c, pct_change: Math.round(pct * 10) / 10 });
    }
  }
  return alerts.sort((a, b) => b.pct_change - a.pct_change);
}
