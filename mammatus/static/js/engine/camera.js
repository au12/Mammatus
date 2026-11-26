// View state and the JS mirror of the shader projection (for picking and labels).

const DEG = Math.PI / 180;
const MAX_LAT_FLAT = 85.0511;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapPi = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const mercY = (latRad) => Math.log(Math.tan(Math.PI / 4 + latRad / 2));

export class Camera {
  constructor() {
    this.lon = -84;
    this.lat = 34;
    this.zoom = 1.6;
    this.mode = "auto";      // auto | globe | map
    this.t = 0;              // current morph (0 globe, 1 flat)
    this.fovDeg = 30;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.minZoom = 0.9;
    this.maxZoom = 12.5;
    this.anim = null;
    this.morphAnim = null;
    this.version = 0;
  }

  setViewport(w, h, dpr) {
    this.w = Math.max(1, w); this.h = Math.max(1, h); this.dpr = dpr;
    this.changed();
  }

  changed() { this.version++; }

  get k() { return (512 * Math.pow(2, this.zoom)) / (2 * Math.PI); }   // CSS px / radian
  get f() { return (this.h / 2) / Math.tan((this.fovDeg * DEG) / 2); }  // CSS px

  autoT() {
    if (this.mode === "globe") return 0;
    if (this.mode === "map") return 1;
    const span = Math.min(this.w, this.h * 1.35) / this.k;
    const a = 1.35, b = 1.85;
    const x = Math.min(1, Math.max(0, (b - span) / (b - a)));
    return x * x * (3 - 2 * x);
  }

  // Derived quantities for the current state (CSS units unless noted).
  derived() {
    const t = this.morphAnim ? this.t : this.autoT();
    const lat0 = this.lat * DEG;
    const m = 1 + t * (1 / Math.cos(Math.min(Math.abs(lat0), 80 * DEG)) - 1);
    const kg = this.k * m;
    const D = 1 + this.f / kg;
    return { t, lat0, lon0: this.lon * DEG, D, kg, merc0: mercY(Math.max(-MAX_LAT_FLAT, Math.min(MAX_LAT_FLAT, this.lat)) * DEG) };
  }

  uniforms() {
    const d = this.derived();
    this.t = d.t;
    const dpr = this.dpr;
    return {
      view: [d.lon0, d.lat0, this.k * dpr, d.t],
      vp: [this.w * dpr, this.h * dpr, this.f * dpr, d.D],
      merc: [d.merc0, 0],
      d,
    };
  }

  // lon/lat (deg) -> CSS px from the top-left; vis > 0 when visible.
  project(lonDeg, latDeg, d = this.derived()) {
    const lon = lonDeg * DEG, lat = latDeg * DEG;
    const dl = lon - d.lon0;
    const cl = Math.cos(lat);
    const px = cl * Math.sin(dl), py = Math.sin(lat), pz = cl * Math.cos(dl);
    const s0 = Math.sin(d.lat0), c0 = Math.cos(d.lat0);
    const gy = py * c0 - pz * s0, gz = py * s0 + pz * c0;
    const s = this.f / (d.D - gz);
    const gxp = px * s, gyp = gy * s;
    const vis = gz - 1 / d.D;
    const fl = Math.max(-MAX_LAT_FLAT * DEG, Math.min(MAX_LAT_FLAT * DEG, lat));
    const fx = wrapPi(dl) * this.k, fy = (mercY(fl) - d.merc0) * this.k;
    const x = gxp + (fx - gxp) * d.t, y = gyp + (fy - gyp) * d.t;
    return { x: this.w / 2 + x, y: this.h / 2 - y, vis: d.t >= 1 ? 1 : vis + (1 - vis) * d.t };
  }

  // CSS px -> {lon, lat} in degrees, or null off the globe.
  unproject(x, y, d = this.derived()) {
    const px = x - this.w / 2, py = this.h / 2 - y;
    if (d.t <= 0.0001) return this._invGlobe(px, py, d);
    const flat = this._invFlat(px, py, d);
    if (d.t >= 0.9999) return flat;
    // Newton iterations on the blended forward projection
    let lon = flat.lon, lat = Math.max(-85, Math.min(85, flat.lat));
    for (let i = 0; i < 8; i++) {
      const p = this.project(lon, lat, d);
      const ex = p.x - x, ey = p.y - y;
      if (Math.abs(ex) + Math.abs(ey) < 0.05) break;
      const h = 1e-3;
      const pl = this.project(lon + h, lat, d), pa = this.project(lon, lat + h, d);
      const a = (pl.x - p.x) / h, b = (pa.x - p.x) / h, c = (pl.y - p.y) / h, e = (pa.y - p.y) / h;
      const det = a * e - b * c;
      if (Math.abs(det) < 1e-9) break;
      lon -= (e * ex - b * ey) / det;
      lat -= (-c * ex + a * ey) / det;
    }
    const p = this.project(lon, lat, d);
    if (p.vis < 0) return null;
    return { lon: wrap180(lon), lat };
  }

