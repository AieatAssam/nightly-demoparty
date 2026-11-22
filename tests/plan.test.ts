import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildPlan, fnv1a, moodMultiplier, mulberry32, weightedPick } from '../harness/plan.js';
import { dayNumber } from '../harness/novelty.js';
import { loadAllConfig } from '../harness/config.js';
import type { CompoId, LedgerEntry, Mood, RepoConfig } from '../harness/types.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const config: RepoConfig = loadAllConfig(REPO);
const DATE = '2026-11-22';

const isoFromDay = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);
const nextDayWhere = (from: string, ok: (n: number) => boolean): string => {
  let n = dayNumber(from);
  while (!ok(n)) n++;
  return isoFromDay(n);
};
const offset = (date: string, nights: number): string => isoFromDay(dayNumber(date) - nights);

const row = (date: string, over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({
    date,
    status: 'published',
    compo: '16k-demo',
    domain: 'oceanography',
    topic: null,
    concept: null,
    techniques: [],
    technique_family: null,
    palette: [],
    phashes: { t2: null, t8: null, t20: null },
    color_histogram: null,
    score: 80,
    attempts: 1,
    mood_pad: null,
    dominant_emotion: null,
    ...over,
  }) as unknown as LedgerEntry;

const mood = (over: { arousal?: number; frustration?: number; boredom?: boolean } = {}): Mood =>
  ({
    pad: { pleasure: 0, arousal: over.arousal ?? 0, dominance: 0 },
    derived_signals: { interest: 0.5, frustration: over.frustration ?? 0 },
    creative_parameters: { boredom_force_unused_30d: over.boredom ?? false },
  }) as unknown as Mood;

describe('seeded PRNG', () => {
  it('fnv1a of the empty string is the FNV offset basis', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
  });

  it('mulberry32 repeats for the same seed and stays in [0, 1)', () => {
    const a = mulberry32(fnv1a(DATE));
    const b = mulberry32(fnv1a(DATE));
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('weightedPick never picks a zero-weight item when others have weight', () => {
    const rng = mulberry32(7);
    const picks = Array.from({ length: 200 }, () => weightedPick(['a', 'b'], (x) => (x === 'a' ? 0 : 1), rng));
    expect(new Set(picks)).toEqual(new Set(['b']));
  });
});

describe('moodMultiplier', () => {
  it('is exactly 1 without a mood', () => {
    expect(moodMultiplier('16k-demo', null)).toBe(1);
  });

  it('rises with arousal for 16k-demo and falls with frustration', () => {
    expect(moodMultiplier('16k-demo', mood({ arousal: 1 }))).toBeGreaterThan(1);
    expect(moodMultiplier('16k-demo', mood({ frustration: 1 }))).toBeLessThan(1);
  });
});

describe('buildPlan', () => {
  it('is deterministic for the same ledger, date and seed', () => {
    const ledger = [row(offset(DATE, 1), { compo: 'simulation', domain: 'sailing' })];
    expect(buildPlan({ date: DATE, config, ledger })).toEqual(buildPlan({ date: DATE, config, ledger }));
  });

  it('defaults the seed to the date and records dry-run and overrides', () => {
    const p = buildPlan({ date: DATE, config, ledger: [], dryRun: true });
    expect(p.seed).toBe(DATE);
    expect(p.dry_run).toBe(true);
    expect(p.overrides).toEqual({ domain: null, compo: null, mood_preset: null });
  });

  it('uses the wildcard domain on every seventh calendar night', () => {
    const wild = nextDayWhere(DATE, (n) => n % 7 === 0);
    const p = buildPlan({ date: wild, config, ledger: [] });
    expect(p.wildcard).toBe(true);
    expect(p.domain).toBe('wildcard');
  });

  it('avoids domains used in the last ten nights on ordinary nights', () => {
    const plain = nextDayWhere(DATE, (n) => n % 7 !== 0);
    const used = config.domains[0]!;
    const ledger = [row(offset(plain, 2), { domain: used.id })];
    const p = buildPlan({ date: plain, config, ledger });
    expect(p.wildcard).toBe(false);
    expect(p.domain.toLowerCase()).not.toBe(used.id.toLowerCase());
  });

  it('collects banned techniques within 21 nights and palette within 7, not older', () => {
    const ledger = [
      row(offset(DATE, 5), { techniques: ['Radial Gradient'], palette: ['#ABCDEF'] }),
      row(offset(DATE, 40), { techniques: ['ancient trick'], palette: ['#123456'] }),
    ];
    const p = buildPlan({ date: DATE, config, ledger });
    expect(p.banned.techniques).toContain('Radial Gradient');
    expect(p.banned.techniques).not.toContain('ancient trick');
    expect(p.banned.palette_hexes).toContain('#abcdef');
    expect(p.banned.palette_hexes).not.toContain('#123456');
  });

  it('honours a forced compo override and rejects an unknown one', () => {
    const p = buildPlan({ date: DATE, config, ledger: [], overrides: { compo: 'kinetic-type' } });
    expect(p.compo).toBe('kinetic-type');
    expect(p.overrides.compo).toBe('kinetic-type');
    expect(() => buildPlan({ date: DATE, config, ledger: [], overrides: { compo: 'nope' as CompoId } })).toThrow(/not in config/);
  });

  it('forces the one compo unused for 30 nights under boredom and flags the override', () => {
    const all = config.compos.map((c) => c.id);
    const unused = all[all.length - 1]!;
    const ledger = all
      .filter((id) => id !== unused)
      .map((id, i) => row(offset(DATE, i + 1), { compo: id }));
    const p = buildPlan({ date: DATE, config, ledger, mood: mood({ boredom: true }) });
    expect(p.compo).toBe(unused);
    expect(p.boredom_override).toBe(true);
  });

  it('draws a constraint and its budget for constraint-night', () => {
    const p = buildPlan({ date: DATE, config, ledger: [], overrides: { compo: 'constraint-night' } });
    const compo = config.compos.find((c) => c.id === 'constraint-night')!;
    const c = compo.constraints!.find((x) => x.id === p.constraint);
    expect(c).toBeTruthy();
    expect(p.size_budget_bytes).toBe(c!.size_budget_bytes);
  });

  it('uses the compo budget when there is no constraint', () => {
    const p = buildPlan({ date: DATE, config, ledger: [], overrides: { compo: '4k-shader' } });
    expect(p.constraint).toBeNull();
    expect(p.size_budget_bytes).toBe(config.compos.find((c) => c.id === '4k-shader')!.size_budget_bytes);
  });
});
