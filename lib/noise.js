// lib/noise.js: seeded PRNGs, simplex noise, fBM, ridged, domain warp; GLSL noise snippets.

/** mulberry32: 32-bit seed -> () => float in [0, 1). */
export const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** xoshiro128**: four 32-bit seeds (not all zero) -> () => float in [0, 1). */
export const xoshiro128ss = (a, b, c, d) => () => {
  const m = Math.imul(b, 5), r = Math.imul((m << 7) | (m >>> 25), 9), t = b << 9;
  c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
  return (r >>> 0) / 4294967296;
};

const G3 = [1,1,0, -1,1,0, 1,-1,0, -1,-1,0, 1,0,1, -1,0,1, 1,0,-1, -1,0,-1, 0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1];

/** Seeded simplex noise -> { n2(x, y), n3(x, y, z) } in [-1, 1]. */
export function simplex(seed = 1) {
  const r = mulberry32(seed), P = [...Array(256).keys()], p = new Uint8Array(512);
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 512; i++) p[i] = P[i & 255];
  const g = (h, x, y, z) => (h = (h % 12) * 3, G3[h] * x + G3[h + 1] * y + G3[h + 2] * z);
  const c = (x, y, z, h, r0) => { let q = r0 - x * x - y * y - z * z; return q < 0 ? 0 : (q *= q, q * q * g(h, x, y, z)); };
  const n2 = (x, y) => {
    const G = 0.21132486540518713, s = (x + y) * 0.36602540378443865;
    const i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G;
    const x0 = x - i + t, y0 = y - j + t, i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1, a = i & 255, b = j & 255;
    return 70 * (c(x0, y0, 0, p[a + p[b]], 0.5) + c(x0 - i1 + G, y0 - j1 + G, 0, p[a + i1 + p[b + j1]], 0.5) +
      c(x0 - 1 + 2 * G, y0 - 1 + 2 * G, 0, p[a + 1 + p[b + 1]], 0.5));
  };
  const n3 = (x, y, z) => {
    const G = 1 / 6, s = (x + y + z) / 3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s), t = (i + j + k) * G;
    const x0 = x - i + t, y0 = y - j + t, z0 = z - k + t;
    const [i1, j1, k1, i2, j2, k2] = x0 >= y0
      ? (y0 >= z0 ? [1, 0, 0, 1, 1, 0] : x0 >= z0 ? [1, 0, 0, 1, 0, 1] : [0, 0, 1, 1, 0, 1])
      : (y0 < z0 ? [0, 0, 1, 0, 1, 1] : x0 < z0 ? [0, 1, 0, 0, 1, 1] : [0, 1, 0, 1, 1, 0]);
    const a = i & 255, b = j & 255, d = k & 255;
    return 32 * (c(x0, y0, z0, p[a + p[b + p[d]]], 0.6) +
      c(x0 - i1 + G, y0 - j1 + G, z0 - k1 + G, p[a + i1 + p[b + j1 + p[d + k1]]], 0.6) +
      c(x0 - i2 + 2 * G, y0 - j2 + 2 * G, z0 - k2 + 2 * G, p[a + i2 + p[b + j2 + p[d + k2]]], 0.6) +
      c(x0 - 0.5, y0 - 0.5, z0 - 0.5, p[a + 1 + p[b + 1 + p[d + 1]]], 0.6));
  };
  return { n2, n3 };
}

/** fBM over n2 or n3 -> (x, y, z) => sum, |sum| < 1. */
export const fbm = (n, oct = 5, lac = 2, gain = 0.5) => (x, y, z) => {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++, f *= lac, a *= gain) s += a * n(x * f, y * f, z * f);
  return s;
};

/** Ridged multifractal, result in [0, 1). */
export const ridged = (n, oct = 5, lac = 2, gain = 0.5) => (x, y, z) => {
  let s = 0, a = 0.5, f = 1, w = 1;
  for (let i = 0; i < oct; i++, f *= lac, a *= gain) {
    let v = 1 - Math.abs(n(x * f, y * f, z * f));
    v *= v * w; w = Math.min(1, v * 2); s += a * v;
  }
  return s;
};

/** Domain warp (Quilez) of a 2D field f. */
export const warp = (f, k = 1) => (x, y) => f(x + k * f(x + 5.2, y + 1.3), y + k * f(x + 1.7, y + 9.2));

// GLSL: name -> [deps, code]. Needs highp int (GL_HEAD). Lattice domain |p| < 65536.
export const NOISE_GLSL = {
  hashU: [[], 'uint hashU(uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return x;}'],
  hash31: [['hashU'], 'float hash31(vec3 p){uvec3 q=uvec3(ivec3(floor(p))+65536);return float(hashU(q.x+hashU(q.y+hashU(q.z))))*2.3283064e-10;}'],
  hash33: [['hashU'], 'vec3 hash33(vec3 p){uvec3 q=uvec3(ivec3(floor(p))+65536);uint h=hashU(q.x+hashU(q.y+hashU(q.z)));return vec3(uvec3(h,h>>10u,h>>20u)&1023u)*(2./1023.)-1.;}'],
  vnoise: [['hash31'], 'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);vec3 c=vec3(i,0);return mix(mix(hash31(c),hash31(c+vec3(1,0,0)),u.x),mix(hash31(c+vec3(0,1,0)),hash31(c+vec3(1,1,0)),u.x),u.y);}'],
  gnoise: [['hash33'], `float gcorner(vec3 i,vec3 f,vec3 o){return dot(hash33(i+o),f-o);}
float gnoise(vec3 p){vec3 i=floor(p),f=fract(p),u=f*f*f*(f*(f*6.-15.)+10.);vec2 e=vec2(0,1);
return mix(mix(mix(gcorner(i,f,e.xxx),gcorner(i,f,e.yxx),u.x),mix(gcorner(i,f,e.xyx),gcorner(i,f,e.yyx),u.x),u.y),
mix(mix(gcorner(i,f,e.xxy),gcorner(i,f,e.yxy),u.x),mix(gcorner(i,f,e.xyy),gcorner(i,f,e.yyy),u.x),u.y),u.z);}`],
  fbm: [['gnoise'], 'float fbm(vec3 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*gnoise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}'],
  ridged: [['gnoise'], 'float ridged(vec3 p){float s=0.,a=.5,w=1.;for(int i=0;i<5;i++){float v=1.-abs(gnoise(p));v*=v*w;w=clamp(v*2.,0.,1.);s+=a*v;p*=2.03;a*=.5;}return s;}'],
  warp: [['fbm'], 'float warp(vec3 p){vec3 q=vec3(fbm(p),fbm(p+vec3(5.2,1.3,2.8)),0);return fbm(p+2.*q);}'],
};

/** Named NOISE_GLSL snippets plus deps, each once, deps first. */
export const noiseGlsl = (...names) => {
  const out = [], seen = new Set();
  const add = (n) => {
    if (seen.has(n)) return;
    if (!NOISE_GLSL[n]) throw Error('noiseGlsl: unknown snippet ' + n);
    seen.add(n); NOISE_GLSL[n][0].forEach(add); out.push(NOISE_GLSL[n][1]);
  };
  names.forEach(add);
  return out.join('\n');
};
