// The nightly pipeline outside the LLM calls, shared by .github/workflows/nightly.yml and the local end-to-end dry run.
// Everything a night produces lives in one folder (NIGHT): audit/<date>/ in Actions, --out locally.
//
// Local dry run (npm run dry-run -- ...): the whole night on the local `claude` CLI, never touching the repo's
// state/emotion.json, ledger/ledger.jsonl, audit/usage.jsonl or site/pieces/.
//   tsx harness/dry-run.ts --out DIR [--date D] [--seed S] [--force-domain X] [--force-compo C] [--force-mood-preset M]
//                          [--ledger P] [--max-attempts 1..3]
// Pieces the workflow calls between its harness/cli.ts and agent steps:
//   tsx harness/dry-run.ts step <name> --night DIR [--ledger P] [--try K] [--attempt N] [--dry-run] [--stage S --reason R]
//     names: init, render-research, render-appraise, check-appraisals, render-brief, render-build, gate, render-jury,
//            jury-check, attempts, halt, publish-input, finalize
//   tsx harness/dry-run.ts log-usage --execution-file F --usage-file U --stage S --attempt N --model M [--effort E]
//                          --date D --run-id R   (composite action usage row; no row without real usage telemetry)
// The composite action's workspace guard is pure Bash (.github/actions/agent/action.yml); the local runner below uses
// the same rules in TypeScript plus a direct hash snapshot of the night folder.
// Step outputs are printed as JSON and, inside Actions, appended to $GITHUB_OUTPUT.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { anchorsBlock, selectStratifiedAnchors, type ScoresData } from "./calibrate-jury.js";
import { findRepoRoot, loadAllConfig, loadCurriculum, loadSlop } from "./config.js";
import { buildHorizontalStrip } from "./contact-sheet.js";
import { decideAttempt, median30d } from "./decide.js";
import { getEmotionContext, shelvedStreakBefore } from "./emotion.js";
import { allBefore, dayNumber, readLedger } from "./novelty.js";
import { renderPrompt } from "./prompt-render.js";
import type { PublishAttempt, PublishInput } from "./publish.js";
import { validateDossierStrict, validateSchema, validateVerdictStrict } from "./schema.js";
import { appendUsage } from "./usage.js";
import type { Brief, Dossier, GatesResult, LedgerEntry, Mood, NightStatus, Plan, UsageEntry, UsageStage, Verdict } from "./types.js";

const ROOT = findRepoRoot();
const SHOTS = ["shot-02s.png", "shot-08s.png", "shot-20s.png"] as const;

/** SPEC section 5. nightly.yml and weekly.yml repeat these; tests/workflows.test.ts keeps them in step. */
export const STAGES = {
  research: { model: "haiku", effort: null, maxTurns: 15, tools: "WebSearch,WebFetch,Write" },
  appraise: { model: "haiku", effort: null, maxTurns: 3, tools: "Write" },
  brief: { model: "haiku", effort: null, maxTurns: 6, tools: "Read,Write" },
  build: { model: "haiku", effort: null, maxTurns: 30, tools: "Read,Write,Edit,Bash(npm run gate:*)" },
  jury: { model: "haiku", effort: "high", maxTurns: 4, tools: "Read,Write" },
  retro: { model: "opus", effort: "low", maxTurns: 8, tools: "Read,Write" },
} as const;
/** Stage 5: Haiku twice, then Opus at low effort. Never more than 3. */
export const BUILD_ATTEMPTS = [
  { model: "haiku", effort: null },
  { model: "haiku", effort: null },
  { model: "opus", effort: "low" },
] as const;
export const JURY_SAMPLES = 3;
/** Sample 4 is the one evidence retry per attempt (SPEC: jury 9 calls, up to 12 with retries). */
export const JURY_RETRY_SAMPLE = 4;

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const readJsonIf = <T>(p: string): T | null => (existsSync(p) ? readJson<T>(p) : null);
const writeJson = (p: string, v: unknown): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
};

// ---------- night folder ----------

export function nightPaths(night: string) {
  // Real path: Claude Code matches Edit(//abs) rules against resolved paths (macOS /tmp is /private/tmp).
  const dir = existsSync(night) ? realpathSync(night) : resolve(night);
  const f = (...p: string[]): string => join(dir, ...p);
  return {
    dir,
    plan: f("plan.json"),
    dossier: f("dossier.json"),
    appraisals: f("appraisals.json"),
    mood: f("mood.json"),
    brief: f("brief.json"),
    piece: f("piece", "index.html"),
    selfgate: f("selfgate"),
    prompts: f("prompts"),
    usageDir: f("usage"),
    usage: f("usage.jsonl"),
    calls: f("calls.jsonl"),
    stateDir: f("state"),
    emotionLog: f("emotion.log.jsonl"),
    strips: f("strips"),
    halt: f("halt.json"),
    attempts: f("attempts.json"),
    juryContext: f("jury-context.json"),
    publishInput: f("publish-input.json"),
    publishOut: f("publish"),
    feedback: f("feedback.json"),
    summary: f("summary.json"),
    researchCheck: (k: number) => f(`research-check-${k}.json`),
    novelty: (k: number) => f(`novelty-${k}.json`),
    attempt: (n: number) => f(`attempt-${n}`),
    decision: (n: number) => f(`decision-${n}.json`),
  };
}

export interface NightCtx {
  night: string;
  ledger: string;
}

function ctxLedger(c: NightCtx): LedgerEntry[] {
  return readLedger(c.ledger, ROOT);
}

function planOf(c: NightCtx): Plan {
  return readJson<Plan>(nightPaths(c.night).plan);
}

/** Moves `from` aside as `to` (audit trail of a rejected try). */
function archive(from: string, to: string): void {
  if (existsSync(from)) renameSync(from, to);
}

