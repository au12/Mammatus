// Lightning layer: GOES GLM strikes streamed from the server and drawn on the GPU.
//
// Two clocks:
//  - live: strikes replay in their true rhythm about a minute behind real time (the GLM data
//    latency), so each one flashes the moment it "happens" on screen;
//  - stepped: when radar or satellite frames are stepped or played, strikes trail the frame time
//    and the ones revealed by each step flash, spread across the step.
// Frames are only drawn while a visible strike is flashing, so an idle map costs nothing.
import { get } from "./api.js";

const CHUNK = 600;
const STRIDE = 5;           // lon, lat, t, energy, rank
const LIVE_FLASHES = 3.2;   // visible flashes per second that animate (the rest simply appear)
const STEP_FLASHES = 28;    // strikes that animate per stepped frame
// Deterministic per-strike rank in [0, 1): decides which strikes get the flash when it is busy.
const rank = (t, lon) => { const x = Math.sin(t * 12.9898 + lon * 78.233) * 43758.5453; return x - Math.floor(x); };
const POLL_MS = 15000;
const RETAIN = 3 * 3600;

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
const upperBound = (arr, x) => lowerBound(arr, x + 1e-9);

function decodeChunk(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x4d4d4c31) throw new Error("bad lightning chunk"); // "MML1"
  const hlen = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const n = h.n, off = 8 + hlen;
  const dt = new Uint16Array(buf, off, n), lat = new Int16Array(buf, off + 2 * n, n);
  const lon = new Int16Array(buf, off + 4 * n, n), e = new Uint8Array(buf, off + 6 * n, n);
  const out = { header: h, t: new Float64Array(n), lon: new Float32Array(n), lat: new Float32Array(n), e: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    out.t[i] = h.t0 + dt[i] / h.tScale;
    out.lat[i] = lat[i] / h.posScale;
    out.lon[i] = lon[i] / h.posScale;
    out.e[i] = e[i];
  }
  return out;
}

