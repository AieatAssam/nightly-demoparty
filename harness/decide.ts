// Stage 8: publish, retry with feedback, b-side or shelve. Also the ratchet and the
// per-attempt outcome classifier that meta.attempts[].outcome must match (DECISIONS.md).
import { dayNumber } from "./novelty.js";
import type { AttemptOutcome, CritiqueItem, GateFailure, GatesResult, LedgerEntry, ThresholdsConfig, Verdict } from "./types.js";

export const DEFAULT_RATCHET_WINDOW_NIGHTS = 30;
/** SPEC stage 8: the ratchet is max(72, median - 3). Fixed, so a weaker month can bring publish_min back down. */
export const RATCHET_FLOOR = 72;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Median score of the shipped (published or b-side) scored nights in the 30 nights before `date`
 * (or the newest 30 entries without a date). Shelved nights never count, so a bad week cannot lower the bar.
 */
export function median30d(ledger: LedgerEntry[], date?: string, windowNights = DEFAULT_RATCHET_WINDOW_NIGHTS): number | null {
  let window: LedgerEntry[];
  if (date) {
    const today = dayNumber(date);
    window = ledger.filter((e) => {
      const d = today - dayNumber(e.date);
      return d >= 1 && d <= windowNights;
    });
  } else {
    window = [...ledger].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, windowNights);
  }
  return median(window.filter((e) => e.status !== "shelved").map((e) => e.score).filter((s): s is number => s !== null));
}

/**
 * Weekly value for publish_min: min(ratchet_cap, max(RATCHET_FLOOR, floor(median - offset))); RATCHET_FLOOR when
 * nothing is scored. The floor is not the current publish_min, which this value replaces.
 */
export function computeRatchetedThreshold(
  ledger: LedgerEntry[],
  thresholds: Pick<ThresholdsConfig, "ratchet_cap" | "ratchet_median_offset">,
  date?: string,
): number {
  const m = median30d(ledger, date);
  if (m === null) return RATCHET_FLOOR;
  return Math.min(thresholds.ratchet_cap, Math.max(RATCHET_FLOOR, Math.floor(m - thresholds.ratchet_median_offset)));
}

/** Night-1 rule: an empty archive (`pairwise_median_ref === null`) counts as a pairwise pass. */
export function pairwisePasses(v: Verdict): boolean {
  return v.pairwise_median_ref === null || v.pairwise_beats_median === true;
}

export function classifyAttempt(gates: GatesResult | null, verdict: Verdict | null, publishThreshold: number): AttemptOutcome {
  if (!gates) return "build_failed";
  if (!gates.passed) return "gates_failed";
  // Gates passed but no valid verdict (jury failed): not publishable, recorded as below_threshold (DECISIONS.md).
  if (!verdict || verdict.total < publishThreshold) return "below_threshold";
  return pairwisePasses(verdict) ? "passed" : "pairwise_failed";
}

export interface AttemptRecord {
  attempt: number;
  gates: GatesResult | null;
  verdict: Verdict | null;
}

export type DecideAction = "publish" | "retry" | "b-side" | "shelve";

export interface DecideResult {
  action: DecideAction;
  /** Attempt kept (the one to publish, b-side, or best effort when shelved). Null when nothing rendered. */
  best_attempt: number | null;
  best_total: number | null;
  publish_threshold: number;
  reason: string;
  /** Feedback for the next build attempt when action is "retry". */
  feedback: { gate_failures: GateFailure[]; critique: CritiqueItem[]; build_failed: boolean } | null;
  outcomes: Array<{ attempt: number; outcome: AttemptOutcome }>;
}

function rankKey(a: AttemptRecord): [number, number] {
  if (a.gates?.passed && a.verdict) return [3, a.verdict.total];
  if (a.gates?.passed) return [2, 0];
  if (a.gates) return [1, 0];
  return [0, 0];
}

/** Best attempt: gates passed with highest verdict total first; earliest wins ties. */
export function bestAttempt(attempts: AttemptRecord[]): AttemptRecord | null {
  let best: AttemptRecord | null = null;
  for (const a of attempts) {
    if (!best) {
      best = a;
      continue;
    }
    const [ka, va] = rankKey(a);
    const [kb, vb] = rankKey(best);
    if (ka > kb || (ka === kb && va > vb)) best = a;
  }
  return best;
}

