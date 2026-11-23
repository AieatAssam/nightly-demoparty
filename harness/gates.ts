// Stage 6 hard gates: Playwright + headless Chromium (SwiftShader). Writes gates.json and screenshots.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AUDIO_INIT_SCRIPT, probeAudioOnPage, type AudioProbeOutcome } from './audio-probe.js';
import { loadAllConfig } from './config.js';
import {
  FLASH_AREA_FRACTION,
  averageHistograms,
  blankImage,
  computeColorHistogram64,
  computeDHash64,
  computeLuminanceVariance,
  computeMeanAbsDiff,
  decodePng,
  encodePng,
  flashGrid,
  gridMaxLumDelta,
  maxFlashesPerSecondFromGrids,
  type DecodedImage,
  type FlashGrid,
} from './image-metrics.js';
import { injectOrVerifyCsp, lintPieceHtml } from './lint.js';
import { checkNoveltyB, readLedger } from './novelty.js';
import { assertSchema } from './schema.js';
import type { GateFailure, GatesResult, RepoConfig, RunGatesOptions } from './types.js';

export const PIECE_ORIGIN = 'http://piece.local';
export const PIECE_URL = `${PIECE_ORIGIN}/index.html`;
export const VIEWPORT = { width: 1280, height: 720 };
export const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  // Lets an autoplaying piece actually play, so AUDIO_INIT_SCRIPT hears it instead of Chromium muting it.
  '--autoplay-policy=no-user-gesture-required',
  // Linux containers ship a tiny /dev/shm; use /tmp so large captures do not crash the renderer.
  '--disable-dev-shm-usage',
];

const PAIR_GAP_MS = 250; // real time between motion-pair frames; never scaled
const CALL_TIMEOUT_MS = 15000; // 1280x720 SwiftShader PNG captures on a 4-vCPU Linux runner need headroom
/** Below this screencast rate a 3 Hz flash limit cannot be resolved (Nyquist: 2 transitions per flash). */
const STROBE_MIN_FPS = 14;

/**
 * rAF frame timestamps (frame-time gate), CSP-blocked URLs (network gate) and every CSP violation
 * (eval, string timers, blocked fonts, workers, data: fetches...) for the console gate. Chromium logs
 * repeated violations to the console only once, so the listener is the complete record.
 * WebRTC is outside CSP, so touching it is recorded too.
 */
const GATES_INIT_SCRIPT = `(() => {
  const w = window;
  const raf = w.requestAnimationFrame.bind(w);
  const stamps = [];
  w.__demopartyRaf = stamps;
  const loop = (t) => { if (stamps.length < 5000) stamps.push(t); raf(loop); };
  raf(loop);
  const blocked = [];
  const violations = [];
  w.__demopartyBlocked = blocked;
  w.__demopartyViolations = violations;
  const note = (s) => { if (violations.length < 50 && !violations.includes(s)) violations.push(s); };
  w.addEventListener('securitypolicyviolation', (e) => {
    const uri = e.blockedURI || '';
    if (/^(https?|wss?|ftp):/i.test(uri)) blocked.push(uri);
    note('CSP violation: ' + (e.effectiveDirective || e.violatedDirective) + ' blocked ' + (uri || 'inline'));
  }, true);
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    if (k in w) Object.defineProperty(w, k, { configurable: false, get() { note('WebRTC: ' + k + ' accessed'); return undefined; } });
  }
})();`;


const round = (x: number, dp = 4): number => (Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : 0);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0];
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function resolveCompoDefaults(config: RepoConfig, opts: RunGatesOptions): { budget: number; requiresAudio: boolean } {
  const entry = config.compos.find((c) => c.id === opts.compo);
  let budget = opts.sizeBudgetBytes;
  if (budget === undefined && opts.constraint) {
    const k = entry?.constraints?.find((c) => c.id === opts.constraint || c.label === opts.constraint);
    budget = k?.size_budget_bytes;
  }
  budget ??= entry?.size_budget_bytes;
  if (!budget || budget < 1) throw new Error(`runHardGates: no size budget for compo ${opts.compo} (constraint ${opts.constraint ?? 'none'})`);
  return { budget, requiresAudio: opts.requiresAudio ?? entry?.requires_audio ?? false };
}

