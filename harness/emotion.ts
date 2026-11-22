// Stage 2 (Feel) and Stage 9 feedback: a thin wrapper around the agent-emotion-core CLI.
// The engine (.claude/skills/agent-emotion-core/scripts/affect_core.py) owns every state dynamic. This file only
// stamps and pipes appraisal events in, and maps the engine's `state` snapshot to mood.json deterministically.
// No LLM ever writes state/emotion.json: Haiku writes appraisals.json, this file feeds it to the engine.
//
// Every engine call runs on a scratch copy of the state folder (AFFECT_AGENT=<agent>, AFFECT_STATE_DIR=<scratch>), so
// the engine's lock file never lands in state/, a failed step never half-writes, and dryRun is simply "do not copy back".
// When persisting, the new <agent>.json is renamed into place and the engine's <agent>.log.jsonl lines are appended to
// the audit log.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findRepoRoot } from "./config.js";
import { assertSchema } from "./schema.js";
import type { AppraisalEvent, Appraisals, EmotionLabel, LedgerEntry, Mood, NightStatus, Pad } from "./types.js";

export const ENGINE_SCRIPT = join(".claude", "skills", "agent-emotion-core", "scripts", "affect_core.py");
export const DEFAULT_AGENT_ID = "emotion";
/** The crew persona: curious and open, loosely organised, mildly social, low agreeableness, emotionally stable. */
export const CREW_PERSONA = { traits: { O: 0.75, C: 0.35, E: 0.2, A: 0.25, N: 0.15 } };

const EMOTION_LABELS: readonly EmotionLabel[] = [
  "joy", "distress", "hope", "fear", "relief", "disappointment", "pride", "shame",
  "admiration", "reproach", "gratitude", "anger", "interest", "boredom", "surprise",
];
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface EngineOptions {
  /** Folder holding <agentId>.json. Default <repoRoot>/state. */
  stateDir?: string;
  /** Engine agent id, so the state file is <stateDir>/<agentId>.json. Default "emotion". */
  agentId?: string;
  repoRoot?: string;
  /** Where engine log lines are appended on persist. Default <dirname(stateDir)>/audit/<agentId>.log.jsonl. */
  logPath?: string;
}

/** The engine's `state` command output (summary()), the fields this wrapper reads. */
export interface EngineSummary {
  mood: [number, number, number];
  emotions: Record<string, number>;
  chem: { da: number; ne: number; sht: number; cort: number; oxt: number; opi: number };
  drives: { novelty: number; social: number; fatigue: number };
  sentiments: Record<string, { liking: number; wanting: number; episodes: number }>;
}

// ---------- engine plumbing ----------

interface Ctx {
  repoRoot: string;
  stateDir: string;
  agentId: string;
  stateFile: string;
  logPath: string;
}

function ctx(o: EngineOptions): Ctx {
  const repoRoot = o.repoRoot ? resolve(o.repoRoot) : findRepoRoot();
  const stateDir = resolve(o.stateDir ?? join(repoRoot, "state"));
  const agentId = o.agentId ?? DEFAULT_AGENT_ID;
  return {
    repoRoot,
    stateDir,
    agentId,
    stateFile: join(stateDir, `${agentId}.json`),
    logPath: resolve(o.logPath ?? join(dirname(stateDir), "audit", `${agentId}.log.jsonl`)),
  };
}

