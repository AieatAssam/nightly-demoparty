// lib/easing.js: easing curves and a 20-second, 4-beat storyboard clock with reduced-motion scaling.

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (x) => (x = clamp01(x), x * x * (3 - 2 * x));
export const quintic = (x) => (x = clamp01(x), x * x * x * (x * (x * 6 - 15) + 10));
export const cubicInOut = (x) => (x = clamp01(x), x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const expoOut = (x) => (x = clamp01(x), x === 1 ? 1 : 1 - 2 ** (-10 * x));
/** Overshoots past 1 (by about 10% at s = 1.70158) and settles. */
export const backOut = (x, s = 1.70158) => (x = clamp01(x) - 1, 1 + x * x * ((s + 1) * x + s));
/** Springy settle onto 1. */
export const elasticOut = (x) => (x = clamp01(x), x === 0 || x === 1 ? x : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);

/** Progress 0..1 of the window [t0, t1] at time t, shaped by an easing curve. */
export const beat = (t, t0, t1, ease = smooth) => (t0 === t1 ? (t >= t1 ? 1 : 0) : ease((t - t0) / (t1 - t0)));

/** Default storyboard: 4 beats over 20 s. */
export const CUTS = [0, 5, 10, 15, 20];

/** Which beat t is in (0..3, held at 3 after the end) and its linear progress 0..1. */
export const act = (t, cuts = CUTS) => {
  let i = 0;
  while (i < cuts.length - 2 && t >= cuts[i + 1]) i++;
  return { i, p: clamp01((t - cuts[i]) / (cuts[i + 1] - cuts[i])) };
};

/** Per-beat weights that crossfade over `blend` seconds around each cut. They always sum to 1. */
export const acts = (t, cuts = CUTS, blend = 1) => {
  const up = (k) => (k === 0 ? 1 : k === cuts.length - 1 ? 0 : smooth((t - cuts[k]) / blend + 0.5));
  return cuts.slice(0, -1).map((_, k) => up(k) - up(k + 1));
};

/** rAF ms -> { t, reduced, i, p }. Never loops; reduced motion slows time to `reduce`. */
export const storyClock = ({ reduce = 0.2, cuts = CUTS } = {}) => {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  let t = 0, last = -1;
  return (ms) => {
    const reduced = mq.matches;
    t += last < 0 ? 0 : Math.min((ms - last) / 1000, 0.5) * (reduced ? reduce : 1);
    last = ms;
    return { t, reduced, ...act(t, cuts) };
  };
};
