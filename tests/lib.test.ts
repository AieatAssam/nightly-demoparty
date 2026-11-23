// lib/ helper library: manifest accuracy, lint cleanliness, maths, and real-browser behaviour.
// LIB_MANIFEST_WRITE=1 npx vitest run tests/lib.test.ts regenerates lib/min/*.js and rewrites the measured fields of lib/manifest.json.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { lintPieceHtml } from '../harness/lint.js';
import { loadAllConfig } from '../harness/config.js';
import { CHROMIUM_ARGS, runHardGates } from '../harness/gates.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const config = loadAllConfig(REPO);
const slopRules = config.slop.static_rules;
const MANIFEST_PATH = join(REPO, 'lib', 'manifest.json');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
// lib/*.js has no .d.ts (tsconfig has no allowJs), so modules come in as `any` via dynamic import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = any;
const load = (rel: string): Promise<Mod> => import(pathToFileURL(join(REPO, rel)).href);

interface ManifestFile {
  file: string;
  min_file: string;
  raw_bytes: number;
  min_bytes: number;
  constraint_night?: string[];
  exports: Array<{ name: string; kind: string; summary: string }>;
  glsl_bytes: Record<string, number>;
  reserved: string[];
  usage: string;
  compos: string[];
}
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { files: ManifestFile[] };
const NAMES = ['noise', 'sdf', 'synth', 'webgl2', 'webgpu', 'palette', 'easing'];
const LIB_FILES = ['lib/noise.js', 'lib/sdf.js', 'lib/synth.js', 'lib/webgl2.js', 'lib/webgpu.js', 'lib/palette.js', 'lib/easing.js'];

const kindOf = (v: unknown): string => (typeof v === 'function' ? 'function' : typeof v === 'string' ? 'string' : 'object');
const topLevelNames = (src: string): string[] =>
  [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([\w$]+)/gm)].map((m) => m[1]!);
/** GLSL snippet sizes: [deps, code] tables by entry, plain string exports by export name. */
function glslBytes(mod: Mod): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, v] of Object.entries(mod)) {
    if (typeof v === 'string' && /\b(?:float|vec[234]|void|uniform)\b/.test(v)) out[name] = Buffer.byteLength(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, e] of Object.entries(v as Record<string, [string[], string]>)) out[`${name}.${k}`] = Buffer.byteLength(e[1]);
    }
  }
  return out;
}
/**
 * lib/min/<name>.js: minified as a classic script with `export` stripped, so esbuild shortens locals but
 * keeps every top-level name (ESM mode would rename them to single letters that collide across files),
 * then one `export{...}` list re-exports the same names.
 */
function minify(src: string): string {
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([\w$]+)/gm)].map((m) => m[1]!);
  return transformSync(src.replace(/^export\s+/gm, ''), { minify: true }).code.trimEnd() + `export{${names.join(',')}};\n`;
}
const minPath = (rel: string): string => rel.replace('lib/', 'lib/min/');
async function measure(rel: string): Promise<Pick<ManifestFile, 'raw_bytes' | 'min_bytes' | 'glsl_bytes' | 'reserved'> & { exports: Array<[string, string]> }> {
  const src = read(rel);
  const mod = await load(rel);
  const exported = Object.keys(mod).sort();
  return {
    raw_bytes: Buffer.byteLength(src),
    min_bytes: Buffer.byteLength(minify(src)),
    glsl_bytes: glslBytes(mod),
    reserved: topLevelNames(src).filter((n) => !exported.includes(n)).sort(),
    exports: exported.map((n) => [n, kindOf(mod[n])]),
  };
}

