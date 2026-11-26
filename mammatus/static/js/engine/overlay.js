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

function halo(ctx, text, x, y, color, width = 3, haloColor = "rgba(4,6,12,0.82)") {
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = haloColor;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
