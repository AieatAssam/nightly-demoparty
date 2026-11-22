// Stage 9: write the piece folder, meta.json and the ledger row, and build the emotion feedback event.
// Everything is validated before the first write, so a bad night never leaves half a publish behind.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyAttempt } from "./decide.js";
import { injectOrVerifyCsp } from "./lint.js";
import { readLedger } from "./novelty.js";
import { assertSchema } from "./schema.js";
import { findRepoRoot } from "./config.js";
import type {
  AppraisalEvent,
  Appraisals,
  Brief,
  Dossier,
  GatesResult,
  LedgerEntry,
  Meta,
  MetaAttempt,
  Mood,
  NightStatus,
  Plan,
  Screenshots,
  Verdict,
} from "./types.js";

export const SHOT_NAMES: Screenshots = { t2: "shot-02s.png", t8: "shot-08s.png", t20: "shot-20s.png" };

export interface PublishAttempt {
  attempt: number;
  model: string;
  effort: string | null;
  gates: GatesResult | null;
  verdict: Verdict | null;
}

export interface PublishInput {
  status: NightStatus;
  /** Required for b-side and shelved, ignored (null) for published. */
  reason: string | null;
  publishThreshold: number;
  plan: Plan;
  dossier: Dossier | null;
  mood: Mood | null;
  brief: Brief | null;
  attempts: PublishAttempt[];
  bestAttempt: number | null;
  /** Defaults to brief.liner_note. */
  linerNote?: string | null;
  /** Override the best attempt's gates.piece_path (repo-relative or absolute). */
  piecePath?: string;
  repoRoot?: string;
  /** Write under outputDir (same site/ and ledger/ layout) instead of the repo. Implied by plan.dry_run. */
  dryRun?: boolean;
  outputDir?: string;
}

export interface PublishResult {
  meta: Meta;
  ledgerEntry: LedgerEntry;
  emotionEvent: AppraisalEvent;
  written: string[];
}

function tag(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().slice(0, 60);
  return t || null;
}

export function buildEmotionEvent(
  status: NightStatus,
  date: string,
  brief: Brief | null,
  compo: string,
  score: number | null,
  reason: string | null,
  repoRoot?: string,
): AppraisalEvent {
  const title = brief ? `'${brief.title}'` : "tonight's piece";
  const topics = [tag(brief?.technique_family), tag(compo)].filter((t): t is string => t !== null);
  const common = {
    event_id: `verdict-${date}`,
    topics: [...new Set(topics)].slice(0, 8),
    agency: "self" as const,
    certainty: 1,
    source: "verdict",
    thread: date,
  };
  const scoreText = score === null ? "" : ` with a score of ${score}`;
  let event: AppraisalEvent;
  if (status === "published") {
    // pride
    event = { event: `The crew published ${title}${scoreText}.`, relevance: 0.8, congruence: 0.8, novelty: 0.3, praiseworthiness: 0.7, control: 0.8, ...common };
  } else if (status === "b-side") {
    // mild disappointment
    event = { event: `${title} only made the B-sides${scoreText}.`, relevance: 0.6, congruence: -0.3, novelty: 0.2, praiseworthiness: 0.1, control: 0.6, ...common };
  } else {
    // frustration / disappointment
    event = { event: `Nothing was released tonight: ${reason ?? "shelved"}`, relevance: 0.9, congruence: -0.7, novelty: 0.2, praiseworthiness: -0.4, control: 0.5, ...common };
  }
  event.event = event.event.slice(0, 300);
  assertSchema<Appraisals>("appraisals", { events: [event] }, repoRoot);
  return event;
}

