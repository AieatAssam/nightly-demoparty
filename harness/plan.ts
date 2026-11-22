// Stage 0: deterministic plan. Same ledger + date + seed (+ mood) -> same plan.
import { assertSchema, normTechnique } from "./schema.js";
import { allBefore, dayNumber, nightsBefore } from "./novelty.js";
import type { CompoConfig, CompoId, DomainConfig, LedgerEntry, Mood, Plan, RepoConfig } from "./types.js";

// ---------- seeded PRNG ----------

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedPick<T>(items: T[], weight: (x: T) => number, rng: () => number): T {
  if (!items.length) throw new Error("weightedPick: no candidates");
  const ws = items.map((x) => Math.max(0, weight(x)));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)]!;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i]!;
    if (r < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

// ---------- mood -> compo affinity ----------

// Coefficients per signal in [-1, 1]. arousal/pleasure/dominance are PAD (-1..1); curiosity is
// (interest - 0.5) * 2; frustration is 0..1 and pushes toward tractable, smaller-scope compos.
const AFFINITY: Record<CompoId, { a: number; p: number; d: number; c: number; f: number }> = {
  "4k-shader": { a: 0.2, p: -0.2, d: 0.6, c: 0.4, f: -0.3 },
  "16k-demo": { a: 0.8, p: 0.2, d: 0.6, c: 0.3, f: -0.8 },
  audiovisual: { a: 0.7, p: 0.6, d: 0.1, c: 0.2, f: -0.3 },
  "interactive-toy": { a: 0.3, p: 0.7, d: -0.4, c: 0.2, f: 0.3 },
  "data-sculpture": { a: -0.5, p: -0.1, d: 0.1, c: -0.2, f: 0.5 },
  "kinetic-type": { a: 0.1, p: 0.1, d: -0.5, c: -0.3, f: 0.6 },
  simulation: { a: 0.2, p: -0.3, d: 0.2, c: 0.7, f: -0.2 },
  "constraint-night": { a: -0.2, p: -0.2, d: 0.3, c: 0.8, f: -0.6 },
};
const MOOD_GAIN = 0.8;

export function moodMultiplier(compo: CompoId, mood: Mood | null | undefined): number {
  if (!mood) return 1;
  const k = AFFINITY[compo];
  const s =
    k.a * mood.pad.arousal +
    k.p * mood.pad.pleasure +
    k.d * mood.pad.dominance +
    k.c * (mood.derived_signals.interest - 0.5) * 2 +
    k.f * mood.derived_signals.frustration;
  return Math.exp(MOOD_GAIN * s);
}

// ---------- plan ----------

export interface BuildPlanInput {
  date: string;
  config: RepoConfig;
  ledger: LedgerEntry[];
  /** Latest mood available at stage 0 (normally last night's mood.json). Null: pure inverse frequency. */
  mood?: Mood | null;
  seed?: string | number;
  dryRun?: boolean;
  overrides?: Partial<Plan["overrides"]>;
}

function dedupe(xs: string[], key: (s: string) => string = (s) => s): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickCompo(
  input: BuildPlanInput,
  past: LedgerEntry[],
  rng: () => number,
): { compo: CompoConfig; boredom: boolean } {
  const { config, mood, date } = input;
  const th = config.thresholds.novelty_a;
  const forced = input.overrides?.compo ?? null;
  if (forced) {
    const c = config.compos.find((x) => x.id === forced);
    if (!c) throw new Error(`overrides.compo '${forced}' is not in config/compos.yml`);
    return { compo: c, boredom: false };
  }
  let candidates = config.compos;
  let boredom = false;
  if (mood?.creative_parameters.boredom_force_unused_30d) {
    const used = new Set(nightsBefore(past, date, th.boredom_window_nights).map((e) => e.compo));
    const unused = config.compos.filter((c) => !used.has(c.id));
    if (unused.length) {
      candidates = unused;
      boredom = true;
    }
  }
  const recent = nightsBefore(past, date, th.compo_recency_window_nights);
  const count = (id: CompoId): number => recent.filter((e) => e.compo === id).length;
  const compo = weightedPick(candidates, (c) => moodMultiplier(c.id, mood) / (1 + count(c.id)), rng);
  return { compo, boredom };
}

function pickDomain(
  input: BuildPlanInput,
  past: LedgerEntry[],
  rng: () => number,
): { domain: string; wildcard: boolean } {
  const { config, date } = input;
  const th = config.thresholds.novelty_a;
  const forced = input.overrides?.domain ?? null;
  if (forced) return { domain: forced, wildcard: false };
  const n = Math.max(1, Math.round(th.wildcard_every_n_nights));
  if (dayNumber(date) % n === 0) return { domain: "wildcard", wildcard: true };
  const recent = new Set(nightsBefore(past, date, th.domain_window_nights).map((e) => e.domain.toLowerCase()));
  const fresh = config.domains.filter((d) => !recent.has(d.id.toLowerCase()) && !recent.has(d.name.toLowerCase()));
  const pool: DomainConfig[] = fresh.length ? fresh : config.domains;
  return { domain: weightedPick(pool, (d) => d.weight, rng).id, wildcard: false };
}

export function buildPlan(input: BuildPlanInput): Plan {
  const { config, date } = input;
  const th = config.thresholds.novelty_a;
  const seed = input.seed ?? date;
  const rng = mulberry32(fnv1a(String(seed)));
  const past = allBefore(input.ledger, date);

  // Fixed draw order: compo, constraint, domain. Changing it changes every reproduced plan.
  const { compo, boredom } = pickCompo(input, past, rng);
  let constraint: string | null = null;
  let budget = compo.size_budget_bytes;
  if (compo.id === "constraint-night") {
    const cs = compo.constraints ?? [];
    if (!cs.length) throw new Error("constraint-night has no constraints in config/compos.yml");
    const c = cs[Math.floor(rng() * cs.length)]!;
    constraint = c.id;
    budget = c.size_budget_bytes;
  }
  const { domain, wildcard } = pickDomain(input, past, rng);

  const techniques = dedupe(
    nightsBefore(past, date, th.technique_window_nights).flatMap((e) => e.techniques),
    normTechnique,
  );
  const domains = dedupe(
    nightsBefore(past, date, th.domain_window_nights).map((e) => e.domain),
    (s) => s.toLowerCase(),
  );
  const palette_hexes = dedupe(
    nightsBefore(past, date, th.palette_window_nights).flatMap((e) => e.palette.map((c) => c.toLowerCase())),
  );
  const slop_patterns = dedupe(
    [...config.slop.static_rules.map((r) => r.message), ...config.slop.visual_slop.map((v) => v.description)]
      .map((s) => s.trim().slice(0, 300))
      .filter(Boolean),
  );

  const plan: Plan = {
    date,
    compo: compo.id,
    size_budget_bytes: budget,
    constraint,
    domain,
    wildcard,
    banned: { techniques, domains, palette_hexes, slop_patterns },
    boredom_override: boredom,
    requires_audio: compo.requires_audio,
    seed,
    dry_run: input.dryRun ?? false,
    overrides: {
      domain: input.overrides?.domain ?? null,
      compo: input.overrides?.compo ?? null,
      mood_preset: input.overrides?.mood_preset ?? null,
    },
  };
  return assertSchema<Plan>("plan", plan, config.repoRoot);
}