/** One browser context with network lockdown, init scripts and error capture. The piece is served under the publish CSP. */
async function openPiece(
  browser: Browser,
  html: string,
  reducedMotion: 'reduce' | 'no-preference',
  consoleErrors: string[],
  network: Set<string>,
): Promise<{ context: BrowserContext; page: Page; nodeMsAtPageZero: number }> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === PIECE_URL) {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: injectOrVerifyCsp(html) });
      return;
    }
    if (url !== `${PIECE_ORIGIN}/favicon.ico`) network.add(url);
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, (ws) => {
    network.add(ws.url());
    void ws.close();
  });
  await context.addInitScript({ content: GATES_INIT_SCRIPT });
  await context.addInitScript({ content: AUDIO_INIT_SCRIPT });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(PIECE_URL, { waitUntil: 'load', timeout: 15000 });
  // Map the page clock (performance.now(), zero at navigation start) onto Node's clock once,
  // so later waits keep working even if the piece blocks its main thread.
  const before = Date.now();
  const pageNow = await withTimeout(page.evaluate(() => performance.now()), CALL_TIMEOUT_MS, 'page clock read');
  const nodeMsAtPageZero = (before + Date.now()) / 2 - pageNow;
  return { context, page, nodeMsAtPageZero };
}

async function shoot(page: Page): Promise<DecodedImage> {
  return decodePng(await page.screenshot({ type: 'png', timeout: CALL_TIMEOUT_MS, animations: 'allow', caret: 'initial' }));
}

/** rAF stamps, CSP-blocked URLs and violations recorded by GATES_INIT_SCRIPT. */
async function readPageState(page: Page): Promise<{ stamps: number[]; blocked: string[]; violations: string[] }> {
  return withTimeout(
    page.evaluate(() => {
      const w = window as unknown as { __demopartyRaf?: number[]; __demopartyBlocked?: string[]; __demopartyViolations?: string[] };
      return { stamps: w.__demopartyRaf ?? [], blocked: w.__demopartyBlocked ?? [], violations: w.__demopartyViolations ?? [] };
    }),
    CALL_TIMEOUT_MS,
    'page state read',
  );
}

/**
 * Starts a CDP screencast (frames arrive on paint, ~25-60 fps on SwiftShader). Each frame is reduced
 * to its 64x36 flash grid on arrival, so a 20 s run keeps a few MB, never raw PNGs. Call the returned
 * function to stop and get the grids.
 */
async function startScreencast(page: Page): Promise<() => Promise<FlashGrid[]>> {
  const cdp = await page.context().newCDPSession(page);
  const grids: FlashGrid[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    // Ack before decoding so the next frame is not held back by our processing.
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    try {
      grids.push(flashGrid(decodePng(Buffer.from(f.data, 'base64')), (f.metadata.timestamp ?? Date.now() / 1000) * 1000));
    } catch {
      // undecodable frame: skip it
    }
  });
  const detach = () => withTimeout(cdp.detach(), CALL_TIMEOUT_MS, 'CDP detach').catch(() => undefined);
  try {
    await withTimeout(cdp.send('Page.startScreencast', { format: 'png', maxWidth: 128, maxHeight: 72, everyNthFrame: 1 }), CALL_TIMEOUT_MS, 'startScreencast');
  } catch (e) {
    await detach();
    throw e;
  }
  return async () => {
    try {
      await withTimeout(cdp.send('Page.stopScreencast'), CALL_TIMEOUT_MS, 'stopScreencast');
    } finally {
      await detach();
    }
    return grids.sort((a, b) => a.tMs - b.tMs);
  };
}

