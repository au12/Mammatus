// Layer controller: turns the selected source (model product, radar, satellite) and time
// index into frames on the GPU, with LOD selection, prefetching and smooth transitions.
import { buildColormap } from "./colormaps.js";
import { FrameStore, sampleFrame } from "./data/frames.js";
import { loadImage } from "./engine/gl.js";
import { runDate } from "./time.js";
import { get } from "./api.js";

const DEG = Math.PI / 180;
const MODEL_RES = { hrrr: 3000 / 6371229, rrfs: 3000 / 6371229, gfs: 0.25 * DEG, ecmwf: 0.25 * DEG, aifs: 0.25 * DEG, mrms: 0.02 * DEG };

export class Layers extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.r = app.renderer;
    this.store = new FrameStore(this.r.gl);
    this.cmaps = new Map();
    this.source = null;   // {type:'model', model, run, product} | {type:'radar'} | {type:'sat', product}
    this.steps = [];      // [{id, time:Date, fhr?, stamp?}]
    this.index = 0;
    this.lod = 1;
    this.current = null;  // entry shown for the fill
    this.gen = 0;         // bumps when the source changes; stale loads are ignored
    this.abort = new AbortController();
    this.errors = new Map();
    this.loading = 0;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  colormap(id) {
    let c = this.cmaps.get(id);
    if (!c) {
      const def = this.app.catalog.colormaps[id];
      c = { def, ...buildColormap(this.r.gl, def) };
      this.cmaps.set(id, c);
    }
    return c;
  }

  product() {
    const s = this.source;
    if (!s || s.type !== "model") return null;
    return this.app.catalog.products.find((p) => p.id === s.product) || null;
  }

  // ------------------------------------------------------------------ source & steps
  async setSource(src, keepTime = true) {
    const prevTime = keepTime && this.steps[this.index] ? this.steps[this.index].time : null;
    const gen = ++this.gen;
    this.abort.abort();
    this.abort = new AbortController();
    this.store.cancelPending(() => true);
    let steps = [];
    if (src.type === "model") {
      const run = (this.app.runs[src.model] || []).find((r) => r.run === src.run);
      const init = runDate(src.run);
      steps = (run?.steps || []).map((fhr) => ({ id: fhr, fhr, time: new Date(init.getTime() + fhr * 3600000) }));
    } else if (src.type === "radar") {
      const { times } = await get("/radar/times?hours=2");
      steps = times.map((s) => ({ id: s, stamp: s, time: stampDate(s) }));
    } else if (src.type === "sat") {
      const { times } = await get(`/sat/${src.product}/times?count=12`);
      steps = times.map((s) => ({ id: s, stamp: s, time: satDate(s) }));
    }
    if (gen !== this.gen) return;
    this.source = src;
    this.steps = steps;
    this.current = null;
    this.errors.clear();
    this.r.setParticles(null);
    this.clearContours();
    if (src.type !== "model") this.r.setField(null);
    let idx = 0;
    if (src.type !== "model") idx = steps.length - 1;
    else if (prevTime) idx = nearest(steps, prevTime);
    else idx = nearest(steps, new Date());
    if (src.fhr != null) { const i = steps.findIndex((s) => s.fhr === src.fhr); if (i >= 0) idx = i; }
    this.index = Math.max(0, idx);
    this.lod = this.pickLod();
    this.emit("source", src);
    this.emit("steps", this.steps);
    await this.show(this.index, { crossfade: false });
  }

  step() { return this.steps[this.index]; }

  pickLod(current = this.lod) {
    const s = this.source;
    if (!s) return 1;
    const res = MODEL_RES[s.type === "radar" ? "mrms" : s.model] || 0.25 * DEG;
    const cam = this.r.camera;
    const pxPerCell = res * cam.derived().kg;
    let lod = pxPerCell >= 0.8 ? 0 : pxPerCell >= 0.38 ? 1 : 2;
    if (s.type === "radar") lod = pxPerCell >= 1.6 ? 0 : pxPerCell >= 0.6 ? 1 : 2;
    // hysteresis
    if (Math.abs(lod - current) === 1) {
      const t0 = s.type === "radar" ? [1.6, 0.6] : [0.8, 0.38];
      const edge = lod < current ? t0[lod] * 1.15 : t0[current] * 0.85;
      if ((lod < current && pxPerCell < edge) || (lod > current && pxPerCell > edge)) return current;
    }
    return lod;
  }

  url(step, lod, varId) {
    const s = this.source;
    if (s.type === "model") return `/api/frame/${s.model}/${s.run}/${varId}/${step.fhr}?lod=${lod}`;
    if (s.type === "radar") return `/api/radar/frame/${step.stamp}?lod=${lod}`;
    return null;
  }

  key(step, lod, varId, extra = "") {
    const s = this.source;
    if (s.type === "model") return `${s.model}/${s.run}/${varId}/${step.fhr}/${lod}${extra}`;
    return `radar/${step.stamp}/${lod}`;
  }

  fillVar() {
    const s = this.source;
    if (s?.type === "model") return this.product()?.fill;
    if (s?.type === "radar") return "mrms";
    return null;
  }

  // ------------------------------------------------------------------ display
  async show(index, { crossfade = true } = {}) {
    if (!this.steps.length) { this.emit("frame", null); return; }
    index = Math.max(0, Math.min(this.steps.length - 1, index));
    this.index = index;
    const step = this.steps[index];
    const gen = this.gen;
    this.emit("index", { index, step });
    this.r.setTime(step.time);
    const s = this.source;
    if (s.type === "sat") return this.showSat(step, gen);
    const varId = this.fillVar();
    const lod = this.lod;
    this.loading++;
    this.emit("loading", this.loading);
    try {
      const entry = await this.store.get(this.key(step, lod, varId), this.url(step, lod, varId), { priority: 0, signal: this.abort.signal });
      if (gen !== this.gen || this.index !== index) return;
      this.errors.delete(step.id);
      this.current = entry;
      this.applyField(entry, crossfade);
      this.emit("frame", { entry, step });
      this.loadExtras(step, gen);
      this.prefetch();
    } catch (err) {
      if (err.name === "AbortError" || gen !== this.gen) return;
      this.errors.set(step.id, err.message);
      if (err.status === 404) this.r.setField(null);
      this.emit("error", { step, message: err.message, status: err.status });
    } finally {
      this.loading--;
      this.emit("loading", this.loading);
    }
  }

  applyField(entry, crossfade) {
    const h = entry.header;
    const s = this.source;
    const cmapId = s.type === "radar" ? "mrms" : this.product().cmap;
    const cm = this.colormap(cmapId);
    const kind = h.kind === "vector" ? 1 : h.kind === "category" ? 2 : 0;
    const f = {
      grid: h.grid, kind, qs: [h.scale, h.offset], tex0: this.store.texture(entry), tex1: null, mix: 0,
      lut: cm.tex, lutRows: cm.rows, stops: cm.stops, nstops: cm.nstops, hemi: cm.hemi,
      opacity: this.app.prefs.opacity ?? 0.88, key: entry.key,
    };
    this.r.look.dim = 0.6;
    const smooth = crossfade && this.app.prefs.smooth !== false;
    if (smooth) this.r.crossfade(f, this.app.playing ? Math.min(380, this.app.frameMs() * 0.55) : 240); else this.r.setField(f);
  }

  clearContours() {
    for (const id of [...this.r.lines.keys()]) if (id.startsWith("contour")) this.r.setLines(id, null);
    this.app.overlay.setContourLabels([]);
    this.app.overlay.setHilo([]);
  }

  async loadExtras(step, gen) {
    const s = this.source;
    if (s.type !== "model") return;
    const p = this.product();
    const cam = this.app.model(s.model)?.kind === "cam";
    // contours (a split contour becomes two passes with their own colors)
    const specs = [];
    (p.contours || []).forEach((c, i) => {
      if (!c.models.includes(s.model)) return;
      const labelKm = cam ? 260 : 650;
      if (c.split) {
        specs.push({ c: { ...c, color: c.split.below }, spec: { ...c, labelKm, max: c.split.value - 1e-6 }, id: `${i}a` });
        specs.push({ c: { ...c, color: c.split.at, width: (c.width || 1.2) * 1.25 }, spec: { ...c, labelKm, levels: [c.split.value] }, id: `${i}b` });
        specs.push({ c: { ...c, color: c.split.above }, spec: { ...c, labelKm, min: c.split.value + 1e-6 }, id: `${i}c` });
      } else specs.push({ c, spec: { ...c, labelKm }, id: `${i}` });
    });
    const tasks = specs.map(async ({ c, spec, id }) => {
      const lod = cam ? 2 : 1;
      const entry = await this.store.get(this.key(step, lod, c.var, `/c${id}`), this.url(step, lod, c.var),
        { priority: 1, signal: this.abort.signal, contour: spec });
      return { c, entry, id };
    });
    // particles
    let windEntry = null;
    if (p.particles && p.particleModels.includes(s.model) && this.app.prefs.particles !== false) {
      if (p.particles === p.fill && this.current?.header.kind === "vector") windEntry = this.current;
      else {
        const lod = cam ? 1 : 1;
        windEntry = await this.store.get(this.key(step, lod, p.particles), this.url(step, lod, p.particles),
          { priority: 1, signal: this.abort.signal }).catch(() => null);
      }
    }
    const results = await Promise.allSettled(tasks);
    if (gen !== this.gen || this.steps[this.index] !== step) return;
    const labels = [], hilo = [];
    const seen = new Set();
    results.forEach((res) => {
      if (res.status !== "fulfilled" || !res.value) return;
      const { c, entry, id } = res.value;
      const ct = entry.contour;
      if (!ct) return;
      seen.add(`contour${id}`);
      const fmt = contourFormatter(c);
      this.r.setLines(`contour${id}`, ct.lines, lineStyle(c, c.color));
      if (c.label !== false) for (let k = 0; k < ct.labels.length; k += 3) labels.push({ lon: ct.labels[k], lat: ct.labels[k + 1], text: fmt(ct.labels[k + 2]), color: c.color });
      if (ct.hilo) for (let k = 0; k < ct.hilo.length; k += 4) hilo.push({ lon: ct.hilo[k], lat: ct.hilo[k + 1], value: ct.hilo[k + 2], type: ct.hilo[k + 3] });
    });
    for (const id of [...this.r.lines.keys()]) if (id.startsWith("contour") && !seen.has(id)) this.r.setLines(id, null);
    this.app.overlay.setContourLabels(labels);
    this.app.overlay.setHilo(hilo);
    if (windEntry) {
      this.r.setParticles({ tex: this.store.texture(windEntry), grid: windEntry.header.grid,
        qs: [windEntry.header.scale, windEntry.header.offset], speed: 3.0, trail: 3.0 });
    } else this.r.setParticles(null);
  }

  async showSat(step, gen) {
    const src = this.source;
    this.loading++;
    this.emit("loading", this.loading);
    try {
      const img = await loadImage(`/api/sat/${src.product}/${step.stamp}.webp`);
      if (gen !== this.gen) return;
      this.r.setClouds(img);
      this.r.look.clouds = src.product === "globalvis" ? 1 : 1.7;
      this.r.look.dim = 1;
      this.emit("frame", { step });
      // prefetch neighbors as images (browser cache)
      for (const d of [-1, -2, 1]) {
        const st = this.steps[this.index + d];
        if (st) loadImage(`/api/sat/${src.product}/${st.stamp}.webp`).catch(() => {});
      }
    } catch (err) {
      if (gen === this.gen) this.emit("error", { step, message: "Satellite image unavailable" });
    } finally {
      this.loading--;
      this.emit("loading", this.loading);
    }
  }

  prefetch(count) {
    const s = this.source;
    if (!s || s.type === "sat" || !this.steps.length) return;
    const n = count ?? (this.app.playing ? this.steps.length : (this.r.lowPower ? 4 : 8));
    const varId = this.fillVar();
    for (let d = 1; d <= n; d++) {
      const i = (this.index + d) % this.steps.length;
      const st = this.steps[i];
      if (!st || this.errors.has(st.id)) continue;
      const key = this.key(st, this.lod, varId);
      if (this.store.has(key)) continue;
      this.store.get(key, this.url(st, this.lod, varId), { priority: 5 + d, signal: this.abort.signal }).then(() => this.emit("loaded", st.id)).catch(() => {});
    }
  }

  isLoaded(i) {
    const st = this.steps[i];
    if (!st || !this.source) return false;
    if (this.source.type === "sat") return true;
    return this.store.has(this.key(st, this.lod, this.fillVar()));
  }

  ensure(i) {
    const st = this.steps[i];
    if (!st || this.source.type === "sat") return Promise.resolve();
    const varId = this.fillVar();
    return this.store.get(this.key(st, this.lod, varId), this.url(st, this.lod, varId), { priority: 0, signal: this.abort.signal });
  }

  onCameraSettled() {
    if (!this.source || this.source.type === "sat") return;
    const lod = this.pickLod();
    if (lod !== this.lod) {
      this.lod = lod;
      this.show(this.index, { crossfade: false });
      this.emit("steps", this.steps);
    }
  }

  sample(lon, lat) {
    if (!this.current) return null;
    return sampleFrame(this.current, lon, lat);
  }
}

function nearest(steps, time) {
  let best = 0, bd = Infinity;
  steps.forEach((s, i) => { const d = Math.abs(s.time - time); if (d < bd) { bd = d; best = i; } });
  return best;
}

const stampDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)));
const satDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13)));

function lineStyle(c, color) {
  const rgb = hexRgb(color || "#f4f6fb");
  return { color: [...rgb, 0.92], width: c.width || 1.2, halo: 1.0, haloColor: [0.02, 0.03, 0.06, 0.55], z: 10, dash: c.dash ? [60, 110] : null };
}

function contourFormatter(c) {
  if (c.unit === "dam") return (v) => String(Math.round(v / 10));
  if (c.var === "mslp") return (v) => String(Math.round(v));
  return (v) => String(Math.round(v));
}

function hexRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export { stampDate, satDate };
