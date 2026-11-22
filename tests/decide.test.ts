import { describe, expect, it } from 'vitest';
import {
  bestAttempt,
  classifyAttempt,
  computeRatchetedThreshold,
  decideAttempt,
  median,
  median30d,
  pairwisePasses,
  type AttemptRecord,
} from '../harness/decide.js';
import type { GatesResult, LedgerEntry, Verdict } from '../harness/types.js';

const DATE = '2026-11-22';
const offset = (n: number): string => new Date(Date.parse(`${DATE}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const TH = { publish_min: 72, ratchet_cap: 85, ratchet_median_offset: 3 };

const gates = (passed: boolean, failures: string[] = []): GatesResult =>
  ({ passed, failures: failures.map((g) => ({ gate: g, message: g, measured: 0, threshold: 0 })) }) as unknown as GatesResult;

const verdict = (total: number, over: Partial<Verdict> = {}): Verdict =>
  ({
    total,
    pairwise_beats_median: true,
    pairwise_median_ref: '2026-11-10',
    critique: [
      { rank: 2, change: 'second', expected_gain: 1 },
      { rank: 1, change: 'first', expected_gain: 2 },
      { rank: 3, change: 'third', expected_gain: 1 },
    ],
    ...over,
  }) as unknown as Verdict;

const scored = (attempt: number, total: number, over: Partial<Verdict> = {}): AttemptRecord => ({ attempt, gates: gates(true), verdict: verdict(total, over) });
const failed = (attempt: number, ...g: string[]): AttemptRecord => ({ attempt, gates: gates(false, g), verdict: null });
const entry = (n: number, score: number | null): LedgerEntry => ({ date: offset(n), score }) as unknown as LedgerEntry;

describe('median', () => {
  it('handles empty, odd and even inputs', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('median30d window', () => {
  it('uses only scored nights 1 to 30 before the date', () => {
    const ledger = [entry(1, 90), entry(2, 70), entry(31, 10), entry(0, 5), entry(3, null)];
    expect(median30d(ledger, DATE)).toBe(80);
  });
});

describe('ratchet', () => {
  it('uses the fixed SPEC floor of 72, not the current publish_min, so the threshold can come down', () => {
    const raised = { ...TH, publish_min: 85 }; // last week's ratchet result
    expect(computeRatchetedThreshold([entry(1, 76)], raised, DATE)).toBe(73);
  });

  it('ignores shelved nights in the 30-night median', () => {
    const shelved = (n: number, score: number): LedgerEntry => ({ ...entry(n, score), status: 'shelved' }) as LedgerEntry;
    const ledger = [entry(1, 90), entry(2, 90), shelved(3, 40), shelved(4, 40), shelved(5, 40)];
    expect(median30d(ledger, DATE)).toBe(90);
    expect(computeRatchetedThreshold(ledger, TH, DATE)).toBe(85);
  });

  it('falls back to publish_min when no night is scored', () => {
    expect(computeRatchetedThreshold([], TH, DATE)).toBe(72);
  });

  it('is min(cap, max(publish_min, floor(median - 3)))', () => {
    expect(computeRatchetedThreshold([entry(1, 95)], TH, DATE)).toBe(85);
    expect(computeRatchetedThreshold([entry(1, 80)], TH, DATE)).toBe(77);
    expect(computeRatchetedThreshold([entry(1, 70)], TH, DATE)).toBe(72);
  });
});

describe('pairwise and classification', () => {
  it('passes when there is no archive to compare against', () => {
    expect(pairwisePasses(verdict(80, { pairwise_median_ref: null }))).toBe(true);
    expect(pairwisePasses(verdict(80, { pairwise_beats_median: false }))).toBe(false);
  });

  it('classifies each attempt outcome', () => {
    expect(classifyAttempt(null, null, 72)).toBe('build_failed');
    expect(classifyAttempt(gates(false, ['motion']), null, 72)).toBe('gates_failed');
    expect(classifyAttempt(gates(true), null, 72)).toBe('below_threshold');
    expect(classifyAttempt(gates(true), verdict(70), 72)).toBe('below_threshold');
    expect(classifyAttempt(gates(true), verdict(80, { pairwise_beats_median: false }), 72)).toBe('pairwise_failed');
    expect(classifyAttempt(gates(true), verdict(80), 72)).toBe('passed');
  });
});

describe('bestAttempt', () => {
  it('prefers a gate-passing attempt with the higher total and keeps the earliest on a tie', () => {
    expect(bestAttempt([failed(1, 'motion'), scored(2, 75), scored(3, 80)])?.attempt).toBe(3);
    expect(bestAttempt([scored(1, 80), scored(2, 80)])?.attempt).toBe(1);
    expect(bestAttempt([])).toBeNull();
  });
});

describe('decideAttempt', () => {
  it('publishes the first attempt that passes gates, scores above threshold and beats the median', () => {
    const r = decideAttempt({ attempts: [scored(1, 80)], currentAttempt: 1, publishThreshold: 72 });
    expect(r.action).toBe('publish');
    expect(r.best_attempt).toBe(1);
    expect(r.feedback).toBeNull();
  });

  it('retries after a gate failure and carries the failures as feedback', () => {
    const r = decideAttempt({ attempts: [failed(1, 'motion')], currentAttempt: 1, publishThreshold: 72 });
    expect(r.action).toBe('retry');
    expect(r.feedback?.gate_failures.map((f) => f.gate)).toEqual(['motion']);
  });

  it('retries after a below-threshold score with critique sorted by rank', () => {
    const r = decideAttempt({ attempts: [scored(1, 65)], currentAttempt: 1, publishThreshold: 72 });
    expect(r.action).toBe('retry');
    expect(r.feedback?.critique.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it('goes to b-side at the attempt cap when the best score is 60 to 71', () => {
    const attempts = [scored(1, 65), scored(2, 66), scored(3, 68)];
    const r = decideAttempt({ attempts, currentAttempt: 3, publishThreshold: 72 });
    expect(r.action).toBe('b-side');
    expect(r.best_attempt).toBe(3);
  });

  it('shelves at the attempt cap when the best score is below 60', () => {
    const r = decideAttempt({ attempts: [scored(1, 50), failed(2, 'strobe'), failed(3, 'strobe')], currentAttempt: 3, publishThreshold: 72 });
    expect(r.action).toBe('shelve');
    expect(r.reason).toMatch(/Best attempt 1 scored 50/);
  });

  it('b-sides at the cap when the best attempt scored above threshold but lost the pairwise check', () => {
    const attempts = [scored(1, 80, { pairwise_beats_median: false }), failed(2, 'motion'), failed(3, 'motion')];
    const r = decideAttempt({ attempts, currentAttempt: 3, publishThreshold: 72 });
    expect(r.action).toBe('b-side');
    expect(r.best_attempt).toBe(1);
    expect(r.outcomes.map((o) => o.outcome)).toEqual(['pairwise_failed', 'gates_failed', 'gates_failed']);
  });
});
