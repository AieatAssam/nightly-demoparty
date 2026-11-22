---
name: demo-craft
description: "Craft and gate rules for the nightly generative piece (one self-contained piece/index.html). Covers mechanism-as-image, the permanent demo slop list, the 20 s four-beat arc judged at t=2/8/20 s, palette and material, lib/min byte budgets per compo, SwiftShader-safe shaders, and the hard-gate contracts. Load it before writing or fixing a piece."
---

# demo-craft

You build one `index.html` per night. A jury sees **three screenshots only: t=2 s, t=8 s, t=20 s**, at 1280x720, DPR 1, in headless Chromium with SwiftShader (software GL). **No pointer or key input happens before those shots.** The jury never hears audio; it sees only the probe numbers. Rubric: mechanism 20, ambition 25, craft 25, distinct from last 7 nights 20, polish 10. The publish bar is 72.

## 1. The mechanism IS the image

Run the researched rule and let the picture come out of it. Do not describe it.

| Score | Anchor | What earned or lost it |
|---|---|---|
| 87 | 10 Winfree Rotors | Live reaction-diffusion. Rings at 2 s, collisions and cuts at 8 s, a mosaic of spirals at 20 s. No text needed. Indigo shifts to copper on a linen ground, with gradient-normal liquid sheen. |
| 84 | 11 Pulse Relief | Real data drawn three ways: pen chart, then a 30-channel waterfall, then a 3D relief. Archival plate look: parchment, graphite and vermilion. |
| 80 | 12 Laplace Chain | Orbital resonances draw chord roses. Close orrery, then the system opens out, then a face-on rose. Crimson to gold. Lost craft because the 20 s frame is overplotted mud. |
| 75 | 09 Cooling Front | Crack net, then hexagon lattice, then a raymarched causeway at dusk. Lost craft for artefacts and an abrupt jump between acts. |
| 53 | 04 Breath at 3,400 m | The mechanism the brief names is not visible in the form. An inset sparkline and a caption carry it. |
| 51 | 03 One Beam, Two Clocks | Textbook physics applet: readouts and a status label state the result, with flat discs on slate. |
| 49 | 01 Nodal Lines | One flat isoline formula, no material or light, under half the budget used. |
| 35 | 02 Twice as Often | A title-card slideshow: headline plus subline in every frame. |

Rules:
- **Deletion test:** remove every text element. If the three frames no longer show the mechanism, rebuild.
- Prefer emergence to keyframes: a ping-pong FBO simulation, particles under forces, an iterated map, a cellular automaton, or an integrator. Tweened shapes read as a slideshow.
- Text is allowed only as a small title block, axis or scale labels, or data annotations at the edge. Never a sentence that explains the idea, never a full-screen card, never more ink than form.
- Ambition means at least two rendering ideas that change between acts (flat field to extruded 3D, chart to waterfall to relief). One formula with the budget half empty reads as low effort.
- Composition: a centred disc on a dark ground is the set's most worn layout (anchors 04, 07, 08, 10, 12). Prefer off-centre masses, horizons, plates with margins, grids, or a cutaway.

## 2. Permanent demo slop list (hard bans)

Items marked **[lint]** fail Stage 6 statically. The rest are marked down by the jury.
- Plain plasma, sine sums as the whole picture. **[lint]** for 4 chained `sin(..)+sin(..)+sin(..)+sin(` terms in JS **or GLSL**.
- Plain starfield, plain tunnel (concentric rings flying past), Matrix rain (**[lint]** `matrixRain`, `katakana...drop`).
- Mouse-following particles with no system behind them.
- A single raymarched sphere or torus on a gradient. An untouched Mandelbrot or Julia zoom.
- Purple-to-blue or teal-to-orange gradient as the whole palette. Neon on black by default.
- Bloom or chromatic aberration hiding an empty scene.
- `Math.random()` **anywhere**, strings included. **[lint]** Use `mulberry32(seed)` from noise.js, or a 3-line hash.
- A loop whose 20 s frame looks like its 2 s frame.
- Title cards or captions doing the visuals' job.
- Shadertoy copies or boilerplate. **[lint]** `mainImage(out vec4`, `shadertoy.com`. Never reproduce a known work.