export function publishNight(input: PublishInput): PublishResult {
  const repoRoot = input.repoRoot ? resolve(input.repoRoot) : findRepoRoot();
  // A dry-run plan never writes into the repo, even when the caller forgot the flag.
  const dryRun = Boolean(input.dryRun || input.plan.dry_run);
  if (dryRun && !input.outputDir) throw new Error("dryRun requires outputDir");
  const outRoot = dryRun ? resolve(input.outputDir!) : repoRoot;
  const { plan, status, brief, dossier, mood, publishThreshold } = input;
  const date = plan.date;

  const metaAttempts: MetaAttempt[] = input.attempts.map((a) => ({
    attempt: a.attempt,
    model: a.model,
    effort: a.effort,
    gates: a.gates,
    verdict: a.verdict,
    outcome: classifyAttempt(a.gates, a.verdict, publishThreshold),
  }));
  const best = input.bestAttempt === null ? null : (input.attempts.find((a) => a.attempt === input.bestAttempt) ?? null);
  if (input.bestAttempt !== null && !best) throw new Error(`bestAttempt ${input.bestAttempt} is not in attempts`);

  const shipped = status === "published" || status === "b-side";
  if (shipped) {
    if (!best?.gates?.passed) throw new Error(`${status} needs a best attempt that passed the hard gates`);
    if (!best.verdict) throw new Error(`${status} needs a non-null verdict on the best attempt`);
  }
  if (status === "published" && metaAttempts.find((a) => a.attempt === best?.attempt)?.outcome !== "passed") {
    throw new Error("published needs the best attempt's outcome to be 'passed'");
  }
  const reason = status === "published" ? null : (input.reason ?? "").trim() || null;
  if (status !== "published" && !reason) throw new Error(`${status} needs a non-empty reason`);

  const pieceDir = join(outRoot, "site", "pieces", date);
  const meta: Meta = {
    date,
    status,
    reason,
    publish_threshold: publishThreshold,
    best_attempt: input.bestAttempt,
    plan,
    dossier,
    mood,
    brief,
    attempts: metaAttempts,
    liner_note: input.linerNote ?? brief?.liner_note ?? null,
    screenshots: shipped ? SHOT_NAMES : null,
    piece_rel_path: shipped ? `pieces/${date}/index.html` : null,
  };
  assertSchema<Meta>("meta", meta, repoRoot);

  // Shelved pieces were never shown, so their hashes stay out of the novelty archive.
  const keptGates = shipped ? best!.gates! : null;
  const ledgerEntry: LedgerEntry = {
    date,
    status,
    compo: plan.compo,
    domain: plan.wildcard ? (dossier?.domain ?? plan.domain) : plan.domain,
    topic: dossier?.topic ?? null,
    concept: brief?.concept ?? null,
    techniques: brief?.techniques ?? [],
    technique_family: brief?.technique_family ?? null,
    palette: (brief?.palette ?? []).map((c) => c.toLowerCase()),
    phashes: keptGates ? { ...keptGates.novelty_b.phashes } : { t2: null, t8: null, t20: null },
    color_histogram: keptGates ? keptGates.novelty_b.color_histogram : null,
    score: best?.verdict?.total ?? bestVerdictTotal(input.attempts),
    attempts: input.attempts.length,
    mood_pad: mood?.pad ?? null,
    dominant_emotion: mood?.dominant_emotions[0]?.label ?? null,
  };
  assertSchema<LedgerEntry>("ledger-entry", ledgerEntry, repoRoot);

  const emotionEvent = buildEmotionEvent(status, date, brief, plan.compo, ledgerEntry.score, reason, repoRoot);

  // Read every source before writing anything.
  let html: string | null = null;
  const shots: Array<[string, string]> = [];
  if (shipped) {
    const g = best!.gates!;
    html = injectOrVerifyCsp(readFileSync(resolve(repoRoot, input.piecePath ?? g.piece_path), "utf8"));
    for (const k of ["t2", "t8", "t20"] as const) shots.push([resolve(repoRoot, g.screenshots[k]), join(pieceDir, SHOT_NAMES[k])]);
  }

  // One ledger row per night: a rerun for the same date would double-count it in every window.
  const ledgerPath = join(outRoot, "ledger", "ledger.jsonl");
  if (readLedger(ledgerPath, repoRoot).some((e) => e.date === date)) {
    throw new Error(`${ledgerPath} already has a row for ${date}`);
  }

  const written: string[] = [];
  mkdirSync(pieceDir, { recursive: true });
  if (html !== null) {
    const p = join(pieceDir, "index.html");
    writeFileSync(p, html);
    written.push(p);
    for (const [from, to] of shots) {
      copyFileSync(from, to);
      written.push(to);
    }
  }
  const metaPath = join(pieceDir, "meta.json");
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  written.push(metaPath);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(ledgerEntry)}\n`);
  written.push(ledgerPath);

  return { meta, ledgerEntry, emotionEvent, written };
}

function bestVerdictTotal(attempts: PublishAttempt[]): number | null {
  const totals = attempts.map((a) => a.verdict?.total).filter((t): t is number => typeof t === "number");
  return totals.length ? Math.max(...totals) : null;
}
