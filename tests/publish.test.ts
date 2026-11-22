import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { buildEmotionEvent, publishNight, type PublishAttempt, type PublishInput } from '../harness/publish.js';
import { buildPlan } from '../harness/plan.js';
import { loadAllConfig } from '../harness/config.js';
import { CANONICAL_CSP } from '../harness/lint.js';
import type { Brief, Dossier, GatesResult, LedgerEntry, Mood, Plan, Verdict } from '../harness/types.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const config = loadAllConfig(REPO);
const DATE = '2026-11-22';

const brief = (): Brief =>
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
  }) as unknown as Brief;

const dossier = (): Dossier =>
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
  }) as unknown as Dossier;

const mood = (): Mood =>
  ({
    timestamp: '2026-11-22T08:00:00Z',
    preset_override: null,
    dominant_emotions: [{ label: 'interest', intensity: 0.6 }],
    pad: { pleasure: 0.2, arousal: 0.1, dominance: 0.3 },
    neurochemistry: { dopamine: 0.5, noradrenaline: 0.4, serotonin: 0.5, cortisol: 0.2, oxytocin: 0.3, opioids: 0.3 },
    drives: { novelty: 0.6, social: 0.3, fatigue: 0.2 },
    derived_signals: { interest: 0.6, boredom: 0.1, frustration: 0.1 },
    likes: [{ topic: 'tides', score: 0.8 }],
    dislikes: [{ topic: 'plasma', score: -0.6 }],
    creative_parameters: {
      tempo_density_cut_rate: { level: 'medium', value: 0.5, guidance: 'Moderate tempo.' },
      palette_warmth_consonance_symmetry: { level: 'balanced', value: 0.2, guidance: 'Balanced palette.' },
      scale_contrast_camera: { level: 'measured', value: 0.3, guidance: 'Measured camera.' },
      technical_risk_budget: { level: 'moderate', value: 0.4, guidance: 'Moderate risk.' },
      boredom_force_unused_30d: false,
      frustration_scope_polish_weight: { shrink_scope: false, polish_weight_boost: 0.3, guidance: 'Normal polish.' },
    },
  }) as unknown as Mood;

const PIECE = `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><script>const a = 1;</script></body></html>`;
const HEX = (n: number) => n.toString(16).padStart(16, '0');

const verdict = (total = 78): Verdict =>
  ({
    scores: { mechanism: 15, ambition: 20, craft: 20, distinctness: 15, polish: 8 },
    total,
    evidence: {
      mechanism: 'The tidal swing is legible in the blobs at 8 s.',
      ambition: 'Three layers develop across the full twenty seconds.',
      craft: 'Gradients are soft and the palette holds together.',
      distinctness: 'Sine drift is not a common technique in the archive.',
      polish: 'Timing is even and nothing stutters.',
    },
    pairwise_beats_median: true,
    pairwise_median_ref: null,
    pairwise_justification: 'The drift reads more clearly than the median piece.',
    calibration_anchors_used: ['anchor-a', 'anchor-b', 'anchor-c', 'anchor-d'],
    critique: [
      { rank: 1, change: 'Make the blobs larger.', expected_gain: 3 },
      { rank: 2, change: 'Shift the palette.', expected_gain: 2 },
      { rank: 3, change: 'Tighten the ending.', expected_gain: 1 },
    ],
  }) as unknown as Verdict;

const gates = (passed: boolean, failures: Array<{ gate: string; message: string; measured: number | string; threshold: number | string }> = []): GatesResult =>
  ({
    passed,
    piece_path: 'work/index.html',
    compo: '16k-demo',
    byte_size: 2704,
    size_budget_bytes: 16384,
    console_errors: [],
    network_requests: [],
    luminance_variance: { t2: 500, t8: 500, t20: 500, floor: 12, passed: true },
    motion: { frame_diff_mean: 6, frame_diff_floor: 0.8, development_diff_t2_t20: 14, development_floor: 2.5, passed: true },
    strobe: { max_flashes_per_sec: 0, limit: 3, passed: true },
    frame_time_ms: { median: 33, p90: 34, budget_ms: 250, passed: true },
    audio_probe: null,
    novelty_b: {
      phashes: { t2: HEX(0x383c2e0f), t8: HEX(0x46260e0d), t20: HEX(0x1c185d4f) },
      color_histogram: Array.from({ length: 64 }, () => 1 / 64),
      min_hamming_distance: null,
      min_histogram_distance: null,
      closest_date: null,
      passed: true,
    },
    slop_lint: { passed: true, violations: [] },
    reduced_motion: { passed: true, normal_motion: 7, reduced_motion: 1, ratio: 0.14 },
    screenshots: { t2: 'work/shot-02s.png', t8: 'work/shot-08s.png', t20: 'work/shot-20s.png' },
    failures,
  }) as unknown as GatesResult;

const png = (): Buffer => {
  const p = new PNG({ width: 4, height: 4 });
  p.data.fill(128);
  return PNG.sync.write(p);
};

let root: string;
let plan: Plan;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'demoparty-publish-'));
  cpSync(join(REPO, 'schemas'), join(root, 'schemas'), { recursive: true });
  mkdirSync(join(root, 'work'), { recursive: true });
  writeFileSync(join(root, 'work', 'index.html'), PIECE);
  for (const n of ['02s', '08s', '20s']) writeFileSync(join(root, 'work', `shot-${n}.png`), png());
  plan = buildPlan({ date: DATE, config, ledger: [] });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const base = (over: Partial<PublishInput> = {}): PublishInput => ({
  status: 'published',
  reason: null,
  publishThreshold: 72,
  plan,
  dossier: dossier(),
  mood: mood(),
  brief: brief(),
  attempts: [{ attempt: 1, model: 'test-model', effort: null, gates: gates(true), verdict: verdict(78) } satisfies PublishAttempt],
  bestAttempt: 1,
  repoRoot: root,
  ...over,
});

