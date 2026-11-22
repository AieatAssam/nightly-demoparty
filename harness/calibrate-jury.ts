// Milestone 4 jury calibration: leave-one-out over the 12 anchors on a local `claude` CLI.
// Usage: tsx harness/calibrate-jury.ts [--model haiku] [--effort high] [--samples 3] [--label iter1] [--anchors anchor-01,anchor-02] [--concurrency 4]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findRepoRoot, loadSlop } from "./config.js";
import { buildHorizontalStrip } from "./contact-sheet.js";
import { aggregateJuryVerdicts } from "./jury-aggregate.js";
import { fnv1a } from "./plan.js";
import { renderPrompt } from "./prompt-render.js";
import { validateVerdictStrict } from "./schema.js";
import type { Verdict } from "./types.js";

export const STRIP_DIR = "/tmp/demoparty-cal-strips";
export const CASE_DIR = "/tmp/demoparty-cal";
const SHOTS = ["shot-02s.png", "shot-08s.png", "shot-20s.png"] as const;
const CRITERIA = ["mechanism", "ambition", "craft", "distinctness", "polish"] as const;

export interface AnchorScore {
  id: string;
  title: string;
  compo: string;
  byte_size: number;
  size_budget_bytes: number;
  agreed_total: number;
  agreed_scores: Record<(typeof CRITERIA)[number], number>;
  summary_evidence: string;
}
export interface ScoresData {
  anchors: AnchorScore[];
}

/** Anchors sorted by agreed total (id breaks ties) and cut into 4 quartile groups of equal size. */
export function scoreQuartiles(scoresData: ScoresData): AnchorScore[][] {
  const sorted = [...scoresData.anchors].sort((a, b) => a.agreed_total - b.agreed_total || a.id.localeCompare(b.id));
  if (sorted.length < 8 || sorted.length % 4) throw new Error(`need a multiple of 4 anchors (at least 8), got ${sorted.length}`);
  const q = sorted.length / 4;
  return [0, 1, 2, 3].map((i) => sorted.slice(i * q, (i + 1) * q));
}

/**
 * One anchor per score quartile, never `excludeAnchorId`. The pick rotates with the excluded anchor's position
 * (and the quartile index), so across a leave-one-out run every anchor serves as calibration several times.
 */
export function selectStratifiedAnchors(scoresData: ScoresData, excludeAnchorId: string): AnchorScore[] {
  const ids = scoresData.anchors.map((a) => a.id).sort();
  const rot = Math.max(0, ids.indexOf(excludeAnchorId));
  return scoreQuartiles(scoresData).map((group, q) => {
    const pool = group.filter((a) => a.id !== excludeAnchorId);
    return pool[(rot + q) % pool.length]!;
  });
}