function writePrompt(c: NightCtx, name: string, text: string): string {
  const p = join(nightPaths(c.night).prompts, `${name}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function template(stage: string): string {
  return readFileSync(join(ROOT, "prompts", `${stage}.md`), "utf8");
}

/** Errors from a `harness/cli.ts validate|novelty` JSON output file, as prompt lines. */
function checkLines(path: string): string[] {
  const j = readJsonIf<{ errors?: string[]; brief_errors?: string[]; collisions?: unknown[]; error?: string }>(path);
  if (!j) return ["no check output was recorded"];
  return [
    ...(j.error ? [j.error] : []),
    ...(j.errors ?? []),
    ...(j.brief_errors ?? []),
    ...(j.collisions ?? []).map((x) => JSON.stringify(x)),
  ];
}

// ---------- steps ----------

/** Fresh night folder plus the scratch copy of the emotion state every engine call in the night works on. */
export function stepInit(c: NightCtx): Record<string, string> {
  const p = nightPaths(c.night);
  if (/\s/.test(p.dir)) throw new Error(`night folder must not contain whitespace (it is pasted into the gate command): ${p.dir}`);
  mkdirSync(p.stateDir, { recursive: true });
  copyFileSync(join(ROOT, "state", "emotion.json"), join(p.stateDir, "emotion.json"));
  return { night: p.dir };
}

export function stepRenderResearch(c: NightCtx, k: number): Record<string, string> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  const d = loadAllConfig(ROOT).domains.find((x) => x.id === plan.domain);
  const hint = plan.wildcard
    ? "Wildcard night: choose a genuinely surprising domain yourself, never one in plan.banned.domains."
    : d
      ? `${d.name} (${d.category}): ${d.prompt_hint}`
      : `${plan.domain} (forced domain; no hint in config/domains.yml).`;
  let rejection = "NONE";
  if (k > 1) {
    const prev = join(p.dir, `dossier-try-${k - 1}.json`);
    archive(p.dossier, prev);
    rejection = existsSync(prev)
      ? checkLines(p.researchCheck(k - 1)).map((l) => `- ${l}`).join("\n")
      : "- The previous run wrote no dossier file. Write it before you run out of turns.";
  }
  const prompt = renderPrompt(template("research"), {
    PLAN_JSON: JSON.stringify(plan, null, 1),
    DOMAIN_HINT: hint,
    PREVIOUS_REJECTION: rejection,
    OUTPUT_PATH: p.dossier,
  });
  return { prompt_file: writePrompt(c, `research-${k}`, prompt) };
}

function lastNightSummary(ledger: LedgerEntry[], date: string): string {
  const e = allBefore(ledger, date)[0];
  if (!e) return "NONE";
  return `${e.date}: ${e.status}${e.score === null ? "" : ` at ${e.score}`}; compo ${e.compo}; domain ${e.domain}; topic ${e.topic ?? "none"}; concept ${e.concept ?? "none"}`;
}

export function stepRenderAppraise(c: NightCtx): Record<string, string> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  const ledger = ctxLedger(c);
  const prompt = renderPrompt(
    template("appraise"),
    {
      DATE: plan.date,
      DOSSIER_JSON: readFileSync(p.dossier, "utf8").trim(),
      EMOTION_CONTEXT: getEmotionContext({ repoRoot: ROOT, stateDir: p.stateDir }),
      LAST_NIGHT_SUMMARY: lastNightSummary(ledger, plan.date),
      SHELVED_STREAK: String(shelvedStreakBefore(ledger, plan.date)),
      OUTPUT_PATH: p.appraisals,
    },
    { escapeHtmlLtKeys: ["DOSSIER_JSON", "LAST_NIGHT_SUMMARY"] },
  );
  return { prompt_file: writePrompt(c, "appraise", prompt) };
}

/**
 * Keeps Haiku's appraisals when they are schema-valid. Otherwise (no file, bad JSON, bad shape) writes one neutral
 * event about tonight's topic, so a failed appraisal call costs the mood one night's nuance instead of the night.
 */
export function stepCheckAppraisals(c: NightCtx): Record<string, string> {
  const p = nightPaths(c.night);
  let errors: string[] = [];
  try {
    const r = validateSchema("appraisals", readJson(p.appraisals), ROOT);
    if (r.ok) return { fallback: "false" };
    errors = r.errors;
  } catch (e) {
    errors = [(e as Error).message];
  }
  archive(p.appraisals, join(p.dir, "appraisals-invalid.json"));
  const plan = planOf(c);
  const topic = readJsonIf<Dossier>(p.dossier)?.topic ?? plan.domain;
  writeJson(p.appraisals, {
    events: [
      {
        event: `Tonight's research arrived: ${topic}`.slice(0, 300),
        event_id: `${plan.date}:fallback`,
        topics: [plan.domain.slice(0, 60)],
        relevance: 0.5,
        congruence: 0,
        novelty: 0.5,
        agency: "circumstance",
        certainty: 0.5,
        thread: plan.date,
      },
    ],
  });
  writeJson(join(p.dir, "appraisals-fallback.json"), { errors });
  return { fallback: "true" };
}

function curriculumSummary(): string {
  return loadCurriculum(ROOT).map((t) => `- ${t.name} (${t.family}): ${t.how_to}`).join("\n");
}

function ledgerTechniques(ledger: LedgerEntry[], date: string): string {
  const rows = allBefore(ledger, date).filter((e) => e.techniques.length || e.technique_family);
  if (!rows.length) return "NONE (empty ledger)";
  return rows.map((e) => `${e.date}: family ${e.technique_family ?? "none"}; ${e.techniques.join(", ")}`).join("\n");
}

export function stepRenderBrief(c: NightCtx, k: number): Record<string, string> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  let collision = "NONE";
  if (k > 1) {
    const prev = join(p.dir, `brief-try-${k - 1}.json`);
    archive(p.brief, prev);
    const lines = existsSync(prev) ? checkLines(p.novelty(k - 1)) : ["The previous run wrote no brief file. Write it before you run out of turns."];
    if (k >= 3) lines.push("Two briefs have collided. Build tonight's piece on a different visualisable mechanism from the dossier.");
    collision = lines.map((l) => `- ${l}`).join("\n");
  }
  const prompt = renderPrompt(
    template("brief"),
    {
      PLAN_JSON: JSON.stringify(plan, null, 1),
      DOSSIER_JSON: readFileSync(p.dossier, "utf8").trim(),
      MOOD_JSON: JSON.stringify(readJson<Mood>(p.mood), null, 1),
      CURRICULUM_SUMMARY: curriculumSummary(),
      LEDGER_TECHNIQUES: ledgerTechniques(ctxLedger(c), plan.date),
      PREVIOUS_COLLISION: collision,
      OUTPUT_PATH: p.brief,
    },
    { escapeHtmlLtKeys: ["DOSSIER_JSON", "MOOD_JSON"] },
  );
  return { prompt_file: writePrompt(c, `brief-${k}`, prompt) };
}

function defaultLedger(): string {
  return join(ROOT, "ledger", "ledger.jsonl");
}

export function gateCommand(c: NightCtx, plan: Plan): string {
  const p = nightPaths(c.night);
  return [
    "npm run gate --",
    p.piece,
    `--compo ${plan.compo}`,
    `--out ${p.selfgate}`,
    `--budget ${plan.size_budget_bytes}`,
    ...(plan.constraint ? [`--constraint ${plan.constraint}`] : []),
    ...(resolve(c.ledger) !== defaultLedger() ? [`--ledger ${resolve(c.ledger)}`] : []),
    `--date ${plan.date}`,
  ].join(" ");
}

interface DecisionFile {
  action: "publish" | "retry" | "b-side" | "shelve";
  best_attempt: number | null;
  best_total: number | null;
  publish_threshold: number;
  reason: string;
  feedback: { gate_failures: unknown[]; critique: unknown[]; build_failed: boolean } | null;
}

