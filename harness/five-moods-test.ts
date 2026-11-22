// Milestone 5 acceptance test (SPEC Stage 2): "5 moods, same dossier". One fixed dossier, one compo (simulation), the 5
// hand-set presets from harness/emotion.ts. Each mood runs Stage 3 (brief, Haiku), Stage 5 (build, Haiku x2 then Opus
// low) and Stage 6 (runHardGates at timingScale 1). A blind Haiku vision judge then matches anonymous strips to moods.
// Usage: tsx harness/five-moods-test.ts [all|prepare|brief|build|gate|jury|report] [--force] [--samples 3]
// Phases are resumable: a preset whose brief or gates already pass is skipped unless --force. Scratch files (prompts,
// attempt archives, builder gate dirs, blind strips, judge output) live in $FIVE_MOODS_WORK (default <tmpdir>/demoparty-five-moods).
// Never touches state/: buildPresetMood is pure and plans are dry_run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runClaude, type ClaudeRun } from "./calibrate-jury.js";
import { findRepoRoot, loadAllConfig, loadCurriculum } from "./config.js";
import { buildHorizontalStrip } from "./contact-sheet.js";
import { MOOD_PRESETS, buildPresetMood } from "./emotion.js";
import { computeColorHistogram64, decodePng } from "./image-metrics.js";
import { checkNoveltyA, hammingDistanceHex, histogramDistanceL1 } from "./novelty.js";
import { buildPlan, fnv1a, mulberry32 } from "./plan.js";
import { renderPrompt } from "./prompt-render.js";
import { assertSchema, validateBriefStrict, validateDossierStrict } from "./schema.js";
import type { Brief, Dossier, GatesResult, Mood, Plan } from "./types.js";

