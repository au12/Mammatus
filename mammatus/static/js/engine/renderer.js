// WebGL2 renderer. Draws only when something changed (camera, data, time, animation),
// so an idle view costs no GPU time or battery.
import { buffer, compile, dataTexture, imageTexture, loadImage, texture } from "./gl.js";
import { Camera } from "./camera.js";
import * as S from "./shaders.js";

const DEG = Math.PI / 180;
const IS_MOBILE = matchMedia("(pointer: coarse)").matches || /Mobi|Android/i.test(navigator.userAgent);

export function sunAndSidereal(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360 * DEG;
  const lon = ra - gmst;
  return { sun: [Math.cos(dec) * Math.cos(lon), Math.cos(dec) * Math.sin(lon), Math.sin(dec)], gmst, dec, subLon: lon };
}

export class Renderer extends EventTarget {
  constructor(canvas, opts = {}) {
    super();
    this.canvas = canvas;
    this.lowPower = opts.lowPower ?? IS_MOBILE;
    const gl = canvas.getContext("webgl2", {
      antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: this.lowPower ? "low-power" : "default",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    this.camera = new Camera();
    this.progs = new Map();
    this.look = { dim: 1, styled: 0, clouds: 1, realism: 1, styleZoom: true };
    this.landColor = [0.078, 0.094, 0.126];
    this.waterColor = [0.026, 0.038, 0.066];
    this.field = null;
    this.lines = new Map();
    this.fills = null;
    this.particles = null;
    this.stars = null;
    this.tex = {};
    this.time = new Date();
    this.timeInfo = sunAndSidereal(this.time);
    this.maxDpr = this.lowPower ? 2 : 2;
    this._raf = 0;
    this._lastFrame = 0;
    this.lastInteraction = performance.now();
    this.idleParticleMs = this.lowPower ? 20000 : 120000;
    this.fieldAnim = null;
    this.frames = 0;
    this._init();
    this._observe();
  }

  _init() {
    const gl = this.gl;
    this.quad = buffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.corner = buffer(gl, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));
    // 2-degree lon/lat mesh used only while morphing between globe and map
    const step = 2, nx = 360 / step + 1, ny = 180 / step + 1;
    const verts = new Float32Array(nx * ny * 2);
    let o = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { verts[o++] = -180 + i * step; verts[o++] = -90 + j * step; }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    o = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
    this.mesh = { vbo: buffer(gl, verts), ibo: gl.createBuffer(), count: idx.length };
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const black = texture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([8, 14, 26, 255]));
    this.tex.day = this.tex.night = this.tex.terrain = black;
    this.tex.empty = black;
    const zero = dataTexture(gl, 1, 1, 1, new Uint16Array([0]));
    this.tex.zero = zero;
    const zero2 = dataTexture(gl, 1, 1, 2, new Uint16Array([0, 0]));
    this.tex.zero2 = zero2;
  }