export function stepRenderBuild(c: NightCtx, n: number): Record<string, string> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  mkdirSync(dirname(p.piece), { recursive: true });
  // Every attempt starts with no candidate: a build that times out or writes nothing must never re-gate and re-judge
  // the previous attempt's HTML (that copy stays in attempt-(n-1)/index.html).
  rmSync(p.piece, { force: true });
  rmSync(p.selfgate, { recursive: true, force: true });
  let feedback = "NONE";
  if (n > 1) {
    const d = readJsonIf<DecisionFile>(p.decision(n - 1));
    feedback = d?.feedback?.build_failed
      ? "The previous attempt wrote no index.html. Write the whole piece first, then run the gate."
      : JSON.stringify({ gate_failures: d?.feedback?.gate_failures ?? [], critique: d?.feedback?.critique ?? [] }, null, 1);
  }
  const prompt = renderPrompt(
    template("build"),
    {
      PLAN_JSON: JSON.stringify(plan, null, 1),
      BRIEF_JSON: JSON.stringify(readJson<Brief>(p.brief), null, 1),
      DOSSIER_JSON: readFileSync(p.dossier, "utf8").trim(),
      MOOD_JSON: JSON.stringify(readJson<Mood>(p.mood), null, 1),
      ATTEMPT_NUMBER: String(n),
      PREVIOUS_FEEDBACK: feedback,
      PIECE_PATH: p.piece,
      GATE_OUT_DIR: p.selfgate,
      GATE_COMMAND: gateCommand(c, plan),
    },
    { escapeHtmlLtKeys: ["DOSSIER_JSON", "BRIEF_JSON", "MOOD_JSON"] },
  );
  const a = BUILD_ATTEMPTS[n - 1];
  if (!a) throw new Error(`attempt must be 1 to ${BUILD_ATTEMPTS.length}, got ${n}`);
  return { prompt_file: writePrompt(c, `build-${n}`, prompt), model: a.model, effort: a.effort ?? "" };
}

/**
 * Stage 6 in a fresh attempt-N/ folder: the builder's piece is copied in and gated from scratch, so nothing the builder
 * wrote in selfgate/ (or anywhere else) is trusted. No piece means a build failure (attempt-N/build-failed.json).
 */
export async function stepGate(c: NightCtx, n: number): Promise<Record<string, string>> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  const dir = p.attempt(n);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  rmSync(p.selfgate, { recursive: true, force: true });
  if (!existsSync(p.piece)) {
    writeJson(join(dir, "build-failed.json"), { reason: "the builder wrote no index.html" });
    return { built: "false", passed: "false" };
  }
  copyFileSync(p.piece, join(dir, "index.html"));
  const { runHardGates } = await import("./gates.js");
  const g = await runHardGates({
    piecePath: join(dir, "index.html"),
    compo: plan.compo,
    outDir: dir,
    ledgerPath: resolve(c.ledger),
    repoRoot: ROOT,
    constraint: plan.constraint,
    date: plan.date,
    timingScale: 1,
  });
  return { built: "true", passed: String(g.passed) };
}

function audioSummary(g: GatesResult): string {
  const a = g.audio_probe;
  if (!a) return "NONE";
  return `rms ${a.rms}, peak ${a.peak}, clipped_ratio ${a.clipped_ratio}, autoplayed ${a.autoplayed}, probe passed ${a.passed}`;
}

function dossierSummary(d: Dossier): string {
  return JSON.stringify(
    { topic: d.topic, summary: d.summary, visualisable_mechanisms: d.visualisable_mechanisms.map(({ name, description }) => ({ name, description })) },
    null,
    1,
  );
}

/** Tonight's 4 calibration anchors: one per score quartile, rotating with the date (one anchor is left out each night). */
export function nightAnchors(date: string): ScoresData["anchors"] {
  const scores = readJson<ScoresData>(join(ROOT, "anchors", "scores.json"));
  const ids = scores.anchors.map((a) => a.id).sort();
  return selectStratifiedAnchors(scores, ids[dayNumber(date) % ids.length]!);
}

function pieceShots(date: string): string[] | null {
  const shots = SHOTS.map((s) => join(ROOT, "site", "pieces", date, s));
  return shots.every((s) => existsSync(s)) ? shots : null;
}

/**
 * The shipped, scored piece in the same 30-night window median30d uses, closest to the median (newest on ties).
 * Null when the window is empty. The jury and every verdict check use archive_empty === (this is null).
 */
export function medianPiece(ledger: LedgerEntry[], date: string): LedgerEntry | null {
  const m = median30d(ledger, date);
  if (m === null) return null;
  const today = dayNumber(date);
  const pool = ledger.filter((e) => {
    const d = today - dayNumber(e.date);
    return d >= 1 && d <= 30 && e.status !== "shelved" && e.score !== null;
  });
  return pool.sort((a, b) => Math.abs(a.score! - m) - Math.abs(b.score! - m) || (a.date < b.date ? 1 : -1))[0] ?? null;
}

interface JuryContext {
  expected_anchors: string[];
  archive_empty: boolean;
  median_ref: string | null;
}

