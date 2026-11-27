// WPC fronts on the GPU: lines through the shared line renderer, symbols as oriented SDF sprites.
//
// Distances along each front are kept in "equator kilometres" (km / cos(latitude)), which is
// proportional to flat-map pixels at every latitude, so symbol spacing and the red/blue alternation
// of stationary fronts stay even on screen. Symbols are re-laid only when the zoom changes; panning
// costs nothing on the CPU.
import { compile } from "./gl.js";
import * as S from "./shaders.js";

const R_EARTH = 6371;
const DEG = Math.PI / 180;
const STRIDE = 9;  // lon, lat, lon2, lat2, kind, side, r, g, b

const STYLE = {
  cold: { color: "#4d8dff", sym: "tri" },
  warm: { color: "#ff4f62", sym: "semi" },
  stationary: { color: "#4d8dff", alt: "#ff4f62", sym: "stat" },
  occluded: { color: "#c278ff", sym: "occl" },
  trough: { color: "#e2a65a", dash: [9, 7] },
  dryline: { color: "#d8a46c", sym: "open" },
  squall: { color: "#ff9a3c", dash: [12, 6] },
};

const rgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };

// Catmull-Rom in lon/lat, done once per bulletin.
function smoothLine(coords) {
  if (coords.length < 3) return coords.map((c) => [c[0], c[1]]);
  const out = [];
  const P = (i) => coords[Math.max(0, Math.min(coords.length - 1, i))];
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const steps = Math.max(2, Math.min(10, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.35)));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, e) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - e) * t2 + (-a + 3 * b - 3 * c + e) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([coords[coords.length - 1][0], coords[coords.length - 1][1]]);
  return out;
}

export class FrontLayer {
  constructor(renderer) {
    this.r = renderer;
    this.gl = renderer.gl;
    this.fronts = [];
    this.lineIds = [];
    this.vbo = this.gl.createBuffer();
    this.count = 0;
    this.layoutZoom = null;
    this.prog = null;
  }

  zoomScale() { return Math.min(1.2, Math.max(0.65, 0.72 + (this.r.camera.zoom - 3) * 0.11)); }

