// Map labels on the GPU: saved places, pressure centers, contour values and cities.
//
// Why not a 2D canvas on top of the map: redrawing every label's text on every frame of a pan is
// slow on phones, text re-rasterized at a new sub-pixel offset each frame shimmers, and a greedy
// placement redone from scratch every frame lets one label entering at the screen edge knock out
// another, which frees room for a third... so labels across the whole map blink while you drag.
//
// Here each label is rasterized once into a texture atlas, and the vertex shader projects it with
// the same math as the map, snapped to whole device pixels, so labels move with the map at no CPU
// cost and stay crisp. Placement runs a few times a second while the view moves (and once when it
// settles), keeps labels that were already showing ahead of newcomers, and pre-places labels just
// off screen so they slide in. Labels that lose their spot fade out rather than vanish.
import { compile } from "./gl.js";
import * as S from "./shaders.js";

const FONT = "ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif";
const STRIDE = 9;            // lon, lat, offX, offY, w, h, u, v, alpha
const PLACE_MS = 110;        // placement cadence while the view moves
const MARGIN = 48;           // pre-place labels this far beyond the screen edge (CSS px)
const ATLAS_W = 2048, ATLAS_H = 1024;
const FADE_IN = 0.2, FADE_OUT = 0.16;   // seconds
const HYST = 3;              // CSS px
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------------ sprite atlas
class Atlas {
  constructor(gl) {
    this.gl = gl;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_W, ATLAS_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.scratch = document.createElement("canvas");
    this.sctx = this.scratch.getContext("2d");
    this.reset();
  }

  reset() {
    this.gen = (this.gen || 0) + 1;
    this.sprites = new Map();
    this.shelves = [];
    this.bottom = 0;
  }

  // Shelf packing; when the atlas is full it starts over (labels re-request their sprites).
  alloc(w, h) {
    w += 2; h += 2;  // 1 px gutter so NEAREST sampling never bleeds a neighbor in
    for (const s of this.shelves) {
      if (h <= s.h && h >= s.h * 0.7 && s.x + w <= ATLAS_W) { const r = { x: s.x + 1, y: s.y + 1 }; s.x += w; return r; }
    }
    const sh = Math.ceil(h / 4) * 4;
    if (this.bottom + sh > ATLAS_H || w > ATLAS_W) return null;
    const s = { y: this.bottom, h: sh, x: w };
    this.bottom += sh;
    this.shelves.push(s);
    return { x: s.x - w + 1, y: s.y + 1 };
  }

  // spec: {key, w, h (device px), draw(ctx)}; returns {x, y, w, h, gen} or null if it cannot fit.
  sprite(spec) {
    const hit = this.sprites.get(spec.key);
    if (hit) return hit;
    let at = this.alloc(spec.w, spec.h);
    if (!at) {
      this.reset();
      at = this.alloc(spec.w, spec.h);
      if (!at) return null;
    }
    // the scratch canvas is sized to the sprite exactly, so the whole canvas is the upload
    const c = this.scratch;
    if (c.width !== spec.w || c.height !== spec.h) { c.width = spec.w; c.height = spec.h; }
    const ctx = this.sctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, spec.w, spec.h);
    ctx.textAlign = "left";
    spec.draw(ctx);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, at.x, at.y, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const sp = { x: at.x, y: at.y, w: spec.w, h: spec.h, gen: this.gen };
    this.sprites.set(spec.key, sp);
    return sp;
  }
}

// ------------------------------------------------------------------ collision grid (CSS px)
class Grid {
  constructor(w, h, cell = 56) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil((w + 2 * MARGIN) / cell) + 1);
    this.rows = Math.max(1, Math.ceil((h + 2 * MARGIN) / cell) + 1);
    this.cells = new Array(this.cols * this.rows);
    this.boxes = [];
  }
  _range(b) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((b[0] + MARGIN) / c)), i1 = Math.min(this.cols - 1, Math.floor((b[2] + MARGIN) / c));
    const j0 = Math.max(0, Math.floor((b[1] + MARGIN) / c)), j1 = Math.min(this.rows - 1, Math.floor((b[3] + MARGIN) / c));
    return [i0, i1, j0, j1];
  }
  free(b) {
    const [i0, i1, j0, j1] = this._range(b);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const list = this.cells[j * this.cols + i];
      if (!list) continue;
      for (const k of list) {
        const o = this.boxes[k];
        if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return false;
      }
    }
    return true;
  }
  add(b) {
    const k = this.boxes.length;
    this.boxes.push(b);
    const [i0, i1, j0, j1] = this._range(b);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (this.cells[j * this.cols + i] ||= []).push(k);
  }
}

