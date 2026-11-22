import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAjv, normTechnique, SCHEMA_ID_BASE, validateBriefStrict, validateDossierStrict, validateSchema, validateVerdictStrict, wordCount } from '../harness/schema.js';
import { buildPlan } from '../harness/plan.js';
import { loadAllConfig } from '../harness/config.js';
import type { Brief, Dossier, Verdict } from '../harness/types.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const config = loadAllConfig(REPO);

const brief = (over: Record<string, unknown> = {}): Brief =>
  ({
    title: 'Slow Tide',
    concept: 'Tidal drift as blobs of light',
    mechanism_embodied: { mechanism_name: 'Tidal drift', how_visualised: 'Blobs follow sine paths over a slow background.' },
    discarded_obvious_idea: 'Plain sine plasma with palette cycling, too common.',
    compo: '16k-demo',
    constraint_honoured: null,
    techniques: ['radial gradient', 'sine drift'],
    novel_technique: 'sine drift',
    technique_family: 'procedural drift',
    palette: ['#0b0d12', '#ffcc66'],
    motion_sound_plan: 'Slow drift, no sound.',
    storyboard: [
      { beat: 1, t_start_s: 0, t_end_s: 5, description: 'Anchor disc alone.' },
      { beat: 2, t_start_s: 5, t_end_s: 10, description: 'Blobs enter.' },
      { beat: 3, t_start_s: 10, t_end_s: 15, description: 'Blobs cross.' },
      { beat: 4, t_start_s: 15, t_end_s: 20, description: 'Tide turns.' },
    ],
    memorable_moment: 'The anchor disc breathes under the blobs.',
    self_declared_risk: 'Colour may read muddy.',
    liner_note: 'A slow tide of light over one still disc.',
    ...over,
  }) as unknown as Brief;

const dossier = (over: Record<string, unknown> = {}): Dossier =>
  ({
    topic: 'Tides',
    domain: 'oceanography',
    wildcard_chosen: false,
    summary: 'Tides move water in long, regular swings.',
    facts: [
      { claim: 'Tides follow the moon.', source_url: 'https://alpha.example.org/a', source_title: 'A' },
      { claim: 'Spring tides are larger.', source_url: 'https://beta.example.net/b', source_title: 'B' },
      { claim: 'Neap tides are smaller.', source_url: 'https://gamma.example.com/c', source_title: 'C' },
      { claim: 'Tides vary by coast.', source_url: 'https://alpha.example.org/d', source_title: 'A2' },
      { claim: 'Tidal range differs.', source_url: 'https://beta.example.net/e', source_title: 'B2' },
    ],
    visualisable_mechanisms: [
      { name: 'Tidal drift', description: 'Water swings.', render_or_sonify_hint: 'Sine paths.' },
      { name: 'Spring cycle', description: 'Range grows.', render_or_sonify_hint: 'Radius.' },
      { name: 'Neap cycle', description: 'Range shrinks.', render_or_sonify_hint: 'Radius.' },
    ],
    open_questions: ['Does range vary by basin?', 'How fast do swings settle?'],
    surprise: { score: 40, justification: 'Common topic with a fresh angle.' },
    dataset: null,
    ...over,
  }) as unknown as Dossier;

const verdict = (over: Record<string, unknown> = {}): Verdict =>
  ({
    scores: { mechanism: 15, ambition: 20, craft: 20, distinctness: 15, polish: 8 },
    total: 78,
    evidence: {
      mechanism: 'The tidal swing is legible in the blobs at 8 s.',
      ambition: 'Three layers develop across the full twenty seconds.',
      craft: 'Gradients are soft and the palette holds together.',
      distinctness: 'Sine drift is not a common technique in the archive.',
      polish: 'Timing is even and nothing stutters.',
    },
    pairwise_beats_median: true,
    pairwise_median_ref: '2026-11-10',
    pairwise_justification: 'The drift reads more clearly than the median piece.',
    calibration_anchors_used: ['anchor-a', 'anchor-b', 'anchor-c', 'anchor-d'],
    critique: [
      { rank: 1, change: 'Make the blobs larger.', expected_gain: 3 },
      { rank: 2, change: 'Shift the palette.', expected_gain: 2 },
      { rank: 3, change: 'Tighten the ending.', expected_gain: 1 },
    ],
    ...over,
  }) as unknown as Verdict;