if (process.env.LIB_MANIFEST_WRITE) {
  mkdirSync(join(REPO, 'lib', 'min'), { recursive: true });
  for (const f of manifest.files) {
    writeFileSync(join(REPO, f.min_file), minify(read(f.file)));
    Object.assign(f, (({ exports: _e, ...m }) => m)(await measure(f.file)));
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

const modulePage = (code: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>lib</title></head><body><script type="module">\n${code}\n</script></body></html>`;

describe('lib/manifest.json', () => {
  it('lists exactly the lib files', () => {
    expect(manifest.files.map((f) => f.file).sort()).toEqual([...LIB_FILES].sort());
    for (const f of manifest.files) expect(f.min_file).toBe(minPath(f.file));
  });

  it.each(LIB_FILES)('%s: byte counts, exports, GLSL sizes and reserved names match the source', async (rel) => {
    const entry = manifest.files.find((f) => f.file === rel)!;
    const m = await measure(rel);
    expect(entry.raw_bytes).toBe(m.raw_bytes);
    expect(entry.min_bytes).toBe(m.min_bytes);
    expect(entry.glsl_bytes).toEqual(m.glsl_bytes);
    expect(entry.reserved).toEqual(m.reserved);
    expect(entry.exports.map((e) => [e.name, e.kind]).sort()).toEqual(m.exports);
    for (const e of entry.exports) expect(e.summary.length).toBeGreaterThan(10);
    expect(entry.usage.length).toBeGreaterThan(20);
  });

  it('recommends only real compos, and only where the raw file takes at most half the budget', () => {
    const budgets = new Map<string, number>(config.compos.map((c) => [c.id, c.size_budget_bytes]));
    for (const f of manifest.files) {
      expect(f.compos.length).toBeGreaterThan(0);
      for (const c of f.compos) {
        expect(budgets.has(c), `${f.file}: ${c}`).toBe(true);
        expect(f.raw_bytes, `${f.file} in ${c}`).toBeLessThanOrEqual(budgets.get(c)! / 2);
      }
    }
  });

  it('constraint-night recommendations name real variants whose budget fits the min file', () => {
    const night = config.compos.find((c) => c.id === 'constraint-night')!;
    const variants = new Map<string, number>((night.constraints ?? []).map((c) => [c.id, c.size_budget_bytes]));
    for (const f of manifest.files) {
      expect(f.compos.includes('constraint-night'), f.file).toBe((f.constraint_night ?? []).length > 0);
      for (const v of f.constraint_night ?? []) {
        expect(variants.has(v), `${f.file}: ${v}`).toBe(true);
        expect(['1kb-micro', 'css-only']).not.toContain(v);
        expect(f.min_bytes, `${f.file} in ${v}`).toBeLessThanOrEqual(variants.get(v)! / 2);
      }
    }
    expect(manifest.files.find((f) => f.file === 'lib/webgl2.js')!.constraint_night).not.toContain('no-canvas');
  });

  it('every file stays compact (raw under 6.5 KB) and no top-level name is declared twice across lib', () => {
    const seen = new Map<string, string>();
    for (const rel of LIB_FILES) {
      expect(Buffer.byteLength(read(rel)), rel).toBeLessThan(6656);
      for (const n of topLevelNames(read(rel))) {
        expect(seen.get(n), `${n} in ${rel} and ${seen.get(n)}`).toBeUndefined();
        seen.set(n, rel);
      }
    }
    // The concatenation parses as one module, which is how a piece inlines it.
    expect(() => transformSync(LIB_FILES.map(read).join('\n'), { format: 'esm' })).not.toThrow();
  });
});

describe('lib lint', () => {
  it.each(LIB_FILES)('%s passes lintPieceHtml with zero violations inside a module script', (rel) => {
    const r = lintPieceHtml(modulePage(read(rel)), { sizeBudgetBytes: 32768, slopRules, constraint: null });
    expect(r.violations).toEqual([]);
  });

  it('all files inlined together pass lint, including with the canonical CSP required', () => {
    const html = modulePage(LIB_FILES.map(read).join('\n')).replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:">`,
    );
    expect(lintPieceHtml(html, { sizeBudgetBytes: 65536, slopRules, constraint: null, requireCsp: true }).violations).toEqual([]);
  });

  it.each(LIB_FILES)('%s has no banned token even in comments', (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/Math\s*\.\s*random/i);
    expect(src).not.toMatch(/\beval\b|\bFunction\s*\(|new\s+Function|\bfetch\b|XMLHttpRequest|WebSocket|\bimport\b|\.constructor\b/);
    expect(src).not.toMatch(/[a-z]+:\/\//i);
    expect(src).not.toMatch(/mainImage/);
  });

  it('every GLSL snippet is explicit about precision through GL_HEAD', async () => {
    const { GL_HEAD } = await load('lib/webgl2.js');
    expect(GL_HEAD).toMatch(/^#version 300 es\n/);
    expect(GL_HEAD).toMatch(/precision highp float;/);
    expect(GL_HEAD).toMatch(/precision highp int;/);
    expect(GL_HEAD).toMatch(/precision highp sampler2D;/);
  });
});

