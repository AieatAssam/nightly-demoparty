import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHardGates } from '../harness/gates.js';
import { checkNoveltyB, readLedger } from '../harness/novelty.js';
import { loadAllConfig } from '../harness/config.js';
import type { CompoId, GatesResult, RunGatesOptions } from '../harness/types.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIX = join(REPO, 'tests', 'fixtures');
const created: string[] = [];

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

async function gate(
  fixture: string,
  opts: { compo?: CompoId; timingScale?: number; constraint?: string | null; ledgerPath?: string; date?: string } = {},
): Promise<GatesResult> {
  const work = mkdtempSync(join(tmpdir(), 'gates-test-'));
  created.push(work);
  const input: RunGatesOptions = {
    piecePath: join(FIX, fixture),
    compo: opts.compo ?? '16k-demo',
    constraint: opts.constraint ?? null,
    outDir: join(work, 'out'),
    ledgerPath: opts.ledgerPath ?? join(work, 'missing', 'ledger.jsonl'),
    timingScale: opts.timingScale ?? 0.25,
    repoRoot: REPO,
    ...(opts.date ? { date: opts.date } : {}),
  };
  return runHardGates(input);
}

const names = (r: GatesResult): string[] => r.failures.map((f) => f.gate);

describe('runHardGates (fixtures)', () => {
  it('good.html passes every gate', async () => {
    const r = await gate('good.html');
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  }, 60_000);

  it('good.html passes at full timingScale 1', async () => {
    const r = await gate('good.html', { timingScale: 1 });
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  }, 120_000);

  it('no-reduced-motion.html fails only reduced_motion', async () => {
    const r = await gate('no-reduced-motion.html');
    expect(names(r)).toEqual(['reduced_motion']);
  }, 60_000);

  it('oversized.html fails only size', async () => {
    const r = await gate('oversized.html');
    expect(names(r)).toEqual(['size']);
  }, 60_000);

  it('static.html fails motion and development, not luminance', async () => {
    const r = await gate('static.html');
    expect(names(r)).toEqual(expect.arrayContaining(['motion', 'development']));
    expect(names(r)).not.toContain('luminance');
    expect(names(r)).not.toContain('strobe');
  }, 60_000);

  it('blank.html fails luminance, motion and development', async () => {
    const r = await gate('blank.html');
    expect(names(r)).toEqual(expect.arrayContaining(['luminance', 'motion', 'development']));
    expect(names(r)).not.toContain('strobe');
  }, 60_000);

  it('networked.html fails network, lint and console', async () => {
    const r = await gate('networked.html');
    expect(names(r)).toEqual(expect.arrayContaining(['network', 'lint', 'console']));
  }, 60_000);

  it('strobing.html fails strobe', async () => {
    const r = await gate('strobing.html');
    expect(names(r)).toContain('strobe');
  }, 60_000);

  it('slop-random.html fails lint', async () => {
    const r = await gate('slop-random.html');
    expect(names(r)).toContain('lint');
  }, 60_000);

  it('autoplay-audio.html (audiovisual) fails audio_autoplay', async () => {
    const r = await gate('autoplay-audio.html', { compo: 'audiovisual' });
    expect(names(r)).toContain('audio_autoplay');
  }, 60_000);

  it('good-audiovisual.html (audiovisual) passes with a passing audio probe', async () => {
    const r = await gate('good-audiovisual.html', { compo: 'audiovisual' });
    expect(r.failures).toEqual([]);
    expect(r.audio_probe?.passed).toBe(true);
  }, 60_000);

  it('evalpiece.html fails console under the canonical CSP even though it catches the error', async () => {
    const r = await gate('evalpiece.html');
    expect(names(r)).toEqual(expect.arrayContaining(['console', 'lint']));
    expect(r.console_errors.some((e) => /^CSP violation: script-src/.test(e))).toBe(true);
  }, 60_000);

  it('latestrobe.html (6 Hz from t = 6 s) fails strobe on the flash count', async () => {
    const r = await gate('latestrobe.html', { timingScale: 0.5 });
    expect(names(r)).toContain('strobe');
    expect(r.strobe.max_flashes_per_sec).toBeGreaterThan(3);
  }, 90_000);

  it('smallstrobe.html (6 Hz over ~15% of the viewport) fails strobe on the flash count', async () => {
    const r = await gate('smallstrobe.html');
    expect(names(r)).toContain('strobe');
    expect(r.strobe.max_flashes_per_sec).toBeGreaterThan(3);
  }, 60_000);

  it('passes date to Novelty Gate B so a same-date ledger row is not compared', async () => {
    const first = await gate('good.html');
    const work = mkdtempSync(join(tmpdir(), 'gates-ledger-'));
    created.push(work);
    const ledgerPath = join(work, 'ledger.jsonl');
    const row = {
      date: '2026-11-22', status: 'published', compo: '16k-demo', domain: 'oceanography', topic: null, concept: null,
      techniques: [], technique_family: null, palette: [], phashes: first.novelty_b.phashes,
      color_histogram: first.novelty_b.color_histogram, score: 80, attempts: 1, mood_pad: null, dominant_emotion: null,
    };
    writeFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
    const same = await gate('good.html', { ledgerPath, date: '2026-11-22' });
    expect(same.novelty_b.passed).toBe(true);
    expect(same.novelty_b.closest_date).toBeNull();
    // Without the date, the same screenshots collide with that row: the pass above is the date filter at work.
    const undated = checkNoveltyB({ phashes: same.novelty_b.phashes, colorHistogram: same.novelty_b.color_histogram, ledger: readLedger(ledgerPath), thresholds: loadAllConfig(REPO).thresholds.novelty_b });
    expect(undated.passed).toBe(false);
    expect(undated.closest_date).toBe('2026-11-22');
  }, 90_000);
});
