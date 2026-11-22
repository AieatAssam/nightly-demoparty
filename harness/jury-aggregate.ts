// Stage 7 jury aggregation: N independent Haiku verdicts (3 in production) into one verdict.
import { validateVerdictStrict } from "./schema.js";
import type { VerdictStrictOptions } from "./schema.js";
import type { Verdict } from "./types.js";

const CRITERIA = ["mechanism", "ambition", "craft", "distinctness", "polish"] as const;

/** Integer median: middle value, or the rounded mean of the two middle values for an even count. */
function intMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * Per-criterion median scores, exact-sum total, strict-majority pairwise vote (a tie is false). Evidence, critique
 * and the pairwise/calibration fields are copied whole from the sample whose total is closest to the aggregate
 * (ties: same pairwise vote, then lowest index), so the prose stays one coherent visual pass. Inputs and the result
 * are checked with validateVerdictStrict; throws on any failure.
 */
export function aggregateJuryVerdicts(verdicts: Verdict[], options: VerdictStrictOptions = {}, repoRoot?: string): Verdict {
  if (!verdicts.length) throw new Error("aggregateJuryVerdicts needs at least one verdict");
  verdicts.forEach((v, i) => {
    const r = validateVerdictStrict(v, repoRoot, options);
    if (!r.ok) throw new Error(`verdict ${i + 1} invalid: ${r.errors.join("; ")}`);
  });
  const scores = Object.fromEntries(CRITERIA.map((k) => [k, intMedian(verdicts.map((v) => v.scores[k]))])) as Verdict["scores"];
  const total = CRITERIA.reduce((s, k) => s + scores[k], 0);
  const beats = verdicts.filter((v) => v.pairwise_beats_median).length * 2 > verdicts.length;
  const rep = verdicts
    .map((v, i) => ({ v, i, d: Math.abs(v.total - total), miss: v.pairwise_beats_median === beats ? 0 : 1 }))
    .sort((a, b) => a.d - b.d || a.miss - b.miss || a.i - b.i)[0]!.v;
  const out: Verdict = {
    scores,
    total,
    evidence: rep.evidence,
    pairwise_beats_median: beats,
    pairwise_median_ref: rep.pairwise_median_ref,
    pairwise_justification: rep.pairwise_justification,
    calibration_anchors_used: rep.calibration_anchors_used,
    critique: rep.critique,
  };
  const r = validateVerdictStrict(out, repoRoot, options);
  if (!r.ok) throw new Error(`aggregated verdict invalid: ${r.errors.join("; ")}`);
  return out;
}