describe('lib/min', () => {
  it.each(LIB_FILES)('%s: min file exists, is fresh, matches min_bytes and passes lint with zero violations', (rel) => {
    const entry = manifest.files.find((f) => f.file === rel)!;
    expect(existsSync(join(REPO, entry.min_file))).toBe(true);
    const min = read(entry.min_file);
    expect(min).toBe(minify(read(rel)));
    expect(Buffer.byteLength(min)).toBe(entry.min_bytes);
    expect(min).not.toMatch(/\/\*|^\s*\/\//m);
    expect(lintPieceHtml(modulePage(min), { sizeBudgetBytes: 32768, slopRules, constraint: null }).violations).toEqual([]);
  });

  it.each(LIB_FILES)('%s: min keeps every top-level name and export of the raw file', async (rel) => {
    const raw = await load(rel), min = await load(minPath(rel));
    expect(Object.keys(min).sort()).toEqual(Object.keys(raw).sort());
    for (const k of Object.keys(raw)) {
      expect(kindOf(min[k]), k).toBe(kindOf(raw[k]));
      if (typeof raw[k] !== 'function') expect(min[k], k).toEqual(raw[k]);
    }
    // Each raw top-level name (exports + reserved) is still declared at top level: redeclaring it must fail to parse.
    const minSrc = read(minPath(rel));
    for (const n of topLevelNames(read(rel))) expect(() => transformSync(`${minSrc}\nconst ${n}=0;`, { format: 'esm' }), n).toThrow(/already been declared/);
  });

  it('all min files inline together as one module and pass lint with the canonical CSP', () => {
    const all = NAMES.map((n) => read(`lib/min/${n}.js`)).join('\n');
    expect(() => transformSync(all, { format: 'esm' })).not.toThrow();
    const html = modulePage(all).replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:">`,
    );
    expect(lintPieceHtml(html, { sizeBudgetBytes: 32768, slopRules, constraint: null, requireCsp: true }).violations).toEqual([]);
  });

  it('min helpers compute the same values as the raw source', async () => {
    const [rn, mn] = [await load('lib/noise.js'), await load('lib/min/noise.js')];
    const a = rn.mulberry32(5), b = mn.mulberry32(5);
    for (let i = 0; i < 100; i++) expect(b()).toBe(a());
    expect(mn.fbm(mn.simplex(3).n3, 5)(1.1, 2.2, 3.3)).toBe(rn.fbm(rn.simplex(3).n3, 5)(1.1, 2.2, 3.3));
    expect(mn.noiseGlsl('warp', 'ridged')).toBe(rn.noiseGlsl('warp', 'ridged'));
    const [rs, ms] = [await load('lib/sdf.js'), await load('lib/min/sdf.js')];
    expect(ms.sdRoundBox(2, 2, 1, 1, 0.5)).toBe(rs.sdRoundBox(2, 2, 1, 1, 0.5));
    expect(ms.smin(0.3, 0.3, 0.4)).toBe(rs.smin(0.3, 0.3, 0.4));
    expect(ms.opRepPolar(1, 2, 6)).toEqual(rs.opRepPolar(1, 2, 6));
    expect(ms.sdfGlsl('march', 'calcAO')).toBe(rs.sdfGlsl('march', 'calcAO'));
    const [rp, mp] = [await load('lib/palette.js'), await load('lib/min/palette.js')];
    expect(mp.ramp(5, 40, 0.12, { hs: 20 })).toEqual(rp.ramp(5, 40, 0.12, { hs: 20 }));
    expect(mp.hex(mp.oklch(0.6, 0.3, 145))).toBe(rp.hex(rp.oklch(0.6, 0.3, 145)));
    const [re, me] = [await load('lib/easing.js'), await load('lib/min/easing.js')];
    for (let t = -1; t < 22; t += 0.7) {
      expect(me.acts(t)).toEqual(re.acts(t));
      expect(me.elasticOut(t / 20)).toBe(re.elasticOut(t / 20));
      expect(me.beat(t, 5, 5)).toBe(re.beat(t, 5, 5));
    }
    const [ry, my] = [await load('lib/synth.js'), await load('lib/min/synth.js')];
    expect(my.mtof(57)).toBe(ry.mtof(57));
    expect(Array.from(my.ksBuffer(8000, 110, 0.2, 3))).toEqual(Array.from(ry.ksBuffer(8000, 110, 0.2, 3)));
    const ev = (m: Mod) => { const out: string[] = []; m.seq({ seed: 4 }, (_c: unknown, _o: unknown, t: number, i: number, r: () => number) => out.push(`${i}@${t}:${r()}`))(null, null, 0, 1, 0); return out; };
    expect(ev(my)).toEqual(ev(ry));
    expect((await load('lib/min/webgl2.js')).GL_HEAD).toBe((await load('lib/webgl2.js')).GL_HEAD);
    expect(typeof (await load('lib/min/webgpu.js')).gpuStart).toBe('function');
  });

  it('webgl2 + sdf + synth min files leave at least 4096 bytes of the 16k-demo budget', () => {
    const budget = config.compos.find((c) => c.id === '16k-demo')!.size_budget_bytes;
    expect(budget).toBe(16384);
    const used = ['webgl2', 'sdf', 'synth'].reduce((s, n) => s + manifest.files.find((f) => f.file === `lib/${n}.js`)!.min_bytes, 0);
    expect(Buffer.byteLength(['webgl2', 'sdf', 'synth'].map((n) => read(`lib/min/${n}.js`)).join('\n'))).toBe(used + 2);
    expect(budget - used).toBeGreaterThanOrEqual(4096);
  });
});

describe('noise.js', () => {
  it('mulberry32 is deterministic, uniform and seed-sensitive', async () => {
    const { mulberry32 } = await load('lib/noise.js');
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const xs = Array.from({ length: 20000 }, () => a());
    expect(Array.from({ length: 20000 }, () => b())).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
    const hist = new Array(10).fill(0);
    for (const x of xs) hist[Math.floor(x * 10)]++;
    for (const h of hist) expect(Math.abs(h - 2000)).toBeLessThan(200);
  });

  it('xoshiro128** matches the reference first output and stays in [0, 1)', async () => {
    const { xoshiro128ss } = await load('lib/noise.js');
    const ref = xoshiro128ss(1, 2, 3, 4);
    // Hand-stepped reference: rotl(s1 * 5, 7) * 9 with state (1,2,3,4) -> (7,0,1026,12288) -> ...
    expect([ref(), ref(), ref()].map((x: number) => x * 2 ** 32)).toEqual([11520, 0, 5927040]);
    const r = xoshiro128ss(0x9e3779b9, 0x243f6a88, 0xb7e15162, 1);
    for (let i = 0; i < 5000; i++) { const x = r(); expect(x >= 0 && x < 1).toBe(true); }
  });

  it('simplex is bounded, zero at the origin, continuous, seeded and roughly zero-mean', async () => {
    const { simplex, mulberry32 } = await load('lib/noise.js');
    const { n2, n3 } = simplex(7);
    const other = simplex(8);
    expect(n2(0, 0)).toBe(0);
    const r = mulberry32(1);
    let s2 = 0, s3 = 0, max = 0, diff = 0;
    for (let i = 0; i < 20000; i++) {
      const x = r() * 200 - 100, y = r() * 200 - 100, z = r() * 200 - 100;
      const a = n2(x, y), b = n3(x, y, z);
      s2 += a; s3 += b; max = Math.max(max, Math.abs(a), Math.abs(b));
      expect(Math.abs(n2(x + 1e-4, y) - a)).toBeLessThan(0.01);
      expect(Math.abs(n3(x, y, z + 1e-4) - b)).toBeLessThan(0.01);
      diff += Math.abs(other.n2(x, y) - a);
    }
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(0.6);
    expect(Math.abs(s2 / 20000)).toBeLessThan(0.03);
    expect(Math.abs(s3 / 20000)).toBeLessThan(0.03);
    expect(diff / 20000).toBeGreaterThan(0.1);
    expect(simplex(7).n3(1.5, 2.5, 3.5)).toBe(n3(1.5, 2.5, 3.5));
  });

  it('fbm, ridged and warp stay in range', async () => {
    const { simplex, fbm, ridged, warp } = await load('lib/noise.js');
    const { n2, n3 } = simplex(3);
    const f = fbm(n3, 6), rg = ridged(n3, 6), w = warp(fbm(n2, 4), 1.5);
    for (let i = 0; i < 3000; i++) {
      const x = i * 0.173, y = i * 0.091, z = i * 0.037;
      expect(Math.abs(f(x, y, z))).toBeLessThan(1);
      const v = rg(x, y, z);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Math.abs(w(x, y))).toBeLessThan(1);
    }
  });

  it('noiseGlsl orders dependencies first, includes each once and rejects unknown names', async () => {
    const { noiseGlsl, NOISE_GLSL } = await load('lib/noise.js');
    const g: string = noiseGlsl('warp', 'fbm', 'ridged');
    const at = (sig: string) => g.indexOf(sig);
    expect(at('uint hashU(')).toBeGreaterThanOrEqual(0);
    expect(at('uint hashU(')).toBeLessThan(at('vec3 hash33('));
    expect(at('vec3 hash33(')).toBeLessThan(at('float gnoise('));
    expect(at('float gnoise(')).toBeLessThan(at('float fbm('));
    expect(at('float fbm(')).toBeLessThan(at('float warp('));
    expect(g.split('float fbm(').length).toBe(2);
    expect(() => noiseGlsl('nope')).toThrow(/unknown snippet nope/);
    for (const [, [deps]] of Object.entries(NOISE_GLSL as Record<string, [string[], string]>)) for (const d of deps) expect(NOISE_GLSL[d]).toBeDefined();
  });
});

