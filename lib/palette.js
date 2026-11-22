// lib/palette.js: OKLCH -> sRGB with chroma-reducing gamut mapping, cosine palettes, tonal ramps.
// Build palettes from one or two hues plus a lightness ramp, not from neon-on-black defaults.

const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const lin = (L, C, h) => {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
};
const inGamut = (c) => c.every((v) => v > -1e-6 && v < 1 + 1e-6);

/** OKLCH (L 0..1, C ~0..0.37, h degrees) -> sRGB [r, g, b] in 0..1. Out-of-gamut colours lose chroma, not hue. */
export const oklch = (L, C, h) => {
  let c = lin(L, C, h);
  if (!inGamut(c)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; inGamut(lin(L, m, h)) ? (lo = m) : (hi = m); }
    c = lin(L, lo, h);
  }
  return c.map((v) => enc(Math.min(1, Math.max(0, v))));
};

/** [r, g, b] 0..1 -> '#rrggbb'. */
export const hex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

/** Quilez cosine palette: a + b * cos(2 pi (c t + d)), each of a, b, c, d an [r, g, b] array. */
export const cosPal = (t, a, b, c, d) => a.map((v, i) => v + b[i] * Math.cos(2 * Math.PI * (c[i] * t + d[i])));

/** WCAG relative luminance and contrast ratio of sRGB colours (1 to 21). */
export const luminance = (c) => {
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (x, y) => { const a = luminance(x), b = luminance(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

/**
 * Tonal ramp: n colours from dark L0 to light L1 at hue h, drifting by hs degrees (cool shadows, warm
 * lights read as natural). Chroma peaks in the midtones and falls off at both ends.
 */
export const ramp = (n, h, C = 0.12, { L0 = 0.18, L1 = 0.94, hs = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    return oklch(L0 + (L1 - L0) * t, C * (0.3 + 0.7 * Math.sin(Math.PI * t)), h + hs * t);
  });

/** GLSL: cosine palette and OKLCH -> sRGB (clamped, no gamut mapping; keep C modest). h in radians. */
export const GLSL_COSPAL = 'vec3 cosPal(float t,vec3 a,vec3 b,vec3 c,vec3 d){return a+b*cos(6.2831853*(c*t+d));}';
export const GLSL_OKLCH = `vec3 oklch(float L,float C,float h){vec2 ab=C*vec2(cos(h),sin(h));
vec3 l=L+vec3(.3963378,-.1055613,-.0894842)*ab.x+vec3(.2158038,-.0638542,-1.2914855)*ab.y;l=l*l*l;
vec3 c=clamp(mat3(4.0767417,-1.2684380,-.0041961,-3.3077116,2.6097574,-.7034186,.2309699,-.3413194,1.7076147)*l,0.,1.);
return mix(12.92*c,1.055*pow(c,vec3(1./2.4))-.055,step(.0031308,c));}`;