  _invGlobe(px, py, d) {
    const f = this.f;
    let dx = px, dy = py, dz = -f;
    const len = Math.hypot(dx, dy, dz);
    dx /= len; dy /= len; dz /= len;
    const b = d.D * dz;
    const disc = b * b - (d.D * d.D - 1);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    const hx = t * dx, hy = t * dy, hz = d.D + t * dz;
    const s0 = Math.sin(d.lat0), c0 = Math.cos(d.lat0);
    const yy = hy * c0 + hz * s0, zz = -hy * s0 + hz * c0;
    return { lon: wrap180((d.lon0 + Math.atan2(hx, zz)) / DEG), lat: Math.asin(Math.max(-1, Math.min(1, yy))) / DEG };
  }

  _invFlat(px, py, d) {
    const lon = d.lon0 + px / this.k;
    const my = d.merc0 + py / this.k;
    return { lon: wrap180(lon / DEG), lat: (2 * Math.atan(Math.exp(my)) - Math.PI / 2) / DEG };
  }

  // Approximate CSS pixels per degree of latitude at the view center.
  pxPerDeg() {
    const d = this.derived();
    return this.k * DEG * (1 + d.t * (1 / Math.cos(d.lat0) - 1));
  }

  clampZoom(z) {
    const max = this.mode === "globe" ? 9 : this.maxZoom;
    return Math.max(this.minZoom, Math.min(max, z));
  }

  setCenter(lon, lat) {
    this.lon = wrap180(lon);
    this.lat = Math.max(-89, Math.min(89, lat));
    this.changed();
  }

  // Drag by CSS pixels so the grabbed point follows the pointer.
  panBy(dx, dy) {
    const d = this.derived();
    if (d.t > 0.5) {
      const my = d.merc0 + dy / this.k;
      const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) / DEG;
      this.setCenter(this.lon - dx / this.k / DEG, Math.max(-80, Math.min(80, lat)));
    } else {
      const s = d.kg;  // px per radian at the center of the globe
      const lat = this.lat + dy / s / DEG;
      const cl = Math.max(0.2, Math.cos(this.lat * DEG));
      this.setCenter(this.lon - dx / s / cl / DEG, lat);
    }
  }

  zoomAround(x, y, dz) {
    const before = this.unproject(x, y);
    this.zoom = this.clampZoom(this.zoom + dz);
    this.changed();
    if (!before) return;
    for (let i = 0; i < 2; i++) {
      const p = this.project(before.lon, before.lat);
      if (p.vis < 0) break;
      this.panBy(x - p.x, y - p.y);
    }
  }

  flyTo(target, duration = 1600) {
    const start = { lon: this.lon, lat: this.lat, zoom: this.zoom };
    let dlon = wrap180(target.lon - start.lon);
    const end = { lon: start.lon + dlon, lat: target.lat ?? start.lat, zoom: this.clampZoom(target.zoom ?? start.zoom) };
    const dist = Math.hypot(dlon, end.lat - start.lat);
    const peak = Math.min(start.zoom, end.zoom) - Math.min(3, dist / 25);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.anim = { start, end, peak, t0: performance.now(), duration: reduce ? 1 : duration };
    this.changed();
  }

  fitBounds([w, s, e, n], pad = 40) {
    const lon = (w + e) / 2, lat = (s + n) / 2;
    const spanLon = Math.max(0.5, e - w) * DEG, spanLat = Math.max(0.5, n - s) * DEG;
    const kx = (this.w - pad * 2) / spanLon;
    const ky = (this.h - pad * 2) / (spanLat / Math.cos(lat * DEG));
    const k = Math.min(kx, ky);
    const zoom = Math.log2((k * 2 * Math.PI) / 512);
    this.flyTo({ lon, lat, zoom });
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const from = this.derived().t;
    this.mode = mode;
    const to = this.autoT();
    this.morphAnim = { from, to, t0: performance.now(), duration: 900 };
    this.changed();
  }

  // Advance animations; returns true while something is still moving.
  step(now) {
    let moving = false;
    if (this.anim) {
      const a = this.anim;
      const u = Math.min(1, (now - a.t0) / a.duration);
      const e = ease(u);
      this.lon = wrap180(a.start.lon + (a.end.lon - a.start.lon) * e);
      this.lat = a.start.lat + (a.end.lat - a.start.lat) * e;
      const base = a.start.zoom + (a.end.zoom - a.start.zoom) * e;
      const dip = Math.sin(Math.PI * e) * Math.max(0, Math.min(a.start.zoom, a.end.zoom) - a.peak);
      this.zoom = base - dip;
      this.changed();
      if (u >= 1) this.anim = null; else moving = true;
    }
    if (this.morphAnim) {
      const m = this.morphAnim;
      const u = Math.min(1, (now - m.t0) / m.duration);
      this.t = m.from + (m.to - m.from) * ease(u);
      this.changed();
      if (u >= 1) this.morphAnim = null; else moving = true;
    }
    return moving;
  }

  cancelAnimation() { this.anim = null; }

  // Visible bounding box in degrees (approximate; used for spawning and LOD decisions).
  visibleSpanDeg() { return Math.min(360, (this.w / this.k) / DEG); }
}

export { DEG, wrap180 };