describe('sdf.js', () => {
  it('2D distances are exact on known points', async () => {
    const s = await load('lib/sdf.js');
    expect(s.sdCircle(3, 4, 5)).toBe(0);
    expect(s.sdCircle(0, 0, 2)).toBe(-2);
    expect(s.sdBox(3, 0, 1, 1)).toBe(2);
    expect(s.sdBox(3, 3, 1, 1)).toBeCloseTo(Math.SQRT2 * 2, 12);
    expect(s.sdBox(0.5, 0, 1, 1)).toBe(-0.5);
    expect(s.sdRoundBox(3, 0, 1, 1, 0.25)).toBeCloseTo(2, 12);
    expect(s.sdRoundBox(2, 2, 1, 1, 0.5)).toBeCloseTo(Math.hypot(1.5, 1.5) - 0.5, 12);
    expect(s.sdSegment(0, 1, -1, 0, 1, 0)).toBe(1);
    expect(s.sdSegment(3, 0, -1, 0, 1, 0)).toBe(2);
    expect(s.sdCapsule(0, 1, -1, 0, 1, 0, 0.25)).toBe(0.75);
  });

  it('smin never exceeds min and equals it outside the blend radius; subtraction carves', async () => {
    const { smin, opSmoothSubtraction } = await load('lib/sdf.js');
    for (let a = -2; a <= 2; a += 0.25) for (let b = -2; b <= 2; b += 0.25) expect(smin(a, b, 0.5)).toBeLessThanOrEqual(Math.min(a, b));
    expect(smin(0, 1, 0.5)).toBe(0);
    expect(smin(0.3, 0.3, 0.4)).toBeCloseTo(0.2, 12);
    expect(opSmoothSubtraction(-1, 2, 0.1)).toBe(-1);
    expect(opSmoothSubtraction(-1, -2, 0.1)).toBe(2);
    expect(smin(0.2, -0.4, 0)).toBe(-0.4);
    expect(smin(0.2, 0.3, -1)).toBe(0.2);
  });

  it('rot2, opRep and opRepPolar preserve what they should', async () => {
    const { rot2, opRep, opRepPolar } = await load('lib/sdf.js');
    const [x, y] = rot2(1, 0, Math.PI / 2);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(Math.hypot(...rot2(3, 4, 1.234))).toBeCloseTo(5, 12);
    expect(opRep(7.3, 2)).toBeCloseTo(opRep(1.3, 2), 12);
    expect(Math.abs(opRep(7.3, 2))).toBeLessThanOrEqual(1);
    for (let a = 0; a < 6.28; a += 0.37) {
      const [px, py] = opRepPolar(2 * Math.cos(a), 2 * Math.sin(a), 6);
      expect(Math.hypot(px, py)).toBeCloseTo(2, 12);
      expect(Math.abs(Math.atan2(py, px))).toBeLessThanOrEqual(Math.PI / 6 + 1e-9);
    }
  });

  it('sdfGlsl pulls in the map prototype for raymarch helpers', async () => {
    const { sdfGlsl } = await load('lib/sdf.js');
    const g: string = sdfGlsl('calcNormal', 'march', 'sdCapsule');
    expect(g.indexOf('float map(vec3 p);')).toBe(0);
    expect(g.split('float map(vec3 p);').length).toBe(2);
    expect(g.indexOf('float sdSegment(')).toBeLessThan(g.indexOf('float sdCapsule('));
    expect(() => sdfGlsl('sdBlob')).toThrow(/unknown snippet sdBlob/);
  });
});

