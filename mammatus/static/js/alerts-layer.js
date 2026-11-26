// NWS alert overlay: warning polygons as glowing outlines, zone/county alerts as soft county fills.
import { get } from "./api.js";
import { decodeCounties, haversine } from "./data/basemap.js";

const RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

export class AlertsLayer {
  constructor(app) {
    this.app = app;
    this.r = app.renderer;
    this.alerts = [];
    this.enabled = false;
    this.timer = null;
    this.counties = null;
    this.lineIds = new Set();
  }

  async setEnabled(on) {
    this.enabled = on;
    clearTimeout(this.timer);
    if (!on) { this.clear(); return; }
    await this.refresh();
  }

  clear() {
    for (const id of this.lineIds) this.r.setLines(id, null);
    this.lineIds.clear();
    this.r.hideCountyFills();
  }

  async refresh() {
    clearTimeout(this.timer);
    if (!this.enabled) return;
    if (document.hidden) { this.timer = setTimeout(() => this.refresh(), 30000); return; }
    try {
      const { alerts } = await get("/alerts", { quiet: true });
      this.alerts = alerts;
      await this.draw();
    } catch { /* keep the last good set */ }
    this.timer = setTimeout(() => this.refresh(), 120000);
  }

  async draw() {
    if (!this.enabled) return;
    // outlines, grouped by color (one GPU buffer per color)
    const groups = new Map();
    for (const a of this.alerts) {
      if (!a.polys) continue;
      if (!groups.has(a.color)) groups.set(a.color, { rank: RANK[a.severity] || 0, parts: [] });
      const g = groups.get(a.color);
      g.rank = Math.max(g.rank, RANK[a.severity] || 0);
      for (const poly of a.polys) {
        const ring = poly[0];
        if (!ring || ring.length < 3) continue;
        const pts = [];
        let d = 0;
        ring.forEach(([lon, lat], i) => {
          if (i) {
            if (Math.abs(lon - ring[i - 1][0]) > 180) { pts.push(999, 0, 0); d = 0; }
            else d += haversine(ring[i - 1][0], ring[i - 1][1], lon, lat);
          }
          pts.push(lon, lat, d);
        });
        pts.push(999, 0, 0);
        const arr = new Float32Array(pts);
        g.parts.push(arr);
      }
    }
    const next = new Set();
    for (const [color, g] of groups) {
      const total = g.parts.reduce((s, p) => s + p.length, 0);
      const data = new Float32Array(total);
      let o = 0;
      for (const p of g.parts) { data.set(p, o); o += p.length; }
      const id = `alert:${color}`;
      const rgb = hex(color);
      this.r.setLines(id, data, { color: [...rgb, 0.95], width: 1.6 + g.rank * 0.35, halo: 2.2, haloColor: [...rgb, 0.22], z: 20 + g.rank });
      next.add(id);
    }
    for (const id of this.lineIds) if (!next.has(id)) this.r.setLines(id, null);
    this.lineIds = next;
    // county fills for zone-based alerts
    const zoneAlerts = this.alerts.filter((a) => !a.polys && a.fips?.length);
    if (!zoneAlerts.length) { this.r.hideCountyFills(); return; }
    if (!this.counties) {
      const buf = await (await fetch("/data/counties.bin")).arrayBuffer();
      this.counties = decodeCounties(buf);
      this.r.setCountyGeometry(this.counties);
    }
    const overField = this.app.state.source?.type === "model";
    const n = this.counties.fips.length;
    const rgba = new Uint8Array(n * 4);
    const best = new Int8Array(n).fill(-1);
    for (const a of zoneAlerts) {
      const rank = RANK[a.severity] || 0;
      const [r, g, b] = hex(a.color).map((v) => Math.round(v * 255));
      for (const f of a.fips) {
        const i = this.counties.fipsIndex.get(f);
        if (i == null || rank <= best[i]) continue;
        best[i] = rank;
        rgba.set([r, g, b, (overField ? 34 + rank * 10 : 70 + rank * 20)], i * 4);
      }
    }
    this.r.setCountyColors(rgba);
  }
}

function hex(h) {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
