// lib/webgl2.js: fullscreen-triangle WebGL2 bootstrap, standard uniforms, ping-pong FBOs.

/** Prepended to fragment sources without #version. Write to `o`. */
export const GL_HEAD = `#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
uniform float u_time,u_reduced;uniform vec2 u_res,u_mouse;uniform vec4 u_audio;out vec4 o;
`;
const GL_VS = '#version 300 es\nvoid main(){gl_Position=vec4(vec2(gl_VertexID&1,gl_VertexID>>1)*4.-1.,0,1);}';

/** Compiles and links; throws with the info log. */
export function glProgram(gl, frag, vert = GL_VS) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vert], [gl.FRAGMENT_SHADER, frag]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error('GLSL compile failed: ' + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error('GLSL link failed: ' + gl.getProgramInfoLog(p));
  return p;
}

/** set(name, number | array) for active uniforms; unknown names are ignored. */
export function glSetter(gl, prog) {
  const fns = { [gl.FLOAT]: 'uniform1fv', [gl.FLOAT_VEC2]: 'uniform2fv', [gl.FLOAT_VEC3]: 'uniform3fv', [gl.FLOAT_VEC4]: 'uniform4fv', [gl.INT]: 'uniform1iv', [gl.SAMPLER_2D]: 'uniform1iv' };
  const u = {};
  for (let i = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i--;) {
    const a = gl.getActiveUniform(prog, i);
    u[a.name.replace('[0]', '')] = [gl.getUniformLocation(prog, a.name), fns[a.type]];
  }
  return (name, v) => { const x = u[name]; if (x && x[1]) gl[x[1]](x[0], typeof v === 'number' ? [v] : v); };
}

/** Draws the fullscreen triangle into fb (null = screen). */
export const glDraw = (gl, fb = null, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight) => {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

/** Render loop: frame(st) runs first (extra passes, st.audio), then frag draws to screen. Reduced motion slows time to `reduce`. */
export function glStart(canvas, frag, { scale = 1, dprMax = 1, reduce = 0.2, frame } = {}) {
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) throw Error('WebGL2 unavailable');
  const prog = glProgram(gl, frag.startsWith('#version') ? frag : GL_HEAD + frag);
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const st = { kind: 'webgl2', gl, prog, set: glSetter(gl, prog), time: 0, reduced: false, mouse: [0.5, 0.5], audio: [0, 0, 0, 0], raf: 0 };
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    st.mouse = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  });
  let last = -1;
  const loop = (ms) => {
    st.raf = requestAnimationFrame(loop);
    const k = Math.min(devicePixelRatio, dprMax) * scale, w = Math.max(1, (canvas.clientWidth * k) | 0), h = Math.max(1, (canvas.clientHeight * k) | 0);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    st.reduced = mq.matches;
    st.time += last < 0 ? 0 : Math.min((ms - last) / 1000, 0.5) * (st.reduced ? reduce : 1);
    last = ms;
    if (frame) frame(st);
    gl.useProgram(prog);
    st.set('u_time', st.time); st.set('u_reduced', st.reduced ? 1 : 0); st.set('u_res', [w, h]);
    st.set('u_mouse', st.mouse); st.set('u_audio', st.audio);
    glDraw(gl);
  };
  st.raf = requestAnimationFrame(loop);
  st.stop = () => cancelAnimationFrame(st.raf);
  return st;
}

/** Targets pp.a (read) and pp.b (write), each { tex, fb }; RGBA16F when renderable, else RGBA8. */
export function createPingPong(gl, w, h) {
  const f = !!gl.getExtension('EXT_color_buffer_float');
  const mk = () => {
    const tex = gl.createTexture(), fb = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, f ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  };
  const pp = { w, h, float: f, a: mk(), b: mk(), swap: () => { [pp.a, pp.b] = [pp.b, pp.a]; } };
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return pp;
}