// ------------------------------------------------------------------ label kinds
// Each kind turns a datum into a sprite (drawn at device scale) and a collision box around its anchor.
const KINDS = {
  point: {
    font: `600 12px ${FONT}`, halo: 3.2,
    key: (d) => `p|${d.name}`,
    layout(m, d) { const w = m(this.font, d.name); return { w: w + 22, h: 18, ax: 7, ay: 9, box: [-7, -9, w + 15, 9] }; },
    draw(ctx, d, L) {
      const s = L.s;
      ctx.beginPath(); ctx.arc(7 * s + L.px, 9 * s + L.px, 4.2 * s, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill();
      ctx.lineWidth = 2.2 * s; ctx.strokeStyle = "rgba(245,154,185,0.95)"; ctx.stroke();
      text(ctx, d.name, 17 * s + L.px, 9 * s + L.px, this.font, s, "#fff", this.halo, "rgba(4,6,12,0.82)");
    },
  },
  hilo: {
    key: (d) => `h|${d.type}|${d.label}`,
    layout(m, d) { const w = Math.max(24, m(`600 10.5px ${FONT}`, d.label) + 8); return { w, h: 40, ax: w / 2, ay: 19, box: [-16, -19, 16, 21] }; },
    draw(ctx, d, L) {
      const s = L.s, cx = L.w / 2 + L.px;
      ctx.textAlign = "center";
      text(ctx, d.type > 0 ? "H" : "L", cx, 16 * s + L.px, `800 22px ${FONT}`, s, d.type > 0 ? "#7fb2ff" : "#ff7a7a", 3.5, "rgba(4,6,12,0.82)");
      text(ctx, d.label, cx, 32 * s + L.px, `600 10.5px ${FONT}`, s, "#e9edf6", 3, "rgba(4,6,12,0.82)");
    },
  },
  contour: {
    font: `650 10.5px ${FONT}`,
    key: (d) => `c|${d.color || ""}|${d.text}`,
    layout(m, d) { const w = m(this.font, d.text) + 8; return { w, h: 16, ax: w / 2, ay: 8, box: [-w / 2 + 1, -7, w / 2 - 1, 7] }; },
    draw(ctx, d, L) {
      ctx.textAlign = "center";
      text(ctx, d.text, L.w / 2 + L.px, 8 * L.s + L.px, this.font, L.s, d.color || "#f4f6fb", 3, "rgba(4,6,12,0.82)");
    },
  },
  city: {
    font: `500 11.5px ${FONT}`,
    key: (d) => `t|${d.name}`,
    layout(m, d) { const w = d.w ??= m(this.font, d.name); return { w: w + 14, h: 16, ax: 4, ay: 8, box: [-4, -8, w + 10, 8] }; },
    draw(ctx, d, L) {
      const s = L.s;
      ctx.beginPath(); ctx.arc(4 * s + L.px, 8 * s + L.px, 1.8 * s, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fill();
      text(ctx, d.name, 10 * s + L.px, 8 * s + L.px, this.font, s, "rgba(233,237,246,0.9)", 2.8, "rgba(4,6,12,0.74)");
    },
  },
};

// (alignment is the caller's: a second call in the same sprite keeps it, where resetting it here used to
// draw a pressure center's value left-aligned from the middle and clip it at the sprite's edge)
function text(ctx, str, x, y, font, s, color, halo, haloColor) {
  ctx.font = font.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${(+n * s).toFixed(2)}px`);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = halo * s;
  ctx.strokeStyle = haloColor;
  ctx.strokeText(str, x, y);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

// ------------------------------------------------------------------ layer
export class Labels {
  constructor(renderer) {
    this.r = renderer;
    this.gl = renderer.gl;
    this.cam = renderer.camera;
    this.atlas = new Atlas(this.gl);
    this.prog = null;
    this.vbo = this.gl.createBuffer();
    this.data = new Float32Array(STRIDE * 64);
    this.count = 0;
    this.cities = [];
    this.points = [];
    this.contour = [];
    this.hilo = [];
    this.frontCenters = [];
    this.showCities = true;
    this.state = new Map();   // key -> {kind, d, lon, lat, L (layout), sprite, alpha, target}
    this.version = 0;
    this.placedVersion = -1;
    this.placedCam = -1;
    this.lastPlace = -1e9;
    this.lastFrame = 0;
    this.dirty = true;
    this.dpr = 0;
    this.measureCtx = document.createElement("canvas").getContext("2d");
    this.widths = new Map();
    this.stats = { placements: 0, lastMs: 0 };
  }

  measure = (font, str) => {
    const k = `${font}|${str}`;
    let w = this.widths.get(k);
    if (w == null) {
      this.measureCtx.font = font;
      w = Math.ceil(this.measureCtx.measureText(str).width);
      if (this.widths.size > 6000) this.widths.clear();
      this.widths.set(k, w);
    }
    return w;
  };

  touch() { this.version++; this.r.requestRender(); }

  // Inputs are checked here so the placement loop (which runs inside the frame loop) never meets
  // a label it cannot handle.
  // rows: [name, admin, cc, lat, lon, pop, rank] sorted by importance
  setCities(rows) {
    this.cities = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && fin(r[3]) && fin(r[4]))
      .map(([name, , , lat, lon, pop, rank], i) => ({ name, lat, lon, pop, rank: fin(rank) ? rank : 10, i }));
    this.touch();
  }
  setPoints(list) { this.points = arr(list).filter((p) => p && typeof p.name === "string" && p.name && fin(p.lat) && fin(p.lon)); this.touch(); }
  setContourLabels(list) { this.contour = arr(list).filter((l) => l && fin(l.lon) && fin(l.lat) && typeof l.text === "string" && l.text); this.touch(); }
  setHilo(list) { this.hilo = arr(list).filter((c) => c && fin(c.lon) && fin(c.lat) && fin(c.value)); this.touch(); }
  setFrontCenters(highs, lows) {
    const pts = (list, type) => arr(list).filter((c) => Array.isArray(c) && fin(c[0]) && fin(c[1]) && fin(c[2])).map(([lon, lat, p]) => ({ lon, lat, value: p, type }));
    this.frontCenters = [...pts(highs, 1), ...pts(lows, -1)];
    this.touch();
  }
  setShowCities(v) { this.showCities = v; this.touch(); }

  // ---------------------------------------------------------------- placement
  place(now) {
    const t0 = performance.now();
    const cam = this.cam, d = cam.derived();
    const W = cam.w, H = cam.h;
    const grid = new Grid(W, H);
    const placed = new Set();
    const onScreen = (p, m = MARGIN) => p.vis > 0.035 && p.x > -m && p.y > -m && p.x < W + m && p.y < H + m;
    const tryPlace = (kind, key, d0, p, pad, force = false) => {
      const K = KINDS[kind];
      const st = this.state.get(key);
      const L = st?.L || K.layout(this.measure, d0);
      const b = [p.x + L.box[0] - pad, p.y + L.box[1] - pad, p.x + L.box[2] + pad, p.y + L.box[3] + pad];
      // spatial hysteresis: a label already showing tolerates a slight overlap before it yields,
      // a newcomer needs a little extra room, so labels near a collision don't flip-flop mid-zoom
      const hy = st && st.target > 0 ? -HYST : HYST;
      if (!force && !grid.free([b[0] - hy, b[1] - hy, b[2] + hy, b[3] + hy])) return false;
      grid.add(b);
      placed.add(key);
      if (st) { st.target = 1; st.lon = d0.lon; st.lat = d0.lat; st.d = d0; }
      else this.state.set(key, { kind, d: d0, lon: d0.lon, lat: d0.lat, L, sprite: null, alpha: 0, target: 1 });
      return true;
    };
    const wasShown = (key) => (this.state.get(key)?.target ?? 0) > 0;

    // 1. saved places: always shown
    for (const pt of this.points) {
      const p = cam.project(pt.lon, pt.lat, d);
      if (onScreen(p)) tryPlace("point", `${KINDS.point.key(pt)}|${pt.lon},${pt.lat}`, pt, p, 2, true);
    }
    // 2. pressure centers (model H/L, or WPC's when the model shows none), strongest first
    const zoomedOut = cam.zoom < 2.4;
    const centers = [...this.hilo, ...this.frontCenters];
    if (centers.length) {
      const hb = zoomedOut ? 22 : 4;
      const cand = [];
      for (const c of centers) {
        if (zoomedOut && Math.abs(c.value - 1013) < 9) continue;
        const p = cam.project(c.lon, c.lat, d);
        if (!onScreen(p, 12)) continue;
        const label = String(Math.round(c.value));
        const dd = { lon: c.lon, lat: c.lat, type: c.type, label };
        const key = `${KINDS.hilo.key(dd)}|${c.lon.toFixed(1)},${c.lat.toFixed(1)}`;
        cand.push({ key, dd, p, s: Math.abs(c.value - 1013) + (wasShown(key) ? 6 : 0) });
      }
      cand.sort((a, b) => b.s - a.s);
      for (const c of cand) tryPlace("hilo", c.key, c.dd, c.p, hb);
    }
    // 3. contour values, sparse when zoomed out
    if (this.contour.length) {
      const pad = cam.zoom < 2.4 ? 40 : cam.zoom < 3.5 ? 20 : 11;
      const cand = [];
      for (let i = 0; i < this.contour.length; i++) {
        const l = this.contour[i];
        const p = cam.project(l.lon, l.lat, d);
        if (!onScreen(p, 24)) continue;
        const key = `${KINDS.contour.key(l)}|${l.lon.toFixed(2)},${l.lat.toFixed(2)}`;
        cand.push({ key, l, p, s: (wasShown(key) ? 0 : 1) * 1e6 + i });
      }
      cand.sort((a, b) => a.s - b.s);
      for (const c of cand) tryPlace("contour", c.key, c.l, c.p, pad);
    }
    // 4. cities: rank by importance; density follows zoom; ones already showing keep their spot
    if (this.showCities && this.cities.length) {
      const z = cam.zoom;
      const maxRank = z < 2.5 ? 1 : z < 3.5 ? 2 : z < 4.5 ? 4 : z < 5.5 ? 6 : z < 6.8 ? 8 : 10;
      const pad = z < 3.5 ? 5 : 3;
      const cand = [];
      for (const c of this.cities) {
        if (c.rank > maxRank) continue;
        const p = cam.project(c.lon, c.lat, d);
        if (!onScreen(p)) continue;
        const key = KINDS.city.key(c) + c.i;
        cand.push({ key, c, p, s: c.rank - (wasShown(key) ? 2.5 : 0) + c.i * 1e-5 });
      }
      cand.sort((a, b) => a.s - b.s);
      for (const k of cand) tryPlace("city", k.key, k.c, k.p, pad);
    }

    // everything not placed fades out (or goes at once if it is off screen anyway)
    for (const [key, st] of this.state) {
      if (placed.has(key)) continue;
      const p = cam.project(st.lon, st.lat, d);
      if (st.alpha <= 0 || !onScreen(p, 0)) this.state.delete(key);
      else st.target = 0;
    }
    this.placedVersion = this.version;
    this.placedCam = cam.version;
    this.lastPlace = now;
    this.dirty = true;
    this.stats.placements++;
    this.stats.lastMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- per frame
  // Returns true while labels still need frames (fading).
  update(now) {
    const cam = this.cam;
    if (cam.dpr !== this.dpr) { this.dpr = cam.dpr; this.atlas.reset(); this.dirty = true; this.version++; }
    const camMoved = cam.version !== this.placedCam;
    if (this.version !== this.placedVersion) this.place(now);
    else if (camMoved) {
      if (now - this.lastPlace >= PLACE_MS) this.place(now);
      else if (!this.settleTimer) {
        // make sure the view gets one more placement after it stops moving
        this.settleTimer = setTimeout(() => { this.settleTimer = 0; this.r.requestRender(); }, PLACE_MS - (now - this.lastPlace) + 4);
      }
    }
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    const instant = reducedMotion();
    let fading = false;
    for (const [key, st] of this.state) {
      if (st.alpha !== st.target) {
        if (instant) st.alpha = st.target;
        else if (st.target > st.alpha) st.alpha = Math.min(st.target, st.alpha + dt / FADE_IN);
        else st.alpha = Math.max(st.target, st.alpha - dt / FADE_OUT);
        this.dirty = true;
        if (st.alpha !== st.target) fading = true;
      }
      if (st.alpha <= 0 && st.target <= 0) { this.state.delete(key); this.dirty = true; }
    }
    if (this.dirty) this._build();
    return fading;
  }

  _build() {
    this.dirty = false;
    const dpr = this.cam.dpr;
    const n = this.state.size;
    if (this.data.length < n * STRIDE) this.data = new Float32Array(Math.ceil(n * 1.5 + 16) * STRIDE);
    const a = this.data;
    let o = 0, count = 0;
    // draw order: cities under contours under pressure centers under saved places
    const order = { city: 0, contour: 1, hilo: 2, point: 3 };
    const list = [...this.state.values()].filter((st) => st.alpha > 0).sort((x, y) => order[x.kind] - order[y.kind]);
    for (const st of list) {
      if (!st.sprite || st.sprite.gen !== this.atlas.gen) {
        const K = KINDS[st.kind];
        const L = st.L;
        const pxPad = 1;
        const w = Math.ceil(L.w * dpr) + 2 * pxPad, h = Math.ceil(L.h * dpr) + 2 * pxPad;
        const lay = { s: dpr, px: pxPad, w: Math.ceil(L.w * dpr) };
        st.sprite = this.atlas.sprite({ key: `${K.key(st.d)}@${dpr}`, w, h, draw: (ctx) => K.draw(ctx, st.d, lay) });
        if (!st.sprite) continue;
        if (st.sprite.gen !== this.atlas.gen) { st.sprite = null; continue; }
      }
      const sp = st.sprite;
      a[o++] = st.lon; a[o++] = st.lat;
      a[o++] = -st.L.ax * dpr - 1; a[o++] = -st.L.ay * dpr - 1;
      a[o++] = sp.w; a[o++] = sp.h; a[o++] = sp.x; a[o++] = sp.y;
      a[o++] = st.alpha;
      count++;
    }
    // an atlas reset part-way through invalidates sprites placed earlier in this pass
    if (list.some((st) => st.sprite && st.sprite.gen !== this.atlas.gen)) { this.dirty = true; this.r.requestRender(); }
    this.count = count;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, a.subarray(0, o), gl.DYNAMIC_DRAW);
  }

  draw(common) {
    if (!this.count) return;
    const gl = this.gl;
    this.prog ||= compile(gl, S.LABEL_VS, S.LABEL_FS);
    const p = this.prog;
    gl.useProgram(p.prog);
    common(p);
    gl.uniform2f(p.uniforms.u_buf, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(p.uniforms.u_atlasSize, ATLAS_W, ATLAS_H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex);
    gl.uniform1i(p.uniforms.u_atlas, 0);
    const A = p.attribs;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.r.corner01);
    gl.enableVertexAttribArray(A.a_corner);
    gl.vertexAttribPointer(A.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(A.a_corner, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const B = STRIDE * 4;
    const attr = (name, size, off) => {
      const loc = A[name];
      if (loc == null || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, B, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr("a_ll", 2, 0); attr("a_off", 2, 2); attr("a_size", 2, 4); attr("a_uv", 2, 6); attr("a_alpha", 1, 8);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    for (const name of ["a_ll", "a_off", "a_size", "a_uv", "a_alpha"]) {
      const loc = A[name];
      if (loc == null || loc < 0) continue;
      gl.vertexAttribDivisor(loc, 0);
      gl.disableVertexAttribArray(loc);
    }
    gl.disableVertexAttribArray(A.a_corner);
  }
}
