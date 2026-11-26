// 2D label overlay (cities, contour labels, pressure centers, saved points).
// Redraws only when the camera or the labeled data change.

export class Overlay {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.r = renderer;
    this.cam = renderer.camera;
    this.cities = [];
    this.contourLabels = [];  // {lon, lat, text, color}
    this.hilo = [];           // {lon, lat, value, type}
    this.points = [];         // saved points {lon, lat, name}
    this.fronts = null;       // {fronts: [{type, strength, coords}], highs, lows, centers}
    this.showCities = true;
    this.version = 0;
    this._drawn = -1;
    this._camDrawn = -1;
    renderer.addEventListener("frame", () => this.maybeDraw());
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    this.touch();
  }

  touch() { this.version++; this.r.requestRender(); }

  setCities(rows) { this.cities = rows.map(([name, adm, cc, lat, lon, pop, rank]) => ({ name, lat, lon, pop, rank })); this.touch(); }
  setContourLabels(list) { this.contourLabels = list; this.touch(); }
  setHilo(list) { this.hilo = list; this.touch(); }
  setPoints(list) { this.points = list; this.touch(); }

  // WPC fronts: coords are smoothed once here (Catmull-Rom in lon/lat), projected on every draw.
  setFronts(set, { centers = false } = {}) {
    if (!set) { this.fronts = null; this.touch(); return; }
    this.fronts = {
      fronts: set.fronts.map((f) => ({ ...f, smooth: smoothLine(f.coords) })),
      highs: centers ? set.highs : [], lows: centers ? set.lows : [],
    };
    this.touch();
  }

  maybeDraw() {
    if (this._drawn === this.version && this._camDrawn === this.cam.version) return;
    this._drawn = this.version;
    this._camDrawn = this.cam.version;
    this.draw();
  }

  draw() {
    const { ctx, cam, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cam.w, cam.h);
    const d = cam.derived();
    const boxes = [];
    const free = (x, y, w, hgt) => {
      for (const b of boxes) if (x < b[2] && x + w > b[0] && y < b[3] && y + hgt > b[1]) return false;
      boxes.push([x, y, x + w, y + hgt]);
      return true;
    };
    const onScreen = (p, m = 20) => p.vis > 0 && p.x > -m && p.y > -m && p.x < cam.w + m && p.y < cam.h + m;

    if (this.fronts) {
      this.drawFronts(ctx, d);
      for (const [list, type] of [[this.fronts.highs, 1], [this.fronts.lows, -1]]) {
        ctx.textAlign = "center";
        for (const [lon, lat, pres] of list) {
          const p = cam.project(lon, lat, d);
          if (!onScreen(p, 0)) continue;
          if (!free(p.x - 16, p.y - 20, 32, 40)) continue;
          ctx.font = "800 21px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
          halo(ctx, type > 0 ? "H" : "L", p.x, p.y - 3, type > 0 ? "#7fb2ff" : "#ff7a7a", 3.5);
          ctx.font = "600 10.5px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
          halo(ctx, String(pres), p.x, p.y + 13, "#e9edf6", 3);
        }
        ctx.textAlign = "left";
      }
    }

    // saved points (highest priority)
    ctx.font = "600 12px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    for (const pt of this.points) {
      const p = cam.project(pt.lon, pt.lat, d);
      if (!onScreen(p)) continue;
      const w = ctx.measureText(pt.name).width;
      free(p.x - 6, p.y - 8, w + 22, 16);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = "rgba(245,154,185,0.9)";
      ctx.stroke();
      halo(ctx, pt.name, p.x + 10, p.y, "#fff", 3.2);
    }

    // pressure centers
    if (this.hilo.length) {
      const zoomedOut = cam.zoom < 2.4;
      const hb = zoomedOut ? 34 : 14;  // keep centers well apart on the globe
      const strong = [...this.hilo].sort((a, b) => Math.abs(b.value - 1013) - Math.abs(a.value - 1013));
      for (const c of strong) {
        if (zoomedOut && Math.abs(c.value - 1013) < 9) continue;
        const p = cam.project(c.lon, c.lat, d);
        if (!onScreen(p, 0)) continue;
        if (!free(p.x - hb, p.y - hb - 4, hb * 2, hb * 2 + 10)) continue;
        ctx.textAlign = "center";
        ctx.font = "800 22px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
        halo(ctx, c.type > 0 ? "H" : "L", p.x, p.y - 3, c.type > 0 ? "#7fb2ff" : "#ff7a7a", 3.5);
        ctx.font = "600 10.5px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
        halo(ctx, Math.round(c.value).toString(), p.x, p.y + 13, "#e9edf6", 3);
        ctx.textAlign = "left";
      }
    }

    // contour labels
    if (this.contourLabels.length) {
      ctx.font = "650 10.5px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
      ctx.textAlign = "center";
      const pad = cam.zoom < 2.4 ? 46 : cam.zoom < 3.5 ? 24 : 14;
      for (const l of this.contourLabels) {
        const p = cam.project(l.lon, l.lat, d);
        if (!onScreen(p, 0)) continue;
        const w = ctx.measureText(l.text).width + 6;
        if (!free(p.x - w / 2 - pad, p.y - pad, w + pad * 2, pad * 2)) continue;
        halo(ctx, l.text, p.x, p.y, l.color || "#f4f6fb", 3);
      }
      ctx.textAlign = "left";
    }

    // cities, ranked; density scales with zoom
    if (this.showCities && this.cities.length) {
      const z = cam.zoom;
      const maxRank = z < 2.5 ? 1 : z < 3.5 ? 2 : z < 4.5 ? 4 : z < 5.5 ? 6 : z < 6.8 ? 8 : 10;
      const maxN = Math.round((cam.w * cam.h) / 11000);
      let n = 0;
      ctx.font = "500 11.5px ui-sans-serif, -apple-system, Segoe UI, sans-serif";
      for (const c of this.cities) {
        if (c.rank > maxRank) continue;
        if (n >= maxN) break;
        const p = cam.project(c.lon, c.lat, d);
        if (!onScreen(p, -4)) continue;
        const w = ctx.measureText(c.name).width;
        if (!free(p.x - 4, p.y - 8, w + 14, 16)) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fill();
        halo(ctx, c.name, p.x + 6, p.y, "rgba(233,237,246,0.85)", 2.8, "rgba(4,6,12,0.72)");
        n++;
      }
    }
  }
}