/** Stage 7 prompts for samples 1 to 3 plus the retry sample, all identical except OUTPUT_PATH. */
export async function stepRenderJury(c: NightCtx, n: number): Promise<Record<string, string>> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  const ledger = ctxLedger(c);
  const dir = p.attempt(n);
  const g = readJson<GatesResult>(join(dir, "gates.json"));
  mkdirSync(p.strips, { recursive: true });

  const cal = nightAnchors(plan.date);
  for (const a of cal) {
    const strip = join(p.strips, `${a.id}.png`);
    if (!existsSync(strip)) await buildHorizontalStrip(SHOTS.map((s) => join(ROOT, "anchors", a.id, s)), strip);
  }

  // Recent block: up to 7 shipped nights whose shots are in site/pieces, as one strip of their 8 s frames.
  const recent = allBefore(ledger, plan.date)
    .filter((e) => e.status !== "shelved" && pieceShots(e.date))
    .slice(0, 7);
  let recentBlock = "NONE";
  if (recent.length) {
    const strip = join(p.strips, "recent.png");
    await buildHorizontalStrip(recent.map((e) => pieceShots(e.date)![1]!), strip);
    recentBlock = [
      `strip: ${strip} (one tile per night, left to right, each night's shot-08s)`,
      ...recent.map((e, i) => `${i + 1}. ${e.date} | ${e.compo} | ${e.technique_family ?? "none"} | ${e.concept ?? ""}`),
    ].join("\n");
  }

  // Median block: NONE exactly when median30d is null. If the median piece's shots are missing, the jury still gets
  // its date as the reference, and every check below is told the archive is not empty.
  const med = medianPiece(ledger, plan.date);
  let medianBlock = "NONE";
  if (med) {
    const shots = pieceShots(med.date);
    let strip = "(screenshots unavailable; judge from its compo and concept)";
    if (shots) {
      strip = join(p.strips, `median-${med.date}.png`);
      await buildHorizontalStrip(shots, strip);
    }
    medianBlock = `${med.date} | ${med.compo} | ${med.concept ?? ""} | strip: ${strip}`;
  }
  const ctx: JuryContext = { expected_anchors: cal.map((a) => a.id), archive_empty: med === null, median_ref: med?.date ?? null };
  writeJson(p.juryContext, ctx);

  const vars = {
    DATE: plan.date,
    PIECE_COMPO: plan.compo,
    BYTE_SIZE: String(g.byte_size),
    SIZE_BUDGET_BYTES: String(g.size_budget_bytes),
    AUDIO_PROBE_SUMMARY: audioSummary(g),
    BRIEF_JSON: JSON.stringify(readJson<Brief>(p.brief), null, 1),
    DOSSIER_SUMMARY: dossierSummary(readJson<Dossier>(p.dossier)),
    SHOT_02_PATH: join(dir, SHOTS[0]),
    SHOT_08_PATH: join(dir, SHOTS[1]),
    SHOT_20_PATH: join(dir, SHOTS[2]),
    CALIBRATION_ANCHORS_BLOCK: anchorsBlock(cal, p.strips),
    VISUAL_SLOP_BLOCK: loadSlop(ROOT).visual_slop.map((r) => `- ${r.id}: ${r.description}`).join("\n"),
    RECENT_SEVEN_BLOCK: recentBlock,
    MEDIAN_PIECE_BLOCK: medianBlock,
  };
  const out: Record<string, string> = {};
  for (let k = 1; k <= JURY_RETRY_SAMPLE; k++) {
    const prompt = renderPrompt(template("jury"), { ...vars, OUTPUT_PATH: join(dir, `verdict-sample-${k}.json`) }, {
      escapeHtmlLtKeys: ["BRIEF_JSON", "DOSSIER_SUMMARY"],
    });
    out[`prompt_${k}`] = writePrompt(c, `jury-a${n}-s${k}`, prompt);
  }
  return { ...out, ...juryFlags(ctx) };
}

function juryFlags(ctx: JuryContext): Record<string, string> {
  return { expected_anchors: ctx.expected_anchors.join(","), archive_flag: ctx.archive_empty ? "--archive-empty" : "--no-archive-empty" };
}

/**
 * Checks every verdict sample with the same strict options the CLI uses (screenshot refs, tonight's anchors, archive
 * state). retry=true when fewer than 3 are valid and the retry sample has not run yet. files lists up to 3 valid samples.
 */
export function stepJuryCheck(c: NightCtx, n: number): Record<string, string> {
  const p = nightPaths(c.night);
  const ctx = readJson<JuryContext>(p.juryContext);
  const results = Array.from({ length: JURY_RETRY_SAMPLE }, (_, i) => {
    const file = join(p.attempt(n), `verdict-sample-${i + 1}.json`);
    if (!existsSync(file)) return { sample: i + 1, file, ok: false, errors: ["not written"] };
    try {
      const r = validateVerdictStrict(readJson<Verdict>(file), ROOT, {
        archiveEmpty: ctx.archive_empty,
        expectedAnchors: ctx.expected_anchors,
        requireScreenshotRef: true,
      });
      return { sample: i + 1, file, ok: r.ok, errors: r.ok ? [] : r.errors };
    } catch (e) {
      return { sample: i + 1, file, ok: false, errors: [(e as Error).message] };
    }
  });
  const valid = results.filter((r) => r.ok).map((r) => r.file).slice(0, JURY_SAMPLES);
  const retry = valid.length < JURY_SAMPLES && !existsSync(join(p.attempt(n), `verdict-sample-${JURY_RETRY_SAMPLE}.json`));
  writeJson(join(p.attempt(n), "jury-check.json"), results);
  return { retry: String(retry), valid: String(valid.length), files: valid.join(" "), ...juryFlags(ctx) };
}

/** attempts.json for `cli decide` and publish-input, rebuilt from the attempt folders each time. */
export function stepAttempts(c: NightCtx): Record<string, string> {
  const p = nightPaths(c.night);
  const attempts: PublishAttempt[] = [];
  for (let n = 1; n <= BUILD_ATTEMPTS.length; n++) {
    const dir = p.attempt(n);
    if (!existsSync(dir)) continue;
    const a = BUILD_ATTEMPTS[n - 1]!;
    attempts.push({
      attempt: n,
      model: a.model,
      effort: a.effort,
      gates: readJsonIf<GatesResult>(join(dir, "gates.json")),
      verdict: readJsonIf<Verdict>(join(dir, "verdict.json")),
    });
  }
  writeJson(p.attempts, attempts);
  return { count: String(attempts.length), ...nightJuryFlags(c) };
}

/**
 * The verdict-check flags for every decide/aggregate call of the night. Both values are fixed by the date and the
 * ledger, so an attempt whose gates failed (no jury, no jury-context.json yet) still checks earlier verdicts the same way.
 */
export function nightJuryFlags(c: NightCtx): Record<string, string> {
  const saved = readJsonIf<JuryContext>(nightPaths(c.night).juryContext);
  if (saved) return juryFlags(saved);
  const date = planOf(c).date;
  return juryFlags({
    expected_anchors: nightAnchors(date).map((a) => a.id),
    archive_empty: medianPiece(ctxLedger(c), date) === null,
    median_ref: null,
  });
}

export function stepHalt(c: NightCtx, stage: string, reason: string): Record<string, string> {
  writeJson(nightPaths(c.night).halt, { stage, reason: reason.slice(0, 400) });
  return { halted: "true" };
}

function latestDecision(c: NightCtx): { n: number; d: DecisionFile } | null {
  const p = nightPaths(c.night);
  for (let n = BUILD_ATTEMPTS.length; n >= 1; n--) {
    const d = readJsonIf<DecisionFile>(p.decision(n));
    if (d?.action) return { n, d };
  }
  return null;
}

/** The furthest stage output on disk, for the reason line when a night stops early. */
function lastStage(c: NightCtx): string {
  const p = nightPaths(c.night);
  const marks: Array<[string, string]> = [
    [p.attempts, "build"],
    [p.brief, "brief"],
    [p.mood, "feel"],
    [p.dossier, "research"],
    [p.plan, "plan"],
  ];
  return marks.find(([f]) => existsSync(f))?.[1] ?? "nothing";
}

/**
 * Stage 9 input: status from the last decision (publish, b-side, shelve), or shelved with the reason when the night
 * halted (research or brief exhausted its retries) or stopped before Stage 8. Writes publish-input.json and
 * feedback.json (the emotion-feedback arguments, read by the workflow with jq).
 */
