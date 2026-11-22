// Ledger reading, night windows, Novelty Gate A (stage 4) and the Gate B comparison used by gates.ts.
// Pure functions only: no import of image-metrics.ts, so gates.ts -> novelty.ts stays acyclic.
import { existsSync, readFileSync } from "node:fs";
import { normTechnique, validateSchema } from "./schema.js";
import type {
  Brief,
  LedgerEntry,
  NoveltyACollision,
  NoveltyAResult,
  NoveltyBResult,
  Phashes,
  Plan,
  ThresholdsConfig,
} from "./types.js";

// ---------- ledger ----------

/** Parses ledger/ledger.jsonl. Missing or empty file -> []. A malformed line throws with its line number. */
export function readLedger(ledgerPath: string, repoRoot?: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const out: LedgerEntry[] = [];
  readFileSync(ledgerPath, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(`${ledgerPath}:${i + 1}: invalid JSON: ${(e as Error).message}`);
      }
      const r = validateSchema<LedgerEntry>("ledger-entry", parsed, repoRoot);
      if (!r.ok) throw new Error(`${ledgerPath}:${i + 1}: ${r.errors.join("; ")}`);
      out.push(r.data);
    });
  return out;
}

const DAY_MS = 86_400_000;

export function dayNumber(date: string): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${date}`);
  return Math.round(t / DAY_MS);
}

/** Entries strictly before `date` and within `nights` calendar nights of it, newest first. */
export function nightsBefore(ledger: LedgerEntry[], date: string, nights: number): LedgerEntry[] {
  const today = dayNumber(date);
  return ledger
    .filter((e) => {
      const diff = today - dayNumber(e.date);
      return diff >= 1 && diff <= nights;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Every entry strictly before `date`, newest first. */
export function allBefore(ledger: LedgerEntry[], date: string): LedgerEntry[] {
  return ledger.filter((e) => e.date < date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---------- similarity primitives ----------

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function wordShingles(s: string, n = 3): Set<string> {
  const w = normText(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (w.length < n) {
    if (w.length) out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

export function charShingles(s: string, n = 5): Set<string> {
  const t = normText(s);
  const out = new Set<string>();
  if (t.length < n) {
    if (t) out.add(t);
    return out;
  }
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}

/** max(Jaccard of 3-word shingles, Jaccard of 5-char shingles), 0..1. */
export function conceptSimilarity(a: string, b: string): number {
  return Math.max(jaccard(wordShingles(a), wordShingles(b)), jaccard(charShingles(a), charShingles(b)));
}

// sRGB hex -> CIE Lab (D65), CIE76 Delta-E.
// ponytail: CIE76 over-weights saturated blues vs CIEDE2000; switch if palette collisions look wrong.
export function hexToLab(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Symmetric mean Chamfer Delta-E between two palettes. Infinity when either is empty. */
export function paletteDistance(a: string[], b: string[]): number {
  if (!a.length || !b.length) return Infinity;
  const side = (x: string[], y: string[]): number =>
    x.reduce((s, c) => s + Math.min(...y.map((d) => deltaE(c, d))), 0) / x.length;
  return (side(a, b) + side(b, a)) / 2;
}

const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Hamming distance between equal-length hex strings; null when lengths differ. */
export function hammingDistanceHex(a: string, b: string): number | null {
  if (a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT4[parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)]!;
  return d;
}

/** Total variation distance 0.5 * sum|a-b| between normalised histograms, 0..1. */
export function histogramDistanceL1(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Histogram length mismatch: ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / 2;
}

// ---------- Gate A ----------

export function checkNoveltyA(params: {
  brief: Brief;
  plan: Plan;
  ledger: LedgerEntry[];
  thresholds: ThresholdsConfig["novelty_a"];
}): NoveltyAResult {
  const { brief, plan, thresholds: th } = params;
  const past = allBefore(params.ledger, plan.date);
  const collisions: NoveltyACollision[] = [];
  const mine = new Set(brief.techniques.map(normTechnique));

  const banned = new Set(plan.banned.techniques.map(normTechnique));
  for (const t of brief.techniques) {
    if (banned.has(normTechnique(t))) collisions.push({ kind: "technique_banned", detail: `'${t}' is on tonight's banned list` });
  }

  const novel = normTechnique(brief.novel_technique);
  const novelHit = past.find((e) => e.techniques.some((t) => normTechnique(t) === novel));
  if (novelHit) {
    collisions.push({
      kind: "novel_technique_not_novel",
      detail: `novel_technique '${brief.novel_technique}' was already used`,
      against_date: novelHit.date,
    });
  }

  for (const e of nightsBefore(past, plan.date, th.technique_window_nights)) {
    if (!e.techniques.length) continue;
    const j = jaccard(mine, new Set(e.techniques.map(normTechnique)));
    if (j >= th.technique_jaccard_max) {
      const shared = e.techniques.filter((t) => mine.has(normTechnique(t)));
      collisions.push({
        kind: "technique_jaccard",
        detail: `technique Jaccard ${j.toFixed(2)} >= ${th.technique_jaccard_max} (shared: ${shared.join(", ")})`,
        against_date: e.date,
      });
    }
  }

  for (const e of past) {
    if (!e.concept) continue;
    const s = conceptSimilarity(brief.concept, e.concept);
    if (s >= th.concept_shingle_max) {
      collisions.push({
        kind: "concept_similarity",
        detail: `concept similarity ${s.toFixed(2)} >= ${th.concept_shingle_max} with "${e.concept}"`,
        against_date: e.date,
      });
    }
  }

  const palette = brief.palette.map((c) => c.toLowerCase());
  for (const e of nightsBefore(past, plan.date, th.palette_window_nights)) {
    if (!e.palette.length) continue;
    const d = paletteDistance(palette, e.palette);
    if (d < th.palette_min_delta_e) {
      collisions.push({
        kind: "palette_distance",
        detail: `palette Delta-E ${d.toFixed(1)} < ${th.palette_min_delta_e} vs [${e.palette.join(", ")}]`,
        against_date: e.date,
      });
    }
  }

  return { passed: collisions.length === 0, collisions };
}