// ------------------------------------------------------------------ fronts
const FRONT = {
  cold: { color: "#4d8dff", sym: "tri" },
  warm: { color: "#ff4f62", sym: "semi" },
  stationary: { color: "#4d8dff", alt: "#ff4f62", sym: "stat" },
  occluded: { color: "#c278ff", sym: "occl" },
  trough: { color: "#e2a65a", dash: [9, 7] },
  dryline: { color: "#d8a46c", sym: "open" },
  squall: { color: "#ff9a3c", dash: [12, 5, 2, 5] },
};

function smoothLine(coords) {
  if (coords.length < 3) return coords;
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
  out.push(coords[coords.length - 1]);
  return out;
}

Overlay.prototype.drawFronts = function drawFronts(ctx, d) {
  const cam = this.cam;
  const maxJump = Math.max(cam.w, cam.h) * 0.5;
  const zs = Math.min(1.2, Math.max(0.65, 0.72 + (cam.zoom - 3) * 0.11));
  const spacing = 62 * zs, size = 10 * zs;
  for (const f of this.fronts.fronts) {
    const st = FRONT[f.type] || FRONT.trough;
    // project into screen-space runs, breaking at the limb or at wrap-around jumps
    const runs = [];
    let run = [];
    for (const [lon, lat] of f.smooth) {
      const p = cam.project(lon, lat, d);
      const prev = run[run.length - 1];
      if (p.vis <= 0 || (prev && Math.hypot(p.x - prev[0], p.y - prev[1]) > maxJump)) {
        if (run.length > 1) runs.push(run);
        run = p.vis > 0 ? [[p.x, p.y]] : [];
        continue;
      }
      run.push([p.x, p.y]);
    }
    if (run.length > 1) runs.push(run);
    const width = (f.strength === "weak" ? 1.9 : f.strength === "strong" ? 3.1 : 2.5) * Math.min(1.1, zs + 0.15);
    for (const pts of runs) {
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of pts) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      if (maxx < -40 || maxy < -40 || minx > cam.w + 40 || miny > cam.h + 40) continue;
      const path = () => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); };
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(st.dash ? st.dash.map((v) => v * zs) : []);
      ctx.strokeStyle = "rgba(4,7,14,0.55)";
      ctx.lineWidth = width + 2.6;
      path();
      ctx.stroke();
      ctx.setLineDash([]);
      // symbol positions along the run
      const marks = [];
      if (st.sym) {
        let acc = 0, next = spacing * 0.5;
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          const seg = Math.hypot(x1 - x0, y1 - y0);
          while (seg > 0 && next <= acc + seg) {
            const u = (next - acc) / seg;
            marks.push({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, tx: (x1 - x0) / seg, ty: (y1 - y0) / seg, at: next });
            next += spacing;
          }
          acc += seg;
        }
      }
      if (st.sym === "stat") {
        // alternate blue and red segments, each carrying its own symbol
        strokeAlternating(ctx, pts, spacing, width, st.color, st.alt);
      } else {
        ctx.strokeStyle = st.color;
        ctx.lineWidth = width;
        if (st.dash) ctx.setLineDash(st.dash.map((v) => v * zs));
        path();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      marks.forEach((m, k) => {
        if (m.x < -20 || m.y < -20 || m.x > cam.w + 20 || m.y > cam.h + 20) return;
        let kind = st.sym, color = st.color, side = 1;
        if (kind === "stat") { kind = k % 2 ? "semi" : "tri"; color = k % 2 ? st.alt : st.color; side = k % 2 ? -1 : 1; }
        else if (kind === "occl") kind = k % 2 ? "semi" : "tri";
        drawSymbol(ctx, kind, m, size, color, side);
      });
    }
  }
};

