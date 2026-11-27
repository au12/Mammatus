// WebGL2 renderer for the Sky view, on its own canvas and context.
//
// What is drawn only when it changes: the atmosphere's lookups (when the sun moves), the weather volumes
// (when the hour, the blend between two hours or the place changes) and the light swept through them (then,
// and now and again as the clouds drift). Every frame: the background (sky, sun, moon, stars, the real
// terrain) at full resolution, a quarter of the cloud image's pixels ray-marched and the rest rebuilt from
// the frames before, then one composite pass (haze, light shafts, halos, rainbows, lightning glow, glare,
// tone mapping, dither) and the bolts.
import { compile, loadImage } from "../engine/gl.js";
import * as S from "./shaders.js";
import { Terrain, HALF } from "./terrain.js";
import { blueNoise, BLUE_SIZE } from "./blue.js";

export const N = 40, NZ = 64;
const ZTOP = 16, DZ = ZTOP / NZ, BOX = 120;
const CYCLE = [[0, 0], [1, 1], [1, 0], [0, 1]];      // which pixel of each 2x2 block is marched, frame by frame

// ------------------------------------------------------------------ small matrix kit (column-major)
export const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  // perspective with a vertical lens shift (the frustum slides up by `shift` NDC units)
  persp(fovY, aspect, near, far, shift = 0) {
    const f = 1 / Math.tan(fovY / 2);
    const o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[9] = shift; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = (2 * far * near) / (near - far);
    return o;
  },
  lookDir(eye, fwd, up) {
    const z = norm([-fwd[0], -fwd[1], -fwd[2]]);
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  },
  inv(m) {
    const o = new Float32Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return o;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },
  project(m, p) {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [x / w, y / w, w];
  },
};
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// ------------------------------------------------------------------ renderer
export class SkyRenderer {
  constructor(canvas, { lowPower = false } = {}) {
    this.canvas = canvas;
    this.lowPower = lowPower;
    const gl = canvas.getContext("webgl2", {
      antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: lowPower ? "low-power" : "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.f32 = !!gl.getExtension("EXT_color_buffer_float");
    if (!this.f32 && !gl.getExtension("EXT_color_buffer_half_float")) throw new Error("This browser can't draw the Sky view.");
    this.shaders = S;
    this.progs = {};
    this.tex = {};
    this.frames = new Map();           // key -> {vol, aux, anvil}
    this.frameCap = lowPower ? 12 : 24;
    this.frameNo = 0;
    this.scale = lowPower ? 0.5 : 0.7;          // the cloud image against the screen (a quarter of it is marched each frame)
    this.maxSteps = lowPower ? 52 : 84;
    this.volN = lowPower ? 96 : 160;            // weather and light volumes: voxels across the 120 km box
    this.shadowSize = lowPower ? 256 : 384;
    this.shadowSpan = 48;                        // km across: cloudlet-sized shadows near the point (the light volume serves beyond)
    this.lost = false;
    this.ready = false;                          // the noise is made
    this.hist = 0;
    this.reset = true;
    this.prevVP = null;
    this.stats = { ms: 0, bakes: 0, sweeps: 0 };
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; this.onLost?.(); });
    this._init();
  }

  // swap in another set of shaders (for working on them without regenerating the noise)
  useShaders(mod) {
    for (const p of Object.values(this.progs)) this.gl.deleteProgram(p.prog);
    this.shaders = mod;
    this.progs = {};
    this.bakeSig = this.lightSig = this.skySig = this.moonSig = this.mieSig = this.ambSig = null;
    this.shadowAt = 0;
    this.reset = true;
    if (this.ready) this._milky();
  }

  _prog(name, vs, fs) {
    if (!this.progs[name]) this.progs[name] = compile(this.gl, vs, fs);
    return this.progs[name];
  }