function runEngine(c: Ctx, dir: string, args: string[], input?: string): string {
  const r = spawnSync("python3", [join(c.repoRoot, ENGINE_SCRIPT), ...args], {
    env: { ...process.env, AFFECT_AGENT: c.agentId, AFFECT_STATE_DIR: dir, AFFECT_WITH: "" },
    input: input ?? "",
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`affect_core.py ${args[0]} failed (exit ${r.status}): ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * Run `fn` against a scratch copy of the state folder. With persist, copy the new state back atomically (tmp file and
 * rename inside stateDir, so it never crosses filesystems) and append the engine log to the audit log.
 */
function withScratch<T>(c: Ctx, persist: boolean, fn: (dir: string) => T, requireState = true): T {
  if (requireState && !existsSync(c.stateFile)) {
    // Without this the engine silently invents a random persona from the agent id.
    throw new Error(`${c.stateFile} does not exist; run initEmotionState first`);
  }
  const dir = mkdtempSync(join(tmpdir(), "affect-scratch-"));
  try {
    if (existsSync(c.stateFile)) copyFileSync(c.stateFile, join(dir, `${c.agentId}.json`));
    const result = fn(dir);
    if (persist) {
      mkdirSync(c.stateDir, { recursive: true });
      const tmp = `${c.stateFile}.tmp`;
      copyFileSync(join(dir, `${c.agentId}.json`), tmp);
      renameSync(tmp, c.stateFile);
      const log = join(dir, `${c.agentId}.log.jsonl`);
      if (existsSync(log)) {
        mkdirSync(dirname(c.logPath), { recursive: true });
        appendFileSync(c.logPath, readFileSync(log, "utf8"));
      }
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hoursArgs = (h: number | undefined): string[] => (h === undefined ? [] : ["--hours", String(h)]);

function readSummary(c: Ctx, dir: string): EngineSummary {
  // --hours 0: the operation's single clock advance already happened in the call before.
  return JSON.parse(runEngine(c, dir, ["state", "--hours", "0"])) as EngineSummary;
}

// ---------- public API ----------

/** Create <stateDir>/<agentId>.json with the crew persona. Refuses to overwrite existing state. */
export function initEmotionState(
  options: EngineOptions & { persona?: { traits: { O: number; C: number; E: number; A: number; N: number } } } = {},
): { stateFile: string; persona: unknown } {
  const c = ctx(options);
  if (existsSync(c.stateFile)) throw new Error(`${c.stateFile} already exists; delete it to start over`);
  const persona = withScratch(
    c,
    true,
    (dir) => JSON.parse(runEngine(c, dir, ["init", "--persona", JSON.stringify(options.persona ?? CREW_PERSONA)])) as unknown,
    false,
  );
  return { stateFile: c.stateFile, persona };
}

/** The `<affect>` block for Stage 2's {{EMOTION_CONTEXT}}. Read-only: wall-clock decay is previewed, never saved. */
export function getEmotionContext(options: EngineOptions & { brief?: boolean } = {}): string {
  const c = ctx(options);
  return withScratch(c, false, (dir) => runEngine(c, dir, ["context", ...(options.brief ? ["--brief"] : [])])).trim();
}

function slug(s: string): string {
  return s
    .replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}:/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "event";
}

/**
 * Deterministic engine input from Haiku's validated appraisals. event_id becomes `${date}:${n}:${slug}` (n is 1-based)
 * and thread becomes `night-${date}`, so a reused or missing id can never collide in the engine's 256-id dedupe ring.
 * `source` is dropped: the engine treats it as another agent's id, so "dossier" would become a person the crew likes
 * or dislikes and would drain the social drive.
 */
export function stampEvents(events: AppraisalEvent[], date: string): AppraisalEvent[] {
  if (!DATE_RE.test(date)) throw new Error(`date must be YYYY-MM-DD, got '${date}'`);
  return events
    .filter((e) => !isCrewOutcomeEvent(e))
    .map((e, i) => {
      const { source: _source, topics, ...rest } = e;
      return {
        ...rest,
        ...(topics ? { topics: topics.filter((t) => !CREW_OUTCOME_TAGS.has(t.trim().toLowerCase())) } : {}),
        event_id: `${date}:${i + 1}:${slug(e.event_id ?? e.event)}`,
        thread: `night-${date}`,
      };
    });
}

/**
 * Stage 9 already appraises the verdict (recordVerdictFeedback) and Stage 2 folds the shelved streak into
 * derived_signals.frustration, so a Haiku `last-verdict` or `shelved-streak` event would count them twice.
 */
const CREW_OUTCOME_TAGS = new Set(["shelved-streak"]);
function isCrewOutcomeEvent(e: AppraisalEvent): boolean {
  const id = (e.event_id ?? "").trim().toLowerCase();
  if (id.endsWith("last-verdict") || id.endsWith("shelved-streak")) return true;
  const tags = (e.topics ?? []).map((t) => t.trim().toLowerCase());
  return tags.length > 0 && tags.every((t) => CREW_OUTCOME_TAGS.has(t));
}

/** Consecutive shelved nights immediately before `date` in the ledger. */
export function shelvedStreakBefore(ledger: LedgerEntry[], date: string): number {
  const prior = ledger.filter((e) => e.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
  let n = 0;
  for (const e of prior) {
    if (e.status !== "shelved") break;
    n++;
  }
  return n;
}

/**
 * Stage 2: appraise tonight's events in the engine and export mood.json. With presetOverride, returns the preset mood
 * and touches no state. dryRun runs on a scratch copy and discards it. hoursAdvance replaces wall-clock decay.
 */
export function applyAppraisalsToEngine(options: EngineOptions & {
  appraisals: Appraisals;
  date: string;
  shelvedStreak: number;
  dryRun?: boolean;
  hoursAdvance?: number;
  presetOverride?: string | null;
}): Mood {
  const c = ctx(options);
  if (options.presetOverride) return buildPresetMood(options.presetOverride, undefined, c.repoRoot);
  const appraisals = assertSchema<Appraisals>("appraisals", options.appraisals, c.repoRoot);
  const events = stampEvents(appraisals.events, options.date);
  const summary = withScratch(c, !options.dryRun, (dir) => {
    runEngine(c, dir, ["appraise", "--json", "-", ...hoursArgs(options.hoursAdvance)], JSON.stringify(events));
    return readSummary(c, dir);
  });
  return assertSchema<Mood>("mood", moodFromEngine(summary, options.shelvedStreak), c.repoRoot);
}

const FEEDBACK: Record<NightStatus, Pick<AppraisalEvent, "relevance" | "congruence" | "novelty" | "praiseworthiness" | "control">> = {
  // The only verdict appraisal: prompts/appraise.md tells Haiku never to emit one, and stampEvents drops any it does.
  published: { relevance: 0.9, congruence: 0.8, novelty: 0.3, praiseworthiness: 0.7, control: 0.6 },
  "b-side": { relevance: 0.8, congruence: 0.05, novelty: 0.3, praiseworthiness: 0.1, control: 0.6 },
  shelved: { relevance: 0.9, congruence: -0.7, novelty: 0.2, praiseworthiness: -0.45, control: 0.5 },
};

/** Stage 9: appraise tonight's verdict as the crew's own outcome, then consolidate so tastes settle across nights. */
export function recordVerdictFeedback(options: EngineOptions & {
  date: string;
  status: NightStatus;
  score: number | null;
  compo: string;
  domain: string;
  techniqueFamily?: string | null;
  shelvedStreak?: number;
  dryRun?: boolean;
}): { event: AppraisalEvent; elicited: Record<string, number>; consolidated: Record<string, number>; mood: Mood } {
  const c = ctx(options);
  if (!DATE_RE.test(options.date)) throw new Error(`date must be YYYY-MM-DD, got '${options.date}'`);
  const what = { published: "was published", "b-side": "went to the B-sides", shelved: "was shelved" }[options.status];
  const topics = [...new Set([options.domain, options.compo, options.techniqueFamily].filter((t): t is string => !!t?.trim()))]
    .map((t) => t.trim().slice(0, 60))
    .slice(0, 8);
  const event: AppraisalEvent = {
    event: `Tonight's ${options.compo} piece on ${options.domain} ${what}${options.score === null ? " without a score" : ` at ${options.score}`}.`,
    event_id: `${options.date}:verdict:${options.status}`,
    topics,
    agency: "self",
    certainty: 1,
    thread: `night-${options.date}`,
    ...FEEDBACK[options.status],
  };
  assertSchema("appraisals", { events: [event] }, c.repoRoot);
  const { elicited, consolidated, summary } = withScratch(c, !options.dryRun, (dir) => {
    const [first] = JSON.parse(runEngine(c, dir, ["appraise", "--json", "-"], JSON.stringify([event]))) as Array<Record<string, number>>;
    const cons = JSON.parse(runEngine(c, dir, ["consolidate", "--hours", "0"])) as Record<string, number>;
    return { elicited: first ?? {}, consolidated: cons, summary: readSummary(c, dir) };
  });
  const mood = assertSchema<Mood>("mood", moodFromEngine(summary, options.shelvedStreak ?? 0), c.repoRoot);
  return { event, elicited, consolidated, mood };
}

// ---------- deterministic mapping (SPEC Stage 2, DECISIONS.md) ----------

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0));
const clamp01 = (x: number): number => clamp(x, 0, 1);