// ---------- Gate B ----------

/**
 * Perceptual hashes vs every archived entry (all 3x3 timestamp pairs), colour histogram vs the
 * last `histogram_window_nights`. With `date`, only entries before it count and the window is in
 * calendar nights; without it, the window is the newest N entries.
 */
export function checkNoveltyB(params: {
  phashes: Phashes;
  colorHistogram: number[];
  ledger: LedgerEntry[];
  thresholds: ThresholdsConfig["novelty_b"];
  date?: string;
}): NoveltyBResult {
  const { phashes, colorHistogram, thresholds: th, date } = params;
  const past = date
    ? allBefore(params.ledger, date)
    : [...params.ledger].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const mine = [phashes.t2, phashes.t8, phashes.t20];

  let minHam: number | null = null;
  let hamDate: string | null = null;
  for (const e of past) {
    for (const theirs of [e.phashes.t2, e.phashes.t8, e.phashes.t20]) {
      if (!theirs) continue;
      for (const h of mine) {
        const d = hammingDistanceHex(h, theirs);
        if (d !== null && (minHam === null || d < minHam)) {
          minHam = d;
          hamDate = e.date;
        }
      }
    }
  }

  const window = date
    ? nightsBefore(past, date, th.histogram_window_nights)
    : past.slice(0, th.histogram_window_nights);
  let minHist: number | null = null;
  let histDate: string | null = null;
  for (const e of window) {
    if (!e.color_histogram) continue;
    const d = histogramDistanceL1(colorHistogram, e.color_histogram);
    if (minHist === null || d < minHist) {
      minHist = d;
      histDate = e.date;
    }
  }

  const phashOk = minHam === null || minHam >= th.phash_min_hamming;
  const histOk = minHist === null || minHist >= th.histogram_min_distance;
  // Closest row: the smaller distance relative to its own threshold (below 1 means that check fails).
  const hamRatio = minHam === null ? Infinity : minHam / th.phash_min_hamming;
  const histRatio = minHist === null ? Infinity : minHist / th.histogram_min_distance;
  return {
    phashes,
    color_histogram: colorHistogram,
    min_hamming_distance: minHam,
    min_histogram_distance: minHist,
    closest_date: hamRatio <= histRatio ? (hamDate ?? histDate) : histDate,
    passed: phashOk && histOk,
  };
}