/** Average ranks (1-based) with ties sharing the mean of their positions. */
export function averageRanks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]![1]] = r;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rho as the Pearson correlation of average ranks (exact with ties). NaN when either side is constant. */
export function spearmanRankCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) throw new Error("spearman needs two equal-length series of at least 2");
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const mean = (r: number[]): number => r.reduce((s, v) => s + v, 0) / r.length;
  const mx = mean(rx);
  const my = mean(ry);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i]! - mx) * (ry[i]! - my);
    sxx += (rx[i]! - mx) ** 2;
    syy += (ry[i]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

export interface ClaudeRun {
  exitCode: number | null;
  /** Distinct assistant API messages (what `--max-turns` limits). The CLI's own num_turns counts content blocks. */
  apiTurns: number;
  numTurns: number | null;
  subtype: string | null;
  isError: boolean | null;
  costUsd: number | null;
  durationMs: number;
  /** Assistant text blocks, in order (the jury's `rank:` and `sum:` lines land here). */
  texts: string[];
  /** Every tool call: name plus its command, file path or URL. */
  toolUses: Array<{ name: string; arg: string }>;
  stdoutTail: string;
}

/** Runs `claude -p` with an args array (no shell), outside any parent Claude session env, on stream-json output. */
export function runClaude(args: string[], cwd: string, timeoutMs = 900_000): Promise<ClaudeRun> {
  const env = { ...process.env };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn("claude", [...args, "--output-format", "stream-json", "--verbose"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ids = new Set<string>();
      const texts: string[] = [];
      const toolUses: Array<{ name: string; arg: string }> = [];
      let result: Record<string, unknown> = {};
      for (const line of out.split("\n")) {
        let j: Record<string, unknown>;
        try {
          j = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (j.type === "result") result = j;
        if (j.type !== "assistant") continue;
        const m = j.message as { id?: string; content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> };
        if (m.id) ids.add(m.id);
        for (const c of m.content ?? []) {
          if (c.type === "text" && c.text) texts.push(c.text);
          if (c.type === "tool_use") {
            const i = c.input ?? {};
            toolUses.push({ name: c.name ?? "?", arg: String(i.command ?? i.file_path ?? i.url ?? i.query ?? i.pattern ?? "").slice(0, 2000) });
          }
        }
      }
      resolveRun({
        exitCode: code,
        apiTurns: ids.size,
        numTurns: typeof result.num_turns === "number" ? result.num_turns : null,
        subtype: typeof result.subtype === "string" ? result.subtype : null,
        isError: typeof result.is_error === "boolean" ? result.is_error : null,
        costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
        durationMs: Date.now() - started,
        texts,
        toolUses,
        stdoutTail: (typeof result.result === "string" ? result.result : out.slice(-400) + err).slice(-600),
      });
    });
  });
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Calibration block for prompts/jury.md, one anchor per quartile (lowest first): strip path, agreed criteria, rater summary. */
export function anchorsBlock(anchors: AnchorScore[], stripDir = STRIP_DIR): string {
  return anchors
    .map((a) => {
      const s = a.agreed_scores;
      return [
        `${a.id} | ${a.compo} | ${a.byte_size} of ${a.size_budget_bytes} bytes | strip: ${join(stripDir, `${a.id}.png`)}`,
        `  agreed: mechanism ${s.mechanism}, ambition ${s.ambition}, craft ${s.craft}, distinctness ${s.distinctness}, polish ${s.polish} = total ${a.agreed_total}`,
        `  raters saw: ${a.summary_evidence}`,
      ].join("\n");
    })
    .join("\n\n");
}

function audioSummary(gates: { audio_probe: null | Record<string, unknown> }): string {
  const p = gates.audio_probe;
  if (!p) return "NONE";
  return `rms ${p.rms}, peak ${p.peak}, clipped_ratio ${p.clipped_ratio}, autoplayed ${p.autoplayed}, probe passed ${p.passed}`;
}

function dossierSummary(d: { topic: string; summary: string; visualisable_mechanisms: Array<{ name: string; description: string }> }): string {
  return JSON.stringify({ topic: d.topic, summary: d.summary, visualisable_mechanisms: d.visualisable_mechanisms.map(({ name, description }) => ({ name, description })) }, null, 1);
}

export interface CaseResult {
  anchor: string;
  agreed: number;
  model_total: number | null;
  error: number | null;
  model_scores: Verdict["scores"] | null;
  calibration_anchors: string[];
  valid: boolean;
  validation_errors: string[];
  api_turns: number;
  cli_num_turns: number | null;
  verification_lines: string[];
  subtype: string | null;
  cost_usd: number | null;
  duration_s: number;
  /** --samples > 1: each raw verdict; the fields above then describe the median aggregate. */
  samples?: Array<Omit<SampleResult, "verdict">>;
}
export type SampleResult = Omit<CaseResult, "anchor" | "agreed" | "error" | "calibration_anchors" | "samples"> & { verdict: Verdict | null };

export async function calibrate(opts: {
  model: string;
  /** `claude --effort` level; Stage 7 runs Haiku at `high` (DECISIONS.md). */
  effort?: string;
  anchors?: string[];
  concurrency: number;
  label: string;
  template?: string;
  /** Independent jury calls per anchor, aggregated by aggregateJuryVerdicts (Stage 7 uses 3). */
  samples?: number;
}): Promise<Record<string, unknown>> {
  const nSamples = opts.samples ?? 1;
  const root = findRepoRoot();
  const scores = JSON.parse(readFileSync(join(root, "anchors", "scores.json"), "utf8")) as ScoresData;
  const template = readFileSync(opts.template ?? join(root, "prompts", "jury.md"), "utf8");
  const slopBlock = loadSlop(root).visual_slop.map((r) => `- ${r.id}: ${r.description}`).join("\n");
  mkdirSync(STRIP_DIR, { recursive: true });
  for (const a of scores.anchors) {
    await buildHorizontalStrip(SHOTS.map((s) => join(root, "anchors", a.id, s)), join(STRIP_DIR, `${a.id}.png`));
  }
  const targets = scores.anchors.filter((a) => !opts.anchors || opts.anchors.includes(a.id));
  const jobs = targets.flatMap((target) => Array.from({ length: nSamples }, (_, k) => ({ target, k })));
  const raw = await pool(jobs, opts.concurrency, async ({ target, k }): Promise<SampleResult> => {
    // Blind the target: neutral case dir outside the repo, shots copied, child cwd there. One dir per sample.
    const caseDir = join(CASE_DIR, opts.label, `case-${fnv1a(`${opts.label}:${target.id}`).toString(16)}${nSamples > 1 ? `-s${k + 1}` : ""}`);
    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    for (const s of SHOTS) copyFileSync(join(root, "anchors", target.id, s), join(caseDir, s));
    const cal = selectStratifiedAnchors(scores, target.id);
    const dir = join(root, "anchors", target.id);
    const outPath = join(caseDir, "verdict.json");
    const prompt = renderPrompt(
      template,
      {
        DATE: "2026-11-22",
        PIECE_COMPO: target.compo,
        BYTE_SIZE: String(target.byte_size),
        SIZE_BUDGET_BYTES: String(target.size_budget_bytes),
        AUDIO_PROBE_SUMMARY: audioSummary(JSON.parse(readFileSync(join(dir, "gates.json"), "utf8"))),
        BRIEF_JSON: JSON.stringify(JSON.parse(readFileSync(join(dir, "brief.json"), "utf8")), null, 1),
        DOSSIER_SUMMARY: dossierSummary(JSON.parse(readFileSync(join(dir, "dossier.json"), "utf8"))),
        SHOT_02_PATH: join(caseDir, SHOTS[0]),
        SHOT_08_PATH: join(caseDir, SHOTS[1]),
        SHOT_20_PATH: join(caseDir, SHOTS[2]),
        CALIBRATION_ANCHORS_BLOCK: anchorsBlock(cal),
        VISUAL_SLOP_BLOCK: slopBlock,
        RECENT_SEVEN_BLOCK: "NONE",
        MEDIAN_PIECE_BLOCK: "NONE (empty archive)",
        OUTPUT_PATH: outPath,
      },
      { escapeHtmlLtKeys: ["BRIEF_JSON", "DOSSIER_SUMMARY"] },
    );
    writeFileSync(join(caseDir, "prompt.md"), prompt);
    const run = await runClaude(
      ["--model", opts.model, ...(opts.effort ? ["--effort", opts.effort] : []), "--max-turns", "4", "--tools", "Read,Write", "--allowedTools", "Read,Write", "--permission-mode", "bypassPermissions", "-p", prompt],
      caseDir,
    );
    let verdict: Verdict | null = null;
    let errors: string[] = [];
    if (existsSync(outPath)) {
      try {
        verdict = JSON.parse(readFileSync(outPath, "utf8")) as Verdict;
        const r = validateVerdictStrict(verdict, root, { archiveEmpty: true, expectedAnchors: cal.map((a) => a.id), requireScreenshotRef: true });
        if (!r.ok) errors = r.errors;
      } catch (e) {
        errors = [`verdict is not JSON: ${(e as Error).message}`];
      }
    } else errors = [`no verdict written (${run.subtype ?? "no result"}): ${run.stdoutTail.slice(-200)}`];
    const total = verdict && typeof verdict.total === "number" ? verdict.total : null;
    const res: SampleResult = {
      verdict: errors.length ? null : verdict,
      model_total: total,
      model_scores: verdict?.scores ?? null,
      valid: errors.length === 0,
      validation_errors: errors,
      api_turns: run.apiTurns,
      cli_num_turns: run.numTurns,
      verification_lines: run.texts.flatMap((t) => t.split("\n")).filter((l) => /^\s*`?(crit|rank|sum):/i.test(l)).map((l) => l.trim()),
      subtype: run.subtype,
      cost_usd: run.costUsd,
      duration_s: Math.round(run.durationMs / 1000),
    };
    console.error(`${target.id}${nSamples > 1 ? ` s${k + 1}` : ""}: agreed ${target.agreed_total}, model ${total}, turns ${run.apiTurns}, valid ${res.valid}${errors.length ? ` (${errors.join("; ")})` : ""}`);
    return res;
  });
  const results = targets.map((target, ti): CaseResult => {
    const ss = raw.slice(ti * nSamples, (ti + 1) * nSamples);
    const cal = selectStratifiedAnchors(scores, target.id).map((a) => a.id);
    const base = { anchor: target.id, agreed: target.agreed_total, calibration_anchors: cal };
    if (nSamples === 1) {
      const { verdict: _v, ...s0 } = ss[0]!;
      return { ...base, ...s0, error: s0.model_total === null ? null : s0.model_total - target.agreed_total };
    }
    let agg: Verdict | null = null;
    let errors: string[] = [];
    const good = ss.flatMap((s) => (s.verdict ? [s.verdict] : []));
    try {
      agg = aggregateJuryVerdicts(good, { archiveEmpty: true, expectedAnchors: cal, requireScreenshotRef: true }, root);
    } catch (e) {
      errors = [(e as Error).message];
    }
    if (good.length < ss.length) errors.push(`${ss.length - good.length} of ${ss.length} samples invalid`);
    console.error(`${target.id}: agreed ${target.agreed_total}, median ${agg?.total ?? null} from [${ss.map((s) => s.model_total).join(", ")}]`);
    return {
      ...base,
      model_total: agg?.total ?? null,
      error: agg ? agg.total - target.agreed_total : null,
      model_scores: agg?.scores ?? null,
      valid: errors.length === 0,
      validation_errors: errors,
      api_turns: Math.max(...ss.map((s) => s.api_turns)),
      cli_num_turns: null,
      verification_lines: [],
      subtype: ss.every((s) => s.subtype === "success") ? "success" : (ss.find((s) => s.subtype !== "success")?.subtype ?? null),
      cost_usd: Number(ss.reduce((t, s) => t + (s.cost_usd ?? 0), 0).toFixed(4)),
      duration_s: Math.max(...ss.map((s) => s.duration_s)),
      samples: ss.map(({ verdict: _v, ...s }) => s),
    };
  });
  const scored = results.filter((r) => r.model_total !== null);
  const abs = scored.map((r) => Math.abs(r.error!));
  return {
    label: opts.label,
    model: opts.model,
    effort: opts.effort ?? null,
    samples: nSamples,
    ...(nSamples > 1
      ? {
          raw_valid: `${raw.filter((r) => r.valid).length}/${raw.length}`,
          raw_within_turns: `${raw.filter((r) => r.subtype === "success" && r.api_turns <= 4).length}/${raw.length}`,
        }
      : {}),
    prompt_sha256: createHash("sha256").update(template).digest("hex"),
    ran_at: new Date().toISOString(),
    n: results.length,
    valid: results.filter((r) => r.valid).length,
    within_turns: results.filter((r) => r.subtype === "success" && r.api_turns <= 4).length,
    spearman_rho:
      scored.length >= 2 ? Number(spearmanRankCorrelation(scored.map((r) => r.agreed), scored.map((r) => r.model_total!)).toFixed(4)) : null,
    mae: abs.length ? Number((abs.reduce((s, v) => s + v, 0) / abs.length).toFixed(2)) : null,
    max_abs_error: abs.length ? Math.max(...abs) : null,
    bias: scored.length ? Number((scored.reduce((s, r) => s + r.error!, 0) / scored.length).toFixed(2)) : null,
    cost_usd: Number(results.reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(4)),
    results,
  };
}

async function main(argv: string[]): Promise<void> {
  const arg = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const summary = await calibrate({
    model: arg("model") ?? "haiku",
    effort: arg("effort") ?? "high",
    label: arg("label") ?? "run",
    concurrency: Number(arg("concurrency") ?? 4),
    samples: Number(arg("samples") ?? 1),
    ...(arg("anchors") ? { anchors: arg("anchors")!.split(",") } : {}),
    ...(arg("template") ? { template: arg("template")! } : {}),
  });
  const out = arg("out");
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
