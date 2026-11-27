// WebGL2 renderer for the Sky view, on its own canvas and context.
//
// Each frame: physical sky lookup (when the sun moves), cloud shadows on the ground, the background
// (sky, sun, moon, stars, terrain) at full resolution, volumetric clouds at reduced resolution with a
// jittered ray start, accumulated over frames and reprojected when the camera moves, then one
// composite pass (light shafts, halos, rainbows, lightning glow, tone mapping, dither) and the bolts.
import { compile, loadImage } from "../engine/gl.js";
import * as S from "./shaders.js";

export const N = 40, NZ = 64;
const HALTON = [[0.5, 0.333], [0.25, 0.667], [0.75, 0.111], [0.125, 0.444], [0.625, 0.778], [0.375, 0.222], [0.875, 0.556], [0.0625, 0.889]];

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
    this.progs = {};
    this.tex = {};
    this.frames = new Map();           // key -> {vol, aux, anvil}
    this.frameNo = 0;
    this.scale = lowPower ? 0.36 : 0.55;
    this.maxSteps = lowPower ? 44 : 76;
    this.shadowSize = lowPower ? 160 : 256;
    this.shadowSpan = 168;
    this.lost = false;
    this.hist = 0;
    this.reset = true;
    this.prevVP = null;
    this.stats = { ms: 0 };
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; this.onLost?.(); });
    this._init();
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
    this.tex.wind = this._tex2D(NZ, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, new Float32Array(NZ * 4));
    this.tex.sunLUT = this._tex2D(64, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT, new Float32Array(64 * 4).fill(1));
    this.tex.terrain = this._tex2D(N, N, gl.R16F, gl.RED, gl.FLOAT, new Float32Array(N * N));
    const blank = { vol: new Uint8Array(NZ * N * N * 4), aux: new Uint8Array(NZ * N * N * 4), anvil: new Float32Array(N * N * 2) };
    this.empty = this._upload(blank);
    const px = this._tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 60, 40, 255]));
    this.tex.day = px;
    this.tex.night = this._tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.skyLUT = this._target(192, 108, [gl.RGBA16F]);
    this.shadow = this._target(this.shadowSize, this.shadowSize, [gl.RGBA8]);
    this.lastSky = null;
  }

  // the noise volumes are made on the GPU the first time the view opens
  makeNoise() {
    if (this.tex.noise) return;
    const gl = this.gl;
    const gen = (size, kind) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, size, size, size);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const p = this._prog("noise", S.QUAD_VS, S.NOISE_FS);
      gl.useProgram(p.prog);
      gl.viewport(0, 0, size, size);
      gl.disable(gl.BLEND);
      gl.uniform1f(p.uniforms.u_size, size);
      gl.uniform1i(p.uniforms.u_kind, kind);
      this._quad(p);
      for (let z = 0; z < size; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, z);
        gl.uniform1f(p.uniforms.u_slice, (z + 0.5) / size);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      return t;
    };
    this.tex.noise = gen(this.lowPower ? 96 : 128, 0);
    this.tex.detail = gen(32, 1);
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

  // GPU copies of decoded frames, kept for the most recent few
  frame(key, f) {
    let g = this.frames.get(key);
    if (g) { this.frames.delete(key); this.frames.set(key, g); return g; }
    g = this._upload(f);
    this.frames.set(key, g);
    const gl = this.gl;
    while (this.frames.size > 10) {
      let victim = null;
      for (const k of this.frames.keys()) if (k !== this.keyA && k !== this.keyB && k !== key) { victim = k; break; }
      if (victim == null) break;
      const old = this.frames.get(victim);
      this.frames.delete(victim);
      gl.deleteTexture(old.vol); gl.deleteTexture(old.aux); gl.deleteTexture(old.anvil);
    }
    return g;
  }

  setWind(arr) { this._sub(this.tex.wind, NZ, 1, this.gl.RGBA, arr); }
  setSunLUT(arr) { this._sub(this.tex.sunLUT, 64, 1, this.gl.RGBA, arr); }
  setTerrain(arr) { this._sub(this.tex.terrain, N, N, this.gl.RED, arr); this.shadowDirty = true; }
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

  _sizeClouds() {
    const gl = this.gl;
    const cw = Math.max(16, Math.ceil(this.W * this.scale)), ch = Math.max(16, Math.ceil(this.H * this.scale));
    if (this.cur && this.cur.w === cw && this.cur.h === ch) return;
    [this.cur, this.histA, this.histB].forEach((t) => this._free(t));
    this.cur = this._target(cw, ch, [gl.RGBA16F, gl.RGBA16F]);
    this.histA = this._target(cw, ch, [gl.RGBA16F, gl.RGBA16F]);
    this.histB = this._target(cw, ch, [gl.RGBA16F, gl.RGBA16F]);
    this.reset = true;
  }

  setScale(s) {
    const v = Math.min(0.75, Math.max(0.22, s));
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
    if (u == null) return;
    const gl = this.gl;
    p._unit = (p._unit ?? -1) + 1;
    gl.activeTexture(gl.TEXTURE0 + p._unit);
    gl.bindTexture(target || gl.TEXTURE_2D, tex);
    gl.uniform1i(u, p._unit);
  }

  _use(p) { this.gl.useProgram(p.prog); p._unit = -1; return p; }

  _common(p, s) {
    const gl = this.gl, u = p.uniforms, e = s.env;
    if (u.u_camPos) gl.uniform3fv(u.u_camPos, s.cam.pos);
    if (u.u_invVP) gl.uniformMatrix4fv(u.u_invVP, false, s.cam.invVP);
    if (u.u_light) gl.uniform3fv(u.u_light, e.light);
    if (u.u_lightI) gl.uniform1f(u.u_lightI, e.lightI);
    if (u.u_ambTop) gl.uniform3fv(u.u_ambTop, e.ambTop);
    if (u.u_ambBot) gl.uniform3fv(u.u_ambBot, e.ambBot);
    if (u.u_elev) gl.uniform1f(u.u_elev, e.elev);
    if (u.u_lat0) gl.uniform2f(u.u_lat0, e.lat, e.lon);
    if (u.u_hazeK) gl.uniform1f(u.u_hazeK, s.cam.hazeK ?? 1);
    if (u.u_cut) gl.uniform4fv(u.u_cut, s.cam.cut);
    if (u.u_slab) gl.uniform2fv(u.u_slab, s.cam.slab || [1e4, 1]);
    this._bind(p, "u_sunLUT", this.tex.sunLUT);
  }

  _cloudUniforms(p, s) {
    const gl = this.gl, u = p.uniforms, w = s.weather;
    const a = this.frames.get(w.a) || this.empty, b = this.frames.get(w.b) || a;
    this._bind(p, "u_vol0", a.vol, gl.TEXTURE_3D);
    this._bind(p, "u_aux0", a.aux, gl.TEXTURE_3D);
    this._bind(p, "u_vol1", b.vol, gl.TEXTURE_3D);
    this._bind(p, "u_aux1", b.aux, gl.TEXTURE_3D);
    this._bind(p, "u_noise", this.tex.noise, gl.TEXTURE_3D);
    this._bind(p, "u_detail", this.tex.detail, gl.TEXTURE_3D);
    this._bind(p, "u_wind", this.tex.wind);
    this._bind(p, "u_anvil", (w.mix > 0.5 ? b : a).anvil);
    gl.uniform1f(u.u_mix, b === a ? 0 : w.mix);
    gl.uniform1f(u.u_time, s.time);
    gl.uniform1f(u.u_appear, w.appear);
    if (u.u_mammatus) gl.uniform1f(u.u_mammatus, w.mammatus);
    gl.uniform1f(u.u_ext, w.ext ?? 0.55);
    if (u.u_pixAngle) gl.uniform1f(u.u_pixAngle, s.cam.fov / Math.max(1, this.cur ? this.cur.h : this.H));
  }

  render(s, now) {
    if (this.lost || !this.bg || !this.tex.noise) return;
    const gl = this.gl;
    const t0 = performance.now();
    this.keyA = s.weather.a; this.keyB = s.weather.b;
    this.frameNo++;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    // 1. physical sky, when the sun or the observer height moved
    const skySig = `${s.env.sunDir.map((x) => x.toFixed(4))}|${(s.cam.pos[2] + s.env.elev).toFixed(1)}`;
    if (skySig !== this.lastSky) {
      this.lastSky = skySig;
      const p = this._use(this._prog("skylut", S.QUAD_VS, S.SKYLUT_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.skyLUT.fb);
      gl.viewport(0, 0, this.skyLUT.w, this.skyLUT.h);
      gl.uniform2f(p.uniforms.u_size, this.skyLUT.w, this.skyLUT.h);
      gl.uniform3fv(p.uniforms.u_sunDir, s.env.sunDir);
      gl.uniform1f(p.uniforms.u_h0, Math.max(0.05, s.cam.pos[2] + s.env.elev));
      this._quad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 2. cloud shadows on the ground (every other frame; the clouds move slowly)
    if (this.shadowDirty || s.dataChanged || this.frameNo % (this.lowPower ? 3 : 2) === 0) {
      this.shadowDirty = false;
      const p = this._use(this._prog("shadow", S.QUAD_VS, S.SHADOW_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fb);
      gl.viewport(0, 0, this.shadow.w, this.shadow.h);
      this._common(p, s);
      this._cloudUniforms(p, s);
      this._bind(p, "u_terrain", this.tex.terrain);
      gl.uniform2f(p.uniforms.u_size, this.shadow.w, this.shadow.h);
      gl.uniform1f(p.uniforms.u_span, this.shadowSpan);
      this._quad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 3. background
    const e = s.env;
    {
      const p = this._use(this._prog("bg", S.QUAD_VS, S.BG_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bg.fb);
      gl.viewport(0, 0, this.W, this.H);
      this._common(p, s);
      const u = p.uniforms;
      gl.uniform2f(u.u_res, this.W, this.H);
      this._bind(p, "u_skyLUT", this.skyLUT.tex[0]);
      this._bind(p, "u_terrain", this.tex.terrain);
      this._bind(p, "u_day", this.tex.day);
      this._bind(p, "u_nightTex", this.tex.night);
      this._bind(p, "u_shadow", this.shadow.tex[0]);
      gl.uniform1f(u.u_shadowSpan, this.shadowSpan);
      gl.uniform3fv(u.u_sunDir, e.sunDir);
      gl.uniform3fv(u.u_sunCol, e.sunCol);
      gl.uniform3fv(u.u_moonDir, e.moonDir);
      gl.uniform3fv(u.u_moonCol, e.moonCol);
      gl.uniform1f(u.u_moonIllum, e.moonIllum);
      gl.uniform1f(u.u_night, e.night);
      gl.uniform1f(u.u_stylize, s.cam.stylize);
      gl.uniform1f(u.u_refDist, s.cam.refDist);
      gl.uniform1f(u.u_refZ, s.cam.pos[2]);
      gl.uniform1f(u.u_snow, e.snow);
      gl.uniform1f(u.u_cityGlow, e.cityGlow);
      gl.uniform1f(u.u_far, s.cam.far);
      this._quad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (this.stars && e.starVis > 0.01) {
      // stars go into the background colour only (the depth target stays unbound while it's read)
      if (!this.starFB) this.starFB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.starFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bg.tex[0], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const p = this._use(this._prog("stars", S.STAR_VS, S.STAR_FS));
      const u = p.uniforms;
      gl.uniformMatrix4fv(u.u_vp, false, s.cam.vp);
      gl.uniformMatrix3fv(u.u_eq, false, e.eq);
      gl.uniform3fv(u.u_camPos, s.cam.pos);
      gl.uniform1f(u.u_dpr, this.dpr);
      gl.uniform1f(u.u_vis, e.starVis);
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

    // 4. clouds
    const jit = HALTON[this.frameNo % HALTON.length];
    {
      const p = this._use(this._prog("cloud", S.QUAD_VS, S.CLOUD_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cur.fb);
      gl.viewport(0, 0, this.cur.w, this.cur.h);
      this._common(p, s);
      this._cloudUniforms(p, s);
      const u = p.uniforms;
      gl.uniform2f(u.u_res, this.cur.w, this.cur.h);
      gl.uniform2f(u.u_jitter, jit[0] - 0.5, jit[1] - 0.5);
      gl.uniform1f(u.u_frame, this.frameNo % 64);
      this._bind(p, "u_sceneDepth", this.bg.tex[1]);
      this._bind(p, "u_shadow", this.shadow.tex[0]);
      gl.uniform1f(u.u_shadowSpan, this.shadowSpan);
      const bands = new Float32Array(12);
      const nb = Math.min(6, s.weather.bands.length);
      for (let i = 0; i < nb; i++) { bands[i * 2] = s.weather.bands[i][0]; bands[i * 2 + 1] = s.weather.bands[i][1]; }
      gl.uniform2fv(u.u_bands, bands);
      gl.uniform1i(u.u_nbands, nb);
      gl.uniform1i(u.u_maxSteps, Math.round(this.maxSteps * (s.cam.cut[3] > 0.5 ? 1 : 1.35)));   // from the ground rays cross the whole depth of the clouds
      gl.uniform1f(u.u_far, s.cam.far);
      gl.uniform3fv(u.u_cityCol, e.cityCol);
      const fc = new Float32Array(8);
      (s.flashes || []).slice(0, 2).forEach((f, i) => { fc.set([f.x, f.y, f.z, f.i], i * 4); });
      gl.uniform4fv(u.u_flash, fc);
      gl.uniform3fv(u.u_flashCol, [0.78, 0.82, 1.0]);
      this._quad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 5. accumulate
    const src = this.hist ? this.histB : this.histA, dst = this.hist ? this.histA : this.histB;
    this.hist ^= 1;
    {
      const p = this._use(this._prog("resolve", S.QUAD_VS, S.RESOLVE_FS));
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
      gl.uniform1f(u.u_alpha, s.moving ? 0.45 : (s.dataChanged ? 0.35 : (this.lowPower ? 0.16 : 0.12)));
      gl.uniform1f(u.u_reset, this.reset ? 1 : 0);
      this._quad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    this.reset = false;
    this.prevVP = s.cam.vp;
    this.out = dst;

    // 6. composite to the screen
    {
      const p = this._use(this._prog("composite", S.QUAD_VS, S.COMPOSITE_FS));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.W, this.H);
      this._common(p, s);
      const u = p.uniforms;
      gl.uniform2f(u.u_res, this.W, this.H);
      gl.uniform2f(u.u_cloudRes, dst.w, dst.h);
      this._bind(p, "u_bg", this.bg.tex[0]);
      this._bind(p, "u_bgDepth", this.bg.tex[1]);
      this._bind(p, "u_cloud", dst.tex[0]);
      this._bind(p, "u_cloudEx", dst.tex[1]);
      this._bind(p, "u_shadow", this.shadow.tex[0]);
      gl.uniform1f(u.u_shadowSpan, this.shadowSpan);
      gl.uniform3fv(u.u_sunDir, e.sunDir);
      gl.uniform3fv(u.u_sunCol, e.sunCol);
      gl.uniform3fv(u.u_moonDir, e.moonDir);
      gl.uniform3fv(u.u_moonCol, e.moonCol);
      gl.uniform1f(u.u_exposure, e.exposure);
      gl.uniform1f(u.u_frame, this.frameNo % 64);
      const fl = new Float32Array(8);
      (s.flashes || []).slice(0, 2).forEach((f, i) => { fl.set([f.x, f.y, f.z, f.i], i * 4); });
      gl.uniform4fv(u.u_flash, fl);
      gl.uniform3fv(u.u_flashCol, [0.78, 0.82, 1.0]);
      gl.uniform1f(u.u_rays, e.rays);
      gl.uniform1f(u.u_far, s.cam.far);
      this._quad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 7. lightning bolts
    if (s.bolts?.length) this._drawBolts(s);
    this.stats.ms = this.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  _drawBolts(s) {
    const gl = this.gl;
    const p = this._use(this._prog("bolt", S.BOLT_VS, S.BOLT_FS));
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
      // glow, then the hot core
      gl.uniform3fv(u.u_col, [0.62, 0.66, 1.0]);
      gl.uniform1f(u.u_width, 7 * this.dpr);
      gl.uniform1f(u.u_i, b.i * 0.22);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
      gl.uniform1f(u.u_width, 1.3 * this.dpr);
      gl.uniform1f(u.u_i, b.i * 1.3);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    }
    for (const a of [A.a_a, A.a_b, A.a_w]) { gl.vertexAttribDivisor(a, 0); gl.disableVertexAttribArray(a); }
    gl.disableVertexAttribArray(A.a_corner);
    gl.disable(gl.BLEND);
  }

  // a still: a dozen frames accumulated with the camera still, so the picture is as clean as the live view
  snapshot(s, frames = 12) {
    return new Promise((resolve) => {
      const still = { ...s, moving: false, dataChanged: false };
      for (let i = 0; i < frames - 1; i++) this.render(still, performance.now());
      this.render(still, performance.now());
      this.canvas.toBlob(resolve, "image/png");
    });
  }

  dispose() {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}