export function stepPublishInput(c: NightCtx, dryRun: boolean): Record<string, string> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  const config = loadAllConfig(ROOT);
  stepAttempts(c);
  const attempts = readJson<PublishAttempt[]>(p.attempts);
  const halt = readJsonIf<{ stage: string; reason: string }>(p.halt);
  const last = latestDecision(c);

  let dossier: Dossier | null = null;
  if (existsSync(p.dossier)) {
    const r = validateDossierStrict(readFileSync(p.dossier, "utf8"), plan, { maxBytes: config.thresholds.gates.dossier_max_bytes, repoRoot: ROOT });
    dossier = r.ok ? r.data : null;
  }
  const mood = existsSync(p.mood) ? readJson<Mood>(p.mood) : null;
  // A brief only counts once it passed Novelty Gate A.
  const passedBrief = [1, 2, 3].some((k) => readJsonIf<{ passed?: boolean }>(p.novelty(k))?.passed === true);
  const brief = passedBrief && existsSync(p.brief) ? readJson<Brief>(p.brief) : null;

  let status: NightStatus = "shelved";
  let reason: string;
  let best: number | null = null;
  let threshold = config.thresholds.publish_min;
  if (halt) {
    reason = `Stopped at ${halt.stage}: ${halt.reason}`;
  } else if (!last) {
    reason = `The night stopped before Stage 8 decided (last stage reached: ${lastStage(c)}).`;
  } else {
    const { d, n } = last;
    threshold = d.publish_threshold;
    best = d.best_attempt;
    reason = d.reason;
    let action = d.action;
    if (action === "retry") {
      // The night ran out of time or attempts after asking for a retry: decide again as if attempt n were the last.
      const final = decideAttempt({
        attempts: attempts.filter((a) => a.attempt <= n),
        currentAttempt: n,
        maxAttempts: n,
        publishThreshold: d.publish_threshold,
        bSideMin: config.thresholds.b_side_min,
        archiveEmpty: nightJuryFlags(c).archive_flag === "--archive-empty",
      });
      action = final.action;
      best = final.best_attempt;
      reason = `The night stopped after attempt ${n} asked for a retry. ${final.reason}`;
    }
    if (action === "publish") status = "published";
    else if (action === "b-side") status = "b-side";
  }
  const input: PublishInput = {
    status,
    reason: status === "published" ? null : reason.slice(0, 400),
    publishThreshold: threshold,
    plan,
    dossier,
    mood,
    brief,
    attempts,
    bestAttempt: best,
    dryRun: dryRun || plan.dry_run,
  };
  writeJson(p.publishInput, input);
  const bestVerdict = attempts.find((a) => a.attempt === best)?.verdict ?? null;
  const scores = attempts.map((a) => a.verdict?.total).filter((t): t is number => typeof t === "number");
  const score = bestVerdict?.total ?? (scores.length ? Math.max(...scores) : null);
  const feedback = {
    date: plan.date,
    status,
    score: score === null ? "null" : String(score),
    compo: plan.compo,
    domain: plan.wildcard ? (dossier?.domain ?? plan.domain) : plan.domain,
    technique_family: brief?.technique_family ?? "",
  };
  writeJson(p.feedback, feedback);
  return { status, dry_run: String(input.dryRun) };
}

/**
 * Collects the night: usage/*.jsonl into usage.jsonl, meta.json, decision.json and (when shipped) the CSP-injected
 * index.html and screenshots copied to the night root, and summary.json.
 */
export function stepFinalize(c: NightCtx, publishRoot?: string): Record<string, string> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  const rows = existsSync(p.usageDir)
    ? readdirSync(p.usageDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => readFileSync(join(p.usageDir, f), "utf8").split("\n").filter((l) => l.trim()))
    : [];
  const usage = rows.map((l) => JSON.parse(l) as UsageEntry).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  writeFileSync(p.usage, usage.map((u) => `${JSON.stringify(u)}\n`).join(""));

  const pieceDir = join(publishRoot ?? p.publishOut, "site", "pieces", plan.date);
  for (const f of ["meta.json", "index.html", ...SHOTS]) {
    if (existsSync(join(pieceDir, f))) copyFileSync(join(pieceDir, f), join(p.dir, f));
  }
  const last = latestDecision(c);
  if (last) writeJson(join(p.dir, "decision.json"), last.d);
  const input = readJsonIf<PublishInput>(p.publishInput);
  const summary = {
    date: plan.date,
    dry_run: input?.dryRun ?? plan.dry_run,
    compo: plan.compo,
    domain: plan.domain,
    status: input?.status ?? null,
    reason: input?.reason ?? null,
    best_attempt: input?.bestAttempt ?? null,
    attempts: (input?.attempts ?? []).map((a) => ({
      attempt: a.attempt,
      model: a.model,
      effort: a.effort,
      gates_passed: a.gates?.passed ?? null,
      gate_failures: a.gates?.failures.map((f) => f.gate) ?? [],
      total: a.verdict?.total ?? null,
    })),
    // calls.jsonl (local runner) also counts calls that timed out without usage telemetry.
    llm_calls: Math.max(usage.length, existsSync(p.calls) ? readFileSync(p.calls, "utf8").split("\n").filter((l) => l.trim()).length : 0),
    cost_usd: Number(usage.reduce((s, u) => s + u.cost_usd, 0).toFixed(4)),
    tokens: usage.reduce((s, u) => s + u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens, 0),
    duration_s: Math.round(usage.reduce((s, u) => s + u.duration_ms, 0) / 1000),
  };
  writeJson(p.summary, summary);
  return { status: String(summary.status), cost_usd: String(summary.cost_usd) };
}

// ---------- workspace guard (composite action and local runner) ----------

const GIT_SAFE = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"];

/**
 * Every changed, untracked or deleted path git reports, with a content hash so an already-dirty file that changes again
 * is caught, plus .git/config (which git status never reports). Git runs with fsmonitor and hooks off.
 */
export function snapshotWorkspace(cwd = ROOT): Record<string, string> {
  const r = spawnSync("git", [...GIT_SAFE, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  const tokens = r.stdout.split("\0").filter(Boolean);
  const snap: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const code = t.slice(0, 2);
    const path = t.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // -z puts the rename source in the next token
    const abs = join(cwd, path);
    let hash = "deleted";
    try {
      hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch {
      // deleted, or a directory (submodule)
    }
    snap[path] = `${code}:${hash}`;
  }
  snap[".git/config"] = `protected:${fileHash(join(cwd, ".git", "config"))}`;
  return snap;
}

function fileHash(abs: string): string {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    return st.isFile() ? createHash("sha256").update(readFileSync(abs)).digest("hex") : "dir";
  } catch {
    return "gone";
  }
}

/** Every file and symlink under `dir` (relative, forward slashes) with its content hash, or link:<target> for a symlink. */
export function snapshotDir(dir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  if (!existsSync(dir)) return snap;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isDirectory()) continue;
    const abs = join(e.parentPath, e.name);
    snap[relative(dir, abs).split(sep).join("/")] = fileHash(abs);
  }
  return snap;
}