describe('palette.js', () => {
  it('oklch matches the OKLab reference for sRGB red, white and black', async () => {
    const { oklch, hex } = await load('lib/palette.js');
    const red = oklch(0.627955, 0.257683, 29.2339);
    expect(red[0]).toBeCloseTo(1, 3);
    expect(red[1]).toBeCloseTo(0, 3);
    expect(red[2]).toBeCloseTo(0, 3);
    expect(hex(oklch(1, 0, 0))).toBe('#ffffff');
    expect(hex(oklch(0, 0, 123))).toBe('#000000');
    expect(hex([1, 0.5, 0])).toBe('#ff8000');
  });

  it('gamut-maps by reducing chroma: out-of-gamut colours stay in 0..1 and keep lightness order', async () => {
    const { oklch, luminance } = await load('lib/palette.js');
    let prev = -1;
    for (const L of [0.2, 0.4, 0.6, 0.8]) {
      const c = oklch(L, 0.4, 145);
      for (const v of c) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      expect(c[1]).toBeGreaterThan(c[0]); // still green, not clipped toward another hue
      expect(luminance(c)).toBeGreaterThan(prev);
      prev = luminance(c);
    }
  });

  it('cosPal, contrast and ramp', async () => {
    const { cosPal, contrast, ramp, luminance } = await load('lib/palette.js');
    expect(cosPal(0, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0])).toEqual([1, 1, 1]);
    expect(cosPal(0.5, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0])[0]).toBeCloseTo(0, 12);
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 9);
    expect(contrast([0.2, 0.3, 0.4], [0.2, 0.3, 0.4])).toBe(1);
    const r: number[][] = ramp(6, 60, 0.12, { hs: 30 });
    expect(r).toHaveLength(6);
    for (let i = 1; i < r.length; i++) expect(luminance(r[i])).toBeGreaterThan(luminance(r[i - 1]));
    expect(contrast(r[0], r[5])).toBeGreaterThan(7);
  });
});

describe('easing.js', () => {
  afterAll(() => vi.unstubAllGlobals());

  it('curves hit their ends, stay monotone where they should, and overshoot where they should', async () => {
    const e = await load('lib/easing.js');
    for (const f of [e.smooth, e.quintic, e.cubicInOut, e.expoOut, e.backOut, e.elasticOut]) {
      expect(f(0)).toBeCloseTo(0, 9);
      expect(f(1)).toBeCloseTo(1, 9);
      expect(f(-3)).toBeCloseTo(0, 9);
      expect(f(4)).toBeCloseTo(1, 9);
    }
    for (const f of [e.smooth, e.quintic, e.cubicInOut, e.expoOut]) {
      for (let x = 0; x < 1; x += 0.01) expect(f(x + 0.01)).toBeGreaterThanOrEqual(f(x));
    }
    const peak = (f: (x: number) => number) => Math.max(...Array.from({ length: 101 }, (_, i) => f(i / 100)));
    expect(peak(e.backOut)).toBeGreaterThan(1.05);
    expect(peak(e.elasticOut)).toBeGreaterThan(1.05);
    expect(e.smooth(0.5)).toBe(0.5);
    expect(e.quintic(0.5)).toBe(0.5);
    expect(e.lerp(2, 4, 0.25)).toBe(2.5);
  });

  it('beat, act and acts follow the 4-beat storyboard', async () => {
    const { beat, act, acts, CUTS, quintic } = await load('lib/easing.js');
    expect(CUTS).toEqual([0, 5, 10, 15, 20]);
    expect(beat(4, 5, 10)).toBe(0);
    expect(beat(7.5, 5, 10, quintic)).toBe(0.5);
    expect(beat(11, 5, 10)).toBe(1);
    expect([beat(4.9, 5, 5), beat(5, 5, 5), beat(6, 5, 5, quintic)]).toEqual([0, 1, 1]);
    expect(act(0)).toEqual({ i: 0, p: 0 });
    expect(act(12.5)).toEqual({ i: 2, p: 0.5 });
    expect(act(30)).toEqual({ i: 3, p: 1 });
    for (let t = -1; t < 25; t += 0.13) {
      const w: number[] = acts(t);
      expect(w).toHaveLength(4);
      expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(acts(2.5)).toEqual([1, 0, 0, 0]);
    expect(acts(12.5)[2]).toBe(1);
    expect(acts(10)[1]).toBeCloseTo(0.5, 12);
  });

  it('storyClock advances by frame deltas, caps jumps and slows under reduced motion', async () => {
    let reduced = false;
    vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; } }));
    const { storyClock } = await load('lib/easing.js');
    const c = storyClock();
    expect(c(1000).t).toBe(0);
    expect(c(2000).t).toBeCloseTo(0.5, 9); // 1 s gap capped to 0.5 s
    expect(c(2400).t).toBeCloseTo(0.9, 9);
    reduced = true;
    const r = c(3400);
    expect(r.reduced).toBe(true);
    expect(r.t).toBeCloseTo(0.9 + 0.5 * 0.2, 9);
    expect(r.i).toBe(0);
  });
});

describe('synth.js (pure parts)', () => {
  it('mtof, Karplus-Strong buffer and chunk-invariant sequencer', async () => {
    const { mtof, ksBuffer, seq } = await load('lib/synth.js');
    expect(mtof(69)).toBe(440);
    expect(mtof(81)).toBeCloseTo(880, 9);
    const a: Float32Array = ksBuffer(44100, 220, 1, 5);
    expect(a.length).toBe(44100);
    expect(Array.from(ksBuffer(44100, 220, 1, 5))).toEqual(Array.from(a));
    expect(Array.from(ksBuffer(44100, 220, 1, 6).slice(0, 50))).not.toEqual(Array.from(a.slice(0, 50)));
    const energy = (from: number, to: number) => a.slice(from, to).reduce((s, x) => s + x * x, 0);
    expect(energy(39690, 44100)).toBeLessThan(energy(0, 4410) * 0.5);
    for (const x of a) expect(Math.abs(x)).toBeLessThanOrEqual(1);

    const events = (chunks: number[]): string[] => {
      const out: string[] = [];
      const play = seq({ bpm: 120, div: 4, seed: 9 }, (_c: unknown, _o: unknown, t: number, i: number, rnd: () => number) => out.push(`${i}@${t.toFixed(6)}:${rnd().toFixed(8)}`));
      for (let k = 1; k < chunks.length; k++) play(null, null, chunks[k - 1]!, chunks[k]!, 10);
      return out;
    };
    const whole = events([0, 2]);
    expect(whole).toHaveLength(16); // 120 bpm, 16ths, 2 s
    expect(whole[0]).toMatch(/^0@10\.000000:/);
    expect(events([0, 0.13, 0.5, 0.51, 1.37, 2])).toEqual(whole);
  });
});

