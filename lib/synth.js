// lib/synth.js: gesture-gated WebAudio synth. One play(ctx, out, t0, t1, base) drives both live
// playback (startSynth) and the gate's offline probe (registerAudioProbe).

const srng = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** input -> dry + ping-pong delay -> compressor -> tanh limiter (peak <= 0.87) -> analyser -> out. */
export function synthBus(ctx, { delay = 0.3, feedback = 0.35, wet = 0.25 } = {}) {
  const gain = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const input = gain(1), sum = gain(1), w = gain(wet), fb = gain(feedback), dl = ctx.createDelay(2), dr = ctx.createDelay(2), mg = ctx.createChannelMerger(2);
  const comp = ctx.createDynamicsCompressor(), lim = ctx.createWaveShaper(), an = ctx.createAnalyser(), curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) curve[i] = 0.9 * Math.tanh(2 * (i / 511.5 - 1));
  lim.curve = curve; // oversample 'none': resampling could overshoot
  comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
  dl.delayTime.value = dr.delayTime.value = delay;
  input.connect(sum); input.connect(w).connect(dl).connect(dr).connect(fb).connect(dl);
  dl.connect(mg, 0, 0); dr.connect(mg, 0, 1); mg.connect(sum);
  sum.connect(comp).connect(lim).connect(an).connect(ctx.destination);
  an.fftSize = 1024;
  const fd = new Uint8Array(an.frequencyBinCount), td = new Float32Array(an.fftSize), sm = { bass: 0, mid: 0, high: 0, rms: 0 };
  let last = 0;
  const avg = (a, b) => {
    const hz = ctx.sampleRate / an.fftSize, i = Math.round(a / hz), j = Math.max(i + 1, Math.round(b / hz));
    let s = 0;
    for (let k = i; k < j; k++) s += fd[k];
    return s / (j - i) / 255;
  };
  const bands = () => {
    an.getByteFrequencyData(fd); an.getFloatTimeDomainData(td);
    let r = 0;
    for (const x of td) r += x * x;
    const v = { bass: avg(20, 250), mid: avg(250, 2000), high: avg(2000, 10000), rms: Math.min(1, Math.sqrt(r / td.length) * 2) };
    const dt = Math.max(0, ctx.currentTime - last);
    last = ctx.currentTime;
    for (const k in sm) sm[k] = v[k] + (sm[k] - v[k]) * Math.exp(-dt / (v[k] > sm[k] ? 0.05 : 0.25));
    return { ...sm };
  };
  return { input, analyser: an, bands };
}

const env = (ctx, t, a, d, peak) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(1e-4, t + a + d);
  return g;
};

/** FM voice; modulation index decays over dur. */
export function fm(ctx, out, t, f, dur = 0.4, { ratio = 2, index = 3, vol = 0.3 } = {}) {
  const c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain(), g = env(ctx, t, 0.005, dur, vol);
  c.frequency.value = f; m.frequency.value = f * ratio;
  mg.gain.setValueAtTime(f * index, t); mg.gain.exponentialRampToValueAtTime(f * index * 0.05 + 1e-3, t + dur);
  m.connect(mg).connect(c.frequency); c.connect(g).connect(out);
  for (const o of [c, m]) { o.start(t); o.stop(t + dur + 0.05); }
}

/** Subtractive voice: lowpass sweeps from cutoff down to f. */
export function sub(ctx, out, t, f, dur = 0.3, { cutoff = 1800, q = 6, vol = 0.25, type = 'sawtooth' } = {}) {
  const o = ctx.createOscillator(), bq = ctx.createBiquadFilter(), g = env(ctx, t, 0.005, dur, vol);
  o.type = type; o.frequency.value = f; bq.type = 'lowpass'; bq.Q.value = q;
  bq.frequency.setValueAtTime(cutoff, t); bq.frequency.exponentialRampToValueAtTime(Math.max(60, f), t + dur);
  o.connect(bq).connect(g).connect(out);
  o.start(t); o.stop(t + dur + 0.05);
}

/** Karplus-Strong samples from a seeded noise burst. */
export function ksBuffer(sr, f, dur = 1, seed = 1, damp = 0.996) {
  const n = Math.max(2, Math.round(sr / f)), d = new Float32Array(Math.ceil(sr * dur)), r = srng(seed);
  for (let i = 0; i < n && i < d.length; i++) d[i] = r() * 2 - 1;
  for (let i = n; i < d.length; i++) d[i] = damp * 0.5 * (d[i - n] + d[i - n + 1]);
  return d;
}

/** Plucked string voice. */
export function pluck(ctx, out, t, f, dur = 1, { vol = 0.4, seed = 1, damp = 0.996 } = {}) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate), s = ctx.createBufferSource(), g = ctx.createGain();
  b.copyToChannel(ksBuffer(ctx.sampleRate, f, dur, seed, damp), 0);
  s.buffer = b; g.gain.value = vol;
  s.connect(g).connect(out); s.start(t);
}

/** Step sequencer -> play(). step() runs once per step in [t0, t1) with a per-step seeded rnd. */
export const seq = ({ bpm = 120, div = 4, seed = 1 } = {}, step) => (ctx, out, t0, t1, base = 0) => {
  const dt = 60 / bpm / div;
  for (let i = Math.max(0, Math.ceil(t0 / dt - 1e-9)); i * dt < t1; i++) step(ctx, out, base + i * dt, i, srng(seed ^ Math.imul(i + 1, 0x9e3779b1)));
};

/** Live playback from the first pointerdown/keydown on target; nothing exists before it. */
export function startSynth(play, { target = document, ahead = 0.2, bus } = {}) {
  const h = { ctx: null, bus: null, bands: () => ({ bass: 0, mid: 0, high: 0, rms: 0 }) };
  const go = () => {
    if (h.ctx) return void h.ctx.resume();
    const ctx = (h.ctx = new AudioContext()), b = (h.bus = synthBus(ctx, bus)), base = ctx.currentTime + 0.05;
    let done = 0;
    h.bands = b.bands;
    const tick = () => { const t1 = ctx.currentTime - base + ahead; if (t1 > done) { play(ctx, b.input, done, t1, base); done = t1; } };
    tick();
    setInterval(tick, 50);
  };
  for (const e of ['pointerdown', 'keydown']) target.addEventListener(e, go);
  return h;
}

/** window.__demopartyAudioProbe: play() over the whole offline context from t = 0. */
export const registerAudioProbe = (play, bus) => {
  window.__demopartyAudioProbe = async (ctx) => play(ctx, synthBus(ctx, bus).input, 0, ctx.length / ctx.sampleRate, 0);
};
