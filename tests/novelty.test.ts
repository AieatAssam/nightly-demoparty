import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkNoveltyA,
  checkNoveltyB,
  conceptSimilarity,
  deltaE,
  hammingDistanceHex,
  histogramDistanceL1,
  hexToLab,
  jaccard,
  nightsBefore,
  paletteDistance,
  readLedger,
  wordShingles,
} from '../harness/novelty.js';
import { loadAllConfig } from '../harness/config.js';
import type { Brief, LedgerEntry, Plan } from '../harness/types.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const th = loadAllConfig(REPO).thresholds;
const DATE = '2026-11-22';
const offset = (date: string, nights: number): string => {
  const t = Date.parse(`${date}T00:00:00Z`) - nights * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

const row = (date: string, over: Record<string, unknown> = {}): LedgerEntry =>
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

const brief = (over: Partial<Brief> = {}): Brief =>
  ({
    concept: 'Glass tides rolling over a dark coast',
    techniques: ['radial gradient', 'sine drift'],
    novel_technique: 'sine drift',
    palette: ['#0b0d12', '#ffcc66'],
    ...over,
  }) as unknown as Brief;

const plan = (over: Partial<Plan> = {}): Plan =>
  ({
    date: DATE,
    banned: { techniques: [], domains: [], palette_hexes: [], slop_patterns: [] },
    ...over,
  }) as unknown as Plan;

describe('set and text similarity', () => {
  it('jaccard is 1 for equal sets and 0 for disjoint ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('wordShingles builds overlapping word trigrams by default', () => {
    expect(wordShingles('a b c d', 3)).toEqual(new Set(['a b c', 'b c d']));
  });

  it('conceptSimilarity is high for near-identical concepts and low for unrelated ones', () => {
    expect(conceptSimilarity('glass tides over a dark coast', 'glass tides over a dark coast')).toBeGreaterThan(0.9);
    expect(conceptSimilarity('glass tides over a dark coast', 'pollen counts in a greenhouse')).toBeLessThan(0.2);
  });
});

describe('colour', () => {
  it('hexToLab puts white near L=100 and black near L=0', () => {
    expect(hexToLab('#ffffff')[0]).toBeCloseTo(100, 0);
    expect(hexToLab('#000000')[0]).toBeCloseTo(0, 0);
  });

  it('deltaE is 0 for the same colour and about 100 for black against white', () => {
    expect(deltaE('#336699', '#336699')).toBeCloseTo(0, 6);
    expect(deltaE('#000000', '#ffffff')).toBeGreaterThan(95);
  });

  it('paletteDistance is 0 for identical palettes', () => {
    expect(paletteDistance(['#0b0d12', '#ffcc66'], ['#0b0d12', '#ffcc66'])).toBeCloseTo(0, 6);
  });
});

describe('perceptual and histogram distances', () => {
  it('hammingDistanceHex counts differing bits and refuses mismatched lengths', () => {
    expect(hammingDistanceHex('ff', '00')).toBe(8);
    expect(hammingDistanceHex('ff', 'ff')).toBe(0);
    expect(hammingDistanceHex('ff', 'ffff')).toBeNull();
  });

  it('histogramDistanceL1 is 0 for identical histograms', () => {
    const h = [0.25, 0.25, 0.5];
    expect(histogramDistanceL1(h, h)).toBe(0);
  });
});

describe('nightsBefore window', () => {
  it('includes the previous nights up to the window and excludes the date itself', () => {
    const ledger = [row(DATE), row(offset(DATE, 1)), row(offset(DATE, 7)), row(offset(DATE, 8))];
    const dates = nightsBefore(ledger, DATE, 7).map((e) => e.date);
    expect(dates).toEqual([offset(DATE, 1), offset(DATE, 7)]);
  });
});