const ROOT = findRepoRoot();
const AUD = join(ROOT, "audit", "five-moods");
const WORK = process.env.FIVE_MOODS_WORK ?? join(tmpdir(), "demoparty-five-moods");
const DATE = "2026-11-23";
const PLAN_SEED = "five-moods";
const MOOD_TS = "2026-11-22T00:00:00.000Z";
const SHUFFLE_SEED = "five-moods-blind-v1";
const COMPO = "simulation" as const;
const BUDGET = 24576;
const PRESETS = Object.keys(MOOD_PRESETS);
const LETTERS = ["A", "B", "C", "D", "E"] as const;
const SHOTS = ["shot-02s.png", "shot-08s.png", "shot-20s.png"] as const;
const EMDASH = /\s*\u2014\s*/g;
const BLOCKED_READS = ["--disallowedTools", "Read(./anchors/**)", "Read(./audit/**)"];
const LEAK_RE = /euphor|melanch|bored|boredom|restless|frustrat|curious|curiosity|experimental|cool-dissonant|warm-consonant|intimate|assertive/gi;

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const writeJson = (p: string, v: unknown): void => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const aud = (p: string, ...f: string[]): string => join(AUD, p, ...f);
const work = (...f: string[]): string => join(WORK, ...f);
const log = (...a: unknown[]): void => console.error(`[five-moods ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Replaces em-dashes (house rule) and returns the count. */
function stripEmdash(s: string): [string, number] {
  const n = (s.match(/\u2014/g) ?? []).length;
  return [s.replace(EMDASH, ", ").replace(/,\s*,/g, ","), n];
}

function runStats(r: ClaudeRun) {
  return { exit: r.exitCode, subtype: r.subtype, api_turns: r.apiTurns, cost_usd: r.costUsd, duration_s: Math.round(r.durationMs / 1000) };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

function dossierText(): { text: string; dossier: Dossier } {
  const text = readFileSync(join(AUD, "dossier.json"), "utf8");
  const v = validateDossierStrict(text, undefined, { maxBytes: loadAllConfig(ROOT).thresholds.gates.dossier_max_bytes, repoRoot: ROOT });
  if (!v.ok) throw new Error(`dossier invalid: ${v.errors.join("; ")}`);
  return { text, dossier: v.data };
}

// ---------- phase 1: mood + plan ----------

function prepare(): void {
  const { dossier } = dossierText();
  const config = loadAllConfig(ROOT);
  for (const p of PRESETS) {
    mkdirSync(aud(p), { recursive: true });
    const mood = buildPresetMood(p, MOOD_TS, ROOT);
    const plan = buildPlan({
      date: DATE, config, ledger: [], mood, seed: PLAN_SEED, dryRun: true,
      overrides: { domain: dossier.domain, compo: COMPO, mood_preset: p },
    });
    if (plan.compo !== COMPO || plan.size_budget_bytes !== BUDGET || !plan.dry_run) throw new Error(`unexpected plan for ${p}`);
    writeJson(aud(p, "mood.json"), mood);
    writeJson(aud(p, "plan.json"), plan);
  }
  log("prepared mood.json and plan.json for", PRESETS.length, "presets");
}

// ---------- phase 2: Stage 3 brief ----------

function curriculumSummary(): string {
  return loadCurriculum(ROOT).map((t) => `- ${t.name} (${t.family}): ${t.how_to}`).join("\n");
}

function checkBrief(brief: Brief, dossier: Dossier, plan: Plan): string[] {
  const config = loadAllConfig(ROOT);
  const v = validateBriefStrict(brief, dossier, [], { plan, maxWords: config.thresholds.gates.liner_note_max_words, repoRoot: ROOT });
  if (!v.ok) return v.errors;
  const n = checkNoveltyA({ brief, plan, ledger: [], thresholds: config.thresholds.novelty_a });
  return n.passed ? [] : n.collisions.map((c) => JSON.stringify(c));
}

async function briefOne(p: string, force: boolean): Promise<void> {
  const { text, dossier } = dossierText();
  const plan = readJson<Plan>(aud(p, "plan.json"));
  const mood = readJson<Mood>(aud(p, "mood.json"));
  if (!force && existsSync(aud(p, "brief.json")) && checkBrief(readJson(aud(p, "brief.json")), dossier, plan).length === 0) return log(p, "brief ok, skip");
  const template = readFileSync(join(ROOT, "prompts", "brief.md"), "utf8");
  const dir = work(p);
  mkdirSync(dir, { recursive: true });
  const tries: unknown[] = [];
  let collision = "NONE";
  for (let k = 1; k <= 3; k++) {
    const out = join(dir, `brief-t${k}.json`);
    rmSync(out, { force: true });
    const prompt = renderPrompt(template, {
      PLAN_JSON: JSON.stringify(plan, null, 1), DOSSIER_JSON: text.trim(), MOOD_JSON: JSON.stringify(mood, null, 1),
      CURRICULUM_SUMMARY: curriculumSummary(), LEDGER_TECHNIQUES: "NONE (empty ledger)", PREVIOUS_COLLISION: collision, OUTPUT_PATH: out,
    }, { escapeHtmlLtKeys: ["DOSSIER_JSON", "MOOD_JSON"] });
    const run = await runClaude(["--model", "haiku", "--max-turns", "6", "--tools", "Read,Write", "--allowedTools", "Read,Write",
      "--permission-mode", "acceptEdits", "--add-dir", dir, ...BLOCKED_READS, "-p", prompt], ROOT);
    let errors: string[];
    let emdashes = 0;
    if (!existsSync(out)) errors = [`no brief written (${run.subtype})`];
    else {
      let raw: string;
      [raw, emdashes] = stripEmdash(readFileSync(out, "utf8"));
      try {
        const brief = JSON.parse(raw) as Brief;
        errors = checkBrief(brief, dossier, plan);
        if (!errors.length) writeJson(aud(p, "brief.json"), brief);
      } catch (e) {
        errors = [`not JSON: ${(e as Error).message}`];
      }
    }
    tries.push({ try: k, ...runStats(run), emdashes_replaced: emdashes, errors });
    log(p, `brief try ${k}:`, errors.length ? errors.join("; ") : "valid");
    if (!errors.length) break;
    collision = errors.map((e) => `- ${e}`).join("\n");
  }
  writeJson(join(dir, "brief-log.json"), tries);
  if (!existsSync(aud(p, "brief.json"))) throw new Error(`${p}: no valid brief in 3 tries`);
}

// ---------- phase 3: Stage 5 build + Stage 6 gate (decision gate, like nightly) ----------

let gateChain: Promise<unknown> = Promise.resolve();
/** One Chromium gate at a time, so frame-time and motion are not measured under another gate's load. */
function gateSerial(piecePath: string, outDir: string): Promise<GatesResult> {
  const job = gateChain.then(async () => {
    const { runHardGates } = await import("./gates.js");
    return runHardGates({ piecePath, compo: COMPO, outDir, repoRoot: ROOT, ledgerPath: join(ROOT, "ledger", "ledger.jsonl"), date: DATE, timingScale: 1 });
  });
  gateChain = job.catch(() => undefined);
  return job;
}

function feedback(g: GatesResult): string {
  return JSON.stringify({ failures: g.failures, slop_lint_violations: g.slop_lint.violations }, null, 1);
}

const ATTEMPTS = [
  { model: "haiku", effort: null },
  { model: "haiku", effort: null },
  { model: "opus", effort: "low" },
] as const;

async function buildOne(p: string, force: boolean): Promise<void> {
  if (!force && existsSync(aud(p, "index.html")) && existsSync(work(p, "build-log.json"))) {
    const last = readJson<Array<{ gate_passed: boolean }>>(work(p, "build-log.json")).at(-1);
    if (last?.gate_passed) return log(p, "build passed earlier, skip");
  }
  const { text } = dossierText();
  const template = readFileSync(join(ROOT, "prompts", "build.md"), "utf8");
  const dir = work(p);
  const piece = join(dir, "piece", "index.html");
  const selfGate = join(dir, "selfgate");
  rmSync(join(dir, "piece"), { recursive: true, force: true });
  mkdirSync(join(dir, "piece"), { recursive: true });
  const gateCommand = `npm run gate -- ${piece} --compo ${COMPO} --out ${selfGate} --budget ${BUDGET} --date ${DATE}`;
  const attempts: unknown[] = [];
  let prev = "NONE";
  for (let n = 1; n <= 3; n++) {
    const a = ATTEMPTS[n - 1]!;
    const prompt = renderPrompt(template, {
      PLAN_JSON: JSON.stringify(readJson(aud(p, "plan.json")), null, 1),
      BRIEF_JSON: JSON.stringify(readJson(aud(p, "brief.json")), null, 1),
      DOSSIER_JSON: text.trim(),
      MOOD_JSON: JSON.stringify(readJson(aud(p, "mood.json")), null, 1),
      ATTEMPT_NUMBER: String(n), PREVIOUS_FEEDBACK: prev, PIECE_PATH: piece, GATE_OUT_DIR: selfGate, GATE_COMMAND: gateCommand,
    }, { escapeHtmlLtKeys: ["DOSSIER_JSON", "BRIEF_JSON", "MOOD_JSON"] });
    log(p, `build attempt ${n} on ${a.model}${a.effort ? ` --effort ${a.effort}` : ""}`);
    const run = await runClaude(["--model", a.model, ...(a.effort ? ["--effort", a.effort] : []), "--max-turns", "30",
      "--tools", "Read,Write,Edit,Bash", "--allowedTools", "Read,Write,Edit,Bash(npm run gate:*)",
      "--permission-mode", "acceptEdits", "--add-dir", dir, ...BLOCKED_READS, "-p", prompt], ROOT, 2_400_000);
    const bash = run.toolUses.filter((t) => t.name === "Bash").map((t) => t.arg);
    const rec: Record<string, unknown> = {
      attempt: n, model: a.model, effort: a.effort, ...runStats(run),
      bash_calls: bash.length, bash_only_gate_command: bash.every((c) => c === gateCommand),
    };
    if (!existsSync(piece)) {
      Object.assign(rec, { gate_passed: false, failures: [{ gate: "build", message: "no piece written" }] });
      prev = "The previous attempt wrote no index.html. Write the whole piece first, then run the gate.";
    } else {
      const [html, emdashes] = stripEmdash(readFileSync(piece, "utf8"));
      writeFileSync(piece, html);
      copyFileSync(piece, join(dir, `attempt-${n}.html`));
      const g = await gateSerial(piece, join(dir, `gate-a${n}`));
      Object.assign(rec, { emdashes_replaced: emdashes, bytes: g.byte_size, gate_passed: g.passed, failures: g.failures, frame_diff_mean: g.motion.frame_diff_mean });
      if (g.passed) copyFileSync(piece, aud(p, "index.html"));
      prev = feedback(g);
    }
    attempts.push(rec);
    writeJson(join(dir, "build-log.json"), attempts);
    log(p, `attempt ${n}:`, rec.gate_passed ? "PASS" : JSON.stringify(rec.failures).slice(0, 400));
    if (rec.gate_passed) return;
  }
  log(p, "FAILED all 3 build attempts");
}

// ---------- phase 4: authoritative gates, sequential, alone ----------

async function gateAll(): Promise<void> {
  for (const p of PRESETS) {
    if (!existsSync(aud(p, "index.html"))) {
      log(p, "no index.html, skip gate");
      continue;
    }
    const g = await gateSerial(aud(p, "index.html"), aud(p));
    const extra = readdirSync(aud(p)).filter((f) => !["plan.json", "mood.json", "brief.json", "index.html", "gates.json", ...SHOTS].includes(f));
    if (extra.length) throw new Error(`${p}: gate wrote unexpected files ${extra.join(", ")}`);
    log(p, "final gate:", g.passed ? "PASS" : JSON.stringify(g.failures));
  }
}

// ---------- phase 5: blind jury ----------

/** Deterministic Fisher-Yates of the presets onto letters A..E. */
export function blindOrder(seed = SHUFFLE_SEED): string[] {
  const rng = mulberry32(fnv1a(seed));
  const a = [...PRESETS];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function moodDescriptions(): string {
  return [...PRESETS].sort().map((p) => {
    const c = buildPresetMood(p, MOOD_TS, ROOT).creative_parameters;
    return [
      `${p}:`,
      `  tempo / density / cut rate: ${c.tempo_density_cut_rate.level}. ${c.tempo_density_cut_rate.guidance}`,
      `  palette / consonance / symmetry: ${c.palette_warmth_consonance_symmetry.level}. ${c.palette_warmth_consonance_symmetry.guidance}`,
      `  scale / contrast / camera: ${c.scale_contrast_camera.level}. ${c.scale_contrast_camera.guidance}`,
      `  technical risk: ${c.technical_risk_budget.level}. ${c.technical_risk_budget.guidance}`,
      `  boredom forces an unused technique family: ${c.boredom_force_unused_30d}`,
      `  frustration shrink scope: ${c.frustration_scope_polish_weight.shrink_scope}. ${c.frustration_scope_polish_weight.guidance}`,
    ].join("\n");
  }).join("\n\n");
}

export function judgePrompt(dir: string, motion: string | null, out: string): string {
  const strips = LETTERS.map((l) => join(dir, `piece-${l}.png`)).join("\n");
  return `You are a blind visual judge. Five generative browser pieces, labelled A to E, were built from the SAME research dossier (a von Karman vortex street simulation) in the SAME compo, each under a DIFFERENT hand-set crew mood. The moods changed the creative parameters below. Your job: tell the pieces apart and match each piece to the mood that produced it. Judge only what you see${motion ? " and the measured motion numbers" : ""}. No titles, briefs or labels are given.

Each image is one contact strip: three frames of the piece at t = 2 s, 8 s and 20 s, left to right (1280 x 720 each, downscaled).

Strips (Read all five in ONE turn, in parallel):
${strips}
${motion ? `\nMeasured motion (deterministic harness, headless Chromium). frame_diff_mean is the mean absolute pixel difference between frames about 0.25 s apart (higher means faster or denser motion). development_t2_t20 is the mean absolute pixel difference between the 2 s and 20 s frames (higher means the scene changes more over the piece):\n${motion}\n` : "\nNo motion measurements are given: judge from the pixels only.\n"}
The five moods and their creative parameters (each used for exactly one piece):

${moodDescriptions()}

How the levels look in practice: low tempo means slow drift with sparse elements (tens) and at most 2 scene changes; high tempo means dense fields or thousands of elements and frequent changes. cool-dissonant means cool grounds (slate, blue-grey, green-grey) with one sharp accent and asymmetric composition; balanced means mixed warm and cool with partial symmetry; warm-consonant means warm grounds (ochre, cream, rust, amber) with mirrored or radial symmetry. intimate means a small subject with margins and low contrast; measured means medium framing and moderate contrast; assertive means the subject fills the frame with high contrast. shrink scope means one clean rendering idea and few techniques.

Turns (4 maximum): Turn 1: Read the five PNGs in parallel. Turn 2: Write the answer file. Every message must contain a tool call until the file is written.

Write ONLY raw JSON to ${out} with exactly this shape:
{
  "pieces": {
    "A": { "visual_description": "<palette, ground, density, scale, composition, how it changes from 2 s to 20 s>", "differs_from_others": "<how A differs from each of B, C, D, E>" },
    "B": {...}, "C": {...}, "D": {...}, "E": {...}
  },
  "matching": { "A": "<mood name>", "B": "<mood name>", "C": "<mood name>", "D": "<mood name>", "E": "<mood name>" },
  "evidence": { "A": "<concrete visual evidence for the match>", "B": "...", "C": "...", "D": "...", "E": "..." }
}
The matching must be one-to-one: each of the five mood names (${[...PRESETS].sort().join(", ")}) used exactly once, spelled exactly.`;
}

function validMatching(m: unknown): m is Record<string, string> {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  const vals = LETTERS.map((l) => r[l]);
  return Object.keys(r).length === 5 && vals.every((v) => typeof v === "string" && PRESETS.includes(v)) && new Set(vals).size === 5;
}

function cleanText(v: unknown): unknown {
  if (typeof v === "string") return stripEmdash(v)[0];
  if (Array.isArray(v)) return v.map(cleanText);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanText(x)]));
  return v;
}

async function jury(samples: number, force: boolean): Promise<void> {
  const order = blindOrder();
  const stripDir = work("strips");
  mkdirSync(stripDir, { recursive: true });
  for (const [i, p] of order.entries()) await buildHorizontalStrip(SHOTS.map((s) => aud(p, s)), join(stripDir, `piece-${LETTERS[i]}.png`));
  const motion = order.map((p, i) => {
    const g = readJson<GatesResult>(aud(p, "gates.json"));
    return `piece-${LETTERS[i]}: frame_diff_mean ${g.motion.frame_diff_mean}, development_t2_t20 ${g.motion.development_diff_t2_t20}`;
  }).join("\n");
  const jobs = (["pixels+motion", "pixels-only"] as const).flatMap((cond) => Array.from({ length: samples }, (_, k) => ({ cond, k: k + 1 })));
  await pool(jobs, 3, async ({ cond, k }) => {
    const resultPath = work("judge", `${cond}-s${k}.json`);
    if (!force && existsSync(resultPath)) return log(`judge ${cond} s${k}: done, skip`);
    mkdirSync(work("judge"), { recursive: true });
    const tries: unknown[] = [];
    let final: Record<string, unknown> | null = null;
    for (let t = 1; t <= 2 && !final; t++) {
      // Fresh neutral dir per call: only the five strips, so no earlier answer or mapping is readable from cwd.
      const dir = join(tmpdir(), `blind-${fnv1a(`${cond}:${k}:${t}`).toString(16)}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const l of LETTERS) copyFileSync(join(stripDir, `piece-${l}.png`), join(dir, `piece-${l}.png`));
      const out = join(dir, "answer.json");
      const prompt = judgePrompt(dir, cond === "pixels+motion" ? motion : null, out);
      const run = await runClaude(["--model", "haiku", "--effort", "high", "--max-turns", "4", "--tools", "Read,Write",
        "--permission-mode", "bypassPermissions", "-p", prompt], dir);
      const reads = run.toolUses.filter((u) => u.name === "Read").map((u) => u.arg);
      let answer: Record<string, unknown> | null = null;
      let error: string | null = null;
      try {
        answer = readJson<Record<string, unknown>>(out);
        if (!validMatching(answer.matching)) error = `matching is not a 1-to-1 map onto the 5 presets: ${JSON.stringify(answer.matching)}`;
      } catch (e) {
        error = `no valid answer.json (${run.subtype}): ${(e as Error).message}`;
      }
      tries.push({ try: t, ...runStats(run), reads, reads_only_blind_dir: reads.every((r) => r.startsWith(dir)), prompt_sha256: sha(prompt), error });
      if (!error) final = cleanText(answer) as Record<string, unknown>;
      rmSync(dir, { recursive: true, force: true });
    }
    writeJson(resultPath, { condition: cond, sample: k, tries, answer: final });
    log(`judge ${cond} s${k}:`, final ? "valid" : "INVALID");
  });
}