const REASON_MAX = 400;
const clip = (s: string): string => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 3)}...` : s);

export function decideAttempt(params: {
  attempts: AttemptRecord[];
  currentAttempt: number;
  maxAttempts?: number;
  publishThreshold: number;
  bSideMin?: number;
}): DecideResult {
  const { attempts, currentAttempt, publishThreshold } = params;
  const maxAttempts = params.maxAttempts ?? 3;
  const bSideMin = params.bSideMin ?? 60;
  const outcomes = attempts.map((a) => ({ attempt: a.attempt, outcome: classifyAttempt(a.gates, a.verdict, publishThreshold) }));
  const base = { publish_threshold: publishThreshold, outcomes };

  const passing = attempts.filter((a, i) => outcomes[i]!.outcome === "passed");
  const winner = bestAttempt(passing);
  if (winner?.verdict) {
    return {
      ...base,
      action: "publish",
      best_attempt: winner.attempt,
      best_total: winner.verdict.total,
      reason: `Attempt ${winner.attempt} scored ${winner.verdict.total} >= ${publishThreshold} and passed the pairwise check.`,
      feedback: null,
    };
  }

  const current = attempts.find((a) => a.attempt === currentAttempt) ?? null;
  const best = bestAttempt(attempts);
  const bestScored = best?.gates?.passed && best.verdict ? best : null;

  if (currentAttempt < maxAttempts) {
    const gateFailures = current?.gates && !current.gates.passed ? current.gates.failures : [];
    const critique = current?.verdict ? [...current.verdict.critique].sort((a, b) => a.rank - b.rank) : [];
    const outcome = current ? classifyAttempt(current.gates, current.verdict, publishThreshold) : "build_failed";
    const why =
      outcome === "build_failed"
        ? "build produced no piece"
        : outcome === "gates_failed"
          ? `hard gates failed: ${gateFailures.map((f) => f.gate).join(", ")}`
          : outcome === "pairwise_failed"
            ? `scored ${current?.verdict?.total} but lost the pairwise check`
            : `scored ${current?.verdict?.total ?? "no verdict"}, below ${publishThreshold}`;
    return {
      ...base,
      action: "retry",
      best_attempt: best?.gates ? best.attempt : null,
      best_total: bestScored?.verdict?.total ?? null,
      reason: clip(`Attempt ${currentAttempt}: ${why}. Retrying (${currentAttempt + 1}/${maxAttempts}).`),
      feedback: { gate_failures: gateFailures, critique, build_failed: outcome === "build_failed" },
    };
  }

  // Attempt cap reached. A best attempt at or above threshold that lost pairwise lands on b-side too.
  if (bestScored?.verdict && bestScored.verdict.total >= bSideMin) {
    const v = bestScored.verdict;
    const why =
      v.total >= publishThreshold
        ? `scored ${v.total} but did not beat the 30-night median piece (${v.pairwise_median_ref})`
        : `scored ${v.total}, below the publish threshold ${publishThreshold}`;
    return {
      ...base,
      action: "b-side",
      best_attempt: bestScored.attempt,
      best_total: v.total,
      reason: clip(`B-side: best attempt ${bestScored.attempt} ${why}.`),
      feedback: null,
    };
  }

  let reason: string;
  if (bestScored?.verdict) {
    reason = `Best attempt ${bestScored.attempt} scored ${bestScored.verdict.total}, below the B-side floor of ${bSideMin}. Top critique: ${
      [...bestScored.verdict.critique].sort((a, b) => a.rank - b.rank)[0]?.change ?? "none"
    }`;
  } else if (attempts.some((a) => a.gates)) {
    const parts = attempts
      .filter((a) => !a.gates?.passed)
      .map((a) => `attempt ${a.attempt}: ${a.gates ? a.gates.failures.map((f) => f.gate).join(", ") : "build failed"}`);
    reason = `No attempt passed the hard gates (${parts.join("; ")}).`;
  } else {
    reason = `No attempt produced a piece (${attempts.length} build failure(s)).`;
  }
  return {
    ...base,
    action: "shelve",
    best_attempt: best?.gates ? best.attempt : null,
    best_total: bestScored?.verdict?.total ?? null,
    reason: clip(reason),
    feedback: null,
  };
}
