// Audio checks for Stage 6: autoplay detection (init script) and level/clipping probe.
import type { Page } from 'playwright';

/**
 * Injected with `addInitScript` before the piece runs. Chromium is launched with
 * `--autoplay-policy=no-user-gesture-required`, so a piece that tries to autoplay really
 * plays, and this script hears it.
 *
 * Autoplay rule: the piece autoplays when audible samples reach any AudioContext's
 * destination, or a media element starts playing unmuted, before `__demopartyUserGesture`.
 * A context that merely exists (and reads `running` under the permissive policy) but stays
 * silent until the click is not autoplay.
 *
 * Every `connect(ctx.destination)` also connects the source to a per-context AnalyserNode tap,
 * so the live fallback probe can measure pieces that do not expose `__demopartyAudioProbe`.
 */
export const AUDIO_INIT_SCRIPT = `(() => {
  const w = window;
  const st = { contexts: 0, media: false, autoplayed: false };
  w.__demopartyAudioState = st;
  w.__demopartyUserGesture = false;
  const taps = [];
  w.__demopartyAudioTaps = taps;
  document.addEventListener('play', (e) => {
    st.media = true;
    const el = e.target;
    if (!w.__demopartyUserGesture && el && !el.muted && el.volume > 0) st.autoplayed = true;
  }, true);
  const AC = w.AudioContext || w.webkitAudioContext;
  if (!AC) return;
  class DemopartyAudioContext extends AC {
    constructor(...args) { super(...args); st.contexts++; }
  }
  w.AudioContext = DemopartyAudioContext;
  if (w.webkitAudioContext) w.webkitAudioContext = DemopartyAudioContext;
  const origConnect = AudioNode.prototype.connect;
  const tapFor = (ctx) => {
    if (!ctx.__demopartyTap) {
      const a = ctx.createAnalyser();
      a.fftSize = 32768;
      ctx.__demopartyTap = a;
      taps.push(a);
    }
    return ctx.__demopartyTap;
  };
  AudioNode.prototype.connect = function (dest, ...rest) {
    const result = origConnect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode && !(dest.context instanceof OfflineAudioContext)) {
        origConnect.call(this, tapFor(dest.context), rest[0] || 0);
      }
    } catch (_) {}
    return result;
  };
  const buf = new Float32Array(32768);
  const timer = setInterval(() => {
    if (w.__demopartyUserGesture) { clearInterval(timer); return; }
    for (const a of taps) {
      a.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > 1e-4) { st.autoplayed = true; break; }
    }
  }, 250);
})();`;

export interface AudioProbeResult {
  required: boolean;
  autoplayed: boolean;
  rms: number;
  peak: number;
  clipped_ratio: number;
  passed: boolean;
}

export interface AudioLimits {
  audio_rms_min: number;
  audio_peak_max: number;
  audio_clipped_ratio_max: number;
}

export interface AudioProbeOutcome {
  /** Null when the piece makes no sound, did not autoplay, and audio is not required. */
  result: AudioProbeResult | null;
  method: 'offline' | 'live';
  error: string | null;
}

interface Levels {
  rms: number;
  peak: number;
  clipped_ratio: number;
}

const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

/**
 * Run after every screenshot is taken, because the live path clicks the page.
 * A: read the pre-gesture autoplay state. B: measure levels, preferring the deterministic
 * OfflineAudioContext probe (`window.__demopartyAudioProbe(ctx)`, 2 s at 44.1 kHz), falling
 * back to a real click plus the destination tap.
 */
export async function probeAudioOnPage(page: Page, required: boolean, limits: AudioLimits): Promise<AudioProbeOutcome> {
  const clip = limits.audio_peak_max;
  const pre = await timeout(
    page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const st = (w.__demopartyAudioState ?? { contexts: 0, media: false, autoplayed: false }) as { contexts: number; media: boolean; autoplayed: boolean };
      return { ...st, hasProbe: typeof w.__demopartyAudioProbe === 'function' };
    }),
    5000,
    'audio state read',
  );

  let levels: Levels = { rms: 0, peak: 0, clipped_ratio: 0 };
  let error: string | null = null;
  let method: AudioProbeOutcome['method'] = 'live';
  let audioSeen = pre.contexts > 0 || pre.media || pre.hasProbe;

  try {
    if (pre.hasProbe) {
      method = 'offline';
      levels = await timeout(
        page.evaluate(async (clipLevel) => {
          const w = window as unknown as { __demopartyAudioProbe: (ctx: OfflineAudioContext) => unknown };
          const ctx = new OfflineAudioContext(1, 44100 * 2, 44100);
          await w.__demopartyAudioProbe(ctx);
          const d = (await ctx.startRendering()).getChannelData(0);
          let sq = 0;
          let peak = 0;
          let clipped = 0;
          for (let i = 0; i < d.length; i++) {
            const a = Math.abs(d[i]);
            sq += d[i] * d[i];
            if (a > peak) peak = a;
            if (a >= clipLevel) clipped++;
          }
          return { rms: Math.sqrt(sq / d.length), peak, clipped_ratio: clipped / d.length };
        }, clip),
        15000,
        'OfflineAudioContext probe',
      );
    } else {
      await timeout(
        page.evaluate(() => {
          (window as unknown as { __demopartyUserGesture: boolean }).__demopartyUserGesture = true;
        }),
        5000,
        'gesture flag write',
      );
      await timeout(page.mouse.click(640, 360), 5000, 'gesture click');
      await page.waitForTimeout(600);
      const reads: number[][] = [];
      for (let i = 0; i < 3; i++) {
        if (i) await page.waitForTimeout(750); // fftSize 32768 covers ~0.7 s, so 3 reads cover ~2 s
        reads.push(
          ...(await timeout(
            page.evaluate(() => {
              const taps = ((window as unknown as { __demopartyAudioTaps?: AnalyserNode[] }).__demopartyAudioTaps ?? []);
              return taps.map((a) => {
                const b = new Float32Array(a.fftSize);
                a.getFloatTimeDomainData(b);
                return Array.from(b);
              });
            }),
            5000,
            'live audio tap read',
          )),
        );
      }
      const post = await timeout(
        page.evaluate(() => {
          const st = (window as unknown as { __demopartyAudioState?: { contexts: number; media: boolean } }).__demopartyAudioState;
          return { contexts: st?.contexts ?? 0, media: st?.media ?? false };
        }),
        5000,
        'audio state read',
      );
      audioSeen ||= post.contexts > 0 || post.media;
      let sq = 0;
      let peak = 0;
      let clipped = 0;
      let n = 0;
      for (const r of reads) {
        for (const s of r) {
          const a = Math.abs(s);
          sq += s * s;
          if (a > peak) peak = a;
          if (a >= clip) clipped++;
          n++;
        }
      }
      if (n) levels = { rms: Math.sqrt(sq / n), peak, clipped_ratio: clipped / n };
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!required && !audioSeen && !pre.autoplayed && !error) return { result: null, method, error };

  const levelsOk =
    !error &&
    levels.rms >= limits.audio_rms_min &&
    levels.peak <= limits.audio_peak_max &&
    levels.clipped_ratio <= limits.audio_clipped_ratio_max;
  return {
    result: {
      required,
      autoplayed: pre.autoplayed,
      rms: levels.rms,
      peak: levels.peak,
      clipped_ratio: Math.min(1, levels.clipped_ratio),
      passed: !pre.autoplayed && (!required || levelsOk),
    },
    method,
    error,
  };
}
