// lib/sdf.js: 2D SDF helpers in JS; GLSL SDF + raymarch snippets.

// 2D distances, negative inside; boxes take half-extents.
export const sdCircle = (x, y, r) => Math.hypot(x, y) - r;
export const sdBox = (x, y, bx, by) => {
  const dx = Math.abs(x) - bx, dy = Math.abs(y) - by;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
};
export const sdRoundBox = (x, y, bx, by, r) => sdBox(x, y, bx - r, by - r) - r;
export const sdSegment = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, ex = bx - ax, ey = by - ay;
  const h = Math.min(1, Math.max(0, (px * ex + py * ey) / (ex * ex + ey * ey)));
  return Math.hypot(px - ex * h, py - ey * h);
};
export const sdCapsule = (x, y, ax, ay, bx, by, r) => sdSegment(x, y, ax, ay, bx, by) - r;
export const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const opSmoothSubtraction = (d, cut, k) => -smin(-d, cut, k);
export const rot2 = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * x - s * y, s * x + c * y]; };
export const opRep = (x, s) => x - s * Math.round(x / s);
export const opRepPolar = (x, y, n) => {
  const an = (2 * Math.PI) / n, a = Math.atan2(y, x) + an / 2, r = Math.hypot(x, y);
  const b = a - an * Math.floor(a / an) - an / 2;
  return [r * Math.cos(b), r * Math.sin(b)];
};

// GLSL: name -> [deps, code]. Raymarch helpers declare `float map(vec3 p);` for you.
export const SDF_GLSL = {
  sdCircle: [[], 'float sdCircle(vec2 p,float r){return length(p)-r;}'],
  sdBox2: [[], 'float sdBox2(vec2 p,vec2 b){vec2 d=abs(p)-b;return length(max(d,0.))+min(max(d.x,d.y),0.);}'],
  sdBox: [[], 'float sdBox(vec3 p,vec3 b){vec3 d=abs(p)-b;return length(max(d,0.))+min(max(d.x,max(d.y,d.z)),0.);}'],
  sdRoundBox: [[], 'float sdRoundBox(vec3 p,vec3 b,float r){vec3 d=abs(p)-b+r;return length(max(d,0.))+min(max(d.x,max(d.y,d.z)),0.)-r;}'],
  sdSegment: [[], 'float sdSegment(vec3 p,vec3 a,vec3 b){vec3 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));}'],
  sdCapsule: [['sdSegment'], 'float sdCapsule(vec3 p,vec3 a,vec3 b,float r){return sdSegment(p,a,b)-r;}'],
  sdTorus: [[], 'float sdTorus(vec3 p,vec2 t){return length(vec2(length(p.xz)-t.x,p.y))-t.y;}'],
  sdOctahedron: [[], 'float sdOctahedron(vec3 p,float s){p=abs(p);return (p.x+p.y+p.z-s)*.57735027;}'],
  sdGyroid: [[], 'float sdGyroid(vec3 p,float s,float th){return (abs(dot(sin(p*s),cos(p.zxy*s)))/s-th)*.6;}'],
  smin: [[], 'float smin(float a,float b,float k){float h=max(k-abs(a-b),0.)/k;return min(a,b)-h*h*k*.25;}'],
  opSmoothSubtraction: [['smin'], 'float opSmoothSubtraction(float d,float cut,float k){return -smin(-d,cut,k);}'],
  opRep: [[], 'vec3 opRep(vec3 p,vec3 s){return p-s*round(p/s);}'],
  opRepPolar: [[], 'vec2 opRepPolar(vec2 p,float n){float an=6.2831853/n,a=atan(p.y,p.x)+an*.5;a=mod(a,an)-an*.5;return length(p)*vec2(cos(a),sin(a));}'],
  rot2: [[], 'mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,s,-s,c);}'],
  map: [[], 'float map(vec3 p);'],
  calcNormal: [['map'], 'vec3 calcNormal(vec3 p){vec2 e=vec2(1,-1)*.001;return normalize(e.xyy*map(p+e.xyy)+e.yyx*map(p+e.yyx)+e.yxy*map(p+e.yxy)+e.xxx*map(p+e.xxx));}'],
  calcAO: [['map'], 'float calcAO(vec3 p,vec3 n){float o=0.,s=1.;for(int i=1;i<=5;i++){float h=.02+.04*float(i);o+=(h-map(p+n*h))*s;s*=.7;}return clamp(1.-2.*o,0.,1.);}'],
  softShadow: [['map'], 'float softShadow(vec3 ro,vec3 rd,float k){float r=1.,t=.02;for(int i=0;i<32;i++){float h=map(ro+rd*t);r=min(r,k*h/t);t+=clamp(h,.02,.3);if(r<.002||t>12.)break;}return clamp(r,0.,1.);}'],
  march: [['map'], 'float march(vec3 ro,vec3 rd){float t=0.;for(int i=0;i<64;i++){float h=map(ro+rd*t);if(abs(h)<.001*t||t>20.)break;t+=h;}return t;}'],
};

/** Named SDF_GLSL snippets plus deps, each once, deps first. */
export const sdfGlsl = (...names) => {
  const out = [], seen = new Set();
  const add = (n) => {
    if (seen.has(n)) return;
    if (!SDF_GLSL[n]) throw Error('sdfGlsl: unknown snippet ' + n);
    seen.add(n); SDF_GLSL[n][0].forEach(add); out.push(SDF_GLSL[n][1]);
  };
  names.forEach(add);
  return out.join('\n');
};
