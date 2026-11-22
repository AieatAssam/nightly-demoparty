// Pure image metrics for Stage 6 hard gates. Inputs are RGBA images decoded with pngjs.
import { PNG } from 'pngjs';

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, 4 bytes per pixel
}

export interface TimedFrame {
  tMs: number;
  img: DecodedImage;
}

export function decodePng(buffer: Buffer): DecodedImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function encodePng(img: DecodedImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png);
}

export function blankImage(width = 1280, height = 720): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** Rec.709 luma of one pixel on the 0..255 scale (gamma-encoded values). */
function luma(d: Uint8Array, i: number): number {
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
}

/** Population variance of Rec.709 luma (0..255 scale) over every pixel. */
export function computeLuminanceVariance(img: DecodedImage): number {
  const n = img.width * img.height;
  if (n === 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const y = luma(img.data, i);
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Mean absolute per-pixel luma difference (0..255 scale). Images must share dimensions. */
export function computeMeanAbsDiff(a: DecodedImage, b: DecodedImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`computeMeanAbsDiff: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const n = a.width * a.height;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n * 4; i += 4) sum += Math.abs(luma(a.data, i) - luma(b.data, i));
  return sum / n;
}

/**
 * Box-average an image down to w x h. Each source pixel is added to the cell it falls in,
 * so every cell is the mean of its source area. `channel` maps (data, i) to the value averaged.
 */
function downsample(img: DecodedImage, w: number, h: number, channels: Array<(d: Uint8Array, i: number) => number>): Float64Array[] {
  const out = channels.map(() => new Float64Array(w * h));
  const count = new Float64Array(w * h);
  for (let y = 0; y < img.height; y++) {
    const cy = Math.min(h - 1, Math.floor((y * h) / img.height));
    for (let x = 0; x < img.width; x++) {
      const cell = cy * w + Math.min(w - 1, Math.floor((x * w) / img.width));
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < channels.length; c++) out[c][cell] += channels[c](img.data, i);
      count[cell]++;
    }
  }
  for (const arr of out) for (let k = 0; k < arr.length; k++) arr[k] = count[k] ? arr[k] / count[k] : 0;
  return out;
}

/** 64-bit difference hash: 9x8 area-averaged luma, bit = left > right. 16 lowercase hex chars. */
export function computeDHash64(img: DecodedImage): string {
  const [g] = downsample(img, 9, 8, [luma]);
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/** 4x4x4 RGB histogram (channel >> 6, bin = r*16 + g*4 + b), normalised to sum 1. See DECISIONS.md. */
export function computeColorHistogram64(img: DecodedImage): number[] {
  const bins = new Array<number>(64).fill(0);
  const n = img.width * img.height;
  if (n === 0) return bins;
  const d = img.data;
  for (let i = 0; i < n * 4; i += 4) bins[(d[i] >> 6) * 16 + (d[i + 1] >> 6) * 4 + (d[i + 2] >> 6)]++;
  return bins.map((v) => v / n);
}

/** Bin-wise mean of several normalised histograms (still sums to 1). */
export function averageHistograms(hists: number[][]): number[] {
  const out = new Array<number>(64).fill(0);
  for (const h of hists) for (let i = 0; i < 64; i++) out[i] += h[i] / hists.length;
  return out;
}

// ---------------------------------------------------------------------------
// Photosensitivity (WCAG 2.3.1 general flash and red flash, Harding-style area rule)
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export const FLASH_GRID_W = 64;
export const FLASH_GRID_H = 36;
/**
 * A flash counts only when at least this fraction of the viewport flashes together. WCAG 2.3.1:
 * a 341x256 px region at 1024x768 is about 9.5% of a 1280x720 viewport. Cells need not be
 * contiguous, which is stricter than WCAG.
 */
export const FLASH_AREA_FRACTION = 0.095;
const LUM_DELTA = 0.1; // WCAG: relative luminance change of 10% or more
const LUM_DARK_MAX = 0.8; // WCAG: darker state below 0.80
const RED_DELTA = 20; // WCAG red flash: change in (R - G - B) * 320 above 20
const RED_SATURATION = 0.8; // WCAG: R / (R + G + B) >= 0.8

/** One frame reduced to the 64x36 cells the flash rule needs (~20 KB), so a 20 s screencast stays small. */
export interface FlashGrid {
  tMs: number;
  lum: Float32Array;
  red: Float32Array;
  sat: Uint8Array;
}

export function flashGrid(img: DecodedImage, tMs: number): FlashGrid {
  const cells = FLASH_GRID_W * FLASH_GRID_H;
  const [r, g, b] = downsample(img, FLASH_GRID_W, FLASH_GRID_H, [
    (d, i) => SRGB_TO_LINEAR[d[i]],
    (d, i) => SRGB_TO_LINEAR[d[i + 1]],
    (d, i) => SRGB_TO_LINEAR[d[i + 2]],
  ]);
  const lum = new Float32Array(cells);
  const red = new Float32Array(cells);
  const sat = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) {
    lum[c] = 0.2126 * r[c] + 0.7152 * g[c] + 0.0722 * b[c];
    red[c] = Math.max(0, r[c] - g[c] - b[c]) * 320;
    const total = r[c] + g[c] + b[c];
    sat[c] = total > 0 && r[c] / total >= RED_SATURATION ? 1 : 0;
  }
  return { tMs, lum, red, sat };
}

/** Largest per-cell luminance change between two grids (0 means the frame repeated). */
export function gridMaxLumDelta(a: FlashGrid, b: FlashGrid): number {
  let m = 0;
  for (let c = 0; c < a.lum.length; c++) m = Math.max(m, Math.abs(a.lum[c] - b.lum[c]));
  return m;
}

/**
 * Transition times for one cell's series. Hysteresis: a transition is a swing of at least
 * `thr` away from the last extreme in the opposite direction, so a slow ramp counts once
 * and noise below `thr` never counts. `ok(extFrame, curFrame)` adds the WCAG side condition.
 */
function transitionTimes(series: (k: number) => number, n: number, times: number[], thr: number, ok: (a: number, b: number) => boolean): number[] {
  const out: number[] = [];
  let dir = 0;
  let lo = 0;
  let hi = 0;
  let ext = 0;
  for (let k = 1; k < n; k++) {
    const v = series(k);
    if (dir === 0) {
      if (v - series(lo) >= thr && ok(lo, k)) {
        out.push(times[k]);
        dir = 1;
        ext = k;
      } else if (series(hi) - v >= thr && ok(hi, k)) {
        out.push(times[k]);
        dir = -1;
        ext = k;
      } else {
        if (v < series(lo)) lo = k;
        if (v > series(hi)) hi = k;
      }
    } else if (dir === 1) {
      if (v >= series(ext)) ext = k;
      else if (series(ext) - v >= thr && ok(ext, k)) {
        out.push(times[k]);
        dir = -1;
        ext = k;
      }
    } else {
      if (v <= series(ext)) ext = k;
      else if (v - series(ext) >= thr && ok(ext, k)) {
        out.push(times[k]);
        dir = 1;
        ext = k;
      }
    }
  }
  return out;
}

/** Index of the first element >= x in an ascending array. */
function lowerBound(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Peak flashes per second over any 1000 ms window, where a flash is a pair of opposing
 * transitions and the count is the value reached by at least FLASH_AREA_FRACTION of the viewport.
 */
export function maxFlashesPerSecondFromGrids(grids: FlashGrid[]): number {
  if (grids.length < 3) return 0;
  const sorted = [...grids].sort((a, b) => a.tMs - b.tMs);
  const times = sorted.map((f) => f.tMs);
  const F = sorted.length;
  const cells = FLASH_GRID_W * FLASH_GRID_H;

  const perCell: number[][] = [];
  for (let c = 0; c < cells; c++) {
    const L = (k: number) => sorted[k]!.lum[c];
    const R = (k: number) => sorted[k]!.red[c];
    const general = transitionTimes(L, F, times, LUM_DELTA, (a, b) => Math.min(L(a), L(b)) < LUM_DARK_MAX);
    const redT = transitionTimes(R, F, times, RED_DELTA, (a, b) => sorted[a]!.sat[c] === 1 || sorted[b]!.sat[c] === 1);
    perCell.push(general.length >= redT.length ? general : redT);
  }

  const need = Math.ceil(cells * FLASH_AREA_FRACTION);
  let best = 0;
  const counts = new Array<number>(cells);
  for (const start of times) {
    for (let c = 0; c < cells; c++) {
      const ts = perCell[c]!;
      counts[c] = ts.length < 2 ? 0 : Math.floor((lowerBound(ts, start + 1000) - lowerBound(ts, start)) / 2);
    }
    counts.sort((a, b) => b - a);
    best = Math.max(best, counts[need - 1]!);
  }
  return best;
}

/** Same as maxFlashesPerSecondFromGrids, from full decoded frames. */
export function detectMaxFlashesPerSecond(frames: TimedFrame[]): number {
  return maxFlashesPerSecondFromGrids(frames.map((f) => flashGrid(f.img, f.tMs)));
}