/** SPEC Stage 2 table as fixed thresholds and sentences. PAD cutpoints are equal thirds of [-1, 1]. */
export function creativeParameters(pad: Pad, s: { interest: number; boredom: number; frustration: number }): Mood["creative_parameters"] {
  const third = (v: number): 0 | 1 | 2 => (v < -1 / 3 ? 0 : v > 1 / 3 ? 2 : 1);
  const tempo = (["low", "medium", "high"] as const)[third(pad.arousal)];
  const palette = (["cool-dissonant", "balanced", "warm-consonant"] as const)[third(pad.pleasure)];
  const scale = (["intimate", "measured", "assertive"] as const)[third(pad.dominance)];
  const risk = s.interest < 0.5 ? "conservative" : s.interest < 0.75 ? "moderate" : "experimental";
  const shrink = s.frustration >= 0.5;
  return {
    tempo_density_cut_rate: {
      level: tempo,
      value: r3((pad.arousal + 1) / 2),
      guidance: {
        low: "Slow, contemplative tempo: sparse elements, few long eased transitions, unhurried sound.",
        medium: "Steady tempo: moderate element density and a few deliberate scene changes.",
        high: "Fast tempo: dense fields or many elements, frequent cuts and an urgent rhythm.",
      }[tempo],
    },
    palette_warmth_consonance_symmetry: {
      level: palette,
      value: r3(pad.pleasure),
      guidance: {
        "cool-dissonant": "Cool, austere palette with one sharp accent, asymmetric composition and dissonant harmony.",
        balanced: "Mixed warm and cool palette, partial symmetry and open, neutral harmony.",
        "warm-consonant": "Warm palette, mirrored or radial symmetry and consonant, major harmony.",
      }[palette],
    },
    scale_contrast_camera: {
      level: scale,
      value: r3(pad.dominance),
      guidance: {
        intimate: "Intimate, delicate framing: small subject with margins, low contrast, a still or drifting camera.",
        measured: "Measured framing: medium scale, moderate contrast and one deliberate camera move.",
        assertive: "Assertive, bold framing: subject fills the frame, high contrast, strong camera moves.",
      }[scale],
    },
    technical_risk_budget: {
      level: risk,
      value: r3(s.interest),
      guidance: {
        conservative: "Conservative risk: build on a technique the crew can execute reliably.",
        moderate: "Moderate risk: add one unfamiliar technique on top of a safe base.",
        experimental: "Experimental risk: the main technique itself may be unfamiliar to the crew.",
      }[risk],
    },
    boredom_force_unused_30d: s.boredom >= 0.5,
    frustration_scope_polish_weight: {
      shrink_scope: shrink,
      polish_weight_boost: r3(s.frustration),
      guidance: shrink
        ? "Shrink scope: one rendering idea and at most 4 techniques; spend the saved effort on clean, refined polish."
        : "Normal scope: polish weight follows the usual rubric.",
    },
  };
}

