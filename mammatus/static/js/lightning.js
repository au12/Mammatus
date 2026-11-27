// Lightning layer: GOES GLM strikes streamed from the server and drawn on the GPU as bolts.
//
// What you see:
//  - every strike in the window is a lightning bolt; the newest are the biggest and white-hot, and
//    they shrink and cool through gold and amber to crimson as they age;
//  - strikes flash as they happen, replayed in their true rhythm about a minute behind real time
//    (the GLM data latency);
//  - when bolts come into view (the layer is turned on, or the map settles somewhere new) they flash
//    in the order they happened, and that replay comes back every half minute so they stay noticeable;
//  - stepping or playing radar and satellite frames flashes the strikes each step reveals.
// Frames are only drawn while something is flashing, so an idle map costs nothing.
import { get } from "./api.js";

const CHUNK = 600;
const STRIDE = 5;            // lon, lat, t, energy, rank
const POLL_MS = 15000;
const LIVE_RETAIN = 50 * 60;  // live mode shows 30 min; keep a little more
const LOOP_RETAIN = 3 * 3600; // radar and satellite loops reach back about 2.5 h
const SDF_N = 96, SDF_RANGE = 20;  // texels; the glyph keeps a wide margin so outlines and small bolts fit
// Deterministic per-strike value in [0, 1): flash selection when it is busy, tilt, flicker pattern.
const rank = (t, lon) => { const x = Math.sin(t * 12.9898 + lon * 78.233) * 43758.5453; return x - Math.floor(x); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function lowerBound(arr, x, n = arr.length) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
const upperBound = (arr, x, n) => lowerBound(arr, x + 1e-9, n);

export function decodeChunk(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) throw new Error("bad lightning chunk");
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x4d4d4c31) throw new Error("bad lightning chunk"); // "MML1"
  const hlen = dv.getUint32(4, true);
  if (hlen > buf.byteLength - 8) throw new Error("bad lightning chunk");
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const n = h.n | 0, off = 8 + hlen;
  if (n < 0 || off + 7 * n > buf.byteLength || !(h.tScale > 0) || !(h.posScale > 0) || !Number.isFinite(h.t0)) throw new Error("bad lightning chunk");
  const bytes = buf.slice(off, off + 7 * n);  // aligned copies for the typed views
  const dt = new Uint16Array(bytes, 0, n), lat = new Int16Array(bytes, 2 * n, n);
  const lon = new Int16Array(bytes, 4 * n, n), e = new Uint8Array(bytes, 6 * n, n);
  const out = { header: h, t: new Float64Array(n), lon: new Float32Array(n), lat: new Float32Array(n), e: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    out.t[i] = h.t0 + dt[i] / h.tScale;
    out.lat[i] = lat[i] / h.posScale;
    out.lon[i] = lon[i] / h.posScale;
    out.e[i] = e[i];
  }
  return out;
}