describe('schema registry', () => {
  it('loads all eleven schemas into one instance under the shared id base', () => {
    const files = readdirSync(join(REPO, 'schemas')).filter((f) => f.endsWith('.schema.json'));
    expect(files).toHaveLength(11);
    const ajv = getAjv(REPO);
    for (const f of files) {
      const name = f.replace('.schema.json', '');
      expect(ajv.getSchema(`${SCHEMA_ID_BASE}${f}`), name).toBeTruthy();
    }
  });

  it('rejects an unknown compo and accepts a plan built by buildPlan', () => {
    const plan = buildPlan({ date: '2026-11-22', config, ledger: [] });
    expect(validateSchema('plan', plan, REPO).ok).toBe(true);
    expect(validateSchema('plan', { ...plan, compo: 'bogus' }, REPO).ok).toBe(false);
  });
});

describe('dossier strict checks', () => {
  it('rejects a dossier over the 24576-byte cap', () => {
    const raw = JSON.stringify(dossier({ summary: 'x'.repeat(25000) }));
    const r = validateDossierStrict(raw, undefined, { repoRoot: REPO });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/over the 24576-byte cap/);
  });

  it('rejects a dossier citing fewer than three source hosts', () => {
    const d = dossier({ facts: dossier().facts.map((f) => ({ ...f, source_url: 'https://alpha.example.org/x' })) });
    const r = validateDossierStrict(JSON.stringify(d), undefined, { repoRoot: REPO });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/distinct source host/);
  });

  it('accepts a dossier with three hosts and a within-cap size', () => {
    const r = validateDossierStrict(JSON.stringify(dossier()), undefined, { repoRoot: REPO });
    expect(r.ok, r.ok ? '' : r.errors.join(' ')).toBe(true);
  });
});

describe('brief strict checks', () => {
  it('accepts a consistent brief', () => {
    const r = validateBriefStrict(brief(), null, null, { repoRoot: REPO });
    expect(r.ok, r.ok ? '' : r.errors.join(' ')).toBe(true);
  });

  it('flags a novel_technique that is not in techniques', () => {
    const r = validateBriefStrict(brief({ novel_technique: 'mystery trick' }), null, null, { repoRoot: REPO });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/not listed in techniques/);
  });

  it('flags a liner note over 120 words', () => {
    const long = Array.from({ length: 121 }, () => 'word').join(' ');
    const r = validateBriefStrict(brief({ liner_note: long }), null, null, { repoRoot: REPO });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/liner_note is 121 words/);
  });

  it('requires the storyboard to start at 0 s and end at 20 s', () => {
    const sb = brief().storyboard;
    const r = validateBriefStrict(brief({ storyboard: [...sb.slice(0, 3), { ...sb[3], t_end_s: 19 }] }), null, null, { repoRoot: REPO });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/must end at 20 s/);
  });
});

describe('verdict strict checks', () => {
  it('accepts a verdict whose total equals the score sum', () => {
    expect(validateVerdictStrict(verdict(), REPO).ok).toBe(true);
  });

  it('flags a total that does not equal the score sum', () => {
    const r = validateVerdictStrict(verdict({ total: 70 }), REPO);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/does not equal the score sum 78/);
  });

  it('flags critique ranks that are not 1, 2, 3', () => {
    const v = verdict();
    const r = validateVerdictStrict({ ...v, critique: [v.critique[0]!, v.critique[0]!, v.critique[2]!] } as Verdict, REPO);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/ranks must be 1, 2, 3/);
  });
});

describe('text helpers', () => {
  it('normalises technique names for comparison', () => {
    expect(normTechnique('  Radial   Gradient ')).toBe('radial gradient');
  });

  it('counts words, ignoring surrounding and repeated whitespace', () => {
    expect(wordCount('  one  two\tthree\n')).toBe(3);
    expect(wordCount('   ')).toBe(0);
  });
});