export class Lightning extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.r = app.renderer;
    this.gl = app.renderer.gl;
    this.enabled = false;
    this.available = true;
    this.chunks = new Map();     // t0 -> {t0, final, n, t, lon, lat, e, lastT}
    this.loading = new Map();
    this.mode = "off";           // off | live | step
    this.T = 0;                  // stepped window end (epoch s)
    this.prevT = 0;
    this.window = 1800;
    this.stepWall = 0;
    this.spread = 0;
    this.offset = 0;             // server clock - client clock (s)
    this.lag = 60;               // live playback delay behind real time (s)
    this.latest = null;
    this.status = null;
    this.vbo = null;
    this.capacity = 0;
    this.base = 0;
    this.times = new Float64Array(0);
    this.data = new Float32Array(0);
    this.animUntil = 0;
    this.upcoming = [];
    this.up = 0;
    this.visibleCount = 0;
    this.flash = this.r.lowPower ? 0.7 : 0.9;
    this.liveFrac = 1;
    this.stepFrac = 1;
    this.idleLimit = this.r.lowPower ? 180000 : 1200000;
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.addEventListener("visibilitychange", () => { if (document.hidden) this._stopTimers(); else if (this.enabled) this._startTimers(true); });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ------------------------------------------------------------------ clocks
  serverNow() { return Date.now() / 1000 + this.offset; }
  playNow() { return this.serverNow() - this.lag; }
  end() { return this.mode === "live" ? this.playNow() : this.T; }
  animEnabled() {
    return this.app.prefs.lightningAnim !== false && !this.reduceMotion
      && performance.now() - this.r.lastInteraction < this.idleLimit;
  }

  // ------------------------------------------------------------------ public API
  async setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this._stopTimers();
      this.r.setStrikes(null);
      this.mode = "off";
      this.emit("status", this.info());
      return;
    }
    this.r.setStrikes(this);
    await this.refreshStatus();
    this._startTimers(true);
    this.emit("status", this.info());
  }

  // Called by the app whenever the displayed time or source changes.
  // mode: live | step | off. In step mode T is the frame time; animate flashes the strikes since prevT.
  sync({ mode, T = 0, prevT = null, window = 1800, spread = 0.9 }) {
    const was = this.mode;
    this.mode = this.enabled ? mode : "off";
    this.window = window;
    if (this.mode === "step") {
      this.prevT = prevT != null && prevT < T && T - prevT < window ? prevT : T;
      this.T = T;
      this.stepWall = performance.now();
      this.spread = spread;
    }
    if (this.mode !== "off") this.ensure();
    if (this.mode === "step" && this.prevT < this.T && this.times.length) {
      const d = this.r.camera.derived();
      const i0 = upperBound(this.times, this.prevT), i1 = upperBound(this.times, this.T);
      let fresh = 0;
      for (let i = i0; i < i1; i++) if (this._onScreen(i, d)) fresh++;
      this.stepFrac = Math.min(1, Math.max(0.05, STEP_FLASHES / Math.max(fresh, 1)));
    }
    if (was !== this.mode) this._startTimers(false);
    this._countVisible();
    this._updateUpcoming();
    this.r.requestRender();
    this.emit("status", this.info());
  }

  info() {
    const s = this.status;
    return {
      enabled: this.enabled, available: this.available, mode: this.mode, window: this.window,
      count: this.visibleCount, warming: this.enabled && this.available && this.latest == null,
      sources: s?.sources || [], end: this.end(),
    };
  }

  wake() {
    if (this.enabled && this.mode === "live") this._updateUpcoming();
  }

  onCameraSettled() {
    if (!this.enabled || this.mode === "off") return;
    this._countVisible();
    this._updateUpcoming();
    this.emit("status", this.info());
  }

  // Nearest strike within the visible window: {km, age} or null.
  nearest(lon, lat, maxKm = 80) {
    if (!this.enabled || this.mode === "off" || !this.times.length) return null;
    const end = this.end();
    const i0 = lowerBound(this.times, end - this.window), i1 = upperBound(this.times, end);
    const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
    let best = maxKm * maxKm, bi = -1;
    for (let i = i0; i < i1; i++) {
      let dl = this.data[i * STRIDE] - lon;
      if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
      const dx = dl * kx, dy = (this.data[i * STRIDE + 1] - lat) * ky;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; bi = i; }
    }
    return bi < 0 ? { km: null, window: this.window } : { km: Math.sqrt(best), age: end - this.times[bi], window: this.window };
  }

  // ------------------------------------------------------------------ renderer hooks
  visible() { return this.enabled && this.mode !== "off" && this.times.length > 0; }

  animating(now) {
    if (!this.visible() || !this.animEnabled()) return false;
    if (this.mode === "live") return this.playNow() < this.animUntil;
    return (now - this.stepWall) / 1000 < this.spread + this.flash && this.prevT < this.T;
  }

  frameState(now) {
    const end = this.end();
    const first = lowerBound(this.times, end - this.window);
    const last = upperBound(this.times, end);
    const cam = this.r.camera;
    const zs = Math.min(1.35, Math.max(0.7, 0.72 + (cam.zoom - 2.5) * 0.11));
    const busy = this.mode === "live" ? Math.max(1, this.flashRate || 0) : 1;
    return {
      vbo: this.vbo, first, count: last - first,
      tEnd: end - this.base, window: this.window, mode: this.mode === "live" ? 0 : 1,
      prevT: this.prevT - this.base, wall: (now - this.stepWall) / 1000, spread: this.spread,
      flash: this.animEnabled() ? this.flash : 0,
      dot: 1.3 * cam.dpr * zs, glow: (this.r.lowPower ? 22 : 30) * cam.dpr * zs,
      gain: Math.max(0.5, Math.min(1, 3 / busy)),
      animFrac: this.mode === "live" ? this.liveFrac : this.stepFrac,
    };
  }

  // ------------------------------------------------------------------ data
  async refreshStatus() {
    try {
      const s = await get("/lightning/status", { quiet: true });
      this.status = s;
      if (s.enabled === false) { this.available = false; return s; }
      this.available = true;
      this.offset = s.now - Date.now() / 1000;
      this._setLatest(s.latest);
      return s;
    } catch {
      return null;
    }
  }

  _setLatest(latest) {
    if (latest == null) return;
    this.latest = latest;
    // Stay behind the newest complete data by its age plus a poll interval, easing down slowly.
    const target = Math.min(300, Math.max(25, this.serverNow() - latest + POLL_MS / 1000 + 6));
    this.lag = target > this.lag ? target : this.lag - Math.min(2, this.lag - target);
  }

  needed() {
    if (this.mode === "off" || this.latest == null) return [];
    const end = this.end();
    const from = Math.floor((end - this.window - 30) / CHUNK) * CHUNK;
    const to = Math.floor(Math.min(end + (this.mode === "live" ? 120 : 30), this.serverNow()) / CHUNK) * CHUNK;
    const out = [];
    for (let t0 = from; t0 <= to; t0 += CHUNK) out.push(t0);
    return out;
  }

  ensure() {
    for (const t0 of this.needed()) {
      if (!this.chunks.has(t0) && !this.loading.has(t0)) this._load(t0);
    }
  }

  async _load(t0, after = null) {
    const p = (async () => {
      const url = `/api/lightning/chunk/${t0}${after != null ? `?after=${after.toFixed(2)}` : ""}`;
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`lightning ${resp.status}`);
      const d = decodeChunk(await resp.arrayBuffer());
      const h = d.header;
      if (h.now) this.offset = h.now - Date.now() / 1000;
      if (h.latest != null) this._setLatest(h.latest);
      const prev = this.chunks.get(t0);
      if (after != null && prev && !h.final) {
        // tail: append flashes newer than what we have (they arrive sorted)
        const n = prev.n + d.t.length;
        const t = new Float64Array(n), lon = new Float32Array(n), lat = new Float32Array(n), e = new Uint8Array(n);
        t.set(prev.t); t.set(d.t, prev.n); lon.set(prev.lon); lon.set(d.lon, prev.n);
        lat.set(prev.lat); lat.set(d.lat, prev.n); e.set(prev.e); e.set(d.e, prev.n);
        this.chunks.set(t0, { t0, final: h.final, n, t, lon, lat, e, lastT: n ? t[n - 1] : after });
        return d.t.length > 0 || h.final !== prev.final;
      }
      const n = d.t.length;
      this.chunks.set(t0, { t0, final: h.final, n, t: d.t, lon: d.lon, lat: d.lat, e: d.e, lastT: n ? d.t[n - 1] : t0 });
      return true;
    })();
    this.loading.set(t0, p);
    try {
      if (await p) this._rebuild();
    } catch {
      /* a later poll retries */
    } finally {
      this.loading.delete(t0);
    }
  }

  async _poll() {
    if (!this.enabled || document.hidden) return;
    if (this.latest == null) {
      await this.refreshStatus();
      if (this.latest == null) {
        // the server just started ingesting; check back soon rather than at the next poll
        clearTimeout(this.warmTimer);
        if (this.available) this.warmTimer = setTimeout(() => this._poll(), 2500);
        this.emit("status", this.info());
        return;
      }
      this.ensure();
      this._updateUpcoming();
    }
    if (this.mode === "off") return;
    this.ensure();
    const jobs = [];
    for (const t0 of this.needed()) {
      const c = this.chunks.get(t0);
      if (c && !c.final && !this.loading.has(t0)) jobs.push(this._load(t0, c.lastT));
    }
    await Promise.all(jobs);
    this._prune();
    this.emit("status", this.info());
  }

  _prune() {
    const keep = this.serverNow() - RETAIN;
    let changed = false;
    for (const t0 of [...this.chunks.keys()]) if (t0 + CHUNK < keep) { this.chunks.delete(t0); changed = true; }
    if (changed) this._rebuild();
  }

  _rebuild() {
    const list = [...this.chunks.values()].filter((c) => c.n).sort((a, b) => a.t0 - b.t0);
    const total = list.reduce((s, c) => s + c.n, 0);
    this.base = list.length ? list[0].t0 : 0;
    const data = new Float32Array(total * STRIDE), times = new Float64Array(total);
    let o = 0;
    for (const c of list) {
      for (let i = 0; i < c.n; i++, o++) {
        const k = o * STRIDE;
        data[k] = c.lon[i];
        data[k + 1] = c.lat[i];
        data[k + 2] = c.t[i] - this.base;
        data[k + 3] = c.e[i] / 255;
        data[k + 4] = rank(c.t[i], c.lon[i]);
        times[o] = c.t[i];
      }
    }
    this.data = data;
    this.times = times;
    const gl = this.gl;
    if (!this.vbo) this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (data.byteLength > this.capacity || data.byteLength < this.capacity / 4) {
      this.capacity = Math.max(64 * 1024, Math.ceil(data.byteLength * 1.5 / 20) * 20);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    this._countVisible();
    this._updateUpcoming();
    this.r.requestRender();
    clearTimeout(this._statusT);
    this._statusT = setTimeout(() => this.emit("status", this.info()), 120);
  }

  // ------------------------------------------------------------------ view-dependent bookkeeping
  _onScreen(i, d) {
    const cam = this.r.camera;
    const p = cam.project(this.data[i * STRIDE], this.data[i * STRIDE + 1], d);
    return p.vis > 0 && p.x > -30 && p.y > -30 && p.x < cam.w + 30 && p.y < cam.h + 30;
  }

  _countVisible() {
    if (this.mode === "off" || !this.times.length) { this.visibleCount = 0; return; }
    const end = this.end();
    const i0 = lowerBound(this.times, end - this.window), i1 = upperBound(this.times, end);
    const d = this.r.camera.derived();
    let n = 0;
    const stride = Math.max(1, Math.floor((i1 - i0) / 40000));  // sample very large sets
    for (let i = i0; i < i1; i += stride) if (this._onScreen(i, d)) n += stride;
    this.visibleCount = n;
  }

  // Live mode: the strikes about to "happen" on screen, so frames are drawn only around them.
  _updateUpcoming() {
    clearTimeout(this.timer);
    this.upcoming = [];
    this.up = 0;
    if (this.mode !== "live" || !this.times.length) return;
    const now = this.playNow();
    const d = this.r.camera.derived();
    const i0 = lowerBound(this.times, now - this.flash);
    const vis = [];
    for (let i = i0; i < this.times.length && this.times[i] < now + 180; i++) if (this._onScreen(i, d)) vis.push(i);
    // how busy the view is decides how many strikes flash, so a raging storm stays a gentle shimmer
    const span = Math.max(20, (this.times[this.times.length - 1] || now) - now);
    this.flashRate = vis.length / span;
    const budget = this.r.lowPower ? LIVE_FLASHES / 2 : LIVE_FLASHES;  // phones: fewer flashes, fewer frames
    this.liveFrac = Math.min(1, Math.max(0.04, budget / Math.max(this.flashRate, 1e-6)));
    for (const i of vis) if (this.data[i * STRIDE + 4] < this.liveFrac) this.upcoming.push(this.times[i]);
    this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    if (this.mode !== "live" || document.hidden || !this.animEnabled()) return;
    const now = this.playNow();
    let fired = false;
    while (this.up < this.upcoming.length && this.upcoming[this.up] <= now + 0.012) {
      const t = this.upcoming[this.up++];
      if (t + this.flash > now) { this.animUntil = Math.max(this.animUntil, t + this.flash); fired = true; }
    }
    if (fired) {
      this.r.requestRender();
      const t = performance.now();
      if (t - (this._lastPulse || 0) > 2500) { this._lastPulse = t; this.emit("flash"); }
    }
    if (this.up < this.upcoming.length) {
      const wait = Math.max(4, (this.upcoming[this.up] - now) * 1000);
      this.timer = setTimeout(() => this._schedule(), wait);
    }
  }

  _startTimers(pollNow) {
    this._stopTimers();
    if (!this.enabled || document.hidden) return;
    this.pollTimer = setInterval(() => this._poll(), POLL_MS);
    // ages drift slowly; one quiet redraw every 10 s keeps colors honest without animating
    this.tickTimer = setInterval(() => { if (this.mode === "live") { this.r.requestRender(); if (this.up >= this.upcoming.length) this._updateUpcoming(); } }, 10000);
    if (pollNow) this._poll();
    else this._schedule();
  }

  _stopTimers() {
    clearTimeout(this.warmTimer);
    clearInterval(this.pollTimer);
    clearInterval(this.tickTimer);
    clearTimeout(this.timer);
  }
}