/**
 * Screencast rate vs the page's rAF rate over the active window (first to last frame that changed).
 * Null when no frame changed. Rates are frames per second.
 */
function samplingRates(grids: FlashGrid[], rafEpochMs: number[]): { fps: number; rafFps: number; spanMs: number } | null {
  let first = -1;
  let last = -1;
  for (let k = 1; k < grids.length; k++) {
    if (gridMaxLumDelta(grids[k - 1]!, grids[k]!) > 0) {
      if (first < 0) first = k - 1;
      last = k;
    }
  }
  if (first < 0) return null;
  const a = grids[first]!.tMs;
  const b = grids[last]!.tMs;
  const spanS = Math.max(b - a, 1) / 1000;
  const raf = rafEpochMs.filter((t) => t >= a && t <= b).length;
  return { fps: (last - first) / spanS, rafFps: Math.max(0, raf - 1) / spanS, spanMs: b - a };
}

export async function runHardGates(opts: RunGatesOptions): Promise<GatesResult> {
  const config = loadAllConfig(opts.repoRoot);
  const repoRoot = config.repoRoot;
  const g = config.thresholds.gates;
  const piecePath = resolve(repoRoot, opts.piecePath);
  const outDir = resolve(repoRoot, opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const scale = opts.timingScale && Number.isFinite(opts.timingScale) && opts.timingScale > 0 ? opts.timingScale : 1;
  const { budget, requiresAudio } = resolveCompoDefaults(config, opts);
  const html = readFileSync(piecePath, 'utf8');

  // --- static checks -------------------------------------------------------
  // Builder output may omit the CSP (publish injects it). Size is its own gate, so size/* rules are dropped here.
  const lint = lintPieceHtml(html, { sizeBudgetBytes: budget, slopRules: config.slop.static_rules, constraint: opts.constraint ?? null });
  const byteSize = Buffer.byteLength(html, 'utf8');
  const lintViolations = lint.violations.filter((v) => !v.rule.startsWith('size/')).map((v) => ({ rule: v.rule, detail: v.detail }));

  // --- browser probes (each one isolated; nothing short-circuits) ------------
  const consoleErrors: string[] = [];
  const network = new Set<string>();
  const harnessErr = (what: string, e: unknown) => consoleErrors.push(`harness: ${what} failed: ${errText(e)}`);
  const shots: { t2: DecodedImage; t8: DecodedImage; t20: DecodedImage } = { t2: blankImage(), t8: blankImage(), t20: blankImage() };
  const pairDiffs: number[] = [];
  const t2Diffs: number[] = [];
  const t8Diffs: number[] = [];
  let strobeGrids: FlashGrid[] = [];
  let sampling: ReturnType<typeof samplingRates> = null;
  let rafDeltas: number[] = [];
  let quietMs = 0;
  let audio: AudioProbeOutcome | null = null;
  let audioError: string | null = null;
  let reducedRan = false;
  let reducedMotion = 0;
  let reducedLumVar = 0;
  const recordState = (st: { blocked: string[]; violations: string[] }) => {
    for (const u of st.blocked) network.add(u);
    for (const v of st.violations) if (!consoleErrors.includes(v)) consoleErrors.push(v);
  };

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });

    // Main run on the 2 / 8 / 20 s schedule.
    try {
      const { page, nodeMsAtPageZero } = await openPiece(browser, html, 'no-preference', consoleErrors, network);
      const until = (pageMs: number) => sleep(nodeMsAtPageZero + pageMs - Date.now());
      const pageNow = () => Date.now() - nodeMsAtPageZero;
      const quiet: Array<[number, number]> = [];

      const sample = async (key: 't2' | 't8' | 't20', atMs: number, extra: number, into: number[][]) => {
        await until(atMs);
        try {
          const frames = [await shoot(page)];
          shots[key] = frames[0];
          for (let i = 0; i < extra; i++) {
            await sleep(PAIR_GAP_MS);
            frames.push(await shoot(page));
          }
          for (let i = 1; i < frames.length; i++) {
            const d = computeMeanAbsDiff(frames[i - 1], frames[i]);
            for (const arr of into) arr.push(d);
          }
        } catch (e) {
          harnessErr(`screenshot at ${key}`, e);
        }
      };

      // The strobe screencast covers the whole timeline (~0.5 s to past t20), so a late-onset strobe is caught.
      await until(500 * scale);
      let stopScreencast: (() => Promise<FlashGrid[]>) | null = null;
      try {
        stopScreencast = await startScreencast(page);
      } catch (e) {
        harnessErr('strobe screencast', e);
      }
      await sample('t2', 2000 * scale, 2, [pairDiffs, t2Diffs]);
      quiet.push([pageNow() + 100, 8000 * scale - 50]);
      await sample('t8', 8000 * scale, 1, [pairDiffs, t8Diffs]);
      quiet.push([pageNow() + 100, 20000 * scale - 50]);
      await sample('t20', 20000 * scale, 1, [pairDiffs]);
      try {
        if (stopScreencast) strobeGrids = await stopScreencast();
      } catch (e) {
        harnessErr('strobe screencast', e);
      }

      try {
        const st = await readPageState(page);
        recordState(st);
        const stamps = st.stamps;
        sampling = samplingRates(strobeGrids, stamps.map((t) => t + nodeMsAtPageZero));
        const inQuiet = (t: number) => quiet.some(([a, b]) => t >= a && t <= b);
        const all: number[] = [];
        for (let i = 1; i < stamps.length; i++) {
          const d = stamps[i] - stamps[i - 1];
          all.push(d);
          if (inQuiet(stamps[i - 1]) && inQuiet(stamps[i])) rafDeltas.push(d);
        }
        if (rafDeltas.length < 5) rafDeltas = all; // short scaled runs leave little quiet time
        quietMs = quiet.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
      } catch (e) {
        harnessErr('frame stamp read', e);
      }

      try {
        audio = await probeAudioOnPage(page, requiresAudio, g);
      } catch (e) {
        audioError = errText(e);
      }
      await withTimeout(page.context().close(), CALL_TIMEOUT_MS, 'context close').catch(() => undefined);
    } catch (e) {
      harnessErr('main page run', e);
    }

    // prefers-reduced-motion run, same lockdown and listeners.
    try {
      const { page, nodeMsAtPageZero } = await openPiece(browser, html, 'reduce', consoleErrors, network);
      // Sampled at t2 and t8, so a calm intro cannot hide an ignored preference.
      const at = async (pageMs: number): Promise<{ lumVar: number; motion: number }> => {
        await sleep(nodeMsAtPageZero + pageMs - Date.now());
        const frames: DecodedImage[] = [];
        for (let i = 0; i < 3; i++) {
          if (i) await sleep(PAIR_GAP_MS);
          frames.push(await shoot(page));
        }
        return { lumVar: computeLuminanceVariance(frames[0]), motion: mean([computeMeanAbsDiff(frames[0], frames[1]), computeMeanAbsDiff(frames[1], frames[2])]) };
      };
      const r2 = await at(2000 * scale);
      const r8 = await at(8000 * scale);
      reducedLumVar = Math.min(r2.lumVar, r8.lumVar);
      reducedMotion = Math.max(r2.motion, r8.motion);
      reducedRan = true;
      try {
        recordState(await readPageState(page));
      } catch (e) {
        harnessErr('reduced-motion page state read', e);
      }
      await withTimeout(page.context().close(), CALL_TIMEOUT_MS, 'context close').catch(() => undefined);
    } catch (e) {
      harnessErr('reduced-motion run', e);
    }
  } catch (e) {
    harnessErr('browser launch', e);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  // --- screenshots to disk ------------------------------------------------------
  const shotPaths = { t2: join(outDir, 'shot-02s.png'), t8: join(outDir, 'shot-08s.png'), t20: join(outDir, 'shot-20s.png') };
  for (const k of ['t2', 't8', 't20'] as const) writeFileSync(shotPaths[k], encodePng(shots[k]));

  // --- measurements -----------------------------------------------------------
  const failures: GateFailure[] = [];
  const fail = (gate: GateFailure['gate'], message: string, measured: number | string, threshold: number | string) =>
    failures.push({ gate, message, measured: typeof measured === 'number' ? round(measured) : measured, threshold });

  const sizeOk = byteSize <= budget;
  if (!sizeOk) fail('size', `index.html is ${byteSize} bytes, over the ${budget} byte budget`, byteSize, budget);

  const slopOk = lintViolations.length === 0;
  if (!slopOk) fail('lint', lintViolations.map((v) => `${v.rule}: ${v.detail}`).join('; '), lintViolations.length, 0);

  if (consoleErrors.length) fail('console', `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 5).join(' | ')}`, consoleErrors.length, 0);
  const networkRequests = [...network];
  if (networkRequests.length) fail('network', `blocked request(s): ${networkRequests.slice(0, 10).join(', ')}`, networkRequests.length, 0);

  const lumVar = { t2: computeLuminanceVariance(shots.t2), t8: computeLuminanceVariance(shots.t8), t20: computeLuminanceVariance(shots.t20) };
  const lumOk = Math.min(lumVar.t2, lumVar.t8, lumVar.t20) >= g.luminance_variance_min;
  if (!lumOk) {
    const low = (['t2', 't8', 't20'] as const).filter((k) => lumVar[k] < g.luminance_variance_min);
    fail('luminance', `luminance variance below floor at ${low.join(', ')} (${low.map((k) => round(lumVar[k], 2)).join(', ')})`, Math.min(lumVar.t2, lumVar.t8, lumVar.t20), g.luminance_variance_min);
  }

  const frameDiffMean = mean(pairDiffs);
  const developmentDiff = computeMeanAbsDiff(shots.t2, shots.t20);
  const frameDiffOk = frameDiffMean >= g.frame_diff_min;
  const developmentOk = developmentDiff >= g.development_diff_min;
  if (!frameDiffOk) fail('motion', `mean frame-to-frame difference ${round(frameDiffMean, 3)} is below ${g.frame_diff_min}: the piece looks static`, frameDiffMean, g.frame_diff_min);
  if (!developmentOk) fail('development', `t=2s vs t=20s difference ${round(developmentDiff, 3)} is below ${g.development_diff_min}: the piece does not develop`, developmentDiff, g.development_diff_min);

  const flashes = maxFlashesPerSecondFromGrids(strobeGrids);
  // Screencast frames arrive on paint, so a low rate is only a problem when the page itself ran much
  // faster (frames dropped). An animating piece with no changed frame at all means the capture missed it.
  // ponytail: a piece that animates via setInterval at < 14 updates/s but keeps rAF at 60 fails closed here;
  // count real paints (tracing) if such pieces show up.
  const undersampled = frameDiffOk && (sampling === null || (sampling.fps < STROBE_MIN_FPS && sampling.fps < 0.5 * sampling.rafFps));
  const strobeOk = flashes <= g.max_flashes_per_sec && !undersampled;
  if (flashes > g.max_flashes_per_sec) fail('strobe', `${flashes} flashes per second over ${round(FLASH_AREA_FRACTION * 100, 1)}% of the screen (limit ${g.max_flashes_per_sec})`, flashes, g.max_flashes_per_sec);
  else if (undersampled) {
    const how = sampling ? `${round(sampling.fps, 1)} fps while the page ran at ${round(sampling.rafFps, 1)} fps` : 'no changed frames captured from an animating piece';
    fail('strobe', `strobe check could not sample the piece densely enough (${how}, need ${STROBE_MIN_FPS} fps)`, sampling ? round(sampling.fps, 1) : 0, STROBE_MIN_FPS);
  }

  const sortedDeltas = [...rafDeltas].sort((a, b) => a - b);
  // No rAF frame at all during the run means the main thread was blocked the whole time.
  const ftMedian = sortedDeltas.length ? quantile(sortedDeltas, 0.5) : Math.max(quietMs, g.frame_time_median_budget_ms + 1);
  const ftP90 = sortedDeltas.length ? quantile(sortedDeltas, 0.9) : ftMedian;
  const frameTimeOk = sortedDeltas.length > 0 && ftMedian <= g.frame_time_median_budget_ms;
  if (!sortedDeltas.length) fail('frame_time', 'no animation frames were measured: the main thread appears blocked', ftMedian, g.frame_time_median_budget_ms);
  else if (!frameTimeOk) fail('frame_time', `median frame time ${round(ftMedian, 1)} ms (p90 ${round(ftP90, 1)} ms) over the ${g.frame_time_median_budget_ms} ms budget`, ftMedian, g.frame_time_median_budget_ms);

  let audioProbe: GatesResult['audio_probe'] = audio?.result ?? null;
  if (!audio && requiresAudio) {
    audioProbe = { required: true, autoplayed: false, rms: 0, peak: 0, clipped_ratio: 0, passed: false };
  }
  if (audioProbe) {
    audioProbe = { ...audioProbe, rms: round(audioProbe.rms, 6), peak: round(audioProbe.peak, 6), clipped_ratio: round(audioProbe.clipped_ratio, 6) };
    if (audioProbe.autoplayed) fail('audio_autoplay', 'audio started before any user gesture', 'autoplayed', 'no sound before gesture');
    if (audioProbe.required) {
      const why = audioError ?? audio?.error;
      if (why) fail('audio_probe', `audio probe failed: ${why}`, 'error', 'probe completes');
      else if (audioProbe.rms < g.audio_rms_min) fail('audio_probe', `audio is silent: rms ${audioProbe.rms} (${audio?.method} probe)`, audioProbe.rms, g.audio_rms_min);
      else if (audioProbe.peak > g.audio_peak_max) fail('audio_probe', `audio clips: peak ${audioProbe.peak}, ${round(audioProbe.clipped_ratio * 100, 2)}% of samples clipped`, audioProbe.peak, g.audio_peak_max);
      else if (audioProbe.clipped_ratio > g.audio_clipped_ratio_max) fail('audio_probe', `audio clips: ${round(audioProbe.clipped_ratio * 100, 2)}% of samples clipped`, audioProbe.clipped_ratio, g.audio_clipped_ratio_max);
    }
  }

  const phashes = { t2: computeDHash64(shots.t2), t8: computeDHash64(shots.t8), t20: computeDHash64(shots.t20) };
  const colorHistogram = averageHistograms([computeColorHistogram64(shots.t2), computeColorHistogram64(shots.t8), computeColorHistogram64(shots.t20)]).map((v) => round(v, 6));
  const ledgerPath = resolve(repoRoot, opts.ledgerPath ?? 'ledger/ledger.jsonl');
  const ledger = existsSync(ledgerPath) ? readLedger(ledgerPath) : [];
  const nb = config.thresholds.novelty_b;
  const novelty = checkNoveltyB({ phashes, colorHistogram, ledger, thresholds: nb, ...(opts.date ? { date: opts.date } : {}) });
  if (!novelty.passed) {
    const vs = novelty.closest_date ? ` (closest: ${novelty.closest_date})` : '';
    const hamFail = novelty.min_hamming_distance !== null && novelty.min_hamming_distance < nb.phash_min_hamming;
    const histFail = novelty.min_histogram_distance !== null && novelty.min_histogram_distance < nb.histogram_min_distance;
    if (hamFail) fail('novelty_phash', `screenshots look like an archived piece${vs}: hamming distance ${novelty.min_hamming_distance}`, novelty.min_hamming_distance!, nb.phash_min_hamming);
    if (histFail) fail('novelty_histogram', `colour histogram matches a recent piece${vs}: distance ${round(novelty.min_histogram_distance!)}`, novelty.min_histogram_distance!, nb.histogram_min_distance);
    if (!hamFail && !histFail) fail('novelty_phash', `novelty gate B failed${vs}`, 'failed', 'novel');
  }

  const normalMotion = Math.max(mean(t2Diffs), mean(t8Diffs));
  const ratio = reducedMotion / Math.max(normalMotion, 1e-3);
  const reducedNotBlank = reducedLumVar >= g.luminance_variance_min * 0.5;
  const reducedOk = reducedRan && reducedNotBlank && (reducedMotion <= g.reduced_motion_abs_max || ratio <= g.reduced_motion_ratio_max);
  if (!reducedOk) {
    if (!reducedRan) fail('reduced_motion', 'reduced-motion run did not complete', 'error', 'completes');
    else if (!reducedNotBlank) fail('reduced_motion', `reduced-motion variant is blank (luminance variance ${round(reducedLumVar, 2)})`, reducedLumVar, g.luminance_variance_min * 0.5);
    else fail('reduced_motion', `prefers-reduced-motion is not honoured: motion ${round(reducedMotion, 3)} vs normal ${round(normalMotion, 3)} (ratio ${round(ratio, 3)}, max ${g.reduced_motion_ratio_max}, or absolute <= ${g.reduced_motion_abs_max})`, ratio, g.reduced_motion_ratio_max);
  }

  const result = {
    passed: failures.length === 0,
    piece_path: relative(repoRoot, piecePath) || piecePath,
    compo: opts.compo,
    byte_size: byteSize,
    size_budget_bytes: budget,
    console_errors: consoleErrors,
    network_requests: networkRequests,
    luminance_variance: { t2: round(lumVar.t2), t8: round(lumVar.t8), t20: round(lumVar.t20), floor: g.luminance_variance_min, passed: lumOk },
    motion: {
      frame_diff_mean: round(frameDiffMean),
      frame_diff_floor: g.frame_diff_min,
      development_diff_t2_t20: round(developmentDiff),
      development_floor: g.development_diff_min,
      passed: frameDiffOk && developmentOk,
    },
    strobe: { max_flashes_per_sec: flashes, limit: g.max_flashes_per_sec, passed: strobeOk },
    frame_time_ms: { median: round(ftMedian, 2), p90: round(ftP90, 2), budget_ms: g.frame_time_median_budget_ms, passed: frameTimeOk },
    audio_probe: audioProbe,
    novelty_b: {
      phashes,
      color_histogram: colorHistogram,
      min_hamming_distance: novelty.min_hamming_distance,
      min_histogram_distance: novelty.min_histogram_distance === null ? null : round(novelty.min_histogram_distance, 6),
      closest_date: novelty.closest_date,
      passed: novelty.passed,
    },
    slop_lint: { passed: slopOk, violations: lintViolations },
    reduced_motion: { passed: reducedOk, normal_motion: round(normalMotion), reduced_motion: round(reducedMotion), ratio: round(ratio) },
    screenshots: { t2: relative(repoRoot, shotPaths.t2), t8: relative(repoRoot, shotPaths.t8), t20: relative(repoRoot, shotPaths.t20) },
    failures,
  };

  // Validate what will actually be on disk (NaN/Infinity would silently become null).
  const onDisk = assertSchema<GatesResult>('gates', JSON.parse(JSON.stringify(result)), repoRoot);
  writeFileSync(join(outDir, 'gates.json'), `${JSON.stringify(onDisk, null, 2)}\n`);
  return onDisk;
}