/** Symlinks in a snapshotDir result (a stage output must be a plain file). */
export function symlinksIn(snap: Record<string, string>): string[] {
  return Object.keys(snap).filter((k) => snap[k]!.startsWith("link:")).sort();
}

/**
 * The --allowedTools value for a stage: its tool list with bare Write and Edit replaced by one Edit(//abs) rule per
 * allowed path (folders end in "/" and become /**). Claude Code applies Edit path rules to Write too, and ignores
 * Write(path) rules, so this is the only form that scopes both. Same logic as the composite action.
 */
export function scopedAllowedTools(tools: string, allowAbs: string[]): string {
  const list = tools.split(",").map((t) => t.trim()).filter(Boolean);
  const keep = list.filter((t) => t !== "Write" && t !== "Edit");
  if (keep.length === list.length) return keep.join(",");
  const rules = allowAbs.map((a) => {
    if (!a.startsWith("/") || a.includes("..") || /[,()\s]/.test(a)) throw new Error(`allowed path must be absolute with no .., commas, brackets or spaces: ${a}`);
    return a.endsWith("/") ? `Edit(/${a}**)` : `Edit(/${a})`;
  });
  return [...keep, ...rules].join(",");
}

/** True when `path` (repo-relative, forward slashes) is `allowed` itself, or inside it when `allowed` is a folder. */
export function pathAllowed(path: string, allowed: string[]): boolean {
  return allowed.some((a0) => {
    const a = a0.trim().replace(/^\.\//, "");
    if (!a) return false;
    if (a.endsWith("/")) return path.startsWith(a);
    return path === a || path.startsWith(`${a}/`);
  });
}

/** Paths whose status or content changed between two snapshots and are not in `allowed`. */
export function guardViolations(before: Record<string, string>, after: Record<string, string>, allowed: string[]): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k] && !pathAllowed(k, allowed)).sort();
}

/** Repo-relative form of a night-folder path for the guard; null when the path is outside the repo. */
export function repoRelative(path: string): string | null {
  const r = relative(ROOT, resolve(path));
  if (!r || r.startsWith("..") || resolve(r) === r) return null;
  return r.split(sep).join("/");
}

// ---------- usage ----------

interface ResultLike {
  type?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

/**
 * Token and cost numbers from a Claude Code result: the CLI's `--output-format json` object, or the
 * claude-code-action execution file (a JSON array of SDK messages whose last `result` message carries the usage).
 * Anything missing counts as 0.
 */
export function usageFromResult(raw: unknown): Pick<UsageEntry, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "cost_usd" | "duration_ms" | "num_turns"> {
  const msgs = Array.isArray(raw) ? (raw as ResultLike[]) : [raw as ResultLike];
  const r = [...msgs].reverse().find((m) => m && typeof m === "object" && (m.type === "result" || m.usage !== undefined)) ?? {};
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    input_tokens: Math.round(n(r.usage?.input_tokens)),
    output_tokens: Math.round(n(r.usage?.output_tokens)),
    cache_read_tokens: Math.round(n(r.usage?.cache_read_input_tokens)),
    cache_creation_tokens: Math.round(n(r.usage?.cache_creation_input_tokens)),
    cost_usd: n(r.total_cost_usd),
    duration_ms: Math.round(n(r.duration_ms)),
    num_turns: Math.round(n(r.num_turns)),
  };
}

/** True when `raw` holds a result message with real usage numbers (not a crash, a timeout or an empty file). */
export function hasUsageTelemetry(raw: unknown): boolean {
  const msgs = Array.isArray(raw) ? (raw as ResultLike[]) : [raw as ResultLike];
  const r = [...msgs].reverse().find((m) => m && typeof m === "object" && m.type === "result");
  return !!r && typeof r.usage === "object" && r.usage !== null && typeof r.total_cost_usd === "number" && Number.isFinite(r.total_cost_usd);
}

export function logUsage(o: {
  raw: unknown;
  usageFile: string;
  stage: UsageStage;
  attempt: number;
  model: string;
  effort: string | null;
  date: string;
  runId: string;
}): UsageEntry {
  const entry: UsageEntry = {
    timestamp: new Date().toISOString(),
    date: o.date,
    run_id: o.runId.slice(0, 64),
    stage: o.stage,
    attempt: o.attempt,
    model: o.model,
    effort: o.effort || null,
    ...usageFromResult(o.raw),
  };
  appendUsage(o.usageFile, entry, ROOT);
  return entry;
}

// ---------- local runner ----------

