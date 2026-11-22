// lib/webgpu.js: WebGPU fullscreen render + optional compute, with fallback. Needs a secure context:
// the gates serve plain http and always see the fallback.

const WGSL_HEAD = `struct U{time:f32,reduced:f32,res:vec2f,mouse:vec2f,pad:vec2f,audio:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(vec2f(f32(i&1u),f32(i>>1u))*4.-1.,0.,1.);}
`;

/** wgsl defines fs (and cs with storage/workgroups); returns fallback() when WebGPU is unusable. */
export async function gpuStart(canvas, wgsl, fallback, { scale = 1, dprMax = 1, reduce = 0.2, storage = 0, workgroups = 0, frame } = {}) {
  let dev = null;
  try {
    const ad = navigator.gpu && (await navigator.gpu.requestAdapter());
    dev = ad && (await ad.requestDevice());
  } catch (e) { dev = null; }
  if (!dev) return fallback();
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  dev.pushErrorScope('validation');
  const mod = dev.createShaderModule({ code: WGSL_HEAD + (storage ? '@group(0) @binding(1) var<storage,read_write> S:array<f32>;\n' : '') + wgsl });
  const bgl = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: 7, buffer: {} }, ...(storage ? [{ binding: 1, visibility: 6, buffer: { type: 'storage' } }] : [])] });
  const layout = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipe = dev.createRenderPipeline({ layout, vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: fmt }] } });
  const comp = workgroups ? dev.createComputePipeline({ layout, compute: { module: mod, entryPoint: 'cs' } }) : null;
  const ub = dev.createBuffer({ size: 48, usage: 72 }); // UNIFORM | COPY_DST
  const buf = storage ? dev.createBuffer({ size: storage * 4, usage: 140 }) : null; // STORAGE | COPY_SRC | COPY_DST
  const bg = dev.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub } }, ...(buf ? [{ binding: 1, resource: { buffer: buf } }] : [])] });
  const err = await dev.popErrorScope();
  const ctx = !err && canvas.getContext('webgpu');
  if (!ctx) {
    console.warn('webgpu: ' + (err ? err.message : 'no canvas context') + '; using fallback');
    return fallback();
  }
  ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque' });
  const mq = matchMedia('(prefers-reduced-motion: reduce)'), un = new Float32Array(12);
  const st = { kind: 'webgpu', dev, buf, time: 0, reduced: false, mouse: [0.5, 0.5], audio: [0, 0, 0, 0], raf: 0 };
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
    un.set([st.time, st.reduced ? 1 : 0, w, h, st.mouse[0], st.mouse[1], 0, 0, ...st.audio]);
    dev.queue.writeBuffer(ub, 0, un);
    const enc = dev.createCommandEncoder();
    if (comp) { const c = enc.beginComputePass(); c.setPipeline(comp); c.setBindGroup(0, bg); c.dispatchWorkgroups(workgroups); c.end(); }
    const r = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    r.setPipeline(pipe); r.setBindGroup(0, bg); r.draw(3); r.end();
    dev.queue.submit([enc.finish()]);
  };
  st.raf = requestAnimationFrame(loop);
  st.stop = () => cancelAnimationFrame(st.raf);
  return st;
}