function strokeAlternating(ctx, pts, spacing, width, a, b) {
  let acc = 0;
  const colorAt = (dist) => (Math.floor(dist / spacing) % 2 ? b : a);
  ctx.lineWidth = width;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    let start = 0;
    while (start < seg) {
      const dist = acc + start;
      const boundary = (Math.floor(dist / spacing) + 1) * spacing - acc;
      const stop = Math.min(seg, boundary);
      ctx.strokeStyle = colorAt(dist);
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * (start / seg), y0 + (y1 - y0) * (start / seg));
      ctx.lineTo(x0 + (x1 - x0) * (stop / seg), y0 + (y1 - y0) * (stop / seg));
      ctx.stroke();
      start = stop + 1e-6;
    }
    acc += seg;
  }
}

// Symbols sit on the left of the direction the bulletin lists points in (side = -1 flips).
function drawSymbol(ctx, kind, m, size, color, side) {
  const nx = m.ty * side, ny = -m.tx * side;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(4,7,14,0.6)";
  ctx.fillStyle = color;
  ctx.beginPath();
  if (kind === "tri") {
    const b = size * 0.82;
    ctx.moveTo(m.x - m.tx * b, m.y - m.ty * b);
    ctx.lineTo(m.x + m.tx * b, m.y + m.ty * b);
    ctx.lineTo(m.x + nx * size * 1.05, m.y + ny * size * 1.05);
    ctx.closePath();
  } else {
    const r = size * 0.72;
    const th = Math.atan2(m.ty, m.tx);
    const a0 = side > 0 ? th + Math.PI : th, a1 = side > 0 ? th + 2 * Math.PI : th + Math.PI;
    ctx.arc(m.x, m.y, r, a0, a1, false);
    ctx.closePath();
  }
  if (kind === "open") { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); return; }
  ctx.stroke();
  ctx.fill();
}

function halo(ctx, text, x, y, color, width = 3, haloColor = "rgba(4,6,12,0.82)") {
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = haloColor;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