// ---------- phase 6: report ----------

function claudeVersion(): string {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function binHex(bin: number): string {
  const c = (v: number): string => ((v << 6) + 32).toString(16).padStart(2, "0");
  return `#${c(bin >> 4)}${c((bin >> 2) & 3)}${c(bin & 3)}`;
}

function signature(p: string) {
  const shots = SHOTS.map((s) => decodePng(readFileSync(aud(p, s))));
  const meanRgb = shots.map((img) => {
    const acc = [0, 0, 0];
    for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) acc[c]! += img.data[i + c]!;
    const n = img.data.length / 4;
    const [r, g, b] = acc.map((v) => v / n) as [number, number, number];
    return { hex: `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`, luma: r4(0.2126 * r + 0.7152 * g + 0.0722 * b) };
  });
  const g = readJson<GatesResult>(aud(p, "gates.json"));
  const top = g.novelty_b.color_histogram.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 4);
  return {
    mean_colour: { t2: meanRgb[0], t8: meanRgb[1], t20: meanRgb[2] },
    dominant_bins: top.map(([v, i]) => ({ hex: binHex(i), share: r4(v) })),
    colour_bins_over_1pct: g.novelty_b.color_histogram.filter((v) => v > 0.01).length,
    luminance_variance: g.luminance_variance,
    frame_diff_mean: g.motion.frame_diff_mean,
    development_diff_t2_t20: g.motion.development_diff_t2_t20,
    per_shot_colour_bins: shots.map((img) => computeColorHistogram64(img).filter((v) => v > 0.01).length),
  };
}