/** Engine `state` snapshot to mood.json, following the DECISIONS.md formulas exactly. */
export function moodFromEngine(e: EngineSummary, shelvedStreak: number, timestamp = new Date().toISOString()): Mood {
  const emotion = (k: string): number => clamp01(e.emotions[k] ?? 0);
  const dominant = EMOTION_LABELS.map((label) => ({ label, intensity: r3(emotion(label)) }))
    .filter((x) => x.intensity > 0)
    .sort((a, b) => b.intensity - a.intensity || EMOTION_LABELS.indexOf(a.label) - EMOTION_LABELS.indexOf(b.label))
    .slice(0, 5);
  const pad: Pad = { pleasure: r3(clamp(e.mood[0], -1, 1)), arousal: r3(clamp(e.mood[1], -1, 1)), dominance: r3(clamp(e.mood[2], -1, 1)) };
  const neurochemistry = {
    dopamine: r3(clamp01(e.chem.da)),
    noradrenaline: r3(clamp01(e.chem.ne)),
    serotonin: r3(clamp01(e.chem.sht)),
    cortisol: r3(clamp01(e.chem.cort)),
    oxytocin: r3(clamp01(e.chem.oxt)),
    opioids: r3(clamp01(e.chem.opi)),
  };
  const streak = Math.max(0, Math.floor(shelvedStreak));
  const derived_signals = {
    interest: r3(emotion("interest")),
    boredom: r3(emotion("boredom")),
    frustration: r3(clamp01((0.5 * Math.min(streak, 3)) / 3 + 0.25 * neurochemistry.cortisol + 0.25 * emotion("distress"))),
  };
  // Topic sentiments only: thread:<night> and agent:<id> keys are per-night or per-source noise, not tastes, and
  // shelved-streak is a crew outcome, never a taste.
  const topics = Object.entries(e.sentiments)
    .filter(([k]) => k.startsWith("topic:") && !CREW_OUTCOME_TAGS.has(k.slice("topic:".length)))
    .map(([k, v]) => ({ topic: k.slice("topic:".length).slice(0, 80), score: r3(v.liking) }))
    .filter((x) => x.topic.length > 0);
  const ranked = (keep: (s: number) => boolean) =>
    topics.filter((x) => keep(x.score)).sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || (a.topic < b.topic ? -1 : 1)).slice(0, 50);
  return {
    timestamp,
    preset_override: null,
    // The schema needs at least one entry; a fully calm engine reports boredom at 0.
    dominant_emotions: dominant.length ? dominant : [{ label: "boredom", intensity: 0 }],
    pad,
    neurochemistry,
    drives: { novelty: r3(clamp01(e.drives.novelty)), social: r3(clamp01(e.drives.social)), fatigue: r3(clamp01(e.drives.fatigue)) },
    derived_signals,
    likes: ranked((s) => s > 0.05),
    dislikes: ranked((s) => s < -0.05),
    creative_parameters: creativeParameters(pad, derived_signals),
  };
}