## 3. The 20-second four-beat arc

| Beat | Story time | Job | Shot |
|---|---|---|---|
| 1 Seed | 0 to 5 s | Establish material, ground and the rule's first visible output. Structure on screen from frame 0. | t=2 s |
| 2 Instability | 5 to 10 s | The mechanism acts: things collide, break, branch, interfere, or the hidden variable shows. | t=8 s |
| 3 Climax | 10 to 15 s | Phase transition and peak richness, often a new rendering mode. **Never photographed.** | none |
| 4 Resolution | 15 to 20 s+ | Pull back or settle into a final composition that **holds beat 3's result**. Keep slow motion alive past 20 s. | t=20 s |

- The three frames must differ in composition, scale or tonal weight, not just phase. The gate needs a mean t2-to-t20 difference of at least 2.5; aim far higher. Novelty also compares a perceptual hash against the whole archive (Hamming distance of at least 10) and a colour histogram against the last 14 nights (distance of at least 0.18).
- Every shot: luminance variance at least 12 (no flat fog, no near-black void), subject inside a 5% margin, nothing key cropped, no washed-out overplot (anchor 12's 20 s mud cost it craft points).
- Clocks are frame-driven: time starts at the first rAF after shader compile and each frame adds at most 0.5 s. Story time therefore lags wall time. **Hold each photographed state through a window** (story 1.2 to 3.5 s and 6.5 to 9.5 s), never at an instant.
- Under `prefers-reduced-motion` the lib clocks run at 0.2x: wall 2 s is story 0.4 s and wall 8 s is story 1.6 s. **Beat 1 must read well from story t=0.** Pre-seed or pre-warm the state.
- Mix beat parameters with easing.js: `const [w0,w1,w2,w3] = acts(t); zoom = w0*1 + w1*1.4 + w2*0.8 + w3*1.1;`. Use `beat(t, t0, t1)` for a single eased ramp.
- Follow the brief's storyboard and its mood mapping: arousal sets tempo and density, pleasure sets warmth and consonance, dominance sets scale and contrast.

## 4. Colour and material

- Start from the brief's explicit hex values. Use 3 to 5 tones: ground, two or three mids, one accent, one highlight. Example: `ramp(5, h, 0.1, { hs: 25 })` for the ground ladder (cool shadows to warm lights), plus one accent at `h + 150` with lower L, via `oklch()`. Pass the colours to GLSL as uniforms, or use `GLSL_OKLCH` (keep C under 0.15) or `GLSL_COSPAL`.
- Grounded families to draw from:
  - Mineral: slate, ochre, malachite, chalk.
  - Archival paper or vellum: cream ground, graphite ink, vermilion marks.
  - Volcanic: basalt, ember, ash.
  - Botanical: moss, lichen, chlorophyll, bark.
  - Ceramic glaze: celadon, tenmoku brown, iron rust.
  - Twilight: dusk slate and sodium amber (not a purple-blue sweep).
  - Oxidised metal: verdigris, copper, patina.
- Figure against ground: `contrast(fg, bg)` of at least 3 for key forms. Light or mid-tone grounds stand out in an archive full of black.
- Material cues: paper grain (hash noise at about 0.015 amplitude, frozen when `u_reduced` is 1), gradient-normal shading for liquids and reliefs, rim light, cheap AO, 1 px hairlines anti-aliased with `fwidth`, a gentle vignette.
- Avoid moiré: no dense 1 px periodic hatching; keep line pitch at least 3 px or fade fine lines out.
- Avoid overdraw washout: tonemap with `1.-exp(-c*k)`, keep additive line alpha at or below 0.08, and thin old strokes over time.

## 5. lib/min within compo budgets

Size gate = `Buffer.byteLength` of the raw `index.html` as UTF-8. Markup, CSS, whitespace, comments all count. Non-ASCII characters count 2 to 4 bytes. Nothing is minified for you.

| File | min bytes | raw bytes | Gives you |
|---|---|---|---|
| `lib/min/webgl2.js` | 3093 | 4584 | `GL_HEAD`, `glProgram`, `glSetter`, `glDraw`, `glStart`, `createPingPong` |
| `lib/min/noise.js` | 3544 | 5419 | `mulberry32`, `xoshiro128ss`, `simplex`, `fbm`, `ridged`, `warp`, `NOISE_GLSL`, `noiseGlsl` |
| `lib/min/sdf.js` | 3331 | 4198 | 2D SDFs, `smin`, `rot2`, `opRep*`, `SDF_GLSL`, `sdfGlsl` (march 64 steps, softShadow 32) |
| `lib/min/synth.js` | 3706 | 5964 | `mtof`, `synthBus`, `fm`, `sub`, `ksBuffer`, `pluck`, `seq`, `startSynth`, `registerAudioProbe` |
| `lib/min/palette.js` | 1713 | 3056 | `oklch`, `hex`, `cosPal`, `luminance`, `contrast`, `ramp`, `GLSL_COSPAL`, `GLSL_OKLCH` |
| `lib/min/easing.js` | 1027 | 2208 | `clamp01`, `lerp`, `smooth`, `quintic`, easings, `beat`, `CUTS`, `act`, `acts`, `storyClock` |
| `lib/min/webgpu.js` | 2641 | 3886 | `gpuStart` with WebGL2 fallback |

GLSL snippet bytes (copy the string out of `lib/noise.js`, `lib/sdf.js` or `lib/palette.js`; deps first):
- noise: hashU 89, hash31 120, hash33 154, vnoise 192, gnoise 383, fbm 114, ridged 148, warp 86. Deps: hash31 and hash33 need hashU; check the `[deps, code]` pairs in `NOISE_GLSL`.
- sdf: sdCircle 51, sdBox2 91, sdBox 99, sdRoundBox 116, sdSegment 114, sdCapsule 73, sdTorus 76, sdOctahedron 78, sdGyroid 90, smin 92, opSmoothSubtraction 77, opRep 49, opRepPolar 131, rot2 66, map 18, calcNormal 142, calcAO 147, softShadow 183, march 129.
- palette: GLSL_COSPAL 84, GLSL_OKLCH 355. webgl2: GL_HEAD 176.

Pasting: put the min files verbatim, one after another, in **one** `<script type="module">`, then your code. Never redeclare an export or a reserved name: `G3`, `env`, `srng`, `GL_VS`, `WGSL_HEAD`, `enc`, `inGamut`, `lin`.

Per compo:
- **4k-shader (4096 B):** no whole file fits. Use the bootstrap in section 5a and copy only the snippet strings you need. One fragment shader with a time arc.
- **16k-demo (16384 B):** leave at least 4 KB for scene logic. Best default: webgl2 + palette + easing (5833 B) plus pasted GLSL snippets. Ceiling: webgl2 + noise + sdf (9968 B) or those three plus palette (11681 B, leaves 4703 B). Never four whole files plus easing.
- **audiovisual (24576 B):** synth + webgl2 + palette + easing = 9539 B; adding noise makes 13083 B.
- **simulation, interactive-toy (24576 B):** webgl2 + noise + palette + easing = 9377 B.
- **kinetic-type (12288 B):** canvas 2D or SVG with palette + easing + noise (6284 B). Set the research's own words, not a caption.
- **data-sculpture (32768 B, data counts):** keep libs under about 10 KB and inline the dossier dataset compactly (numeric arrays, no repeated keys).
- **webgpu:** only when you need compute. The gates serve plain http, so `navigator.gpu` is absent and **only the WebGL2 fallback is ever screenshotted**. The fallback must be a faithful port: same motion, palette and flash behaviour. Usually skip it.
- **constraint-night** (read `plan.constraint`):
  - `1kb-micro` (1024 B): no lib file. Hand-write a minimal 4K-style bootstrap, or canvas 2D. At most one tiny snippet (`hashU`, 89 B). Development and reduced motion are still gated.
  - `two-colour` (16384 B): the lint counts distinct `#hex`, `rgb()`, `rgba()`, `hsl()` literals in the **whole source**. Write exactly two colours once each and reuse the variables. The lib/min files contain none. Hex-looking ids or selectors (`#bad`, `#fed`, `#ace`) also count, so avoid them. GLSL `vec3` colours are not counted but still render, so they must be the same two. Render with `step()` or dithering, not anti-aliased blends, so no third tone appears.
  - `css-only` (16384 B): no `<script>`, no inline `on*` handlers, no `<canvas>`. Use CSS `@keyframes`, gradients and many DOM elements. Reduced motion: under `@media (prefers-reduced-motion: reduce)` lengthen `animation-duration` at least 3x and shrink amplitudes, but keep it non-blank.
  - `no-canvas` (16384 B): SVG or DOM only. No `<canvas>`, no `createElement('canvas')`, no `OffscreenCanvas`. noise, sdf (2D), palette and easing are allowed. `document.createElementNS('http://www.w3.org/2000/svg', 'path')` is allowed by the URL lint.

### 5a. Snippets that pass the gates

4K bootstrap (about 600 B). `F` is a fragment shader string starting **exactly** with `#version 300 es` (no leading newline), declaring `precision highp float;uniform vec4 U;out vec4 o;`. `U.x` = time, `U.yz` = resolution, `U.w` = 1 under reduced motion (use it to freeze grain and damp fast terms).
```js
const c=document.getElementById('c'),g=c.getContext('webgl2'),R=matchMedia('(prefers-reduced-motion: reduce)'),P=g.createProgram();
[[35633,'#version 300 es\nvoid main(){gl_Position=vec4(vec2(gl_VertexID&1,gl_VertexID>>1)*4.-1.,0,1);}'],[35632,F]].forEach(([k,s])=>{const h=g.createShader(k);g.shaderSource(h,s);g.compileShader(h);g.attachShader(P,h)});
g.linkProgram(P);g.useProgram(P);const L=g.getUniformLocation(P,'U');let T=0,M=-1;
const f=m=>{requestAnimationFrame(f);const w=c.clientWidth>>1,h=c.clientHeight>>1;if(c.width!=w||c.height!=h){c.width=w;c.height=h}T+=M<0?0:Math.min((m-M)/1e3,.5)*(R.matches?.1:1);M=m;g.viewport(0,0,w,h);g.uniform4f(L,T,w,h,R.matches?1:0);g.drawArrays(4,0,3)};
requestAnimationFrame(f);
```
with `<canvas id=c></canvas>` and CSS `*{margin:0}canvas{width:100vw;height:100vh;display:block}`.

Simulation stepped by story time (anchor 10 pattern). Reduced motion slows it, frame rate cannot change the story, and the canvas size is unknown until the first frame:
```js
// SIM = GL_HEAD + `uniform sampler2D S;uniform float K,T; void main(){ if(K>0.){ /* seed */ return; } /* step */ }`
// RENDER = `uniform sampler2D S; void main(){ ... texture(S, uv) ... }`   (glStart adds GL_HEAD; glProgram does not)
const N = 256, SPS = 30, CAP = 6; let sim, setS, pp, steps = 0;
const st = glStart(cv, RENDER, { scale: 0.5, frame(st) {
  const gl = st.gl;
  gl.useProgram(sim || (sim = glProgram(gl, SIM))); gl.activeTexture(gl.TEXTURE0);
  if (!pp) { setS = glSetter(gl, sim); pp = createPingPong(gl, N, N);
    gl.bindTexture(gl.TEXTURE_2D, pp.a.tex); setS('K', 1); glDraw(gl, pp.b.fb, N, N); pp.swap(); setS('K', 0); }
  for (let n = Math.min(CAP, Math.floor(st.time * SPS) - steps); n > 0; n--) {
    steps++; setS('T', steps / SPS); gl.bindTexture(gl.TEXTURE_2D, pp.a.tex); glDraw(gl, pp.b.fb, N, N); pp.swap();
  }
  gl.bindTexture(gl.TEXTURE_2D, pp.a.tex); // RENDER samples unit 0
} });
```
- The seed pass runs once, so t=0 already has structure.
- **Bind `pp.a.tex` before every draw into `pp.b.fb`.** `createPingPong` leaves `pp.b.tex` bound. Drawing into its own framebuffer is a feedback loop, the draw is silently dropped, and the reduced-motion frame comes out blank (this failed in testing).
- Keep `N*N*CAP` cheap.

Audio wiring (audiovisual):
```js
const play = seq({ bpm: 92, seed: 7 }, (ctx, out, t, i, rnd) => { if (i % 4 === 0) sub(ctx, out, t, mtof(36), 0.4); if (rnd() < 0.4) pluck(ctx, out, t, mtof(60 + (rnd() * 12 | 0)), 1.2, { seed: i }); });
registerAudioProbe(play);           // window.__demopartyAudioProbe: 2 s offline render from t=0; startSynth makes the AudioContext only after a gesture
let off = null;                     // story time at unlock; add this listener BEFORE startSynth
for (const e of ['pointerdown', 'keydown']) document.addEventListener(e, () => { if (off === null) off = st.time; });
const syn = startSynth((ctx, out, t0, t1, base) => play(ctx, out, t0 + off, t1 + off, base - off));
// each frame: const b = syn.bands(); st.audio = [b.bass, b.mid, b.high, b.rms];
```
The offset keeps the music in step with the visuals when a visitor clicks at, say, 25 s (anchor 12 pattern). `st` is the `glStart` handle.
- Never `const { bands } = startSynth(...)`: the handle's `bands` is replaced once audio unlocks.
- **bands() is zero in all three screenshots**, because the gates click only after them. Drive the visuals from the same deterministic score that drives the sound (time to step index to note), and use bands only as extra detail.
- Notes must start at t=0 so the probe's 2 s clears RMS 0.005. `synthBus` limits the peak to 0.87, under the 0.92 target. If you build your own graph, end it with a compressor, a tanh `WaveShaper` and a master gain at or below 0.3.

Interactive toy: the gates send no pointer events. Run a seeded **attract mode** that performs the interaction itself (scripted strokes, drops or pushes, as anchor 10 scripts its scratches) until the first real `pointerdown` or `keydown`. Input must change the system, not just the camera.

## 6. Shader and SwiftShader hygiene

- A shader string you write with your own header must start with `#version 300 es` at byte 0. A template literal that opens with a newline breaks compilation. Otherwise omit the header and let `glStart` prepend `GL_HEAD`; then do not redeclare `u_time`, `u_res`, `u_mouse`, `u_audio`, `u_reduced` or `o`.
- `precision highp float;` and `precision highp int;` (the hashes use `uint`).
- Loops have constant bounds, `for(int i=0;i<48;i++){ if(d<eps) break; }`. No `while`.
- Raymarch at most 64 steps (lib `march` is 64), soft shadow at most 32, AO at most 5 taps. Render raymarched scenes at `glStart` `scale: 0.5`, `dprMax: 1`. NOISE_GLSL `warp` costs 3 fbm calls, so never call it inside a march loop.
- Simulation textures: 256x256 by default, 512x512 at most, with cheap steps.
- Frame budget: median frame at or below 250 ms on SwiftShader at 1280x720. Aim under 120 ms. Canvas 2D: avoid `shadowBlur` and `filter: blur()` (very slow in software), batch paths, cap the element count.
- Analytic AA: `float w=fwidth(d); a=smoothstep(w,-w,d);`. Use hard `step` only on two-colour nights.
- No NaN: guard `sqrt`, `pow`, `normalize` and division against zero or negative input.
- A shader compile error is a console error, which fails the gate.
- No `window.__*` globals other than `window.__demopartyAudioProbe`. No debug globals at all.

## 7. Hard gates: pass on attempt 1

Network and CSP. **Do not add a CSP meta tag**: the gates and publish inject the canonical one, and any other CSP meta fails lint as `csp/mismatch`. The published CSP is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:`. Every violation is a console error. Banned:
- `eval`, `Function(`, `.constructor` access, and `setTimeout` or `setInterval` with a string.
- `fetch`, `XMLHttpRequest`, `WebSocket`, `import(`, Workers and AudioWorklets (blob scripts are blocked), and any `fetch` of `data:`.
- Any URL literal. The only exceptions are the SVG, XLink and XHTML namespace URIs.
- Writing to `location`, `location.assign`, `replace` or `reload`, `window.open(`, and a bare `open(`, so never name a function `open`.
- `<form>`, `javascript:`, `RTCPeerConnection` and other `RTC*` constructors.
- Fonts: there is no `font-src`, so even a `data:` font is blocked. Use system stacks: `Georgia,serif`, `ui-monospace,Menlo,monospace`, `system-ui,sans-serif`.

Photosensitivity: never flash more than 9.5% of the viewport faster than 3 Hz at any point from 0.5 s to past 20 s. No full-frame luminance pulses on the beat, no hard cuts faster than every 0.34 s, no strobing grain at high amplitude. Audio-reactive brightness goes through smoothed bands.

Reduced motion (`prefers-reduced-motion: reduce`): the variant is sampled at wall t=2 s and t=8 s. Its motion must be at most 0.65x normal motion, or at most 1.5 absolute, at **both** times, and it must stay non-blank (luminance variance of at least 6). `glStart` and `storyClock` already slow time 0.2x, but fine high-frequency patterns still measured 0.60 at 0.2x in testing. The 4K bootstrap uses 0.1x (measured 0.32). For fine patterns pass `glStart(..., { reduce: 0.1 })` and damp fast terms with `u_reduced`. Simulations must step from `st.time` (section 5a), not once per frame. Freeze grain and camera shake when `u_reduced` is 1. Canvas 2D or CSS pieces must do the same themselves.

Audio compos:
- No audible sample before a `pointerdown` or `keydown`. `startSynth` handles this; never create a live `AudioContext` at load.
- Always register `window.__demopartyAudioProbe = async (offlineCtx) => ...`; `registerAudioProbe(play)` does it.
- Probe output: 2 s, RMS at least 0.005, peak under 0.92, and no clipping (samples at 0.999 or above must stay under 1%).

Gate numbers: luminance variance at least 12 at t2, t8 and t20. Mean frame difference at least 0.8. t2-to-t20 difference at least 2.5. Median frame time at most 250 ms. Zero console errors and zero network requests. Size within budget.

## 8. Self-check loop

1. `npm run gate -- piece/index.html --compo <compo> --out <dir>`, adding `--constraint <id>` on constraint nights. Audiovisual turns on the audio checks automatically.
2. Open `<dir>`'s `gates.json`. Read **every** entry in `failures` (`gate`, `measured`, `threshold`) and every lint violation, then look at `shot-02s.png`, `shot-08s.png` and `shot-20s.png` as the jury will.
3. Fix the root cause, not the symptom:
   - `luminance`: the frame is empty or flat. Pre-seed beat 1 and lift the ground off black. Do not add noise.
   - `motion`: the scene froze. Keep the system evolving.
   - `development`: t20 resembles t2. Change scale, composition or rendering mode in beats 3 and 4.
   - `frame_time`: halve the resolution (`scale: 0.5`), cut march steps or sim size, drop `warp`.
   - `strobe`: remove beat flashes and ease brightness changes over at least 0.5 s.
   - `reduced_motion`: step the simulation from `st.time` and freeze grain.
   - `audio_*`: register the probe, start notes at t=0, route through `synthBus`.
   - `console` or `lint`: remove the banned API, never wrap it in try/catch.
   - `novelty_*`: change palette family and composition, not tiny details.
4. Re-run until `passed` is true, then check the shots against the brief's storyboard and the deletion test.