function leakScan(p: string) {
  const html = readFileSync(aud(p, "index.html"), "utf8");
  const hits = [...html.matchAll(LEAK_RE)].map((m) => {
    const i = m.index ?? 0;
    return { word: m[0], context: html.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, " ") };
  });
  // ponytail: only canvas fillText literals; DOM text would need a rendered-text probe.
  const rendered = [...html.matchAll(/fillText\(\s*(['"`])(.*?)\1/g)].map((m) => m[2]!);
  return { hits: hits.length, samples: hits.slice(0, 8), preset_name_in_source: html.toLowerCase().includes(p), canvas_text_literals: rendered };
}

function codeLines(path: string): Set<string> {
  return new Set(readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 20));
}

function pairOverlap() {
  const lines = Object.fromEntries(PRESETS.map((p) => [p, codeLines(aud(p, "index.html"))]));
  const anchors = readdirSync(join(ROOT, "anchors")).filter((d) => existsSync(join(ROOT, "anchors", d, "index.html")))
    .map((d) => codeLines(join(ROOT, "anchors", d, "index.html")));
  const share = (a: Set<string>, b: Set<string>): number => r4([...a].filter((l) => b.has(l)).length / Math.max(1, Math.min(a.size, b.size)));
  const pairs: unknown[] = [];
  for (let i = 0; i < PRESETS.length; i++) for (let j = i + 1; j < PRESETS.length; j++) {
    pairs.push({ a: PRESETS[i], b: PRESETS[j], shared_line_share: share(lines[PRESETS[i]!]!, lines[PRESETS[j]!]!) });
  }
  const anchorMax = Object.fromEntries(PRESETS.map((p) => [p, Math.max(...anchors.map((s) => share(lines[p]!, s)))]));
  return { pairs, max_share_with_any_anchor: anchorMax };
}

function report(): void {
  const { dossier } = dossierText();
  const config = loadAllConfig(ROOT);
  const order = blindOrder();
  const pieces = PRESETS.map((p) => {
    const brief = readJson<Brief>(aud(p, "brief.json"));
    const mood = assertSchema<Mood>("mood", readJson(aud(p, "mood.json")), ROOT);
    const g = readJson<GatesResult>(aud(p, "gates.json"));
    const attempts = readJson<Array<Record<string, unknown>>>(work(p, "build-log.json"));
    return {
      preset: p,
      blind_letter: LETTERS[order.indexOf(p)],
      mood_levels: {
        pad: mood.pad,
        tempo: mood.creative_parameters.tempo_density_cut_rate.level,
        palette: mood.creative_parameters.palette_warmth_consonance_symmetry.level,
        scale: mood.creative_parameters.scale_contrast_camera.level,
        risk: mood.creative_parameters.technical_risk_budget.level,
        boredom_force_unused_30d: mood.creative_parameters.boredom_force_unused_30d,
        shrink_scope: mood.creative_parameters.frustration_scope_polish_weight.shrink_scope,
      },
      brief: {
        title: brief.title, concept: brief.concept, mechanism: brief.mechanism_embodied.mechanism_name, technique_family: brief.technique_family,
        techniques: brief.techniques, novel_technique: brief.novel_technique, palette: brief.palette, motion_sound_plan: brief.motion_sound_plan,
        brief_tries: readJson<unknown[]>(work(p, "brief-log.json")),
      },
      build: {
        attempts,
        final_model: attempts.at(-1)?.model, final_effort: attempts.at(-1)?.effort ?? null, attempts_used: attempts.length,
        cost_usd: r4(attempts.reduce((s, a) => s + (Number(a.cost_usd) || 0), 0)),
      },
      gates: {
        passed: g.passed, failures: g.failures, byte_size: g.byte_size, size_budget_bytes: g.size_budget_bytes, motion: g.motion,
        luminance_variance: g.luminance_variance, strobe: g.strobe, frame_time_ms: g.frame_time_ms, reduced_motion: g.reduced_motion,
        console_errors: g.console_errors.length, network_requests: g.network_requests.length, slop_lint: g.slop_lint,
      },
      visual_signature: signature(p),
      mood_label_leak_scan: leakScan(p),
    };
  });

  const pairs: unknown[] = [];
  for (let i = 0; i < PRESETS.length; i++) for (let j = i + 1; j < PRESETS.length; j++) {
    const a = readJson<GatesResult>(aud(PRESETS[i]!, "gates.json"));
    const b = readJson<GatesResult>(aud(PRESETS[j]!, "gates.json"));
    const ham = (["t2", "t8", "t20"] as const).map((k) => hammingDistanceHex(a.novelty_b.phashes[k], b.novelty_b.phashes[k]) ?? 0);
    pairs.push({
      a: PRESETS[i], b: PRESETS[j],
      histogram_l1: r4(histogramDistanceL1(a.novelty_b.color_histogram, b.novelty_b.color_histogram)),
      dhash_hamming: { t2: ham[0], t8: ham[1], t20: ham[2], mean: r4(ham.reduce((s, v) => s + v, 0) / 3), min: Math.min(...ham) },
    });
  }
  const nb = config.thresholds.novelty_b;
  const hist = pairs.map((x) => (x as { histogram_l1: number }).histogram_l1);
  const hmin = pairs.map((x) => (x as { dhash_hamming: { min: number } }).dhash_hamming.min);
  const hmean = pairs.map((x) => (x as { dhash_hamming: { mean: number } }).dhash_hamming.mean);

  const judgeDir = work("judge");
  const conditions = (["pixels+motion", "pixels-only"] as const).map((cond) => {
    const files = existsSync(judgeDir) ? readdirSync(judgeDir).filter((f) => f.startsWith(`${cond}-s`)).sort() : [];
    const samples = files.map((f) => {
      const j = readJson<{ sample: number; tries: Array<Record<string, unknown>>; answer: { matching?: Record<string, string>; pieces?: unknown; evidence?: unknown } | null }>(join(judgeDir, f));
      const m = j.answer?.matching ?? null;
      const per = LETTERS.map((l, i) => ({ letter: l, truth: order[i], judged: m?.[l] ?? null, correct: m?.[l] === order[i] }));
      return {
        sample: j.sample, valid: !!m, correct: m ? per.filter((x) => x.correct).length : null, per_piece: per,
        pieces: j.answer?.pieces ?? null, evidence: j.answer?.evidence ?? null,
        reads_only_blind_dir: j.tries.every((t) => t.reads_only_blind_dir === true),
        read_all_five_strips: LETTERS.every((l) => ((j.tries.at(-1)?.reads ?? []) as string[]).some((r) => r.endsWith(`piece-${l}.png`))),
        cost_usd: r4(j.tries.reduce((s, t) => s + (Number(t.cost_usd) || 0), 0)), tries: j.tries.length,
      };
    });
    const valid = samples.filter((s) => s.correct !== null).map((s) => s.correct!);
    return {
      condition: cond,
      samples,
      headline_mean_correct_of_5: valid.length ? r4(valid.reduce((a, b) => a + b, 0) / valid.length) : null,
      headline_accuracy: valid.length ? r4(valid.reduce((a, b) => a + b, 0) / (5 * valid.length)) : null,
      per_sample_correct: valid,
    };
  });

  writeJson(join(AUD, "report.json"), {
    test: "SPEC Stage 2 acceptance: 5 moods, same dossier, same compo",
    ran_at: new Date().toISOString(),
    claude_cli: claudeVersion(),
    reproduce: "npx tsx harness/five-moods-test.ts all",
    fixed_inputs: {
      dossier: "audit/five-moods/dossier.json (hand-authored for this test from verified pages, not Stage 1 output)",
      dossier_topic: dossier.topic, dossier_domain: dossier.domain,
      dossier_sha256: sha(readFileSync(join(AUD, "dossier.json"), "utf8")),
      compo: COMPO, size_budget_bytes: BUDGET, plan_date: DATE, plan_seed: PLAN_SEED, mood_timestamp: MOOD_TS,
      ledger: "empty (ledger/ledger.jsonl has 0 lines), so boredom_force_unused_30d and the bans constrain nothing here",
      prompt_sha256: { brief: sha(readFileSync(join(ROOT, "prompts", "brief.md"), "utf8")), build: sha(readFileSync(join(ROOT, "prompts", "build.md"), "utf8")) },
      stage_models: {
        brief: "claude --model haiku --max-turns 6 (up to 3 tries with validation errors fed back)",
        build: "claude --model haiku --max-turns 30, attempt 2 haiku with exact gate failures, attempt 3 claude --model opus --effort low",
        gate: "runHardGates timingScale 1; decision gate serialised, final gate rerun sequentially with no other load",
        judge: "claude --model haiku --effort high --max-turns 4 --tools Read,Write --permission-mode bypassPermissions, fresh dir with only the 5 strips",
      },
    },
    mapping_separability_note: "With the thirds cutpoints, tempo is high for 4 of 5 presets (only melancholic is low) and scale is measured for 3. Bored vs curious vs frustrated rest mainly on palette level, risk budget and shrink_scope.",
    pieces,
    all_gates_passed: pieces.every((p) => p.gates.passed && p.gates.failures.length === 0),
    pairwise_distinctness: {
      metric_note: "histogram_l1 is histogramDistanceL1 (total variation, 0..1) on the 3-shot 64-bin colour histogram from gates.json; dhash_hamming is hammingDistanceHex on the 64-bit dHash per matching shot.",
      novelty_b_thresholds: { histogram_min_distance: nb.histogram_min_distance, phash_min_hamming: nb.phash_min_hamming },
      pairs,
      summary: {
        histogram_l1_min: Math.min(...hist), histogram_l1_mean: r4(hist.reduce((a, b) => a + b, 0) / hist.length),
        dhash_min_over_pairs: Math.min(...hmin), dhash_mean_over_pairs: r4(hmean.reduce((a, b) => a + b, 0) / hmean.length),
        pairs_clearing_histogram_threshold: hist.filter((v) => v >= nb.histogram_min_distance).length,
        pairs_clearing_dhash_threshold_on_every_shot: hmin.filter((v) => v >= nb.phash_min_hamming).length,
        pairs_total: pairs.length,
      },
    },
    build_independence: {
      note: "Builder Read calls were not logged, so independence is checked on the output: share of non-trivial lines (over 20 chars) shared between pieces and with any anchor.",
      pairwise_line_overlap: pairOverlap(),
    },
    blind_jury: {
      shuffle_seed: SHUFFLE_SEED,
      true_mapping: Object.fromEntries(order.map((p, i) => [LETTERS[i], p])),
      judge_inputs: "piece-A..E contact strips (t = 2, 8, 20 s) and the 5 preset creative-parameter descriptions; pixels+motion also gets frame_diff_mean and development_diff_t2_t20. No titles, briefs or preset-to-piece hints.",
      chance_baseline: { expected_correct: 1, p_at_least_3_correct: r4(11 / 120), p_all_5_correct: r4(1 / 120) },
      headline_metric: "mean correct matches of 5 over all valid samples, per condition (fixed before running)",
      conditions,
    },
  });
  log("wrote report.json");
}

async function main(argv: string[]): Promise<void> {
  const phase = argv.find((a) => !a.startsWith("--")) ?? "all";
  const force = argv.includes("--force");
  const si = argv.indexOf("--samples");
  const samples = si >= 0 ? Number(argv[si + 1]) : 3;
  mkdirSync(WORK, { recursive: true });
  log("work dir", WORK);
  const run = (name: string): boolean => phase === "all" || phase === name;
  if (run("prepare")) prepare();
  if (run("brief")) await pool(PRESETS, 5, (p) => briefOne(p, force));
  if (run("build")) await pool(PRESETS, 3, (p) => buildOne(p, force));
  if (run("gate")) await gateAll();
  if (run("jury")) await jury(samples, force);
  if (run("report")) report();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