  _init() {
    const gl = this.gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.boltBuf = gl.createBuffer();
    this.tex.sunLUT = this._tex2D(64, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, new Float32Array(64 * 4).fill(1));
    this.tex.ramp = this._tex2D(256, 2, gl.RGBA16F, gl.RGBA, gl.FLOAT, new Float32Array(256 * 2 * 4));
    this.tex.blue = this._tex2D(BLUE_SIZE, BLUE_SIZE, gl.R8, gl.RED, gl.UNSIGNED_BYTE, blueNoise(), gl.NEAREST, gl.REPEAT);
    // level ground until the first terrain arrives
    const flat = new Terrain({ size: 64, layers: HALF.map(() => new Float32Array(64 * 64)) });
    this.setDem(flat, flat.pyramids());
    const blank = { vol: new Uint8Array(NZ * N * N * 4), aux: new Uint8Array(NZ * N * N * 4), anvil: new Float32Array(N * N * 2) };
    this.empty = this._upload(blank);
    this.tex.day = this._tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 60, 40, 255]));
    this.tex.night = this._tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    // the atmosphere
    this.trans = this._target(256, 64, [gl.RGBA16F]);
    this.mscat = this._target(32, 32, [gl.RGBA16F]);
    this.skyLUT = this._target(192, 108, [gl.RGBA16F]);
    this.moonLUT = this._target(96, 54, [gl.RGBA16F]);
    this.amb = this._target(2, 1, [gl.RGBA16F], "nearest");
    this.milky = this._target(768, 384, [gl.RGBA16F]);
    gl.bindTexture(gl.TEXTURE_2D, this.milky.tex[0]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    this.shadow = this._target(this.shadowSize, this.shadowSize, [gl.R16F]);
    // the weather and the light in it
    const n = this.volN;
    const vol = (fmt) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texStorage3D(gl.TEXTURE_3D, 1, fmt, n, n, NZ);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.w1 = vol(gl.RGBA8);
    this.w2 = vol(gl.RGBA8);
    this.lv = vol(gl.RGBA16F);
    this.lv2 = null;                              // made the first time the light comes from below the horizon
    this._vol = vol;
    this.run = [0, 1, 2, 3].map(() => this._tex2D(n, n, gl.RGBA16F, gl.RGBA, gl.FLOAT, null));      // [3] ends up holding the whole column
    this.bakeFB = gl.createFramebuffer();
    this.lightFB = gl.createFramebuffer();
    this.wZero = new Uint8Array(NZ).fill(1);      // slices of the weather that hold nothing
    this.bakeSig = null;
    this.lightSig = null;
    this.lightAt = 0;
    this.shadowAt = 0;
  }

  // The noise volumes are made on the GPU the first time the view opens, a few slices a frame (the camera is
  // still swooping in), then given their mips.
  makeNoise() {
    if (this.noise || this.ready) return;
    const gl = this.gl;
    const mk = (size, kind) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texStorage3D(gl.TEXTURE_3D, Math.floor(Math.log2(size)) + 1, gl.RGBA8, size, size, size);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, this.lowPower ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return { tex: t, size, kind, z: 0 };
    };
    this.noise = { jobs: [mk(128, 0), mk(64, 1)], fb: gl.createFramebuffer() };
  }

  _stepNoise(budget) {
    const gl = this.gl, J = this.noise;
    if (!J) return;
    const p = this._use(this._prog("noise", this.shaders.QUAD_VS, this.shaders.NOISE_FS));
    gl.bindFramebuffer(gl.FRAMEBUFFER, J.fb);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.disable(gl.BLEND);
    this._quad(p);
    for (const job of J.jobs) {
      if (job.z >= job.size || budget <= 0) continue;
      gl.viewport(0, 0, job.size, job.size);
      gl.uniform1f(p.uniforms.u_size, job.size);
      gl.uniform1i(p.uniforms.u_kind, job.kind);
      // (a slice of the big volume costs four of the small one's)
      const cost = job.size >= 128 ? 4 : 1;
      while (job.z < job.size && budget > 0) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, job.tex, 0, job.z);
        gl.uniform1f(p.uniforms.u_slice, (job.z + 0.5) / job.size);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        job.z++;
        budget -= cost;
      }
    }
    if (J.jobs.every((j) => j.z >= j.size)) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(J.fb);
      for (const j of J.jobs) { gl.bindTexture(gl.TEXTURE_3D, j.tex); gl.generateMipmap(gl.TEXTURE_3D); }
      this.tex.noise = J.jobs[0].tex;
      this.tex.detail = J.jobs[1].tex;
      this.noise = null;
      this.ready = true;
      this.bakeSig = null;
      this.reset = true;
      this._milky();
    }
  }

  // the Milky Way, painted once
  _milky() {
    const gl = this.gl;
    const p = this._use(this._prog("milky", this.shaders.QUAD_VS, this.shaders.MILKY_FS));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.milky.fb);
    gl.viewport(0, 0, this.milky.w, this.milky.h);
    gl.uniform2f(p.uniforms.u_size, this.milky.w, this.milky.h);
    this._bind(p, "u_noise", this.tex.noise, gl.TEXTURE_3D);
    this._quad(p);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  async loadEarth(hd) {
    try {
      const [day, night] = await Promise.all([loadImage(`img/earth-day-${hd ? "4k" : "2k"}.jpg`), loadImage("img/earth-night-2k.jpg")]);
      const gl = this.gl;
      const mk = (img) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.tex.day = mk(day);
      this.tex.night = mk(night);
    } catch { /* plain ground colour */ }
  }

  setStars(stars) {
    const gl = this.gl;
    this.stars = { dir: gl.createBuffer(), mt: gl.createBuffer(), count: stars.count };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stars.dir);
    gl.bufferData(gl.ARRAY_BUFFER, stars.dir, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stars.mt);
    gl.bufferData(gl.ARRAY_BUFFER, stars.mt, gl.STATIC_DRAW);
  }

  // ---------------------------------------------------------------- resources
  _tex2D(w, h, internal, format, type, data, filter, wrap) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
    return t;
  }

  _tex3D(data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, NZ, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _target(w, h, formats, filter) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const tex = formats.map((f, i) => {
      const fmt = f === gl.R32F || f === gl.R16F ? gl.RED : gl.RGBA;
      const type = f === gl.RGBA8 ? gl.UNSIGNED_BYTE : gl.FLOAT;
      const nearest = f === gl.R32F || filter === "nearest";
      const t = this._tex2D(w, h, f, fmt, type, null, nearest ? gl.NEAREST : gl.LINEAR);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      return t;
    });
    gl.drawBuffers(formats.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error("Sky view: render target not supported");
    return { fb, tex, w, h };
  }

  _free(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.fb);
    t.tex.forEach((x) => gl.deleteTexture(x));
  }

  _upload(f) {
    const gl = this.gl;
    return {
      vol: this._tex3D(f.vol), aux: this._tex3D(f.aux),
      anvil: this._tex2D(N, N, gl.RG16F, gl.RG, gl.FLOAT, f.anvil),
    };
  }

  // GPU copies of decoded frames, kept for the most recent couple of dozen
  frame(key, f) {
    let g = this.frames.get(key);
    if (g) { this.frames.delete(key); this.frames.set(key, g); return g; }
    g = this._upload(f);
    this.frames.set(key, g);
    const gl = this.gl;
    while (this.frames.size > this.frameCap) {
      let victim = null;
      for (const k of this.frames.keys()) if (k !== this.keyA && k !== this.keyB && k !== key) { victim = k; break; }
      if (victim == null) break;
      const old = this.frames.get(victim);
      this.frames.delete(victim);
      gl.deleteTexture(old.vol); gl.deleteTexture(old.aux); gl.deleteTexture(old.anvil);
    }
    return g;
  }

  has(key) { return this.frames.has(key); }

  setSunLUT(arr) { this._sub(this.tex.sunLUT, 64, 1, this.gl.RGBA, arr); }

  // The ground: three nested grids in one array texture, each with its chain of (mean, highest) mips.
  setDem(terrain, pyramids) {
    const gl = this.gl, S = terrain.size;
    if (!this.tex.dem || this.demSize !== S) {
      if (this.tex.dem) gl.deleteTexture(this.tex.dem);
      this.tex.dem = gl.createTexture();
      this.demSize = S;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.dem);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, terrain.levels, gl.RG16F, S, S, pyramids.length);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.dem);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    pyramids.forEach((chain, k) => chain.forEach((m, level) => {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, k, m.w, m.w, 1, gl.RG, gl.FLOAT, m.data);
    }));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.dem = { size: S, levels: terrain.levels, min: terrain.min, max: terrain.max, base: terrain.base, sea: terrain.sea };
    this.shadowAt = 0;
    this.reset = true;
  }

  _demUniforms(p, s) {
    const gl = this.gl, u = p.uniforms, d = this.dem, g = s.ground || {};
    this._bind(p, "u_dem", this.tex.dem, gl.TEXTURE_2D_ARRAY);
    gl.uniform3f(u.u_demHalf, HALF[0], HALF[1], HALF[2]);
    gl.uniform4f(u.u_demInfo, d.size, d.levels, g.relief ?? 1, g.curve ?? 0);
    gl.uniform3f(u.u_demRange, d.min, d.max, d.base);
    if (u.u_demSea) gl.uniform1f(u.u_demSea, d.sea);
    if (u.u_demSteps) gl.uniform1i(u.u_demSteps, this.lowPower ? 160 : 256);     // a cap few rays come near (typically 11)
  }

  _sub(t, w, h, fmt, arr) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, gl.FLOAT, arr);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const cap = this.lowPower ? 1.35 : 1.6;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
    if (w === this.W && h === this.H && this.bg) return false;
    this.W = w; this.H = h; this.dpr = dpr;
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    this._free(this.bg);
    this.bg = this._target(w, h, [gl.RGBA16F, this.f32 ? gl.R32F : gl.R16F]);
    this._sizeClouds();
    return true;
  }

  // the cloud image (kept from frame to frame) and the quarter of it marched each frame
  _sizeClouds() {
    const gl = this.gl;
    const cw = Math.max(8, Math.ceil(this.W * this.scale / 2)), ch = Math.max(8, Math.ceil(this.H * this.scale / 2));
    if (this.cur && this.cur.w === cw && this.cur.h === ch) return;
    [this.cur, this.histA, this.histB].forEach((t) => this._free(t));
    this.cur = this._target(cw, ch, [gl.RGBA16F, gl.RGBA16F]);
    this.histA = this._target(cw * 2, ch * 2, [gl.RGBA16F, gl.RGBA16F]);
    this.histB = this._target(cw * 2, ch * 2, [gl.RGBA16F, gl.RGBA16F]);
    for (const t of [this.histA, this.histB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
      gl.clearBufferfv(gl.COLOR, 1, [880, 0, 0, 1]);
    }
    this.out = this.histA;
    this.reset = true;
  }

  setScale(s) {
    const v = Math.min(0.9, Math.max(0.34, s));
    if (Math.abs(v - this.scale) < 0.02) return;
    this.scale = v;
    if (this.W) this._sizeClouds();
  }

  // ---------------------------------------------------------------- drawing
  _quad(p) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const loc = p.attribs.a_pos;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  _bind(p, name, tex, target) {
    const u = p.uniforms[name];
    if (u == null) return -1;
    const gl = this.gl;
    p._unit = (p._unit ?? -1) + 1;
    gl.activeTexture(gl.TEXTURE0 + p._unit);
    gl.bindTexture(target || gl.TEXTURE_2D, tex);
    gl.uniform1i(u, p._unit);
    return p._unit;
  }

  _use(p) { this.gl.useProgram(p.prog); p._unit = -1; return p; }

  // (for measuring: with `prof` set, wait for the GPU after each pass and note how long the pass took)
  _mark(name) {
    if (!this.prof) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.amb.fb);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, this._px ||= new Float32Array(4));
    const t = performance.now();
    this.timings ||= {};
    this.timings[name] = (this.timings[name] || 0) * 0.5 + (t - this._t) * 0.5;
    this._t = t;
  }

  _draw(p) { this._quad(p); this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }

  _common(p, s) {
    const gl = this.gl, u = p.uniforms, e = s.env;
    if (u.u_camPos) gl.uniform3fv(u.u_camPos, s.cam.pos);
    if (u.u_invVP) gl.uniformMatrix4fv(u.u_invVP, false, s.cam.invVP);
    if (u.u_light) gl.uniform3fv(u.u_light, e.light);
    if (u.u_lightI) gl.uniform1f(u.u_lightI, e.lightI);
    if (u.u_elev) gl.uniform1f(u.u_elev, e.elev);
    if (u.u_lat0) gl.uniform2f(u.u_lat0, e.lat, e.lon);
    if (u.u_hazeK) gl.uniform1f(u.u_hazeK, s.cam.hazeK ?? 1);
    if (u.u_hazeLow) gl.uniform1f(u.u_hazeLow, e.hazeLow ?? 1);
    if (u.u_cut) gl.uniform4fv(u.u_cut, s.cam.cut);
    if (u.u_slab) gl.uniform2fv(u.u_slab, s.cam.slab || [1e4, 1]);
    if (u.u_frame) gl.uniform1f(u.u_frame, this.frameNo % 1024);
    this._bind(p, "u_sunLUT", this.tex.sunLUT);
    this._bind(p, "u_amb", this.amb.tex[0]);
    this._bind(p, "u_blue", this.tex.blue);
  }

  // what the cloud model reads: the baked weather, the noise, and how far everything has drifted
  _cloudUniforms(p, s) {
    const gl = this.gl, u = p.uniforms, w = s.weather;
    const a = this.frames.get(w.a) || this.empty, b = this.frames.get(w.b) || a;
    this._bind(p, "u_w1", this.w1, gl.TEXTURE_3D);
    this._bind(p, "u_w2", this.w2, gl.TEXTURE_3D);
    this._bind(p, "u_noise", this.tex.noise, gl.TEXTURE_3D);
    this._bind(p, "u_detail", this.tex.detail, gl.TEXTURE_3D);
    this._bind(p, "u_anvil", (w.mix > 0.5 ? b : a).anvil);
    if (u.u_rise) gl.uniform1f(u.u_rise, w.rise || 0);
    if (u.u_evo) gl.uniform1f(u.u_evo, w.evo || 0);
    if (u.u_fall) gl.uniform1f(u.u_fall, w.fall || 0);
    if (u.u_mammatus) gl.uniform1f(u.u_mammatus, w.mammatus || 0);
    if (u.u_ext) gl.uniform1f(u.u_ext, w.ext ?? 0.5);
  }

  _lightUniforms(p, s) {
    const gl = this.gl;
    this._bind(p, "u_lv", this.lv, gl.TEXTURE_3D);
    this._bind(p, "u_lv2", this.lv2 || this.lv, gl.TEXTURE_3D);
    this._bind(p, "u_ctot", this.run[3]);
    if (p.uniforms.u_sunAbove) gl.uniform1f(p.uniforms.u_sunAbove, this.lv2 ? s.env.sunAbove : 1);
  }

  // the height bands that hold cloud, and each one's drift
  _bandUniforms(p, s) {
    const gl = this.gl, u = p.uniforms, w = s.weather;
    const nb = Math.min(6, w.bands.length);
    const bands = new Float32Array(12), drift = new Float32Array(24), dir = new Float32Array(12);
    for (let i = 0; i < nb; i++) {
      const d = w.drift?.[i] || ZERO;
      bands[i * 2] = w.bands[i][0]; bands[i * 2 + 1] = w.bands[i][1];
      drift[i * 4] = d.x; drift[i * 4 + 1] = d.y; drift[i * 4 + 2] = d.run;
      dir[i * 2] = d.dx; dir[i * 2 + 1] = d.dy;
    }
    gl.uniform2fv(u.u_bands, bands);
    if (u.u_bDrift) gl.uniform4fv(u.u_bDrift, drift);
    if (u.u_bDir) gl.uniform2fv(u.u_bDir, dir);
    gl.uniform1i(u.u_nbands, nb);
  }

  // the band a level belongs to (or the nearest one)
  _bandAt(z, bands) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < Math.min(6, bands.length); i++) {
      const d = z < bands[i][0] ? bands[i][0] - z : (z > bands[i][1] ? z - bands[i][1] : 0);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------------------------------------------------------------- the atmosphere
  // the air's transmittance and multiple scattering for this much haze; true when they were redrawn
  _air(mie) {
    const gl = this.gl;
    const sig = mie.toFixed(2);
    if (sig === this.mieSig) return false;
    this.mieSig = sig;
    let p = this._use(this._prog("trans", this.shaders.QUAD_VS, this.shaders.TRANS_FS));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trans.fb);
    gl.viewport(0, 0, this.trans.w, this.trans.h);
    gl.uniform2f(p.uniforms.u_size, this.trans.w, this.trans.h);
    gl.uniform1f(p.uniforms.u_mie, mie);
    this._draw(p);
    p = this._use(this._prog("mscat", this.shaders.QUAD_VS, this.shaders.MSCAT_FS));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mscat.fb);
    gl.viewport(0, 0, this.mscat.w, this.mscat.h);
    gl.uniform2f(p.uniforms.u_size, this.mscat.w, this.mscat.h);
    gl.uniform1f(p.uniforms.u_mie, mie);
    this._bind(p, "u_trans", this.trans.tex[0]);
    this._draw(p);
    return true;
  }

  // the sky as seen from height h0 with the light in direction dir
  _skyView(target, dir, mie, h0) {
    const gl = this.gl;
    const p = this._use(this._prog("skyview", this.shaders.QUAD_VS, this.shaders.SKYVIEW_FS));
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.uniform2f(p.uniforms.u_size, target.w, target.h);
    gl.uniform1f(p.uniforms.u_mie, mie);
    gl.uniform3fv(p.uniforms.u_sunDir, dir);
    gl.uniform1f(p.uniforms.u_h0, h0);
    this._bind(p, "u_trans", this.trans.tex[0]);
    this._bind(p, "u_ms", this.mscat.tex[0]);
    this._draw(p);
  }

  // How bright the sky is (the mean radiance of the dome, per unit of sunlight) for a sun at each of a set of
  // elevations, in this haze and from this height: worked out once on the GPU and read back, so the view can
  // set its exposure for any time of day without waiting on the picture. Returns a function of elevation (deg).
  skyBrightness(mie, h0) {
    const key = `${mie.toFixed(2)}|${h0.toFixed(1)}`;
    this.skyTables ||= new Map();
    let tab = this.skyTables.get(key);
    if (!tab) {
      const gl = this.gl, n = SKY_ELS.length;
      if (this._air(mie)) this.skySig = this.moonSig = null;
      this.skyTmp ||= this._target(64, 36, [gl.RGBA16F]);
      this.skyStrip ||= this._target(2 * SKY_ELS.length, 1, [gl.RGBA16F], "nearest");
      this.black ||= this._tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      SKY_ELS.forEach((el, i) => {
        const a = el * Math.PI / 180;
        this._skyView(this.skyTmp, [0, Math.cos(a), Math.sin(a)], mie, h0);
        const p = this._use(this._prog("ambient", this.shaders.QUAD_VS, this.shaders.AMBIENT_FS));
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.skyStrip.fb);
        gl.viewport(2 * i, 0, 2, 1);
        this._bind(p, "u_skyLUT", this.skyTmp.tex[0]);
        this._bind(p, "u_moonLUT", this.black);
        gl.uniform1f(p.uniforms.u_moonK, 0);
        gl.uniform3f(p.uniforms.u_night, 0, 0, 0);
        gl.uniform4f(p.uniforms.u_stDome, 0, 0, 0, 0);
        this._draw(p);
      });
      const px = new Float32Array(2 * n * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.skyStrip.fb);
      gl.readPixels(0, 0, 2 * n, 1, gl.RGBA, gl.FLOAT, px);
      tab = SKY_ELS.map((_, i) => Math.max(1e-9, 0.2126 * px[i * 8] + 0.7152 * px[i * 8 + 1] + 0.0722 * px[i * 8 + 2]));
      this.skyTables.set(key, tab);
      if (this.skyTables.size > 12) this.skyTables.delete(this.skyTables.keys().next().value);
    }
    return (el) => {
      if (el <= SKY_ELS[0]) return tab[0] * Math.exp((el - SKY_ELS[0]) * 0.9);        // (deeper than the table goes: the last of the twilight dies away)
      let i = 0;
      while (i < SKY_ELS.length - 2 && el > SKY_ELS[i + 1]) i++;
      const u = Math.min(1, (el - SKY_ELS[i]) / (SKY_ELS[i + 1] - SKY_ELS[i]));
      return Math.exp(Math.log(tab[i]) * (1 - u) + Math.log(tab[i + 1]) * u);
    };
  }

  _sky(s) {
    const gl = this.gl, e = s.env;
    const mie = e.mie ?? 1;
    let changed = false;
    if (this._air(mie)) this.skySig = this.moonSig = null;
    const h0 = Math.max(0.02, s.cam.pos[2] + e.elev);
    const view = (target, dir) => { this._skyView(target, dir, mie, h0); changed = true; };
    const sig = `${e.sunDir[2].toFixed(4)}|${h0.toFixed(1)}`;
    if (sig !== this.skySig) { this.skySig = sig; view(this.skyLUT, e.sunDir); }
    const msig = e.moonK > 1e-5 ? `${e.moonDir[2].toFixed(3)}|${h0.toFixed(1)}` : "off";
    if (msig !== this.moonSig) {
      this.moonSig = msig;
      if (msig === "off") { gl.bindFramebuffer(gl.FRAMEBUFFER, this.moonLUT.fb); gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]); changed = true; }
      else view(this.moonLUT, e.moonDir);
    }
    const st = Math.min(1, Math.max(0, s.cam.stylize || 0));
    const stDome = (e.stDome || [0, 0, 0]).map((x) => x / e.exposure), stRim = (e.stRim || [0, 0, 0]).map((x) => x / e.exposure);
    const asig = `${e.moonK.toFixed(6)}|${e.nightAir.map((x) => x.toExponential(2))}|${st.toFixed(2)}|${stDome.map((x) => x.toExponential(2))}`;
    if (changed || asig !== this.ambSig) {
      this.ambSig = asig;
      const p = this._use(this._prog("ambient", this.shaders.QUAD_VS, this.shaders.AMBIENT_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.amb.fb);
      gl.viewport(0, 0, 2, 1);
      this._bind(p, "u_skyLUT", this.skyLUT.tex[0]);
      this._bind(p, "u_moonLUT", this.moonLUT.tex[0]);
      gl.uniform1f(p.uniforms.u_moonK, e.moonK);
      gl.uniform3fv(p.uniforms.u_night, e.nightAir);
      gl.uniform4f(p.uniforms.u_stDome, stDome[0], stDome[1], stDome[2], st);
      gl.uniform3fv(p.uniforms.u_stRim, stRim);
      this._draw(p);
    }
    if (e.ramp && e.rampKey !== this.rampKey) {
      this.rampKey = e.rampKey;
      this._sub(this.tex.ramp, 256, 2, gl.RGBA, e.ramp);
    }
  }

  // ---------------------------------------------------------------- the weather volumes
  // Returns true when they were redrawn.
  _weather(s) {
    const gl = this.gl, w = s.weather, n = this.volN;
    const a = this.frames.get(w.a) || this.empty, b = this.frames.get(w.b) || a;
    const mix = b === a ? 0 : w.mix;
    const sig = `${w.a}|${w.b}|${mix.toFixed(4)}|${(w.appear ?? 1).toFixed(3)}|${(w.adv || []).map((d) => `${d[0].toFixed(2)},${d[1].toFixed(2)}`)}|${w.occKey || ""}`;
    if (sig === this.bakeSig) return false;
    this.bakeSig = sig;
    this.stats.bakes++;
    const p = this._use(this._prog("bake", this.shaders.QUAD_VS, this.shaders.BAKE_FS));
    const u = p.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bakeFB);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, n, n);
    this._bind(p, "u_vol0", a.vol, gl.TEXTURE_3D);
    this._bind(p, "u_aux0", a.aux, gl.TEXTURE_3D);
    this._bind(p, "u_vol1", b.vol, gl.TEXTURE_3D);
    this._bind(p, "u_aux1", b.aux, gl.TEXTURE_3D);
    this._bind(p, "u_noise", this.tex.noise, gl.TEXTURE_3D);
    gl.uniform1f(u.u_n, n);
    gl.uniform1f(u.u_mix, mix);
    gl.uniform1f(u.u_appear, w.appear ?? 1);
    this._quad(p);
    const none = a === this.empty && b === this.empty;
    for (let z = 0; z < NZ; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.w1, 0, z);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, this.w2, 0, z);
      if (none || (w.occ && !w.occ[z]) || (w.appear ?? 1) <= 0) {
        if (!this.wZero[z]) {
          gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
          gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
          this.wZero[z] = 1;
        }
        continue;
      }
      this.wZero[z] = 0;
      const zc = (z + 0.5) * DZ;
      const d = w.adv?.[this._bandAt(zc, w.bands)] || ZERO2;
      gl.uniform1f(u.u_z, zc);
      gl.uniform4f(u.u_adv, d[0] * mix, d[1] * mix, d[0] * (1 - mix), d[1] * (1 - mix));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return true;
  }

  // Optical depth toward the light and of the cloud overhead, swept through the weather slice by slice: down
  // from the top for a light above the horizon, and up from the ground as well when it is near or below it.
  // A sweep is spread over a few frames (so many slices' worth of work in each), the volume being updated
  // in place as it goes: the light changes slowly, and no frame pays for the whole thing.
  _sweepStart(s) {
    const passes = [false];
    if (s.env.sunAbove < 0.996) { this.lv2 ||= this._vol(this.gl.RGBA16F); passes.push(true); }
    this.stats.sweeps++;
    return { s, passes, pi: 0, i: 0 };
  }

  // returns true when the sweep is finished
  _sweepStep(sw, budget) {
    const gl = this.gl, s = sw.s, e = s.env, w = s.weather, n = this.volN;
    const up = sw.passes[sw.pi];
    const L = e.light, hl = Math.hypot(L[0], L[1]) || 1;
    const elev = Math.asin(Math.max(-1, Math.min(1, L[2])));
    // (a light on the horizon is treated as 4 degrees above or below it: its path through the box stays finite)
    const el = Math.max(up ? -elev : elev, 4 * Math.PI / 180);
    const k = DZ / Math.tan(el);
    const shift = [L[0] / hl * k, L[1] / hl * k];
    const sub = Math.max(1, Math.min(4, Math.ceil(k / (BOX / n) / 1.5)));
    const p = this._use(this._prog("light", this.shaders.QUAD_VS, this.shaders.LIGHT_FS));
    const u = p.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFB);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, n, n);
    this._common(p, s);
    this._cloudUniforms(p, s);
    const runUnit = this._bind(p, "u_run", this.run[2]);
    gl.uniform1f(u.u_n, n);
    gl.uniform1f(u.u_dz, DZ);
    gl.uniform2f(u.u_shift, shift[0], shift[1]);
    gl.uniform1f(u.u_path, 1 / Math.sin(el));
    gl.uniform1f(u.u_up, up ? 1 : 0);
    gl.uniform1i(u.u_sub, sub);
    this._quad(p);
    const vol = up ? this.lv2 : this.lv;
    // (the sweep down ends in run[3], which then holds the whole column until the next sweep ends there too)
    const idx = (i) => (i === NZ - 1 && !up ? 3 : (i % 2 === 0 ? 0 : (up ? 2 : 1)));
    const mam = (w.mammatus || 0) > 0.01;
    const cost = sub > 1 ? (1 + sub) / 2 : 1;
    for (; sw.i < NZ && budget > 0; sw.i++) {
      const i = sw.i, z = up ? i : NZ - 1 - i;
      const empty = this.wZero[z] && !mam;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.run[idx(i)], 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, vol, 0, z);
      gl.activeTexture(gl.TEXTURE0 + runUnit);
      gl.bindTexture(gl.TEXTURE_2D, this.run[i > 0 ? idx(i - 1) : 2]);
      gl.uniform1f(u.u_z0, z * DZ);
      gl.uniform1f(u.u_first, i === 0 ? 1 : 0);
      gl.uniform1f(u.u_empty, empty ? 1 : 0);
      const d = w.drift?.[this._bandAt((z + 0.5) * DZ, w.bands)] || ZERO;
      gl.uniform4f(u.u_sDrift, d.x, d.y, d.run, 0);
      gl.uniform2f(u.u_sDir, d.dx, d.dy);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      budget -= empty ? 0.12 : cost;
    }
    if (sw.i >= NZ) { sw.i = 0; sw.pi++; }
    return sw.pi >= sw.passes.length;
  }

  // the shadows of the clouds on the ground near the point, at cloudlet scale
  _shadow(s) {
    const gl = this.gl;
    const p = this._use(this._prog("shadow", this.shaders.QUAD_VS, this.shaders.SHADOW_FS));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fb);
    gl.viewport(0, 0, this.shadow.w, this.shadow.h);
    this._common(p, s);
    this._cloudUniforms(p, s);
    this._demUniforms(p, s);
    this._bandUniforms(p, s);
    gl.uniform2f(p.uniforms.u_size, this.shadow.w, this.shadow.h);
    gl.uniform1f(p.uniforms.u_span, this.shadowSpan);
    this._draw(p);
  }

  render(s, now) {
    if (this.lost || !this.bg) return;
    const gl = this.gl;
    const t0 = performance.now();
    const e = s.env, w = s.weather;
    this.keyA = w.a; this.keyB = w.b;
    this.frameNo++;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    if (!this.ready) this._stepNoise(this.lowPower ? 24 : 48);

    if (this.prof) { this._mark("start"); }
    // 1. the atmosphere, when the sun, the moon, the haze or the observer's height changed
    this._sky(s);
    this._mark("sky");

    // 2. the weather volumes when the weather changed; the light through them then, when the light moved,
    //    and every so often as the clouds drift; their shadows on the ground a little more often
    if (this.ready) {
      const still = !!s.still;
      const baked = !still && (!this.lowPower || !w.morphing || this.frameNo % 2 === 0 || this.bakeSig == null) ? this._weather(s) : false;
      this._mark("bake");
      const lsig = `${e.light.map((x) => x.toFixed(3))}|${e.sunAbove.toFixed(2)}|${(w.mammatus || 0).toFixed(2)}`;
      if (baked || lsig !== this.lightSig || (!still && now - this.lightAt > (this.lowPower ? 2400 : 1200))) this.lightDirty = true;
      if (!this.sweep && this.lightDirty) {
        this.lightDirty = false;
        this.lightSig = lsig;
        this.lightAt = now;
        this.sweep = this._sweepStart(s);
      }
      let lightDone = false;
      if (this.sweep && this._sweepStep(this.sweep, this.lowPower ? 10 : 20)) { this.sweep = null; lightDone = true; }
      this._mark("light");
      if (lightDone || this.shadowAt === 0 || (!still && now - this.shadowAt > (this.lowPower ? 1000 : 500)) || s.ground?.relief !== this.shadowRelief) {
        this.shadowAt = now || 1;
        this.shadowRelief = s.ground?.relief;
        this._shadow(s);
        this._mark("shadow");
      }
    }

    // 3. background
    {
      const p = this._use(this._prog("bg", this.shaders.QUAD_VS, this.shaders.BG_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bg.fb);
      gl.viewport(0, 0, this.W, this.H);
      this._common(p, s);
      const u = p.uniforms;
      gl.uniform2f(u.u_res, this.W, this.H);
      gl.uniform1f(u.u_pix, s.cam.fov / this.H);
      this._bind(p, "u_skyLUT", this.skyLUT.tex[0]);
      this._bind(p, "u_moonLUT", this.moonLUT.tex[0]);
      this._bind(p, "u_ramp", this.tex.ramp);
      this._bind(p, "u_milky", this.milky.tex[0]);
      this._demUniforms(p, s);
      this._bind(p, "u_day", this.tex.day);
      this._bind(p, "u_nightTex", this.tex.night);
      this._bind(p, "u_shadow", this.shadow.tex[0]);
      this._lightUniforms(p, s);
      gl.uniform1f(u.u_shadowSpan, this.shadowSpan);
      gl.uniform3fv(u.u_sunDir, e.sunDir);
      gl.uniform3fv(u.u_sunCol, e.sunCol);
      gl.uniform3fv(u.u_moonDir, e.moonDir);
      gl.uniform3fv(u.u_moonCol, e.moonCol);
      gl.uniform1f(u.u_moonIllum, e.moonIllum);
      gl.uniform1f(u.u_moonK, e.moonK);
      gl.uniform1f(u.u_night, e.night);
      gl.uniform1f(u.u_stylize, s.cam.stylize);
      gl.uniform1f(u.u_rampK, 1 / e.exposure);
      gl.uniform1f(u.u_refDist, s.cam.refDist);
      gl.uniform1f(u.u_refZ, s.cam.pos[2]);
      gl.uniform1f(u.u_snow, e.snow);
      gl.uniform1f(u.u_cityGlow, e.cityGlow);
      gl.uniform1f(u.u_far, s.cam.far);
      gl.uniformMatrix3fv(u.u_eqInv, false, e.eqInv);
      gl.uniformMatrix3fv(u.u_starCam, false, s.cam.starCam);
      gl.uniform1f(u.u_starVis, this.ready ? e.starVis : 0);
      gl.uniform1f(u.u_milkyK, 0.22 / e.exposure);
      gl.uniform3fv(u.u_nightAir, e.nightAir);
      this._draw(p);
    }
    if (this.stars && e.starVis > 0.01) {
      // stars go into the background colour only (the depth target stays unbound while it's read)
      if (!this.starFB) this.starFB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.starFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bg.tex[0], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const p = this._use(this._prog("stars", this.shaders.STAR_VS, this.shaders.STAR_FS));
      const u = p.uniforms;
      gl.uniformMatrix4fv(u.u_vp, false, s.cam.starVP || s.cam.vp);
      gl.uniformMatrix3fv(u.u_eq, false, e.eq);
      gl.uniform3fv(u.u_camPos, s.cam.starVP ? [0, 0, 0] : s.cam.pos);
      gl.uniform1f(u.u_dpr, this.dpr);
      gl.uniform1f(u.u_vis, e.starVis * e.starGain);
      gl.uniform1f(u.u_twinkle, (now / 1000) % 1000);
      gl.uniform2f(u.u_res, this.W, this.H);
      gl.uniform1f(u.u_far, s.cam.far);
      this._bind(p, "u_depth", this.bg.tex[1]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stars.dir);
      gl.enableVertexAttribArray(p.attribs.a_dir);
      gl.vertexAttribPointer(p.attribs.a_dir, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stars.mt);
      gl.enableVertexAttribArray(p.attribs.a_mt);
      gl.vertexAttribPointer(p.attribs.a_mt, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.stars.count);
      gl.disableVertexAttribArray(p.attribs.a_dir);
      gl.disableVertexAttribArray(p.attribs.a_mt);
      gl.disable(gl.BLEND);
    }

    this._mark("bg");
    // 4. clouds: one pixel of each 2x2 block of the cloud image
    const src = this.hist ? this.histB : this.histA, dst = this.hist ? this.histA : this.histB;
    const fc = new Float32Array(8);
    (s.flashes || []).slice(0, 2).forEach((f, i) => { fc.set([f.x, f.y, f.z, f.i], i * 4); });
    if (this.ready) {
      const jit = CYCLE[this.frameNo % 4];
      {
        const p = this._use(this._prog("cloud", this.shaders.QUAD_VS, this.shaders.CLOUD_FS));
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.cur.fb);
        gl.viewport(0, 0, this.cur.w, this.cur.h);
        this._common(p, s);
        this._cloudUniforms(p, s);
        this._lightUniforms(p, s);
        this._bandUniforms(p, s);
        const u = p.uniforms;
        gl.uniform2f(u.u_res, dst.w, dst.h);
        gl.uniform2f(u.u_jitter, jit[0], jit[1]);
        gl.uniform1f(u.u_pixAngle, s.cam.fov / dst.h);
        this._bind(p, "u_sceneDepth", this.bg.tex[1]);
        gl.uniform1i(u.u_maxSteps, Math.round(this.maxSteps * (s.cam.cut[3] > 0.5 ? 1 : 1.3)));   // from the ground rays cross the whole depth of the clouds
        gl.uniform1i(u.u_lightSteps, this.lowPower ? 3 : 4);
        gl.uniform1f(u.u_fill, e.fill ?? 1);
        gl.uniform1f(u.u_far, s.cam.far);
        gl.uniform3fv(u.u_cityCol, e.cityCol);
        gl.uniform4fv(u.u_flash, fc);
        gl.uniform3fv(u.u_flashCol, e.flashCol);
        gl.uniform1f(u.u_groundAlb, e.groundAlb);
        this._draw(p);
      }

      this._mark("cloud");
      // 5. rebuild the whole cloud image from this quarter and the frames before
      this.hist ^= 1;
      {
        const p = this._use(this._prog("resolve", this.shaders.QUAD_VS, this.shaders.RESOLVE_FS));
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        const u = p.uniforms;
        this._bind(p, "u_cur", this.cur.tex[0]);
        this._bind(p, "u_curEx", this.cur.tex[1]);
        this._bind(p, "u_hist", src.tex[0]);
        this._bind(p, "u_histEx", src.tex[1]);
        gl.uniformMatrix4fv(u.u_invVP, false, s.cam.invVP);
        gl.uniformMatrix4fv(u.u_prevVP, false, this.prevVP || s.cam.vp);
        gl.uniform3fv(u.u_camPos, s.cam.pos);
        gl.uniform2f(u.u_res, dst.w, dst.h);
        gl.uniform2f(u.u_jitter, jit[0], jit[1]);
        // moving: follow the new picture closely; still: let it settle, each new sample refining the last
        gl.uniform1f(u.u_alpha, s.moving ? 0.85 : (s.dataChanged ? 0.6 : 0.15));
        gl.uniform1f(u.u_keep, s.moving ? 0.8 : (s.dataChanged ? 0.9 : 0.97));
        gl.uniform1f(u.u_clamp, s.moving || s.dataChanged ? 1 : 0.1);
        gl.uniform1f(u.u_reset, this.reset ? 1 : 0);
        this._bandUniforms(p, s);
        const vel = new Float32Array(18);
        for (let i = 0; i < Math.min(6, w.bands.length); i++) { const d = w.drift?.[i]; if (d) { vel[i * 3] = d.vx || 0; vel[i * 3 + 1] = d.vy || 0; } }
        gl.uniform3fv(u.u_bVel, vel);
        this._draw(p);
      }
      this.reset = false;
      this.prevVP = s.cam.vp;
      this.out = dst;
    }
    const out = this.out;
    this._mark("resolve");

    // 6. composite to the screen
    {
      const p = this._use(this._prog("composite", this.shaders.QUAD_VS, this.shaders.COMPOSITE_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.W, this.H);
      this._common(p, s);
      const u = p.uniforms;
      gl.uniform2f(u.u_res, this.W, this.H);
      gl.uniform2f(u.u_cloudRes, out.w, out.h);
      this._bind(p, "u_bg", this.bg.tex[0]);
      this._bind(p, "u_bgDepth", this.bg.tex[1]);
      this._bind(p, "u_cloud", out.tex[0]);
      this._bind(p, "u_cloudEx", out.tex[1]);
      this._bind(p, "u_shadow", this.shadow.tex[0]);
      this._lightUniforms(p, s);
      gl.uniform1f(u.u_shadowSpan, this.shadowSpan);
      gl.uniform3fv(u.u_sunDir, e.sunDir);
      gl.uniform3fv(u.u_sunCol, e.sunCol);
      gl.uniform3fv(u.u_moonDir, e.moonDir);
      gl.uniform3fv(u.u_moonCol, e.moonCol);
      gl.uniform1f(u.u_exposure, e.exposure);
      gl.uniform4fv(u.u_flash, fc);
      gl.uniform3fv(u.u_flashCol, e.flashCol);
      gl.uniform1f(u.u_rays, e.rays * (1 - 0.65 * Math.min(1, s.cam.stylize || 0)));      // (fainter in the side view's diagram)
      gl.uniform1f(u.u_far, s.cam.far);
      // where the sun is on the screen, for its glare
      const q = M4.project(s.cam.vp, [s.cam.pos[0] + e.sunDir[0] * 500, s.cam.pos[1] + e.sunDir[1] * 500, s.cam.pos[2] + e.sunDir[2] * 500]);
      const on = q[2] > 0 && Math.abs(q[0]) < 1.6 && Math.abs(q[1]) < 1.6 && s.cam.stylize < 0.5;
      gl.uniform3f(u.u_glare, q[0] * 0.5 + 0.5, q[1] * 0.5 + 0.5, on ? 1 : 0);
      gl.uniform1f(u.u_aspect, this.W / this.H);
      gl.uniform1f(u.u_grade, e.grade ?? 1);
      this._draw(p);
    }

    // 7. lightning bolts
    if (s.bolts?.length) this._drawBolts(s);
    this._mark("composite");
    this.stats.ms = this.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  _drawBolts(s) {
    const gl = this.gl;
    const p = this._use(this._prog("bolt", this.shaders.BOLT_VS, this.shaders.BOLT_FS));
    const u = p.uniforms;
    gl.uniformMatrix4fv(u.u_vp, false, s.cam.vp);
    gl.uniform2f(u.u_res, this.W, this.H);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const A = p.attribs;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(A.a_corner);
    gl.vertexAttribPointer(A.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(A.a_corner, 0);
    for (const b of s.bolts) {
      if (b.i < 0.01) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.boltBuf);
      gl.bufferData(gl.ARRAY_BUFFER, b.segs, gl.STREAM_DRAW);
      const stride = 7 * 4;
      gl.enableVertexAttribArray(A.a_a);
      gl.vertexAttribPointer(A.a_a, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(A.a_a, 1);
      gl.enableVertexAttribArray(A.a_b);
      gl.vertexAttribPointer(A.a_b, 3, gl.FLOAT, false, stride, 12);
      gl.vertexAttribDivisor(A.a_b, 1);
      gl.enableVertexAttribArray(A.a_w);
      gl.vertexAttribPointer(A.a_w, 1, gl.FLOAT, false, stride, 24);
      gl.vertexAttribDivisor(A.a_w, 1);
      // a wide violet glow, a tighter one, then the hot thin core
      gl.uniform3fv(u.u_col, [0.52, 0.42, 1.0]);
      gl.uniform1f(u.u_width, 11 * this.dpr);
      gl.uniform1f(u.u_i, b.i * 0.035);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
      gl.uniform3fv(u.u_col, [0.66, 0.62, 1.0]);
      gl.uniform1f(u.u_width, 4 * this.dpr);
      gl.uniform1f(u.u_i, b.i * 0.13);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
      gl.uniform3fv(u.u_col, [0.9, 0.88, 1.0]);
      gl.uniform1f(u.u_width, 1.1 * this.dpr);
      gl.uniform1f(u.u_i, b.i * 1.2);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    }
    for (const a of [A.a_a, A.a_b, A.a_w]) { gl.vertexAttribDivisor(a, 0); gl.disableVertexAttribArray(a); }
    gl.disableVertexAttribArray(A.a_corner);
    gl.disable(gl.BLEND);
  }

  // a still: a few rounds of the 2x2 cycle with nothing moving, so the picture is as clean as the live view
  snapshot(s, frames = 16) {
    return new Promise((resolve) => {
      const drift = (s.weather.drift || []).map((d) => ({ ...d, vx: 0, vy: 0 }));
      const still = { ...s, moving: false, dataChanged: false, still: true, weather: { ...s.weather, drift } };
      for (let i = 0; i < frames; i++) this.render(still, performance.now());
      this.canvas.toBlob(resolve, "image/png");
    });
  }

  dispose() {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}

const SKY_ELS = [-18, -14, -11, -9, -7.5, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3.5, 5, 7, 10, 14, 20, 28, 38, 50, 65, 90];
const ZERO = { x: 0, y: 0, run: 0, dx: 1, dy: 0, vx: 0, vy: 0 };
const ZERO2 = [0, 0];