// ---------- hand-set presets (workflow_dispatch mood_preset, the "5 moods, same dossier" test) ----------

interface PresetSpec {
  pad: Pad;
  derived: { interest: number; boredom: number; frustration: number };
  emotions: Array<{ label: EmotionLabel; intensity: number }>;
  neurochemistry: Mood["neurochemistry"];
  drives: Mood["drives"];
}

export const MOOD_PRESETS: Readonly<Record<string, PresetSpec>> = {
  "euphoric-high-arousal": {
    pad: { pleasure: 0.85, arousal: 0.88, dominance: 0.75 },
    derived: { interest: 0.85, boredom: 0.05, frustration: 0.05 },
    emotions: [{ label: "joy", intensity: 0.9 }, { label: "interest", intensity: 0.85 }, { label: "pride", intensity: 0.7 }, { label: "surprise", intensity: 0.4 }],
    neurochemistry: { dopamine: 0.9, noradrenaline: 0.8, serotonin: 0.65, cortisol: 0.1, oxytocin: 0.55, opioids: 0.8 },
    drives: { novelty: 0.3, social: 0.5, fatigue: 0.05 },
  },
  "melancholic-low-arousal": {
    pad: { pleasure: -0.65, arousal: -0.75, dominance: -0.55 },
    derived: { interest: 0.45, boredom: 0.15, frustration: 0.15 },
    emotions: [{ label: "disappointment", intensity: 0.6 }, { label: "distress", intensity: 0.5 }, { label: "interest", intensity: 0.45 }, { label: "boredom", intensity: 0.15 }],
    neurochemistry: { dopamine: 0.25, noradrenaline: 0.15, serotonin: 0.3, cortisol: 0.3, oxytocin: 0.35, opioids: 0.3 },
    drives: { novelty: 0.25, social: 0.6, fatigue: 0.6 },
  },
  "bored-restless": {
    pad: { pleasure: -0.25, arousal: 0.45, dominance: 0.2 },
    derived: { interest: 0.15, boredom: 0.9, frustration: 0.2 },
    emotions: [{ label: "boredom", intensity: 0.9 }, { label: "interest", intensity: 0.15 }],
    neurochemistry: { dopamine: 0.3, noradrenaline: 0.6, serotonin: 0.45, cortisol: 0.35, oxytocin: 0.4, opioids: 0.4 },
    drives: { novelty: 0.95, social: 0.4, fatigue: 0.2 },
  },
  "frustrated-tight-polish": {
    pad: { pleasure: -0.5, arousal: 0.35, dominance: -0.2 },
    derived: { interest: 0.3, boredom: 0.1, frustration: 0.88 },
    emotions: [{ label: "distress", intensity: 0.65 }, { label: "disappointment", intensity: 0.55 }, { label: "anger", intensity: 0.4 }, { label: "interest", intensity: 0.3 }],
    neurochemistry: { dopamine: 0.35, noradrenaline: 0.65, serotonin: 0.35, cortisol: 0.75, oxytocin: 0.35, opioids: 0.3 },
    drives: { novelty: 0.4, social: 0.3, fatigue: 0.5 },
  },
  "curious-experimental": {
    pad: { pleasure: 0.55, arousal: 0.55, dominance: 0.15 },
    derived: { interest: 0.95, boredom: 0.05, frustration: 0.05 },
    emotions: [{ label: "interest", intensity: 0.95 }, { label: "surprise", intensity: 0.6 }, { label: "hope", intensity: 0.5 }, { label: "joy", intensity: 0.4 }],
    neurochemistry: { dopamine: 0.8, noradrenaline: 0.6, serotonin: 0.55, cortisol: 0.15, oxytocin: 0.45, opioids: 0.6 },
    drives: { novelty: 0.85, social: 0.35, fatigue: 0.1 },
  },
};

/** A hand-set mood. creative_parameters go through the same mapping as the engine path. */
export function buildPresetMood(presetName: string, timestamp = new Date().toISOString(), repoRoot?: string): Mood {
  const p = MOOD_PRESETS[presetName];
  if (!p) throw new Error(`unknown mood preset '${presetName}' (one of: ${Object.keys(MOOD_PRESETS).join(", ")})`);
  const mood: Mood = {
    timestamp,
    preset_override: presetName,
    dominant_emotions: p.emotions.map((x) => ({ ...x })),
    pad: { ...p.pad },
    neurochemistry: { ...p.neurochemistry },
    drives: { ...p.drives },
    derived_signals: { ...p.derived },
    likes: [],
    dislikes: [],
    creative_parameters: creativeParameters(p.pad, p.derived),
  };
  return assertSchema<Mood>("mood", mood, repoRoot);
}