// ---------- real Chromium ----------

const ROOT_URL = 'http://localhost/lib-test.html'; // localhost is a secure context, so WebGPU is reachable
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
});
afterAll(async () => {
  await browser?.close();
});

/** Opens a page at ROOT_URL whose single module script is `code`; resolves when window.__done is set. */
async function runInPage(code: string, init?: string): Promise<{ page: Page; result: Mod; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 180 } });
  if (init) await ctx.addInitScript({ content: init });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas id="c"></canvas><script type="module">\n${code}\n</script></body></html>`,
    }),
  );
  await page.goto(ROOT_URL);
  await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, null, { timeout: 30000 });
  const result = await page.evaluate(() => (window as unknown as { __result: unknown }).__result);
  return { page, result, errors };
}
const libs = (...names: string[]): string => names.map((n) => read(`lib/${n}.js`)).join('\n');
const minLibs = (...names: string[]): string => names.map((n) => read(`lib/min/${n}.js`)).join('\n');
const done = (expr: string) => `window.__result = ${expr}; window.__done = true;`;

describe('lib in headless Chromium (SwiftShader)', () => {
  it('every GLSL snippet compiles together under GL_HEAD and matches the JS maths; ping-pong FBOs accumulate', async () => {
    const code = `${libs('webgl2', 'noise', 'sdf', 'palette')}