  set(set) {
    for (const id of this.lineIds) this.r.setLines(id, null);
    this.lineIds = [];
    this.fronts = [];
    this.count = 0;
    this.layoutZoom = null;
    if (!set?.fronts?.length) { this.r.requestRender(); return; }
    set.fronts.forEach((f, i) => {
      const coords = (f.coords || []).filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90);
      if (coords.length < 2) return;
      const pts = smoothLine(coords);
      // cumulative equator-km; break the polyline where it jumps across the dateline
      const dist = new Float64Array(pts.length);
      const parts = [];
      let run = [];
      for (let k = 0; k < pts.length; k++) {
        if (k) {
          const [lo0, la0] = pts[k - 1], [lo1, la1] = pts[k];
          let dl = lo1 - lo0;
          if (Math.abs(dl) > 180) { parts.push(run); run = []; dl = 0; }
          const cl = Math.max(0.05, Math.cos(((la0 + la1) / 2) * DEG));
          const km = Math.hypot(dl * cl, la1 - la0) * DEG * R_EARTH;
          dist[k] = dist[k - 1] + km / cl;
        }
        run.push(k);
      }
      parts.push(run);
      const data = [];
      for (const part of parts) {
        if (part.length < 2) continue;
        for (const k of part) data.push(pts[k][0], pts[k][1], dist[k]);
        data.push(999, 0, 0);
      }
      if (data.length < 9) return;
      const st = STYLE[f.type] || STYLE.trough;
      const width = f.strength === "weak" ? 1.9 : f.strength === "strong" ? 3.1 : 2.5;
      const id = `front:${i}`;
      const base = { width, z: 15, halo: 1.3, haloColor: [0.016, 0.027, 0.055, 0.55], globeAlpha: 1 };
      this.r.setLines(id, new Float32Array(data), { ...base, color: [...rgb(st.color), 1] });
      this.lineIds.push(id);
      if (st.alt) {
        this.r.setLines(`${id}:alt`, new Float32Array(data), { width, z: 15.5, color: [...rgb(st.alt), 1] });
        this.lineIds.push(`${id}:alt`);
      }
      this.fronts.push({ type: f.type, st, pts, dist, id, width });
    });
    this.r.requestRender();
  }

  // Lay symbols out along each front for the current zoom; called from the frame loop.
  update() {
    if (!this.fronts.length) return;
    const cam = this.r.camera;
    if (this.layoutZoom != null && Math.abs(cam.zoom - this.layoutZoom) < 0.01) return;
    this.layoutZoom = cam.zoom;
    const zs = this.zoomScale();
    const pxToKm = R_EARTH / cam.k;          // equator-km per CSS px on the flat map
    const spacing = 62 * zs * pxToKm;
    const out = [];
    for (const f of this.fronts) {
      const st = f.st;
      const w = f.width * Math.min(1.1, zs + 0.15);
      this.r.setLineStyle(f.id, { width: w, dash: st.dash ? [st.dash[0] * zs * pxToKm, (st.dash[0] + st.dash[1]) * zs * pxToKm, 0] : null });
      if (st.alt) this.r.setLineStyle(`${f.id}:alt`, { width: w, dash: [spacing, 2 * spacing, spacing] });
      if (!st.sym) continue;
      const { pts, dist } = f;
      const total = dist[pts.length - 1];
      let k = 1, j = 0;
      const [c0] = [rgb(st.color)], c1 = st.alt ? rgb(st.alt) : c0;
      for (let at = spacing * 0.5; at < total; at += spacing, j++) {
        while (k < pts.length - 1 && dist[k] < at) k++;
        const a = pts[k - 1], b = pts[k];
        const seg = dist[k] - dist[k - 1];
        if (seg <= 0 || Math.abs(b[0] - a[0]) > 180) continue;
        const u = (at - dist[k - 1]) / seg;
        const lon = a[0] + (b[0] - a[0]) * u, lat = a[1] + (b[1] - a[1]) * u;
        let kind = 0, side = 1, col = c0;
        if (st.sym === "semi") kind = 1;
        else if (st.sym === "open") kind = 2;
        else if (st.sym === "occl") kind = j % 2;
        else if (st.sym === "stat") { kind = j % 2; side = j % 2 ? -1 : 1; col = j % 2 ? c1 : c0; }
        out.push(lon, lat, b[0], b[1], kind, side, col[0], col[1], col[2]);
      }
    }
    this.count = out.length / STRIDE;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.DYNAMIC_DRAW);
  }

  draw(common) {
    if (!this.count) return;
    const gl = this.gl;
    this.prog ||= compile(gl, S.FRONTSYM_VS, S.FRONTSYM_FS);
    const p = this.prog;
    gl.useProgram(p.prog);
    common(p);
    const dpr = this.r.camera.dpr;
    gl.uniform1f(p.uniforms.u_size, 10 * this.zoomScale() * dpr);
    gl.uniform1f(p.uniforms.u_dpr, dpr);
    const A = p.attribs;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.r.quad);
    gl.enableVertexAttribArray(A.a_corner);
    gl.vertexAttribPointer(A.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(A.a_corner, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const B = STRIDE * 4;
    const attr = (name, size, off) => { const l = A[name]; if (l == null || l < 0) return; gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, B, off * 4); gl.vertexAttribDivisor(l, 1); };
    attr("a_ll", 4, 0); attr("a_kind", 2, 4); attr("a_color", 3, 6);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    for (const n of ["a_ll", "a_kind", "a_color"]) { const l = A[n]; if (l == null || l < 0) continue; gl.vertexAttribDivisor(l, 0); gl.disableVertexAttribArray(l); }
    gl.disableVertexAttribArray(A.a_corner);
  }
}
