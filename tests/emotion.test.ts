// Exercises the real agent-emotion-core engine (python3 affect_core.py) in temp folders. Nothing here touches the
// repo's state/ or audit/: every test passes its own <tmp>/state, so the engine log lands in <tmp>/audit.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main as cli } from '../harness/cli.js';
import {
  CREW_PERSONA,
  MOOD_PRESETS,
  applyAppraisalsToEngine,
  buildPresetMood,
  getEmotionContext,
  initEmotionState,
  moodFromEngine,
  recordVerdictFeedback,
  shelvedStreakBefore,
  stampEvents,
} from '../harness/emotion.js';
import { assertSchema } from '../harness/schema.js';
import type { EngineSummary } from '../harness/emotion.js';
import type { AppraisalEvent, Appraisals, LedgerEntry, Mood } from '../harness/types.js';

const REPO = resolve(__dirname, '..');
const DATE = '2026-11-22';
const root = mkdtempSync(join(tmpdir(), 'emotion-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh <tmp>/state with the crew persona. */
function freshState(): string {
  const stateDir = join(root, `case-${++n}`, 'state');
  initEmotionState({ stateDir, repoRoot: REPO });
  return stateDir;
}
const stateOf = (stateDir: string): Record<string, any> => JSON.parse(readFileSync(join(stateDir, 'emotion.json'), 'utf8'));
const logOf = (stateDir: string): Array<Record<string, any>> =>
  readFileSync(join(stateDir, '..', 'audit', 'emotion.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const emotionOf = (m: Mood, label: string): number => m.dominant_emotions.find((e) => e.label === label)?.intensity ?? 0;

const fact = (i: number, topic: string): AppraisalEvent => ({
  event: `Learned fact ${i} about ${topic}.`,
  event_id: `${DATE}:fact-${i}`,
  topics: [topic, 'raymarching'],
  relevance: 0.6,
  congruence: 0.4,
  novelty: 0.7,
  agency: 'circumstance',
  control: 0.7,
  certainty: 1,
  source: 'dossier',
  thread: DATE,
});

describe('initEmotionState and getEmotionContext', () => {
  it('creates state with the crew persona at <stateDir>/emotion.json and nothing else in state/', () => {
    const stateDir = freshState();
    expect(readdirSync(stateDir)).toEqual(['emotion.json']);
    const s = stateOf(stateDir);
    expect(s.agent).toBe('emotion');
    expect(s.persona.traits).toEqual(CREW_PERSONA.traits);
    expect(() => initEmotionState({ stateDir, repoRoot: REPO })).toThrow(/already exists/);
  });

  it('returns a non-empty <affect> block and never writes state', () => {
    const stateDir = freshState();
    const before = readFileSync(join(stateDir, 'emotion.json'), 'utf8');
    const ctx = getEmotionContext({ stateDir, repoRoot: REPO });
    expect(ctx).toMatch(/^<affect agent="emotion">/);
    expect(ctx).toMatch(/Mood:/);
    expect(getEmotionContext({ stateDir, repoRoot: REPO, brief: true }).length).toBeGreaterThan(20);
    expect(readFileSync(join(stateDir, 'emotion.json'), 'utf8')).toBe(before);
    expect(readdirSync(stateDir)).toEqual(['emotion.json']);
  });

  it('refuses to run against a missing state file instead of inventing a persona', () => {
    const stateDir = join(root, 'missing', 'state');
    expect(() => getEmotionContext({ stateDir, repoRoot: REPO })).toThrow(/initEmotionState/);
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe('stampEvents', () => {
  it('stamps deterministic ids and the night thread, and drops source', () => {
    const out = stampEvents([fact(1, 'starlings'), { event: 'No id here!' }], DATE);
    expect(out.map((e) => e.event_id)).toEqual([`${DATE}:1:fact-1`, `${DATE}:2:no-id-here`]);
    expect(out.every((e) => e.thread === `night-${DATE}` && !('source' in e))).toBe(true);
    expect(stampEvents([fact(1, 'starlings')], DATE)).toEqual(stampEvents([fact(1, 'starlings')], DATE));
    expect(stampEvents([{ event: 'x', event_id: 'y'.repeat(120) }], DATE)[0]!.event_id!.length).toBeLessThanOrEqual(128);
    expect(() => stampEvents([fact(1, 'a')], '22-11-2026')).toThrow(/YYYY-MM-DD/);
  });

  it('drops last-verdict and shelved-streak events (Stage 9 and the frustration formula own them) and the shelved-streak tag', () => {
    const verdict: AppraisalEvent = { ...fact(9, 'x'), event: 'Last night was shelved at 41.', event_id: `${DATE}:last-verdict`, topics: ['4k-shader'], agency: 'self', congruence: -0.7 };
    const streak: AppraisalEvent = { ...fact(9, 'x'), event: '2 nights in a row ended shelved.', event_id: `${DATE}:Shelved-Streak`, topics: ['shelved-streak'], agency: 'self', congruence: -0.7 };
    const tagOnly: AppraisalEvent = { event: 'Another streak.', topics: ['shelved-streak'], congruence: -0.7 };
    const tagged: AppraisalEvent = { ...fact(2, 'starlings'), topics: ['starlings', 'shelved-streak'] };
    const out = stampEvents([verdict, fact(1, 'starlings'), streak, tagOnly, tagged], DATE);
    expect(out.map((e) => e.event_id)).toEqual([`${DATE}:1:fact-1`, `${DATE}:2:fact-2`]);
    expect(out[1]!.topics).toEqual(['starlings']);
    expect(stampEvents([verdict, streak], DATE)).toEqual([]);
  });

  it('applies a batch whose events were all dropped without touching tastes', () => {
    const stateDir = freshState();
    const mood = applyAppraisalsToEngine({
      stateDir,
      repoRoot: REPO,
      appraisals: { events: [{ event: '3 nights in a row ended shelved.', event_id: `${DATE}:shelved-streak`, topics: ['shelved-streak'], relevance: 0.9, congruence: -0.85, agency: 'self' }] },
      date: DATE,
      shelvedStreak: 3,
      hoursAdvance: 0,
    });
    expect(stateOf(stateDir).seen_event_ids ?? []).toEqual([]);
    expect([...mood.likes, ...mood.dislikes].some((t) => t.topic === 'shelved-streak')).toBe(false);
  });

  it('moodFromEngine never reports shelved-streak as a like or dislike, even from older state', () => {
    const summary: EngineSummary = {
      mood: [-0.2, 0.1, 0],
      emotions: { distress: 0.4 },
      chem: { da: 0.5, ne: 0.5, sht: 0.5, cort: 0.4, oxt: 0.5, opi: 0.5 },
      drives: { novelty: 0.3, social: 0.3, fatigue: 0.2 },
      sentiments: {
        'topic:shelved-streak': { liking: -0.6, wanting: 0, episodes: 3 },
        'topic:moire': { liking: -0.3, wanting: 0, episodes: 1 },
      },
    };
    const mood = moodFromEngine(summary, 2, '2026-11-22T00:00:00.000Z');
    expect(mood.dislikes.map((d) => d.topic)).toEqual(['moire']);
    expect(mood.likes).toEqual([]);
  });
});

describe('applyAppraisalsToEngine', () => {
  it('updates state, returns schema-valid mood, stamps ids, and logs to <tmp>/audit', () => {
    const stateDir = freshState();
    const before = stateOf(stateDir);
    const mood = applyAppraisalsToEngine({
      stateDir,
      repoRoot: REPO,
      appraisals: { events: [fact(1, 'starlings'), fact(2, 'starlings')] },
      date: DATE,
      shelvedStreak: 2,
      hoursAdvance: 0,
    });
    assertSchema('mood', mood, REPO);
    expect(mood.preset_override).toBeNull();
    expect(mood.dominant_emotions[0]!.label).toBe('interest');
    expect(mood.derived_signals.interest).toBe(emotionOf(mood, 'interest'));
    const expected = 0.5 * 2 / 3 + 0.25 * mood.neurochemistry.cortisol + 0.25 * emotionOf(mood, 'distress');
    expect(mood.derived_signals.frustration).toBeCloseTo(expected, 2);
    expect(mood.likes.map((l) => l.topic)).toEqual(expect.arrayContaining(['starlings', 'raymarching']));
    expect(mood.likes.some((l) => /night-|dossier/.test(l.topic))).toBe(false);

    const after = stateOf(stateDir);
    expect(after.seen_event_ids).toEqual([`${DATE}:1:fact-1`, `${DATE}:2:fact-2`]);
    expect(Object.keys(after.threads)).toEqual([`night-${DATE}`]);
    expect(Object.keys(after.sentiments).some((k) => k.startsWith('agent:'))).toBe(false);
    expect(after.emotions).not.toEqual(before.emotions);
    expect(readdirSync(stateDir)).toEqual(['emotion.json']);
    expect(logOf(stateDir).map((l) => l.event_id)).toEqual([`${DATE}:1:fact-1`, `${DATE}:2:fact-2`]);
  });

  it('the same Haiku ids on a later night are still appraised (dates differ)', () => {
    const stateDir = freshState();
    const events = { events: [fact(1, 'starlings')] };
    applyAppraisalsToEngine({ stateDir, repoRoot: REPO, appraisals: events, date: DATE, shelvedStreak: 0, hoursAdvance: 0 });
    applyAppraisalsToEngine({ stateDir, repoRoot: REPO, appraisals: events, date: '2026-11-23', shelvedStreak: 0, hoursAdvance: 0 });
    expect(logOf(stateDir).map((l) => Object.keys(l.elicited).length > 0)).toEqual([true, true]);
  });

  it('dryRun leaves the real state file byte-identical and writes no log', () => {
    const stateDir = freshState();
    const before = readFileSync(join(stateDir, 'emotion.json'), 'utf8');
    const mood = applyAppraisalsToEngine({
      stateDir,
      repoRoot: REPO,
      appraisals: { events: [fact(1, 'starlings')] },
      date: DATE,
      shelvedStreak: 0,
      dryRun: true,
    });
    expect(emotionOf(mood, 'interest')).toBeGreaterThan(0.3);
    expect(readFileSync(join(stateDir, 'emotion.json'), 'utf8')).toBe(before);
    expect(existsSync(join(stateDir, '..', 'audit'))).toBe(false);
  });

  it('rejects appraisals that break the schema before calling the engine', () => {
    const stateDir = freshState();
    const bad = { events: [{ event: 'x', relevance: 2 }] } as unknown as Appraisals;
    expect(() => applyAppraisalsToEngine({ stateDir, repoRoot: REPO, appraisals: bad, date: DATE, shelvedStreak: 0 })).toThrow(/appraisals schema/);
    expect(() =>
      applyAppraisalsToEngine({ stateDir, repoRoot: REPO, appraisals: { events: [] }, date: DATE, shelvedStreak: 0 }),
    ).toThrow(/appraisals schema/);
  });

  it('presetOverride returns the preset and never touches state', () => {
    const stateDir = freshState();
    const before = readFileSync(join(stateDir, 'emotion.json'), 'utf8');
    const mood = applyAppraisalsToEngine({
      stateDir,
      repoRoot: REPO,
      appraisals: { events: [fact(1, 'x')] },
      date: DATE,
      shelvedStreak: 0,
      presetOverride: 'bored-restless',
    });
    expect(mood.preset_override).toBe('bored-restless');
    expect(readFileSync(join(stateDir, 'emotion.json'), 'utf8')).toBe(before);
  });

  it('habituation: after 5 repeats on one topic, the same probe elicits less interest and surprise than on a fresh state', () => {
    const repeated = freshState();
    applyAppraisalsToEngine({
      stateDir: repeated,
      repoRoot: REPO,
      appraisals: { events: [1, 2, 3, 4, 5].map((i) => fact(i, 'raymarching')) },
      date: DATE,
      shelvedStreak: 0,
      hoursAdvance: 0,
    });
    const s = stateOf(repeated);
    expect(s.threads[`night-${DATE}`].exposure).toBeCloseTo(0.75, 5);
    expect(s.emotion_adaptation.interest).toBeGreaterThan(0.5);
    const probe = { events: [fact(6, 'raymarching')] };
    applyAppraisalsToEngine({ stateDir: repeated, repoRoot: REPO, appraisals: probe, date: DATE, shelvedStreak: 0, hoursAdvance: 0 });
    const novel = freshState();
    applyAppraisalsToEngine({ stateDir: novel, repoRoot: REPO, appraisals: probe, date: DATE, shelvedStreak: 0, hoursAdvance: 0 });
    const habituated = logOf(repeated).at(-1)!.elicited;
    const fresh = logOf(novel).at(-1)!.elicited;
    expect(habituated.interest).toBeLessThan(fresh.interest);
    expect(habituated.surprise).toBeLessThan(fresh.surprise - 0.05);
  });

  it('24 simulated hours decay an aroused state toward baseline', () => {
    const stateDir = freshState();
    applyAppraisalsToEngine({
      stateDir,
      repoRoot: REPO,
      appraisals: { events: [{ event: 'A stunning discovery.', relevance: 1, congruence: 0.9, novelty: 1, control: 0.9, agency: 'circumstance' }] },
      date: DATE,
      shelvedStreak: 0,
      hoursAdvance: 0,
    });
    const baseArousal = stateOf(stateDir).baseline[1] as number;
    // The identical mild probe from the same state, with and without a day of decay; dryRun keeps the state fixed.
    const probe = { events: [{ event: 'A minor note.', relevance: 0.2, congruence: 0.1, novelty: 0.2, control: 0.5 }] };
    const now = applyAppraisalsToEngine({ stateDir, repoRoot: REPO, appraisals: probe, date: '2026-11-23', shelvedStreak: 0, hoursAdvance: 0, dryRun: true });
    const later = applyAppraisalsToEngine({ stateDir, repoRoot: REPO, appraisals: probe, date: '2026-11-23', shelvedStreak: 0, hoursAdvance: 24, dryRun: true });
    expect(emotionOf(later, 'interest')).toBeLessThan(emotionOf(now, 'interest') * 0.5);
    expect(emotionOf(later, 'surprise')).toBeLessThan(emotionOf(now, 'surprise'));
    expect(Math.abs(later.pad.arousal - baseArousal)).toBeLessThan(Math.abs(now.pad.arousal - baseArousal));
  });
});

describe('recordVerdictFeedback', () => {
  const feedback = (status: 'published' | 'b-side' | 'shelved') => {
    const stateDir = freshState();
    const r = recordVerdictFeedback({
      stateDir,
      repoRoot: REPO,
      date: DATE,
      status,
      score: status === 'published' ? 81 : status === 'b-side' ? 65 : 41,
      compo: '16k-demo',
      domain: 'bird-behaviour',
      techniqueFamily: 'agent-flocking',
      shelvedStreak: status === 'shelved' ? 1 : 0,
    });
    return { stateDir, ...r };
  };

  it('publish feels better than shelve, and consolidation persists the taste', () => {
    const pub = feedback('published');
    const bside = feedback('b-side');
    const shelf = feedback('shelved');
    assertSchema('mood', pub.mood, REPO);
    expect(pub.event).toMatchObject({ agency: 'self', topics: ['bird-behaviour', '16k-demo', 'agent-flocking'], event_id: `${DATE}:verdict:published` });
    expect(pub.elicited.pride).toBeGreaterThan(0.3);
    expect(pub.elicited.joy).toBeGreaterThan(0.3);
    expect(shelf.elicited.distress).toBeGreaterThan(0.2);
    expect(shelf.elicited.pride ?? 0).toBe(0);
    expect(pub.mood.pad.pleasure).toBeGreaterThan(bside.mood.pad.pleasure);
    expect(bside.mood.pad.pleasure).toBeGreaterThan(shelf.mood.pad.pleasure);
    expect(shelf.mood.derived_signals.frustration).toBeGreaterThan(pub.mood.derived_signals.frustration);
    expect(pub.mood.likes.map((l) => l.topic)).toContain('agent-flocking');
    expect(shelf.mood.dislikes.map((l) => l.topic)).toContain('agent-flocking');
    for (const { stateDir, consolidated } of [pub, shelf]) {
      expect(Object.keys(consolidated)).toContain('topic:agent-flocking');
      const rec = stateOf(stateDir).sentiments['topic:agent-flocking'];
      expect(rec.n).toBe(1);
      expect(rec.ep).toBeNull();
      expect(logOf(stateDir).map((l) => l.type)).toEqual(['appraise', 'consolidate']);
    }
    expect(stateOf(pub.stateDir).sentiments['topic:agent-flocking'].L).toBeGreaterThan(0);
    expect(stateOf(shelf.stateDir).sentiments['topic:agent-flocking'].L).toBeLessThan(0);
  });

  it('dryRun does not persist', () => {
    const stateDir = freshState();
    const before = readFileSync(join(stateDir, 'emotion.json'), 'utf8');
    recordVerdictFeedback({ stateDir, repoRoot: REPO, date: DATE, status: 'shelved', score: null, compo: 'simulation', domain: 'tides', dryRun: true });
    expect(readFileSync(join(stateDir, 'emotion.json'), 'utf8')).toBe(before);
  });
});

describe('shelvedStreakBefore', () => {
  it('counts consecutive shelved nights immediately before the date', () => {
    const row = (date: string, status: LedgerEntry['status']) => ({ date, status }) as LedgerEntry;
    const ledger = [row('2026-11-18', 'shelved'), row('2026-11-19', 'published'), row('2026-11-20', 'shelved'), row('2026-11-21', 'shelved'), row(DATE, 'shelved')];
    expect(shelvedStreakBefore(ledger, DATE)).toBe(2);
    expect(shelvedStreakBefore(ledger, '2026-11-20')).toBe(0);
    expect(shelvedStreakBefore([], DATE)).toBe(0);
  });
});

describe('MOOD_PRESETS', () => {
  const names = Object.keys(MOOD_PRESETS);
  const moods = Object.fromEntries(names.map((k) => [k, buildPresetMood(k, '2026-11-22T02:17:00Z', REPO)])) as Record<string, Mood>;
  const levels = (m: Mood) => {
    const c = m.creative_parameters;
    return [c.tempo_density_cut_rate.level, c.palette_warmth_consonance_symmetry.level, c.scale_contrast_camera.level, c.technical_risk_budget.level, c.boredom_force_unused_30d, c.frustration_scope_polish_weight.shrink_scope];
  };

  it('has the 5 named presets, each schema-valid', () => {
    expect(names).toEqual(['euphoric-high-arousal', 'melancholic-low-arousal', 'bored-restless', 'frustrated-tight-polish', 'curious-experimental']);
    for (const k of names) {
      assertSchema('mood', moods[k], REPO);
      expect(moods[k]!.preset_override).toBe(k);
    }
    expect(() => buildPresetMood('serene')).toThrow(/unknown mood preset/);
  });

  it('lands each preset in its intended creative bands', () => {
    expect(levels(moods['euphoric-high-arousal']!)).toEqual(['high', 'warm-consonant', 'assertive', 'experimental', false, false]);
    expect(levels(moods['melancholic-low-arousal']!)).toEqual(['low', 'cool-dissonant', 'intimate', 'conservative', false, false]);
    expect(levels(moods['bored-restless']!).slice(4)).toEqual([true, false]);
    const f = moods['frustrated-tight-polish']!.creative_parameters;
    expect(f.frustration_scope_polish_weight).toMatchObject({ shrink_scope: true, polish_weight_boost: 0.88 });
    expect(f.technical_risk_budget.level).toBe('conservative');
    expect(moods['curious-experimental']!.creative_parameters.technical_risk_budget).toMatchObject({ level: 'experimental', value: 0.95 });
  });

  it('every pair differs in its creative levels and in at least 2 creative values by 0.25 or more', () => {
    const values = (m: Mood) => {
      const c = m.creative_parameters;
      return [c.tempo_density_cut_rate.value, c.palette_warmth_consonance_symmetry.value, c.scale_contrast_camera.value, c.technical_risk_budget.value, c.frustration_scope_polish_weight.polish_weight_boost];
    };
    expect(new Set(names.map((k) => JSON.stringify(levels(moods[k]!)))).size).toBe(5);
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const va = values(moods[a]!);
        const vb = values(moods[b]!);
        expect(va.filter((v, i) => Math.abs(v - vb[i]!) >= 0.25).length, `${a} vs ${b}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('cli: emotion-context, feel, emotion-feedback', () => {
  const run = async (args: string[]): Promise<{ code: number; json: any }> => {
    let text = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((text += String(s)), true));
    try {
      const code = await cli([...args, '--repo-root', REPO]);
      return { code, json: JSON.parse(text) };
    } finally {
      spy.mockRestore();
    }
  };

  it('emotion-context prints the context as JSON', async () => {
    const stateDir = freshState();
    const { code, json } = await run(['emotion-context', '--state-dir', stateDir]);
    expect(code).toBe(0);
    expect(json.context).toMatch(/^<affect agent="emotion">/);
    expect((await run(['emotion-context', '--compact', '--state-dir', stateDir])).json.context).toMatch(/<affect/);
  });

  it('feel --preset prints and writes the preset mood without touching state', async () => {
    const outPath = join(root, 'preset-mood.json');
    const { code, json } = await run(['feel', '--date', DATE, '--preset', 'curious-experimental', '--out', outPath, '--state-dir', join(root, 'nope')]);
    expect(code).toBe(0);
    expect(json.preset_override).toBe('curious-experimental');
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual(json);
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });

  it('feel --appraisals runs the engine; --dry-run leaves state alone', async () => {
    const stateDir = freshState();
    const appraisalsPath = join(root, 'appraisals.json');
    writeFileSync(appraisalsPath, JSON.stringify({ events: [fact(1, 'starlings')] }));
    const before = readFileSync(join(stateDir, 'emotion.json'), 'utf8');
    const dry = await run(['feel', '--date', DATE, '--appraisals', appraisalsPath, '--shelved-streak', '0', '--dry-run', '--state-dir', stateDir]);
    expect(dry.code).toBe(0);
    assertSchema('mood', dry.json, REPO);
    expect(readFileSync(join(stateDir, 'emotion.json'), 'utf8')).toBe(before);
    const real = await run(['feel', '--date', DATE, '--appraisals', appraisalsPath, '--shelved-streak', '1', '--hours', '0', '--state-dir', stateDir]);
    expect(real.json.likes.map((l: { topic: string }) => l.topic)).toContain('starlings');
    expect(stateOf(stateDir).seen_event_ids).toEqual([`${DATE}:1:fact-1`]);
    await expect(run(['feel', '--date', DATE, '--state-dir', stateDir])).rejects.toThrow(/exactly one of/);
  });

  it('emotion-feedback appraises and consolidates the verdict', async () => {
    const stateDir = freshState();
    const { code, json } = await run([
      'emotion-feedback', '--date', DATE, '--status', 'published', '--score', '80', '--compo', 'audiovisual',
      '--domain', 'tides', '--technique-family', 'wave-modal', '--shelved-streak', '0', '--state-dir', stateDir,
    ]);
    expect(code).toBe(0);
    expect(json.elicited.pride).toBeGreaterThan(0.3);
    expect(json.consolidated['topic:wave-modal']).toBeGreaterThan(0);
    assertSchema('mood', json.mood, REPO);
    await expect(run(['emotion-feedback', '--date', DATE, '--status', 'meh', '--score', '1', '--compo', 'x', '--domain', 'y', '--state-dir', stateDir])).rejects.toThrow(/--status/);
  });
});

describe('repo hygiene', () => {
  it('the committed state/emotion.json is a clean crew init', () => {
    const s = JSON.parse(readFileSync(join(REPO, 'state', 'emotion.json'), 'utf8'));
    expect(s.agent).toBe('emotion');
    expect(s.persona.traits).toEqual(CREW_PERSONA.traits);
    expect(s.emotions).toEqual({});
    expect(readdirSync(join(REPO, 'state'))).toEqual(['emotion.json']);
  });

  it('never abbreviates agent-emotion-core', () => {
    for (const f of ['harness/emotion.ts', 'harness/cli.ts', 'tests/emotion.test.ts']) {
      expect(readFileSync(join(REPO, f), 'utf8'), f).not.toMatch(/\bemo\b/i);
    }
  });

  const hasMain = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'main'], { cwd: REPO }).status === 0;
  it.skipIf(!hasMain)('leaves the vendored skill untouched', () => {
    const r = spawnSync('git', ['diff', '--stat', 'main', '--', '.claude/skills/agent-emotion-core/'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