const gl = document.getElementById('c').getContext('webgl2');
const pp = createPingPong(gl, 4, 1);
const all = noiseGlsl(...Object.keys(NOISE_GLSL)) + '\\n' + sdfGlsl(...Object.keys(SDF_GLSL)) + '\\n' + GLSL_COSPAL + '\\n' + GLSL_OKLCH + '\\n';
const prog = glProgram(gl, GL_HEAD + all + \`
float map(vec3 p){return sdTorus(p,vec2(1,.25));}
float others(vec3 q){q=opRep(q,vec3(8));q.xy*=rot2(.3);return smin(sdRoundBox(q,vec3(.4),.1),min(sdOctahedron(q,.6),min(sdCapsule(q,vec3(0),vec3(1),.1),min(sdGyroid(q,4.,.05),sdBox(q,vec3(1))))),.2)+opRepPolar(q.xy,6.).x;}
void main(){int x=int(gl_FragCoord.x);vec3 p=vec3(.31,.27,.13);vec4 v;
if(x==0)v=vec4(sdBox2(vec2(3,3),vec2(1)),sdCircle(vec2(3,4),1.),smin(.3,.3,.4),opSmoothSubtraction(-1.,-2.,.1));
else if(x==1)v=vec4(hash31(p*10.),vnoise(p.xy*3.),gnoise(p*3.)*.5+.5,fbm(p)*.5+.5+0.*(ridged(p)+warp(p)+others(p)+u_time+u_reduced+u_res.x+u_mouse.x+u_audio.x));
else if(x==2)v=vec4(march(vec3(0,0,-5),vec3(0,0,1)),calcNormal(vec3(0,0,-1.3)).z,calcAO(vec3(0,1.5,0),vec3(0,1,0)),softShadow(vec3(0,3,0),vec3(0,1,0),8.));
else v=vec4(cosPal(0.,vec3(.5),vec3(.5),vec3(1),vec3(0)).x,oklch(.627955,.257683,radians(29.2339)));
o=v;}\`);
gl.useProgram(prog);
glDraw(gl, pp.b.fb, 4, 1);
const px = new Float32Array(16);
gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.FLOAT, px);
const acc = glProgram(gl, GL_HEAD + 'uniform sampler2D u_prev;void main(){o=texture(u_prev,gl_FragCoord.xy/vec2(4,1))+vec4(1,2,0,0);}');
const set = glSetter(gl, acc);
gl.useProgram(acc);
set('u_prev', 0);
for (let i = 0; i < 3; i++) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pp.a.tex); glDraw(gl, pp.b.fb, 4, 1); pp.swap(); }
gl.bindFramebuffer(gl.FRAMEBUFFER, pp.a.fb);
const acc3 = new Float32Array(16);
gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.FLOAT, acc3);
${done('{ px: Array.from(px), acc: Array.from(acc3), err: gl.getError(), float: pp.float }')}`;
    const { page, result, errors } = await runInPage(code);
    await page.context().close();
    expect(errors).toEqual([]);
    expect(result.err).toBe(0);
    expect(result.float).toBe(true);
    const px: number[] = result.px;
    const near = (got: number, want: number, tol = 0.01) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThan(tol);
    // pixel 0: SDF values vs the JS reference maths
    near(px[0]!, Math.SQRT2 * 2);
    near(px[1]!, 4);
    near(px[2]!, 0.2);
    near(px[3]!, 2);
    // pixel 1: hashes and noise in range
    for (const v of px.slice(4, 8)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    // pixel 2: march hits the torus ring's inner tube at z = -1.25, its normal faces -z, AO and shadow in range
    near(px[8]!, 3.75, 0.02);
    near(px[9]!, -1, 0.05);
    for (const v of px.slice(10, 12)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    // pixel 3: cosPal white, oklch red
    near(px[12]!, 1);
    near(px[13]!, 1);
    near(px[14]!, 0);
    near(px[15]!, 0);
    expect(result.acc).toEqual([3, 6, 0, 0, 3, 6, 0, 0, 3, 6, 0, 0, 3, 6, 0, 0]);
  }, 60_000);

  it('GLSL compile errors throw a clear Error with the info log', async () => {
    const code = `${libs('webgl2')}
let msg = '';
try { glProgram(document.getElementById('c').getContext('webgl2'), GL_HEAD + 'void main(){o=vec4(nope);}'); } catch (e) { msg = e.message; }
${done('msg')}`;
    const { page, result } = await runInPage(code);
    await page.context().close();
    expect(result).toMatch(/^GLSL compile failed: .*nope/s);
  }, 30_000);

  it('WebGPU render + compute path draws the storage buffer on a secure origin', async (t) => {
    const code = `${libs('webgpu')}
// Headless Linux can leave requestAdapter/requestDevice pending forever; give up after 5 s and skip.
const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 5000))]);
const ad = navigator.gpu ? await within(navigator.gpu.requestAdapter()) : null;
const probe = ad ? await within(ad.requestDevice()) : null;
if (probe) probe.destroy();
if (!probe) { ${done('{ skipped: true }')} } else {
const WGSL = \`@compute @workgroup_size(4) fn cs(@builtin(global_invocation_id) id:vec3u){S[id.x]=f32(id.x)*.25;}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{return vec4f(S[1],S[2],S[3],1.);}\`;
const st = await gpuStart(document.getElementById('c'), WGSL, () => ({ kind: 'fallback' }), { storage: 4, workgroups: 1 });
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
let data = null;
if (st.kind === 'webgpu') {
  const rb = st.dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = st.dev.createCommandEncoder(); enc.copyBufferToBuffer(st.buf, 0, rb, 0, 16); st.dev.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); data = Array.from(new Float32Array(rb.getMappedRange()));
}
${done('{ kind: st.kind, data }')} }`;
    const { page, result, errors } = await runInPage(code);
    if (result.skipped) { await page.context().close(); t.skip(); return; }
    const png = PNG.sync.read(await page.screenshot({ type: 'png' }));
    await page.context().close();
    expect(errors).toEqual([]);
    expect(result.kind).toBe('webgpu');
    expect(result.data).toEqual([0, 0.25, 0.5, 0.75]);
    const i = (90 * png.width + 160) * 4;
    expect(Math.abs(png.data[i]! - 64)).toBeLessThan(4);
    expect(Math.abs(png.data[i + 1]! - 128)).toBeLessThan(4);
    expect(Math.abs(png.data[i + 2]! - 191)).toBeLessThan(4);
  }, 30_000);

  it('WebGPU falls back to WebGL2 when there is no adapter, and when the WGSL is invalid', async () => {
    const code = `${libs('webgl2', 'webgpu')}
const c = document.getElementById('c');
const fb = () => glStart(c, 'void main(){o=vec4(.2,.6,.4,1);}');
const a = await gpuStart(c, 'not wgsl at all', fb);
const c2 = document.createElement('canvas');
const b = await gpuStart(c2, '@fragment fn fs()->@location(0) vec4f{return vec4f(1.);}', () => ({ kind: 'fallback-b' }));
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
${done('{ a: a.kind, b: b.kind }')}`;
    // Bad WGSL on a real adapter (when present), then no adapter at all.
    const r1 = await runInPage(code);
    const png = PNG.sync.read(await r1.page.screenshot({ type: 'png' }));
    await r1.page.context().close();
    expect(r1.errors).toEqual([]);
    expect(r1.result.a).toBe('webgl2');
    const i = (90 * png.width + 160) * 4;
    expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([51, 153, 102]);
    const r2 = await runInPage(code, 'if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;');
    await r2.page.context().close();
    expect(r2.errors).toEqual([]);
    expect(r2.result).toEqual({ a: 'webgl2', b: 'fallback-b' });
  }, 30_000);

  it('synth: offline probe is loud enough, never clips even when overdriven, and nothing starts before a gesture', async () => {
    const code = `${libs('synth')}
const made = []; const AC = window.AudioContext;
window.AudioContext = class extends AC { constructor(...a) { super(...a); made.push(this); } };
const play = seq({ bpm: 100, div: 4, seed: 3 }, (ctx, out, t, i, rnd) => {
  if (i % 4 === 0) sub(ctx, out, t, mtof(36), 0.4);
  if (rnd() < 0.5) pluck(ctx, out, t, mtof(57 + ((rnd() * 12) | 0)), 0.8, { seed: i });
  if (i % 8 === 4) fm(ctx, out, t, mtof(69), 0.5);
});
const loud = seq({ bpm: 240, div: 4, seed: 4 }, (ctx, out, t, i) => {
  for (let k = 0; k < 6; k++) { sub(ctx, out, t, mtof(30 + k * 7), 0.3, { vol: 8 }); fm(ctx, out, t, mtof(50 + k), 0.3, { vol: 8, index: 20 }); }
  pluck(ctx, out, t, mtof(40 + i % 12), 0.5, { vol: 20, seed: i });
});
const level = async (p, ch) => {
  registerAudioProbe(p);
  const ctx = new OfflineAudioContext(ch, 88200, 44100);
  await window.__demopartyAudioProbe(ctx);
  const buf = await ctx.startRendering();
  let peak = 0, sq = 0, n = 0;
  for (let c = 0; c < ch; c++) for (const x of buf.getChannelData(c)) { peak = Math.max(peak, Math.abs(x)); sq += x * x; n++; }
  return { peak, rms: Math.sqrt(sq / n) };
};
const normal = await level(play, 1), stereo = await level(play, 2), hot = await level(loud, 1);
const h = startSynth(play);
const before = { made: made.length, bands: h.bands() };
${done('{ normal, stereo, hot, before }')}
window.__h = h; window.__made = made;`;
    const { page, result, errors } = await runInPage(code);
    expect(errors).toEqual([]);
    for (const k of ['normal', 'stereo', 'hot'] as const) {
      expect(result[k].peak, k).toBeLessThan(0.92);
      expect(result[k].rms, k).toBeGreaterThan(0.005);
    }
    expect(result.hot.peak).toBeGreaterThan(0.8); // the limiter, not luck, held it
    expect(result.before).toEqual({ made: 0, bands: { bass: 0, mid: 0, high: 0, rms: 0 } });
    await page.mouse.click(100, 100);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const w = window as unknown as { __made: AudioContext[]; __h: { bands: () => Record<string, number> } };
      return { made: w.__made.length, state: w.__made[0]?.state, bands: w.__h.bands() };
    });
    await page.keyboard.press('a');
    const stillOne = await page.evaluate(() => (window as unknown as { __made: unknown[] }).__made.length);
    await page.context().close();
    expect(after.made).toBe(1);
    expect(after.state).toBe('running');
    for (const v of Object.values(after.bands)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(stillOne).toBe(1);
  }, 30_000);
});