const log = (...a: unknown[]): void => console.error(`[dry-run ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Runs harness/cli.ts in a child process, the same command the workflow runs. Returns its exit code and stdout. */
function cli(args: string[]): { code: number; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "harness", "cli.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 2, stdout: r.stdout };
}

function cliTo(file: string, args: string[]): number {
  const r = cli(args);
  writeFileSync(file, r.stdout);
  if (r.code === 2) log(`cli ${args[0]} error:`, r.stdout.slice(0, 400));
  return r.code;
}

interface AgentCall {
  stage: UsageStage;
  model: string;
  effort: string | null;
  maxTurns: number;
  tools: string;
  promptFile: string;
  /** Night-folder paths (files, or folders ending in "/") this call may change. */
  allow: string[];
  attempt: number;
  timeoutMs: number;
}

/**
 * One LLM stage on the local `claude` CLI with the same flags the composite action passes, then the same workspace
 * guard and usage row. A guard violation throws; a failed or timed-out call does not (the stage's check decides).
 */
async function runAgent(c: NightCtx, a: AgentCall, runId: string): Promise<void> {
  const p = nightPaths(c.night);
  const plan = planOf(c);
  if (a.model !== "haiku" && a.model !== "opus") throw new Error(`model must be haiku or opus, got ${a.model}`);
  const before = snapshotWorkspace();
  const nightBefore = snapshotDir(p.dir);
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
  const args = [
    "-p",
    readFileSync(a.promptFile, "utf8"),
    "--model",
    a.model,
    ...(a.effort ? ["--effort", a.effort] : []),
    "--max-turns",
    String(a.maxTurns),
    "--tools",
    a.tools.replace(/\([^)]*\)/g, ""),
    "--allowedTools",
    scopedAllowedTools(a.tools, a.allow),
    "--permission-mode",
    "dontAsk",
    "--add-dir",
    p.dir,
    "--output-format",
    "json",
  ];
  log(`${a.stage} (call ${a.attempt}) on ${a.model}${a.effort ? ` --effort ${a.effort}` : ""}`);
  const stdout = await new Promise<string>((done) => {
    const child = spawn("claude", args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => child.kill("SIGTERM"), a.timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      done(out);
    });
  });
  let raw: unknown = {};
  try {
    raw = JSON.parse(stdout);
  } catch {
    log(`${a.stage}: no JSON result (timed out or crashed)`);
  }
  const allowed = a.allow.map((x) => {
    const r = repoRelative(x);
    return r === null ? "" : x.endsWith("/") ? `${r}/` : r;
  });
  const nightAfter = snapshotDir(p.dir);
  const nightAllowed = a.allow.map((x) => relative(p.dir, x).split(sep).join("/") + (x.endsWith("/") ? "/" : ""));
  const bad = [
    ...guardViolations(before, snapshotWorkspace(), allowed),
    ...guardViolations(nightBefore, nightAfter, nightAllowed).map((x) => `${p.dir}/${x}`),
    ...symlinksIn(nightAfter).map((x) => `${p.dir}/${x} (symlink)`),
  ];
  if (bad.length) throw new Error(`${a.stage}: workspace guard: changed outside the allowed paths: ${bad.join(", ")}`);
  const telemetry = hasUsageTelemetry(raw);
  appendFileSync(p.calls, `${JSON.stringify({ stage: a.stage, attempt: a.attempt, model: a.model, effort: a.effort, telemetry })}\n`);
  if (!telemetry) return void log(`${a.stage}: no usage telemetry (timeout or crash); no usage row`);
  const e = logUsage({
    raw,
    usageFile: join(p.usageDir, `${a.stage}.jsonl`),
    stage: a.stage,
    attempt: a.attempt,
    model: a.model,
    effort: a.effort,
    date: plan.date,
    runId,
  });
  log(`${a.stage}: ${e.num_turns} turns, $${e.cost_usd.toFixed(4)}, ${Math.round(e.duration_ms / 1000)} s`);
}

export interface DryRunOptions {
  out: string;
  date?: string;
  seed?: string;
  forceDomain?: string;
  forceCompo?: string;
  forceMoodPreset?: string;
  ledger?: string;
  maxAttempts?: number;
}

const MIN = 60_000;

/** The whole nightly pipeline, Stages 0 to 9, locally, as a dry run. Returns summary.json. */
export async function runDryRun(o: DryRunOptions): Promise<Record<string, unknown>> {
  mkdirSync(o.out, { recursive: true });
  const c: NightCtx = { night: realpathSync(o.out), ledger: resolve(o.ledger ?? defaultLedger()) };
  const p = nightPaths(c.night);
  const max = o.maxAttempts ?? 3;
  if (!(Number.isInteger(max) && max >= 1 && max <= 3)) throw new Error("--max-attempts must be 1, 2 or 3");
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const runId = `local-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  if (existsSync(p.plan)) throw new Error(`${p.dir} already holds a night; pick a fresh --out`);
  stepInit(c);

  // Stage 0
  const planArgs = ["plan", "--date", date, "--dry-run", "--ledger", c.ledger, "--out", p.plan];
  if (o.seed) planArgs.push("--seed", o.seed);
  if (o.forceDomain) planArgs.push("--domain", o.forceDomain);
  if (o.forceCompo) planArgs.push("--compo", o.forceCompo);
  if (o.forceMoodPreset) planArgs.push("--mood-preset", o.forceMoodPreset);
  if (cliTo(join(p.dir, "plan-output.json"), planArgs) !== 0) throw new Error("plan failed (see plan-output.json)");
  const plan = planOf(c);
  log(`plan: ${plan.date} ${plan.compo} ${plan.domain}${plan.wildcard ? " (wildcard)" : ""}`);

  const S = STAGES;
  const night = async (): Promise<void> => {
    // Stage 1: research, one rejection retry.
    let dossierOk = false;
    for (let k = 1; k <= 2 && !dossierOk; k++) {
      const { prompt_file } = stepRenderResearch(c, k);
      await runAgent(c, { stage: "research", ...S.research, promptFile: prompt_file!, allow: [p.dossier], attempt: k, timeoutMs: 20 * MIN }, runId);
      dossierOk = cliTo(p.researchCheck(k), ["validate", "dossier", p.dossier, "--plan", p.plan]) === 0;
      log(`research try ${k}:`, dossierOk ? "valid" : checkLines(p.researchCheck(k)).join("; ").slice(0, 300));
    }
    if (!dossierOk) return void stepHalt(c, "research", "the dossier failed validation twice");

    // Stage 2: preset, or Haiku appraisal into the engine (on the night's copy of the state).
    if (o.forceMoodPreset) {
      cliTo(p.mood, ["feel", "--date", date, "--preset", o.forceMoodPreset]);
    } else {
      const { prompt_file } = stepRenderAppraise(c);
      await runAgent(c, { stage: "appraise", ...S.appraise, promptFile: prompt_file!, allow: [p.appraisals], attempt: 1, timeoutMs: 5 * MIN }, runId);
      if (stepCheckAppraisals(c).fallback === "true") log("appraisal invalid, used the neutral fallback event");
      const code = cliTo(join(p.dir, "feel-output.json"), ["feel", "--date", date, "--appraisals", p.appraisals, "--dry-run", "--state-dir", p.stateDir, "--ledger", c.ledger, "--out", p.mood]);
      if (code !== 0) throw new Error("feel failed (see feel-output.json)");
    }

    // Stages 3 and 4: brief plus Novelty Gate A, up to 2 retries naming the collision.
    let briefOk = false;
    for (let k = 1; k <= 3 && !briefOk; k++) {
      const { prompt_file } = stepRenderBrief(c, k);
      await runAgent(c, { stage: "brief", ...S.brief, promptFile: prompt_file!, allow: [p.brief], attempt: k, timeoutMs: 10 * MIN }, runId);
      briefOk = cliTo(p.novelty(k), ["novelty", "--brief", p.brief, "--plan", p.plan, "--dossier", p.dossier, "--ledger", c.ledger]) === 0;
      log(`brief try ${k}:`, briefOk ? "passed Novelty Gate A" : checkLines(p.novelty(k)).join("; ").slice(0, 300));
    }
    if (!briefOk) return void stepHalt(c, "brief", "three briefs failed Novelty Gate A");

    // Stages 5 to 8, up to max attempts.
    for (let n = 1; n <= max; n++) {
      const b = stepRenderBuild(c, n);
      await runAgent(
        c,
        { stage: "build", ...S.build, model: b.model!, effort: b.effort || null, promptFile: b.prompt_file!, allow: [p.piece, `${p.selfgate}/`], attempt: n, timeoutMs: 40 * MIN },
        runId,
      );
      const g = await stepGate(c, n);
      log(`attempt ${n} gates:`, g.built === "false" ? "no piece" : g.passed === "true" ? "PASS" : JSON.stringify(readJson<GatesResult>(join(p.attempt(n), "gates.json")).failures).slice(0, 300));
      if (g.passed === "true") {
        const j = await stepRenderJury(c, n);
        const sample = (k: number): AgentCall => ({
          stage: "jury",
          ...S.jury,
          promptFile: j[`prompt_${k}`]!,
          allow: [join(p.attempt(n), `verdict-sample-${k}.json`)],
          attempt: (n - 1) * JURY_RETRY_SAMPLE + k,
          timeoutMs: 10 * MIN,
        });
        for (const k of [1, 2, 3]) await runAgent(c, sample(k), runId); // one at a time, as in CI, so each guard sees only its own file
        let chk = stepJuryCheck(c, n);
        if (chk.retry === "true") {
          await runAgent(c, sample(JURY_RETRY_SAMPLE), runId);
          chk = stepJuryCheck(c, n);
        }
        log(`attempt ${n} jury: ${chk.valid} valid samples`);
        if (chk.files) {
          const agg = ["aggregate-jury", ...chk.files.split(" "), "--out", join(p.attempt(n), "verdict.json"), "--expected-anchors", chk.expected_anchors!, chk.archive_flag!];
          cliTo(join(p.attempt(n), "aggregate-output.json"), agg);
        }
      }
      const flags = stepAttempts(c);
      const decideArgs = ["decide", "--attempts", p.attempts, "--current", String(n), "--max", String(max), flags.archive_flag!, "--expected-anchors", flags.expected_anchors!];
      if (cliTo(p.decision(n), decideArgs) !== 0) throw new Error(`decide failed (see ${p.decision(n)})`);
      const d = readJson<DecisionFile>(p.decision(n));
      log(`attempt ${n} decision: ${d.action}: ${d.reason}`);
      if (d.action !== "retry") break;
    }
  };
  await night();

  // Stage 9, dry: everything lands under the night folder.
  stepPublishInput(c, true);
  if (cliTo(join(p.dir, "publish-output.json"), ["publish", "--input", p.publishInput, "--dry-run", "--out", p.publishOut]) !== 0) {
    throw new Error("publish failed (see publish-output.json)");
  }
  const fb = readJson<Record<string, string>>(p.feedback);
  const fbArgs = ["emotion-feedback", "--date", fb.date!, "--status", fb.status!, "--score", fb.score!, "--compo", fb.compo!, "--domain", fb.domain!, "--dry-run", "--state-dir", p.stateDir, "--ledger", c.ledger];
  if (fb.technique_family) fbArgs.push("--technique-family", fb.technique_family);
  cliTo(join(p.dir, "emotion-feedback.json"), fbArgs);
  stepFinalize(c);
  return readJson<Record<string, unknown>>(p.summary);
}