const ledgerRows = (file: string): LedgerEntry[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry) : [];

describe('publishNight: published', () => {
  it('writes the piece with the canonical CSP, screenshots, meta and one ledger row', () => {
    const r = publishNight(base());
    const piece = join(root, 'site', 'pieces', DATE, 'index.html');
    expect(readFileSync(piece, 'utf8')).toContain(CANONICAL_CSP);
    for (const n of ['02s', '08s', '20s']) expect(existsSync(join(root, 'site', 'pieces', DATE, `shot-${n}.png`))).toBe(true);
    expect(r.meta.status).toBe('published');
    expect(r.meta.piece_rel_path).toBe(`pieces/${DATE}/index.html`);
    expect(r.written).toHaveLength(6);
    const rows = ledgerRows(join(root, 'ledger', 'ledger.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(78);
    expect(rows[0]!.status).toBe('published');
  });

  it('refuses a second ledger row for the same date', () => {
    publishNight(base());
    expect(() => publishNight(base())).toThrow(/already has a row for 2026-11-22/);
  });

  it('refuses to publish when the best attempt failed the hard gates', () => {
    expect(() => publishNight(base({ attempts: [{ attempt: 1, model: 'm', effort: null, gates: gates(false, [{ gate: 'motion', message: 'static', measured: 0, threshold: 0.8 }]), verdict: verdict() }] }))).toThrow(/passed the hard gates/);
  });

  it('records the attempt outcome in meta', () => {
    const r = publishNight(base());
    expect(r.meta.attempts[0]!.outcome).toBe('passed');
  });
});

describe('publishNight: shelved', () => {
  it('writes meta and a ledger row without screenshots, piece or hashes', () => {
    const r = publishNight(
      base({
        status: 'shelved',
        reason: 'No attempt passed the hard gates.',
        bestAttempt: null,
        attempts: [{ attempt: 1, model: 'm', effort: null, gates: gates(false, [{ gate: 'motion', message: 'static', measured: 0, threshold: 0.8 }]), verdict: null }],
      }),
    );
    expect(r.meta.screenshots).toBeNull();
    expect(r.meta.piece_rel_path).toBeNull();
    expect(existsSync(join(root, 'site', 'pieces', DATE, 'index.html'))).toBe(false);
    const row = ledgerRows(join(root, 'ledger', 'ledger.jsonl'))[0]!;
    expect(row.phashes).toEqual({ t2: null, t8: null, t20: null });
    expect(row.color_histogram).toBeNull();
    expect(row.score).toBeNull();
  });

  it('requires a non-empty reason', () => {
    expect(() => publishNight(base({ status: 'shelved', reason: '  ', bestAttempt: null, attempts: [] }))).toThrow(/needs a non-empty reason/);
  });
});

describe('publishNight: dry run', () => {
  it('writes only under outputDir and leaves the repo ledger untouched', () => {
    const out = join(root, 'dry');
    publishNight(base({ dryRun: true, outputDir: out }));
    expect(existsSync(join(out, 'ledger', 'ledger.jsonl'))).toBe(true);
    expect(existsSync(join(out, 'site', 'pieces', DATE, 'meta.json'))).toBe(true);
    expect(existsSync(join(root, 'ledger', 'ledger.jsonl'))).toBe(false);
    expect(existsSync(join(root, 'site'))).toBe(false);
  });

  it('requires outputDir for a dry run', () => {
    expect(() => publishNight(base({ dryRun: true }))).toThrow(/dryRun requires outputDir/);
  });

  it('treats plan.dry_run as a dry run even without the flag', () => {
    const dryPlan = { ...plan, dry_run: true };
    expect(() => publishNight(base({ plan: dryPlan }))).toThrow(/dryRun requires outputDir/);
    const out = join(root, 'dry');
    publishNight(base({ plan: dryPlan, outputDir: out }));
    expect(existsSync(join(out, 'ledger', 'ledger.jsonl'))).toBe(true);
    expect(existsSync(join(root, 'ledger', 'ledger.jsonl'))).toBe(false);
    expect(existsSync(join(root, 'site'))).toBe(false);
  });
});

describe('buildEmotionEvent', () => {
  it('describes a publish with positive congruence', () => {
    const e = buildEmotionEvent('published', DATE, null, '16k-demo', 78, null, root);
    expect(e.event).toMatch(/published .*78/);
    expect(e.congruence).toBeGreaterThan(0);
    expect(e.topics).toEqual(['16k-demo']);
  });

  it('describes a shelved night with negative congruence and the reason', () => {
    const e = buildEmotionEvent('shelved', DATE, null, '16k-demo', null, 'nothing passed', root);
    expect(e.event).toBe('Nothing was released tonight: nothing passed');
    expect(e.congruence).toBeLessThan(0);
  });

  it('keeps the event text within 300 characters', () => {
    const e = buildEmotionEvent('shelved', DATE, null, '16k-demo', null, 'x'.repeat(500), root);
    expect(e.event.length).toBeLessThanOrEqual(300);
  });
});