// ---------- composed piece through the real Stage 6 gates ----------

const PIECE_GLSL = String.raw`
float map(vec3 p){
  p.xz*=rot2(u_time*.35);
  vec3 q=p;q.xz=opRepPolar(q.xz,7.);q.x-=1.7;q.xy*=rot2(u_time*.6);
  float ring=smin(sdTorus(p,vec2(1.7,.12)),sdOctahedron(q,.42),.35);
  float core=max(length(p)-1.05,sdGyroid(p+vec3(0,u_time*.15,0),4.5,.05));
  return min(ring,core);
}
void main(){
  vec2 uv=(gl_FragCoord.xy*2.-u_res)/u_res.y;
  float a=.6+u_time*.18;
  vec3 ro=vec3(4.6*sin(a),1.4+.7*sin(u_time*.23),4.6*cos(a)),f=normalize(-ro),r=normalize(cross(f,vec3(0,1,0))),up=cross(r,f);
  vec3 rd=normalize(f*1.9+uv.x*r+uv.y*up);
  vec3 bg=mix(vec3(.86,.82,.74),vec3(.42,.47,.5),uv.y*.4+.5);
  vec3 c=bg;
  float t=march(ro,rd);
  if(t<20.){
    vec3 p=ro+rd*t,n=calcNormal(p);
    float dif=clamp(dot(n,normalize(vec3(.5,.8,.3))),0.,1.),ao=calcAO(p,n);
    vec3 alb=.55+.35*cos(6.2831*(vec3(.02,.12,.24)+length(p)*.35+u_time*.03));
    c=alb*(.3+.7*dif)*(.4+.6*ao)*(1.+.25*u_audio.x);
    c=mix(c,bg,1.-exp(-.004*t*t));
  }
  o=vec4(pow(c,vec3(.4545)),1);
}`;

const PIECE_WGSL = String.raw`@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{
  let uv=p.xy/u.res;
  return vec4f(.5+.3*cos(6.2831*(uv.x+u.time*.05)),.5+.2*uv.y,.45,1.);
}`;

function composePiece(pick = libs): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lib Smoke</title>
<style>html,body{margin:0;height:100%;background:#d8d0c0;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style>
</head>
<body>
<canvas id="c"></canvas>
<script type="module">
${pick('webgl2', 'sdf', 'synth', 'webgpu')}
const canvas = document.getElementById('c');
const GLSL = sdfGlsl('sdTorus', 'sdOctahedron', 'sdGyroid', 'smin', 'opRepPolar', 'rot2', 'march', 'calcNormal', 'calcAO') + ${JSON.stringify(PIECE_GLSL)};
const music = seq({ bpm: 92, div: 4, seed: 11 }, (ctx, out, t, i, rnd) => {
  if (i % 4 === 0) sub(ctx, out, t, mtof(38), 0.45, { cutoff: 900 });
  if (rnd() < 0.45) pluck(ctx, out, t, mtof([62, 65, 67, 69, 72][(rnd() * 5) | 0]), 1.1, { seed: i, vol: 0.3 });
  if (i % 16 === 8) fm(ctx, out, t, mtof(74), 0.9, { ratio: 3.5, index: 2, vol: 0.12 });
});
registerAudioProbe(music);
const syn = startSynth(music);
const frame = (st) => { const b = syn.bands(); st.audio = [b.bass, b.mid, b.high, b.rms]; };
gpuStart(canvas, ${JSON.stringify(PIECE_WGSL)}, () => glStart(canvas, GLSL, { scale: 0.25, frame }), { scale: 0.25, frame });
</script>
</body>
</html>
`;
}

describe('composed piece through runHardGates', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it.each([['lib', libs], ['lib/min', minLibs]] as const)('%s: webgl2 + sdf + synth + webgpu (fallback) inline into an audiovisual piece that passes every hard gate', async (_label, pick) => {
    const html = composePiece(pick);
    const budget = config.compos.find((c) => c.id === 'audiovisual')!.size_budget_bytes;
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(budget);
    const dir = mkdtempSync(join(tmpdir(), 'lib-gate-'));
    dirs.push(dir);
    const piecePath = join(dir, 'index.html');
    writeFileSync(piecePath, html);
    const r = await runHardGates({ piecePath, compo: 'audiovisual', outDir: join(dir, 'out'), ledgerPath: join(dir, 'none', 'ledger.jsonl'), timingScale: 0.25, repoRoot: REPO });
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.audio_probe?.passed).toBe(true);
    expect(r.audio_probe?.autoplayed).toBe(false);
    expect(r.audio_probe!.peak).toBeLessThan(0.92);
    expect(r.audio_probe!.rms).toBeGreaterThan(0.005);
  }, 120_000);
});