  _observe() {
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas);
    this.resize();
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    this.canvas.addEventListener("webglcontextrestored", () => location.reload());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.requestRender(); });
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.camera.setViewport(r.width, r.height, dpr);
    this.requestRender();
  }

  prog(key, vs, fs, defines = [], feedback = null) {
    const id = `${key}|${defines.join(",")}`;
    let p = this.progs.get(id);
    if (!p) { p = compile(this.gl, vs, fs, defines, feedback); this.progs.set(id, p); }
    return p;
  }

  // ----------------------------------------------------------------- assets
  async loadEarth(hd, base = "") {
    const size = hd ? "4k" : "2k";
    const [day, night, terrain] = await Promise.all([
      loadImage(`${base}img/earth-day-${size}.jpg`), loadImage(`${base}img/earth-night-${size}.jpg`), loadImage(`${base}img/earth-terrain.jpg`),
    ]);
    const gl = this.gl;
    this.tex.day = imageTexture(gl, day, { aniso: this.aniso });
    this.tex.night = imageTexture(gl, night, { aniso: this.aniso });
    this.tex.terrain = imageTexture(gl, terrain, { aniso: this.aniso });
    this.requestRender();
  }

  setStars(stars) {
    const gl = this.gl;
    this.stars = { dir: buffer(gl, stars.dir), mt: buffer(gl, stars.mt), count: stars.count };
    this.requestRender();
  }

  setClouds(img) {
    const gl = this.gl;
    if (this.tex.clouds) gl.deleteTexture(this.tex.clouds);
    this.tex.clouds = img ? imageTexture(gl, img, { aniso: this.aniso }) : null;
    this.requestRender();
  }

  setTime(date) {
    this.time = date;
    this.timeInfo = sunAndSidereal(date);
    this.requestRender();
  }

  // ----------------------------------------------------------------- field
  // f: {grid, kind, qs, tex0, tex1, mix, lut, lutRows, stops, nstops, hemi, opacity}
  setField(f) {
    this.field = f;
    this.requestRender();
  }

  crossfade(f, ms = 260) {
    if (!this.field || !f || this.field.grid?.id !== f.grid?.id || this.field.kind !== f.kind || ms <= 0) {
      this.fieldAnim = null;
      this.setField(f);
      return;
    }
    this.field = { ...f, tex1: f.tex0, tex0: this.field.tex0, mix: 0 };
    this.fieldAnim = { t0: performance.now(), ms, target: f };
    this.requestRender();
  }

  // ----------------------------------------------------------------- lines
  setLines(id, data, style) {
    const gl = this.gl;
    const old = this.lines.get(id);
    if (old?.vbo) gl.deleteBuffer(old.vbo);
    if (!data || data.length < 6) { this.lines.delete(id); this.requestRender(); return; }
    this.lines.set(id, { vbo: buffer(gl, data), count: data.length / 3 - 1, ...style });
    this.requestRender();
  }

  setLineStyle(id, patch) {
    const l = this.lines.get(id);
    if (l) { Object.assign(l, patch); this.requestRender(); }
  }

  // ----------------------------------------------------------------- county fills (alerts)
  setCountyGeometry(geom) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    this.fills = { geom, vao, vbo: buffer(gl, geom.verts), obo: buffer(gl, geom.owner), ibo: gl.createBuffer(),
      count: geom.indices.length, colorTex: null, rows: 1, visible: false };
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fills.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
  }

  setCountyColors(rgba) {
    if (!this.fills) return;
    const gl = this.gl;
    const rows = Math.ceil(rgba.length / 4 / 1024);
    const data = new Uint8Array(rows * 1024 * 4);
    data.set(rgba);
    if (this.fills.colorTex) gl.deleteTexture(this.fills.colorTex);
    const t = texture(gl, { filter: gl.NEAREST });
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.fills.colorTex = t;
    this.fills.rows = rows;
    this.fills.visible = true;
    this.requestRender();
  }

  hideCountyFills() { if (this.fills) { this.fills.visible = false; this.requestRender(); } }

  // ----------------------------------------------------------------- particles
  setParticles(cfg) {
    const gl = this.gl;
    if (!cfg) {
      if (this.particles) { this.particles.enabled = false; }
      this.requestRender();
      return;
    }
    const count = cfg.count || (this.lowPower ? 2600 : 6000);
    if (!this.particles || this.particles.count !== count) {
      const init = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) { init[i * 4 + 2] = 1e6; init[i * 4 + 3] = Math.random(); }
      const a = buffer(gl, init, gl.DYNAMIC_COPY), b = buffer(gl, init, gl.DYNAMIC_COPY);
      if (this.particles) { gl.deleteBuffer(this.particles.a); gl.deleteBuffer(this.particles.b); }
      this.particles = { a, b, count, tf: gl.createTransformFeedback() };
    }
    Object.assign(this.particles, cfg, { enabled: true, fade: this.particles.fade ?? 0 });
    this.poke();
  }

  // ----------------------------------------------------------------- loop
  poke() {
    this.lastInteraction = performance.now();
    this.requestRender();
  }

  requestRender() {
    if (this._raf || this.lost) return;
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    this._raf = 0;
    if (document.hidden) return;
    let more = this.camera.step(now);
    if (this.fieldAnim) {
      const a = this.fieldAnim;
      const u = Math.min(1, (now - a.t0) / a.ms);
      this.field.mix = u * u * (3 - 2 * u);
      if (u >= 1) { this.field = a.target; this.fieldAnim = null; } else more = true;
    }
    const p = this.particles;
    let animParticles = false;
    if (p?.enabled) {
      const idle = now - this.lastInteraction > this.idleParticleMs;
      p.fade = Math.max(0, Math.min(1, p.fade + (idle ? -0.03 : 0.06)));
      animParticles = p.fade > 0;
      if (animParticles) {
        // cap at ~30 fps on low-power devices to save battery
        if (this.lowPower && now - this._lastFrame < 30) { this._raf = requestAnimationFrame((t) => this._frame(t)); return; }
        more = true;
      }
    }
    this._lastFrame = now;
    this.draw(now, animParticles);
    this.frames++;
    this.dispatchEvent(new Event("frame"));
    if (more) this.requestRender();
  }

  draw(now, animParticles) {
    const gl = this.gl;
    const cam = this.camera;
    const U = cam.uniforms();
    const t = U.d.t;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.004, 0.006, 0.012, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const common = (p) => {
      gl.uniform4fv(p.uniforms.u_view, U.view);
      gl.uniform4fv(p.uniforms.u_vp, U.vp);
      gl.uniform2fv(p.uniforms.u_merc, U.merc);
    };

    const skyVisible = t < 0.999 && !this._globeCoversScreen(U.d);
    if (skyVisible) this._drawSky(common, 1 - t);

    this._drawSurface(common, t);
    if (this.fills?.visible && this.fills.colorTex) this._drawFills(common);
    if (this.particles?.enabled && this.particles.fade > 0 && this.particles.tex) this._drawParticles(common, now, animParticles);
    const zoom = cam.zoom;
    const sorted = [...this.lines.values()].filter((l) => l.visible !== false && zoom >= (l.minZoom ?? -9) && zoom < (l.maxZoom ?? 99))
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    if (sorted.length) this._drawLines(common, sorted);
  }

  _globeCoversScreen(d) {
    const cam = this.camera;
    for (const [x, y] of [[0, 0], [cam.w, 0], [0, cam.h], [cam.w, cam.h]]) if (!cam.unproject(x, y, d)) return false;
    return true;
  }

  _bindQuad(p) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const loc = p.attribs.a_pos;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  _drawSky(common, fade) {
    const gl = this.gl;
    gl.bindVertexArray(null);
    const p = this.prog("sky", S.SKY_VS, S.SKY_FS);
    gl.useProgram(p.prog);
    common(p);
    gl.uniform1f(p.uniforms.u_gmst, this.timeInfo.gmst);
    gl.uniform1f(p.uniforms.u_fade, fade);
    this._bindQuad(p);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    if (this.stars) {
      const sp = this.prog("stars", S.STAR_VS, S.STAR_FS);
      gl.useProgram(sp.prog);
      common(sp);
      gl.uniform1f(sp.uniforms.u_gmst, this.timeInfo.gmst);
      gl.uniform1f(sp.uniforms.u_dpr, this.camera.dpr);
      gl.uniform1f(sp.uniforms.u_fade, fade);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stars.dir);
      gl.enableVertexAttribArray(sp.attribs.a_dir);
      gl.vertexAttribPointer(sp.attribs.a_dir, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stars.mt);
      gl.enableVertexAttribArray(sp.attribs.a_mt);
      gl.vertexAttribPointer(sp.attribs.a_mt, 2, gl.FLOAT, false, 0, 0);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, this.stars.count);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disableVertexAttribArray(sp.attribs.a_dir);
      gl.disableVertexAttribArray(sp.attribs.a_mt);
    }
  }

  _drawSurface(common, t) {
    const gl = this.gl;
    const f = this.field;
    const defs = [];
    if (t >= 0.999) defs.push("FLAT"); else if (t > 0.001) defs.push("MESH");
    if (f) defs.push("FIELD_ON");
    if (this.tex.clouds && this.look.clouds > 0.01) defs.push("CLOUDS");
    const p = this.prog("surface", S.SURFACE_VS, S.SURFACE_FS, defs);
    gl.useProgram(p.prog);
    common(p);
    const u = p.uniforms;
    gl.uniform3fv(u.u_sun, this.timeInfo.sun);
    const zoomStyle = this.look.styleZoom ? smooth(4.6, 7.2, this.camera.zoom) : 0;
    const styled = Math.max(this.look.styled, zoomStyle);
    gl.uniform4f(u.u_look, this.look.dim, styled, this.look.clouds, this.look.realism * (1 - t));
    gl.uniform3fv(u.u_land, this.landColor);
    gl.uniform3fv(u.u_water, this.waterColor);
    let unit = 0;
    const bind = (name, tex, target = gl.TEXTURE_2D) => {
      if (u[name] == null) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
      gl.uniform1i(u[name], unit++);
    };
    bind("u_day", this.tex.day);
    bind("u_night", this.tex.night);
    bind("u_terrain", this.tex.terrain);
    bind("u_clouds", this.tex.clouds || this.tex.empty);
    if (f) {
      const zeroTex = f.kind === 1 ? this.tex.zero2 : this.tex.zero;
      bind("u_data0", f.tex0 || zeroTex);
      bind("u_data1", f.tex1 || f.tex0 || zeroTex);
      bind("u_lut", f.lut);
      gl.uniform1f(u.u_mix, f.tex1 ? f.mix || 0 : 0);
      gl.uniform2f(u.u_qs, f.qs[0], f.qs[1]);
      gl.uniform1i(u.u_kind, f.kind);
      gl.uniform1f(u.u_hemi, f.hemi ? 1 : 0);
      gl.uniform1fv(u.u_stops, f.stops);
      gl.uniform1i(u.u_nstops, f.nstops);
      gl.uniform1f(u.u_lutRows, f.lutRows || 1);
      gl.uniform1f(u.u_opacity, f.opacity ?? 0.88);
      setGrid(gl, u, f.grid);
    }
    if (defs.includes("MESH")) {
      gl.uniform1f(u.u_meshLon, Math.round(this.camera.lon / 2) * 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.vbo);
      gl.enableVertexAttribArray(p.attribs.a_pos);
      gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.ibo);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    } else {
      this._bindQuad(p);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disableVertexAttribArray(p.attribs.a_pos);
  }

  _drawFills(common) {
    const gl = this.gl;
    const F = this.fills;
    const p = this.prog("fill", S.FILL_VS, S.FILL_FS);
    gl.useProgram(p.prog);
    common(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, F.colorTex);
    gl.uniform1i(p.uniforms.u_colors, 0);
    gl.uniform1f(p.uniforms.u_ncolors, F.rows);
    gl.bindBuffer(gl.ARRAY_BUFFER, F.vbo);
    gl.enableVertexAttribArray(p.attribs.a_ll);
    gl.vertexAttribPointer(p.attribs.a_ll, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, F.obo);
    gl.enableVertexAttribArray(p.attribs.a_owner);
    gl.vertexAttribPointer(p.attribs.a_owner, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, F.ibo);
    gl.drawElements(gl.TRIANGLES, F.count, gl.UNSIGNED_INT, 0);
    gl.disableVertexAttribArray(p.attribs.a_ll);
    gl.disableVertexAttribArray(p.attribs.a_owner);
  }

  _drawLines(common, layers) {
    const gl = this.gl;
    const p = this.prog("line", S.LINE_VS, S.LINE_FS);
    gl.useProgram(p.prog);
    common(p);
    const A = p.attribs;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(A.a_corner);
    gl.vertexAttribPointer(A.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(A.a_corner, 0);
    const dpr = this.camera.dpr;
    for (const l of layers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, l.vbo);
      gl.enableVertexAttribArray(A.a_a);
      gl.vertexAttribPointer(A.a_a, 3, gl.FLOAT, false, 12, 0);
      gl.vertexAttribDivisor(A.a_a, 1);
      gl.enableVertexAttribArray(A.a_b);
      gl.vertexAttribPointer(A.a_b, 3, gl.FLOAT, false, 12, 12);
      gl.vertexAttribDivisor(A.a_b, 1);
      gl.uniform2f(p.uniforms.u_dash, l.dash ? l.dash[0] : 0, l.dash ? l.dash[1] : 0);
      if (l.halo) {
        gl.uniform1f(p.uniforms.u_width, (l.width + l.halo * 2) * dpr);
        gl.uniform4fv(p.uniforms.u_color, l.haloColor || [0, 0, 0, 0.45]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
      }
      gl.uniform1f(p.uniforms.u_width, l.width * dpr);
      const ga = l.globeAlpha ?? 1;
      const fade = ga + (1 - ga) * this.camera.t;
      gl.uniform4f(p.uniforms.u_color, l.color[0], l.color[1], l.color[2], l.color[3] * fade);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
    }
    gl.vertexAttribDivisor(A.a_a, 0);
    gl.vertexAttribDivisor(A.a_b, 0);
    gl.disableVertexAttribArray(A.a_a);
    gl.disableVertexAttribArray(A.a_b);
    gl.disableVertexAttribArray(A.a_corner);
  }

  _drawParticles(common, now, animate) {
    const gl = this.gl;
    const P = this.particles;
    const dt = Math.min(0.05, (now - (P.last || now)) / 1000) || 0.016;
    P.last = now;
    const cam = this.camera;
    const kpx = cam.derived().kg * cam.dpr;  // device px per radian
    if (animate) {
      const up = this.prog("pupdate", S.PARTICLE_UPDATE_VS, S.PARTICLE_UPDATE_FS, [], ["v_state"]);
      gl.useProgram(up.prog);
      common(up);
      const u = up.uniforms;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, P.tex);
      gl.uniform1i(u.u_wind, 0);
      gl.uniform2f(u.u_qs, P.qs[0], P.qs[1]);
      // ~ 30 px/s for a 10 m/s wind at any zoom
      gl.uniform1f(u.u_step, (P.speed ?? 3.0) * cam.dpr * dt / kpx);
      gl.uniform1f(u.u_maxAge, P.maxAge ?? 3.2);
      gl.uniform1f(u.u_dt, dt);
      gl.uniform1f(u.u_seed, (now % 10000) / 10000);
      setGrid(gl, u, P.grid);
      gl.bindBuffer(gl.ARRAY_BUFFER, P.a);
      gl.enableVertexAttribArray(up.attribs.a_state);
      gl.vertexAttribPointer(up.attribs.a_state, 4, gl.FLOAT, false, 0, 0);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, P.tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, P.b);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, P.count);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.disableVertexAttribArray(up.attribs.a_state);
      [P.a, P.b] = [P.b, P.a];
    }
    const dp = this.prog("pdraw", S.PARTICLE_DRAW_VS, S.PARTICLE_DRAW_FS);
    gl.useProgram(dp.prog);
    common(dp);
    const u = dp.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, P.tex);
    gl.uniform1i(u.u_wind, 0);
    gl.uniform2f(u.u_qs, P.qs[0], P.qs[1]);
    gl.uniform1f(u.u_trail, (P.trail ?? 1.7) * cam.dpr / kpx);
    gl.uniform1f(u.u_maxAge, P.maxAge ?? 3.2);
    gl.uniform1f(u.u_width, (P.width ?? 1.25) * cam.dpr);
    const c = P.color || [1, 1, 1, 0.78];
    gl.uniform4f(u.u_color, c[0], c[1], c[2], c[3] * P.fade);
    setGrid(gl, u, P.grid);
    const A = dp.attribs;
    gl.bindBuffer(gl.ARRAY_BUFFER, P.a);
    gl.enableVertexAttribArray(A.a_state);
    gl.vertexAttribPointer(A.a_state, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(A.a_state, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(A.a_corner);
    gl.vertexAttribPointer(A.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, P.count);
    gl.vertexAttribDivisor(A.a_state, 0);
    gl.disableVertexAttribArray(A.a_state);
    gl.disableVertexAttribArray(A.a_corner);
  }

  // Read the current frame as a PNG blob (for snapshots).
  snapshot() {
    return new Promise((resolve) => {
      this.draw(performance.now(), false);
      this.canvas.toBlob(resolve, "image/png");
    });
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function setGrid(gl, u, g) {
  if (!g || u.u_gtype == null) return;
  if (g.type === "lambert") {
    gl.uniform1i(u.u_gtype, 1);
    gl.uniform4f(u.u_g0, g.n, g.RF, g.rho0, g.lov);
    gl.uniform4f(u.u_g1, g.x1, g.y1, g.dx, g.dy);
    gl.uniform1f(u.u_gjpos, g.jpos === 0 ? -1 : 1);
  } else {
    gl.uniform1i(u.u_gtype, 0);
    gl.uniform4f(u.u_g0, g.la1, g.lo1, g.dlat, g.dlon);
    gl.uniform4f(u.u_g1, g.ni, g.nj, g.wrap ? 1 : 0, 0);
    gl.uniform1f(u.u_gjpos, 1);
  }
  gl.uniform2f(u.u_gsize, g.ni, g.nj);
}