describe('readLedger', () => {
  it('returns an empty list for a missing file', () => {
    expect(readLedger(join(tmpdir(), 'demoparty-no-such-ledger.jsonl'), REPO)).toEqual([]);
  });

  it('parses valid rows and names the line of a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demoparty-ledger-'));
    try {
      const good = join(dir, 'good.jsonl');
      writeFileSync(good, `${JSON.stringify(row(offset(DATE, 1)))}\n`);
      expect(readLedger(good, REPO)).toHaveLength(1);

      const bad = join(dir, 'bad.jsonl');
      writeFileSync(bad, `${JSON.stringify(row(offset(DATE, 1)))}\nnot json\n`);
      expect(() => readLedger(bad, REPO)).toThrow(/bad\.jsonl:2: invalid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Novelty Gate A', () => {
  it('passes a brief with no overlap with the archive', () => {
    const r = checkNoveltyA({ brief: brief(), plan: plan(), ledger: [], thresholds: th.novelty_a });
    expect(r.passed).toBe(true);
    expect(r.collisions).toEqual([]);
  });

  it('flags a technique on tonight\'s banned list', () => {
    const r = checkNoveltyA({
      brief: brief(),
      plan: plan({ banned: { techniques: ['Radial Gradient'], domains: [], palette_hexes: [], slop_patterns: [] } } as unknown as Partial<Plan>),
      ledger: [],
      thresholds: th.novelty_a,
    });
    expect(r.collisions.map((c) => c.kind)).toContain('technique_banned');
  });

  it('flags a novel_technique that an earlier night already used', () => {
    const ledger = [row(offset(DATE, 30), { techniques: ['Sine Drift'] })];
    const r = checkNoveltyA({ brief: brief(), plan: plan(), ledger, thresholds: th.novelty_a });
    expect(r.collisions.map((c) => c.kind)).toContain('novel_technique_not_novel');
  });

  it('flags technique overlap at or above the Jaccard limit within 21 nights', () => {
    const ledger = [row(offset(DATE, 2), { techniques: ['radial gradient', 'sine drift'] })];
    const r = checkNoveltyA({ brief: brief(), plan: plan(), ledger, thresholds: th.novelty_a });
    expect(r.collisions.map((c) => c.kind)).toContain('technique_jaccard');
  });

  it('flags a near-identical palette within 7 nights', () => {
    const ledger = [row(offset(DATE, 3), { palette: ['#0b0d12', '#ffcc66'] })];
    const r = checkNoveltyA({ brief: brief(), plan: plan(), ledger, thresholds: th.novelty_a });
    expect(r.collisions.map((c) => c.kind)).toContain('palette_distance');
  });
});

describe('Novelty Gate B', () => {
  const far = { t2: 'ffffffffffffffff', t8: 'ffffffffffffffff', t20: 'ffffffffffffffff' };
  const hist = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

  it('passes when the screenshots are far from every archived hash and histogram', () => {
    const ledger = [row(offset(DATE, 1), { phashes: { t2: '0000000000000000', t8: '0000000000000000', t20: '0000000000000000' }, color_histogram: Array.from({ length: 64 }, (_, i) => (i === 63 ? 1 : 0)) })];
    const r = checkNoveltyB({ phashes: far, colorHistogram: hist, ledger, thresholds: th.novelty_b, date: DATE });
    expect(r.passed).toBe(true);
    expect(r.min_hamming_distance).toBe(64);
  });

  it('fails when a hash is identical to an archived one', () => {
    const ledger = [row(offset(DATE, 1), { phashes: far })];
    const r = checkNoveltyB({ phashes: far, colorHistogram: hist, ledger, thresholds: th.novelty_b, date: DATE });
    expect(r.passed).toBe(false);
    expect(r.min_hamming_distance).toBe(0);
    expect(r.closest_date).toBe(offset(DATE, 1));
  });

  it('fails when the colour histogram matches a piece in the last 14 nights', () => {
    const ledger = [row(offset(DATE, 4), { color_histogram: hist })];
    const r = checkNoveltyB({ phashes: { t2: '0000000000000000', t8: '0000000000000000', t20: '0000000000000000' }, colorHistogram: hist, ledger, thresholds: th.novelty_b, date: DATE });
    expect(r.passed).toBe(false);
    expect(r.min_histogram_distance).toBe(0);
  });

  it('closest_date is the row nearest relative to its threshold, histogram or hash', () => {
    const zero = { t2: '0000000000000000', t8: '0000000000000000', t20: '0000000000000000' };
    const near = Array.from({ length: 64 }, (_, i) => (i === 0 ? 0.8 : i === 1 ? 0.2 : 0)); // distance 0.2, just above 0.18
    const ledger = [
      row(offset(DATE, 2), { phashes: { t2: '00000000ffffffff', t8: null, t20: null } }), // hamming 32: ratio 3.2
      row(offset(DATE, 3), { color_histogram: near }), // ratio 1.11
    ];
    const pass = checkNoveltyB({ phashes: zero, colorHistogram: hist, ledger, thresholds: th.novelty_b, date: DATE });
    expect(pass.passed).toBe(true);
    expect(pass.closest_date).toBe(offset(DATE, 3));

    ledger.push(row(offset(DATE, 5), { phashes: { t2: '000000000000001f', t8: null, t20: null } }), row(offset(DATE, 6), { color_histogram: hist }));
    const fail = checkNoveltyB({ phashes: zero, colorHistogram: hist, ledger, thresholds: th.novelty_b, date: DATE });
    expect(fail.passed).toBe(false);
    expect(fail.min_hamming_distance).toBe(5);
    expect(fail.closest_date).toBe(offset(DATE, 6)); // histogram ratio 0 beats hamming ratio 0.5
  });

  it('ignores a same-date row when date is passed (gate rerun on the same night)', () => {
    const ledger = [row(DATE, { phashes: far, color_histogram: hist })];
    const r = checkNoveltyB({ phashes: far, colorHistogram: hist, ledger, thresholds: th.novelty_b, date: DATE });
    expect(r.passed).toBe(true);
    expect(r.min_hamming_distance).toBeNull();
    expect(r.closest_date).toBeNull();
  });
});