// Signed distance field of a lightning-bolt glyph (R8, 0.5 on the outline, larger inside).
function boltSDF(gl) {
  const P = [[13.2, 2.8], [5.8, 13.2], [11.2, 13.2], [9.8, 21.2], [17.2, 10.8], [11.8, 10.8]]; // 24 px icon space
  const cx = 11.5, cy = 12, hs = 14;
  const pts = P.map(([x, y]) => [((x - cx) / hs * 0.5 + 0.5) * SDF_N, ((y - cy) / hs * 0.5 + 0.5) * SDF_N]);
  const out = new Uint8Array(SDF_N * SDF_N);
  for (let j = 0; j < SDF_N; j++) {
    for (let i = 0; i < SDF_N; i++) {
      const px = i + 0.5, py = j + 0.5;
      let d = Infinity, inside = false;
      for (let k = 0, m = pts.length - 1; k < pts.length; m = k++) {
        const [ax, ay] = pts[m], [bx, by] = pts[k];
        const ex = bx - ax, ey = by - ay;
        const t = clamp(((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey), 0, 1);
        d = Math.min(d, Math.hypot(px - ax - ex * t, py - ay - ey * t));
        if ((ay > py) !== (by > py) && px < ax + ((py - ay) / (by - ay)) * ex) inside = !inside;
      }
      const sd = inside ? -d : d;
      out[j * SDF_N + i] = clamp(Math.round((0.5 - sd / (2 * SDF_RANGE)) * 255), 0, 255);
    }
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SDF_N, SDF_N, 0, gl.RED, gl.UNSIGNED_BYTE, out);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
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
    this.stepWall = -1e9;
    this.spread = 0;
    this.offset = 0;             // server clock - client clock (s)
    this.lag = 60;               // live playback delay behind real time (s)
    this.latest = null;
    this.status = null;
    // strikes, time-sorted, with room to append the live tail without a rebuild
    this.data = new Float32Array(0);
    this.times = new Float64Array(0);
    this.n = 0;
    this.base = 0;
    this.vbo = null;
    this.capacity = 0;           // GPU buffer bytes
    this.animUntil = 0;
    this.upcoming = [];
    this.up = 0;
    this.visibleCount = 0;
    this.flashDur = 0.75;
    this.liveFrac = 1;
    this.stepFrac = 1;
    this.flashRate = 0;
    this.seq = null;             // replay sequence {kind, wall0, t0, t1, dur, flash, gain, knots}
    this.knots = new Float32Array(17);
    this.pendingReveal = false;
    this.seqView = null;
    this.cycleS = this.r.lowPower ? 32 : 26;
    this.idleLimit = this.r.lowPower ? 10 * 60000 : 30 * 60000;
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.wall0 = performance.now();
    this.sdf = boltSDF(this.gl);
    this.stats = { rebuilds: 0, appends: 0, sequences: 0 };
    document.addEventListener("visibilitychange", () => { if (document.hidden) this._stopTimers(); else if (this.enabled) this._startTimers(true); });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ------------------------------------------------------------------ clocks
  serverNow() { return Date.now() / 1000 + this.offset; }
  playNow() { return this.serverNow() - this.lag; }
  wallNow() { return (performance.now() - this.wall0) / 1000; }
  end() { return this.mode === "live" ? this.playNow() : this.T; }
  retain() { return this.mode === "step" || this.app.state?.source?.type !== "model" ? LOOP_RETAIN : LIVE_RETAIN; }
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
      this.seq = null;
      this.emit("status", this.info());
      return;
    }
    this.pendingReveal = true;
    this.r.setStrikes(this);
    await this.refreshStatus();
    this._startTimers(true);
    this.emit("status", this.info());
  }

  // Called by the app whenever the displayed time or source changes.
  // mode: live | step | off. In step mode T is the frame time; strikes since prevT flash across the step.
  sync({ mode, T = 0, prevT = null, window = 1800, spread = 0.9 } = {}) {
    const was = this.mode;
    if (!["live", "step", "off"].includes(mode) || (mode === "step" && !Number.isFinite(T))) mode = "off";
    if (!Number.isFinite(prevT)) prevT = null;
    if (!Number.isFinite(spread) || spread < 0) spread = 0.9;
    this.mode = this.enabled ? mode : "off";
    if (!Number.isFinite(window) || window <= 0) window = 1800;
    window = Math.min(window, 6 * 3600);
    this.window = window;
    if (this.mode === "step") {
      this.prevT = prevT != null && prevT < T && T - prevT < window ? prevT : T;
      this.T = T;
      this.stepWall = this.wallNow();
      this.spread = spread;
      this.seq = null;
    }
    if (this.mode === "live" && was !== "live") this.pendingReveal = true;
    if (this.mode !== "off") this.ensure();
    if (this.mode === "step" && this.prevT < this.T && this.n) {
      const d = this.r.camera.derived();
      const i0 = upperBound(this.times, this.prevT, this.n), i1 = upperBound(this.times, this.T, this.n);
      let fresh = 0;
      for (let i = i0; i < i1; i++) if (this._onScreen(i, d)) fresh++;
      this.stepFrac = clamp(40 / Math.max(fresh, 1), 0.05, 1);
    }
    if (was !== this.mode) this._startTimers(false);
    this._countVisible();
    this._updateUpcoming();
    this._maybeReveal();
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
    this._afterMove();
    this.emit("status", this.info());
  }

  // Nearest strike within the visible window: {km, age} or null.
  nearest(lon, lat, maxKm = 80) {
    if (!this.enabled || this.mode === "off" || !this.n) return null;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const end = this.end();
    const i0 = lowerBound(this.times, end - this.window, this.n), i1 = upperBound(this.times, end, this.n);
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

  // ------------------------------------------------------------------ replays
  // Flash the strikes in view in the order they happened. "reveal" hides each bolt until its turn
  // (for strikes arriving on screen); "pulse" re-flashes bolts already showing.
  startSequence(kind = "pulse") {
    if (!this.visible() || !this.animEnabled()) return false;
    const end = this.end();
    const i0 = lowerBound(this.times, end - this.window, this.n), i1 = upperBound(this.times, end, this.n);
    if (i1 <= i0) return false;
    const d = this.r.camera.derived();
    const stride = Math.max(1, Math.floor((i1 - i0) / 20000));
    const vis = [];
    for (let i = i0; i < i1; i += stride) if (this._onScreen(i, d, 10)) vis.push(this.times[i]);
    if (!vis.length) return false;
    const n = vis.length * stride;
    for (let k = 0; k <= 16; k++) this.knots[k] = vis[Math.round((k / 16) * (vis.length - 1))] - this.base;
    const dur = clamp(1.3 + 0.75 * Math.log10(1 + n), 1.5, 3.4);
    const flash = clamp(0.8 * Math.sqrt(24 / n), 0.24, 0.8);
    const concurrent = (n / dur) * flash;
    // in a big storm only a few hundred bolts get the full flash; the rest just take their turn
    const pick = clamp(320 / n, 0.06, 1);
    const gain = clamp(1.7 / Math.sqrt(Math.max(1, concurrent * pick)), 0.25, 1);
    const wall0 = this.wallNow() + 0.05;
    this.seq = { kind, wall0, t0: vis[0] - this.base - 1e-3, t1: vis[vis.length - 1] - this.base + 1e-3, dur, flash, gain, pick };
    const cam = this.r.camera;
    this.seqView = { lon: cam.lon, lat: cam.lat, zoom: cam.zoom, cam: this._camSnapshot() };
    this.stats.sequences++;
    this._lastPulse = performance.now();
    this.emit("flash");
    this._armCycle();
    this.r.requestRender();
    return true;
  }

  _camSnapshot() {
    const c = this.r.camera;
    return { lon: c.lon, lat: c.lat, zoom: c.zoom, mode: c.mode, w: c.w, h: c.h, t: c.t, morphAnim: null };
  }

  _maybeReveal() {
    // wait for the initial chunks, so the replay covers the whole window
    if (!this.pendingReveal || this.mode === "off" || this.loading.size || !this.n || !this.visibleCount) return;
    if (this.mode === "step") { this.pendingReveal = false; return; }
    if (this.startSequence("reveal")) this.pendingReveal = false;
  }

  // After the map settles: a mostly new view gets a reveal, a smaller move a pulse.
  _afterMove() {
    if (this.pendingReveal) { this._maybeReveal(); return; }
    if (!this.visibleCount || this.mode !== "live" || !this.animEnabled()) return;
    const prev = this.seqView;
    if (!prev) { this.startSequence("pulse"); return; }
    const cam = this.r.camera;
    const zoomed = Math.abs(cam.zoom - prev.zoom);
    // share of strikes in view now that were not in view at the last replay
    const pc = Object.assign(Object.create(Object.getPrototypeOf(cam)), cam, prev.cam);
    const pd = pc.derived(), d = cam.derived();
    const end = this.end();
    const i0 = lowerBound(this.times, end - this.window, this.n), i1 = upperBound(this.times, end, this.n);
    const stride = Math.max(1, Math.floor((i1 - i0) / 4000));
    let now = 0, fresh = 0;
    for (let i = i0; i < i1; i += stride) {
      if (!this._onScreen(i, d)) continue;
      now++;
      const lon = this.data[i * STRIDE], lat = this.data[i * STRIDE + 1];
      const p = pc.project(lon, lat, pd);
      if (!(p.vis > 0 && p.x > 0 && p.y > 0 && p.x < pc.w && p.y < pc.h)) fresh++;
    }
    if (!now) return;
    const share = fresh / now;
    if (share > 0.55) this.startSequence("reveal");
    else if (share > 0.12 || zoomed > 0.75) this.startSequence("pulse");
  }

  _armCycle() {
    clearTimeout(this.cycleTimer);
    if (!this.enabled || document.hidden) return;
    this.cycleTimer = setTimeout(() => {
      if (!this.enabled || document.hidden) return;
      const busy = this.seq && this.wallNow() < this.seq.wall0 + this.seq.dur + this.seq.flash;
      if (!busy && !this.app.playing && this.visibleCount && this.animEnabled()) this.startSequence("pulse");
      else this._armCycle();
    }, this.cycleS * 1000);
  }

  // ------------------------------------------------------------------ renderer hooks
  visible() { return this.enabled && this.mode !== "off" && this.n > 0; }

  _seqActive(wall) {
    const s = this.seq;
    return !!s && wall < s.wall0 + s.dur + s.flash + 0.05;
  }

  animating() {
    if (!this.visible() || !this.animEnabled()) return false;
    const wall = this.wallNow();
    if (this._seqActive(wall)) return true;
    if (this.mode === "live") return this.playNow() < this.animUntil;
    return wall - this.stepWall < this.spread + this.flashDur && this.prevT < this.T;
  }

  frameState() {
    if (!this.vbo) return null;
    const end = this.end();
    const first = lowerBound(this.times, end - this.window, this.n);
    const last = upperBound(this.times, end, this.n);
    const cam = this.r.camera;
    const zs = clamp(0.72 + (cam.zoom - 3) * 0.1, 0.72, 1.3);
    const dpr = cam.dpr;
    const anim = this.animEnabled();
    const wall = this.wallNow();
    const seqOn = anim && this._seqActive(wall);
    if (!seqOn && this.seq && wall > this.seq.wall0 + this.seq.dur + this.seq.flash + 0.05) this.seq = null;
    const s = this.seq;
    const busy = this.mode === "live" ? Math.max(1, this.flashRate || 0) : 1;
    return {
      vbo: this.vbo, first, count: last - first,
      tEnd: end - this.base, window: this.window, mode: this.mode === "live" ? 0 : 1,
      prevT: this.prevT - this.base, wall, stepWall: this.stepWall, spread: this.spread,
      flash: anim ? this.flashDur : 0,
      animFrac: this.mode === "live" ? this.liveFrac : this.stepFrac,
      seq: seqOn ? [s.wall0, s.t0, s.t1, s.dur] : [0, 0, 0, 0],
      seqOpt: seqOn ? [s.kind === "reveal" ? 1 : 2, s.flash, s.pick] : [0, 0.5, 0],
      knots: this.knots,
      size: (this.r.lowPower ? 27 : 30) * zs * dpr,
      minSize: 7 * zs * dpr,
      gain: seqOn ? s.gain : clamp(3 / busy, 0.5, 1),
      sdf: this.sdf, sdfRange: (2 * SDF_RANGE) / SDF_N,
    };
  }

  // ------------------------------------------------------------------ data
  async refreshStatus() {
    try {
      const s = await get("/lightning/status", { quiet: true });
      this.status = s;
      if (s.enabled === false) { this.available = false; return s; }
      this.available = true;
      if (Number.isFinite(s.now)) this.offset = s.now - Date.now() / 1000;
      this._setLatest(s.latest);
      return s;
    } catch {
      return null;
    }
  }

  _setLatest(latest) {
    if (latest == null || !Number.isFinite(latest)) return;
    this.latest = latest;
    // Stay behind the newest complete data by its age plus a poll interval, easing down slowly.
    const target = clamp(this.serverNow() - latest + POLL_MS / 1000 + 6, 25, 300);
    this.lag = target > this.lag ? target : this.lag - Math.min(2, this.lag - target);
  }

  needed() {
    if (this.mode === "off" || this.latest == null) return [];
    const end = this.end();
    const from = Math.floor((end - this.window - 30) / CHUNK) * CHUNK;
    const to = Math.floor(Math.min(end + (this.mode === "live" ? 120 : 30), this.serverNow()) / CHUNK) * CHUNK;
    const out = [];
    for (let t0 = from; t0 <= to && out.length < 40; t0 += CHUNK) out.push(t0);
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
      if (Number.isFinite(h.now)) this.offset = h.now - Date.now() / 1000;
      if (h.latest != null) this._setLatest(h.latest);
      const prev = this.chunks.get(t0);
      if (after != null && prev && !h.final) {
        // tail: flashes newer than what we have (they arrive sorted)
        const k = d.t.length;
        if (!k) return null;
        const n = prev.n + k;
        const t = new Float64Array(n), lon = new Float32Array(n), lat = new Float32Array(n), e = new Uint8Array(n);
        t.set(prev.t); t.set(d.t, prev.n); lon.set(prev.lon); lon.set(d.lon, prev.n);
        lat.set(prev.lat); lat.set(d.lat, prev.n); e.set(prev.e); e.set(d.e, prev.n);
        this.chunks.set(t0, { t0, final: false, n, t, lon, lat, e, lastT: t[n - 1] });
        return { t0, tail: d };
      }
      const n = d.t.length;
      this.chunks.set(t0, { t0, final: !!h.final, n, t: d.t, lon: d.lon, lat: d.lat, e: d.e, lastT: n ? d.t[n - 1] : t0 });
      // a chunk turning final with the same strikes needs no rebuild
      return prev && prev.n === n ? null : { t0, full: true };
    })();
    this.loading.set(t0, p);
    let res = null;
    try { res = await p; } catch { /* a later poll retries */ } finally { this.loading.delete(t0); }
    if (res) this._merge(res);
    else if (this.pendingReveal) this._maybeReveal();
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
    const keep = this.serverNow() - this.retain() - CHUNK;
    let changed = false;
    for (const t0 of [...this.chunks.keys()]) if (t0 + CHUNK < keep) { this.chunks.delete(t0); changed = true; }
    if (changed) this._rebuild();
  }

  // New strikes at the very end (the live tail) are appended in place; anything else rebuilds.
  _merge(res) {
    if (res.tail && this.n) {
      const lastChunk = Math.max(...[...this.chunks.values()].filter((c) => c.n).map((c) => c.t0));
      const d = res.tail;
      if (res.t0 === lastChunk && d.t[0] >= this.times[this.n - 1]) { this._append(d); return; }
    }
    this._rebuild();
  }

  _grow(n) {
    if (n * STRIDE <= this.data.length) return;
    const cap = Math.ceil(n * 1.5) + 1024;
    const data = new Float32Array(cap * STRIDE), times = new Float64Array(cap);
    data.set(this.data.subarray(0, this.n * STRIDE));
    times.set(this.times.subarray(0, this.n));
    this.data = data;
    this.times = times;
  }

  _append(d) {
    const k = d.t.length, n0 = this.n;
    this._grow(n0 + k);
    for (let i = 0; i < k; i++) {
      const o = (n0 + i) * STRIDE;
      this.data[o] = d.lon[i];
      this.data[o + 1] = d.lat[i];
      this.data[o + 2] = d.t[i] - this.base;
      this.data[o + 3] = d.e[i] / 255;
      this.data[o + 4] = rank(d.t[i], d.lon[i]);
      this.times[n0 + i] = d.t[i];
    }
    this.n = n0 + k;
    const gl = this.gl;
    const bytes = this.n * STRIDE * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (bytes > this.capacity) {
      this.capacity = Math.max(64 * 1024, Math.ceil(bytes * 1.5 / 20) * 20);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.n * STRIDE));
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, n0 * STRIDE * 4, this.data.subarray(n0 * STRIDE, this.n * STRIDE));
    }
    this.stats.appends++;
    this._changed();
  }

  _rebuild() {
    const list = [...this.chunks.values()].filter((c) => c.n).sort((a, b) => a.t0 - b.t0);
    const total = list.reduce((s, c) => s + c.n, 0);
    const base = list.length ? list[0].t0 : 0;
    if (base !== this.base) this.seq = null;  // relative times shift under a replay in flight
    this.base = base;
    const cap = Math.ceil(total * 1.25) + 1024;
    if (this.data.length < cap * STRIDE || this.data.length > cap * STRIDE * 4) {
      this.data = new Float32Array(cap * STRIDE);
      this.times = new Float64Array(cap);
    }
    let o = 0;
    for (const c of list) {
      for (let i = 0; i < c.n; i++, o++) {
        const k = o * STRIDE;
        this.data[k] = c.lon[i];
        this.data[k + 1] = c.lat[i];
        this.data[k + 2] = c.t[i] - this.base;
        this.data[k + 3] = c.e[i] / 255;
        this.data[k + 4] = rank(c.t[i], c.lon[i]);
        this.times[o] = c.t[i];
      }
    }
    this.n = total;
    const gl = this.gl;
    if (!this.vbo) this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const bytes = total * STRIDE * 4;
    if (bytes > this.capacity || bytes < this.capacity / 4) {
      this.capacity = Math.max(64 * 1024, Math.ceil(bytes * 1.5 / 20) * 20);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    if (total) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, total * STRIDE));
    this.stats.rebuilds++;
    this._changed();
  }

  _changed() {
    this._countVisible();
    this._updateUpcoming();
    this._maybeReveal();
    this.r.requestRender();
    clearTimeout(this._statusT);
    this._statusT = setTimeout(() => this.emit("status", this.info()), 120);
  }

  // ------------------------------------------------------------------ view-dependent bookkeeping
  _onScreen(i, d, m = 30) {
    const cam = this.r.camera;
    const p = cam.project(this.data[i * STRIDE], this.data[i * STRIDE + 1], d);
    return p.vis > 0 && p.x > -m && p.y > -m && p.x < cam.w + m && p.y < cam.h + m;
  }

  _countVisible() {
    if (this.mode === "off" || !this.n) { this.visibleCount = 0; return; }
    const end = this.end();
    const i0 = lowerBound(this.times, end - this.window, this.n), i1 = upperBound(this.times, end, this.n);
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
    if (this.mode !== "live" || !this.n) return;
    const now = this.playNow();
    const d = this.r.camera.derived();
    const i0 = lowerBound(this.times, now - this.flashDur, this.n);
    const vis = [];
    for (let i = i0; i < this.n && this.times[i] < now + 180; i++) if (this._onScreen(i, d)) vis.push(i);
    // how busy the view is decides how many strikes flash, so a raging storm stays readable
    const span = Math.max(20, (this.times[this.n - 1] || now) - now);
    this.flashRate = vis.length / span;
    const budget = this.r.lowPower ? 3.5 : 5;
    this.liveFrac = clamp(budget / Math.max(this.flashRate, 1e-6), 0.04, 1);
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
      if (t + this.flashDur > now) { this.animUntil = Math.max(this.animUntil, t + this.flashDur); fired = true; }
    }
    if (fired) {
      this.r.requestRender();
      const t = performance.now();
      if (t - (this._lastPulse || 0) > 2500) { this._lastPulse = t; this.emit("flash"); }
    }
    if (this.up < this.upcoming.length) {
      const wait = Math.max(4, (this.upcoming[this.up] - now) * 1000);
      this.timer = setTimeout(() => this._schedule(), Math.min(wait, 60000));
    }
  }

  _startTimers(pollNow) {
    this._stopTimers();
    if (!this.enabled || document.hidden) return;
    this.pollTimer = setInterval(() => this._poll(), POLL_MS);
    // bolts shrink and cool as they age; a quiet redraw every 10 s keeps sizes and colors honest
    this.tickTimer = setInterval(() => {
      if (this.mode !== "live") return;
      this._countVisible();
      if (this.visibleCount) this.r.requestRender();
      if (this.up >= this.upcoming.length) this._updateUpcoming();
    }, 10000);
    this._armCycle();
    if (pollNow) this._poll();
    else this._schedule();
  }

  _stopTimers() {
    clearTimeout(this.warmTimer);
    clearInterval(this.pollTimer);
    clearInterval(this.tickTimer);
    clearTimeout(this.timer);
    clearTimeout(this.cycleTimer);
  }
}