// ---------- CLI ----------

function emit(outputs: Record<string, string>): void {
  process.stdout.write(`${JSON.stringify(outputs)}\n`);
  const gh = process.env.GITHUB_OUTPUT;
  if (gh) appendFileSync(gh, Object.entries(outputs).map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, " ")}\n`).join(""));
}

export async function main(argv: string[]): Promise<number> {
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      night: { type: "string" },
      ledger: { type: "string" },
      try: { type: "string" },
      attempt: { type: "string" },
      "dry-run": { type: "boolean" },
      stage: { type: "string" },
      reason: { type: "string" },
      "execution-file": { type: "string" },
      "usage-file": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      date: { type: "string" },
      "run-id": { type: "string" },
      out: { type: "string" },
      seed: { type: "string" },
      "force-domain": { type: "string" },
      "force-compo": { type: "string" },
      "force-mood-preset": { type: "string" },
      "max-attempts": { type: "string" },
    },
  });
  const [cmd, sub] = pos;
  const num = (v: string | undefined, flag: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${flag} must be a positive integer`);
    return n;
  };

  if (cmd === "log-usage") {
    const stage = o.stage as UsageStage;
    let raw: unknown = {};
    const f = o["execution-file"];
    if (f && existsSync(f)) {
      try {
        raw = readJson(f);
      } catch {
        console.error(`log-usage: ${f} is not JSON`);
      }
    } else console.error("log-usage: no execution file");
    // A fake all-zero row would drag the 7-night usage averages down; a call without telemetry logs nothing.
    if (!hasUsageTelemetry(raw)) {
      console.error("log-usage: no usage telemetry in the execution file; no row appended");
      return 0;
    }
    const e = logUsage({
      raw,
      usageFile: o["usage-file"] ?? join(ROOT, "audit", "usage.jsonl"),
      stage,
      attempt: num(o.attempt ?? "1", "attempt"),
      model: o.model ?? "",
      effort: o.effort ?? null,
      date: o.date ?? new Date().toISOString().slice(0, 10),
      runId: o["run-id"] ?? "unknown",
    });
    process.stdout.write(`${JSON.stringify(e)}\n`);
    return 0;
  }

  if (cmd === "step") {
    if (!o.night) throw new Error("step needs --night");
    const c: NightCtx = { night: o.night, ledger: resolve(o.ledger ?? defaultLedger()) };
    const k = (): number => num(o.try, "try");
    const n = (): number => num(o.attempt, "attempt");
    const steps: Record<string, () => Record<string, string> | Promise<Record<string, string>>> = {
      init: () => stepInit(c),
      "render-research": () => stepRenderResearch(c, k()),
      "render-appraise": () => stepRenderAppraise(c),
      "check-appraisals": () => stepCheckAppraisals(c),
      "render-brief": () => stepRenderBrief(c, k()),
      "render-build": () => stepRenderBuild(c, n()),
      gate: () => stepGate(c, n()),
      "render-jury": () => stepRenderJury(c, n()),
      "jury-check": () => stepJuryCheck(c, n()),
      attempts: () => stepAttempts(c),
      halt: () => stepHalt(c, o.stage ?? "unknown", o.reason ?? "no reason given"),
      "publish-input": () => stepPublishInput(c, o["dry-run"] ?? false),
      finalize: () => stepFinalize(c, o["dry-run"] ? undefined : ROOT),
    };
    const fn = sub ? steps[sub] : undefined;
    if (!fn) throw new Error(`unknown step '${sub ?? ""}' (${Object.keys(steps).join(", ")})`);
    emit(await fn());
    return 0;
  }

  if (cmd !== undefined) throw new Error(`unknown command '${cmd}' (step, log-usage, or no command for a local dry run)`);
  if (!o.out) throw new Error("a local dry run needs --out DIR (for example audit/dry-runs/run-01)");
  const summary = await runDryRun({
    out: o.out,
    ...(o.date ? { date: o.date } : {}),
    ...(o.seed ? { seed: o.seed } : {}),
    ...(o["force-domain"] ? { forceDomain: o["force-domain"] } : {}),
    ...(o["force-compo"] ? { forceCompo: o["force-compo"] } : {}),
    ...(o["force-mood-preset"] ? { forceMoodPreset: o["force-mood-preset"] } : {}),
    ...(o.ledger ? { ledger: o.ledger } : {}),
    ...(o["max-attempts"] ? { maxAttempts: Number(o["max-attempts"]) } : {}),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`dry-run: ${(e as Error).stack ?? String(e)}`);
      process.exit(2);
    },
  );
}
