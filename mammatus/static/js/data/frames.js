// Frame fetching, decoding (in a worker pool) and a GPU texture cache with a memory budget.
import { dataTexture } from "../engine/gl.js";

const WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

class WorkerPool {
  constructor(url, n) {
    this.workers = Array.from({ length: n }, () => new Worker(url, { type: "module" }));
    this.queue = [];
    this.busy = new Set();
    this.pending = new Map();
    this.seq = 0;
    for (const w of this.workers) w.onmessage = (e) => this._done(w, e.data);
  }
  run(payload, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, payload, transfer });
      this._pump();
    });
  }
  _pump() {
    for (const w of this.workers) {
      if (this.busy.has(w) || !this.queue.length) continue;
      const job = this.queue.shift();
      this.busy.add(w);
      w.postMessage({ id: job.id, ...job.payload }, job.transfer);
    }
  }
  _done(w, data) {
    this.busy.delete(w);
    const p = this.pending.get(data.id);
    this.pending.delete(data.id);
    if (p) data.error ? p.reject(new Error(data.error)) : p.resolve(data);
    this._pump();
  }
}

export class FrameStore {
  constructor(gl, budgetMB) {
    this.gl = gl;
    const mem = navigator.deviceMemory || 4;
    this.budget = (budgetMB || (mem <= 2 ? 96 : mem <= 4 ? 192 : 384)) * 1024 * 1024;
    this.used = 0;
    this.cache = new Map(); // key -> entry (insertion order = LRU)
    this.inflight = new Map();
    // eslint-disable-next-line no-undef
    const url = typeof __WORKER_URL__ !== "undefined" ? __WORKER_URL__ : new URL("./frame-worker.js", import.meta.url);
    this.pool = new WorkerPool(url, WORKERS);
    this.active = 0;
    this.maxActive = 4;
    this.waiting = [];
    this.bytesFetched = 0;
  }

  has(key) { return this.cache.has(key); }

  peek(key) {
    const e = this.cache.get(key);
    if (e) { this.cache.delete(key); this.cache.set(key, e); }
    return e;
  }

  // opts: {priority (lower first), contour, signal}
  get(key, url, opts = {}) {
    const hit = this.peek(key);
    if (hit) return Promise.resolve(hit);
    let p = this.inflight.get(key);
    if (p) return p;
    p = this._schedule(() => this._load(key, url, opts), opts.priority ?? 5, opts.signal)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  _schedule(fn, priority, signal) {
    return new Promise((resolve, reject) => {
      const job = { fn, priority, resolve, reject, signal };
      this.waiting.push(job);
      this.waiting.sort((a, b) => a.priority - b.priority);
      this._next();
    });
  }

  _next() {
    while (this.active < this.maxActive && this.waiting.length) {
      const job = this.waiting.shift();
      if (job.signal?.aborted) { job.reject(new DOMException("aborted", "AbortError")); continue; }
      this.active++;
      job.fn().then(job.resolve, job.reject).finally(() => { this.active--; this._next(); });
    }
  }

  cancelPending(pred) {
    this.waiting = this.waiting.filter((j) => {
      if (pred(j)) { j.reject(new DOMException("aborted", "AbortError")); return false; }
      return true;
    });
  }

  async _load(key, url, opts) {
    const resp = await fetch(url, { credentials: "same-origin", signal: opts.signal });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }
    const buf = await resp.arrayBuffer();
    this.bytesFetched += buf.byteLength;
    const res = await this.pool.run({ buf, contour: opts.contour || null }, [buf]);
    const header = res.header;
    const comps = res.comps.map((b) => new Uint16Array(b));
    const entry = { key, header, comps, tex: null, bytes: comps.reduce((s, c) => s + c.byteLength * 2, 0) };
    if (res.contour) {
      entry.contour = {
        lines: new Float32Array(res.contour.lines),
        labels: new Float32Array(res.contour.labels),
        hilo: res.contour.hilo ? new Float32Array(res.contour.hilo) : null,
      };
    }
    this._insert(entry);
    return entry;
  }

  _insert(entry) {
    this.cache.set(entry.key, entry);
    this.used += entry.bytes;
    while (this.used > this.budget && this.cache.size > 2) {
      const [k, old] = this.cache.entries().next().value;
      if (old.pinned) { this.cache.delete(k); this.cache.set(k, old); continue; }
      this.evict(k);
    }
  }

  evict(key) {
    const e = this.cache.get(key);
    if (!e) return;
    if (e.tex) this.gl.deleteTexture(e.tex);
    this.used -= e.bytes;
    this.cache.delete(key);
  }

  texture(entry) {
    if (!entry.tex) {
      const { w, h } = entry.header;
      let data = entry.comps[0];
      if (entry.comps.length === 2) {
        data = new Uint16Array(w * h * 2);
        const a = entry.comps[0], b = entry.comps[1];
        for (let i = 0; i < w * h; i++) { data[i * 2] = a[i]; data[i * 2 + 1] = b[i]; }
      }
      entry.tex = dataTexture(this.gl, w, h, entry.comps.length, data);
    }
    return entry.tex;
  }

  clear(pred = () => true) {
    for (const k of [...this.cache.keys()]) if (pred(k)) this.evict(k);
  }
}

// Value at lon/lat from a decoded frame (bilinear), in canonical units.
export function sampleFrame(entry, lon, lat) {
  const { header, comps } = entry;
  const g = header.grid;
  let i, j;
  if (g.type === "latlon") {
    const di = lon - g.lo1;
    i = g.dlon > 0 ? (((di % 360) + 720) % 360) / g.dlon : -(((-di % 360) + 720) % 360) / g.dlon;
    j = (lat - g.la1) / g.dlat;
  } else {
    const DEG = Math.PI / 180;
    let dl = (lon - g.lov) * DEG;
    dl = dl - 2 * Math.PI * Math.floor((dl + Math.PI) / (2 * Math.PI));
    const rho = g.RF / Math.pow(Math.tan(Math.PI / 4 + lat * DEG / 2), g.n);
    const th = g.n * dl;
    const x = rho * Math.sin(th), y = g.rho0 - rho * Math.cos(th);
    i = (x - g.x1) / g.dx;
    j = (y - g.y1) / g.dy * (g.jpos === 0 ? -1 : 1);
  }
  const w = header.w, h = header.h;
  if (j < -0.5 || j > h - 0.5) return null;
  if (!(g.type === "latlon" && g.wrap) && (i < -0.5 || i > w - 0.5)) return null;
  const wrapI = (ii) => (g.type === "latlon" && g.wrap ? ((ii % w) + w) % w : Math.min(w - 1, Math.max(0, ii)));
  const i0 = Math.floor(i), j0 = Math.floor(j), ti = i - i0, tj = j - j0;
  const idx = (ii, jj) => Math.min(h - 1, Math.max(0, jj)) * w + wrapI(ii);
  const s = header.scale, o = header.offset;
  const read = (c) => {
    if (header.kind === "category") {
      const q = c[idx(Math.round(i), Math.round(j))];
      return q === 0 ? null : q - 1;
    }
    const pts = [[i0, j0, (1 - ti) * (1 - tj)], [i0 + 1, j0, ti * (1 - tj)], [i0, j0 + 1, (1 - ti) * tj], [i0 + 1, j0 + 1, ti * tj]];
    let sum = 0, ws = 0;
    for (const [a, b, wgt] of pts) { const q = c[idx(a, b)]; if (q) { sum += ((q - 1) * s + o) * wgt; ws += wgt; } }
    return ws > 0.01 ? sum / ws : null;
  };
  if (header.kind === "vector") {
    const u = read(comps[0]), v = read(comps[1]);
    if (u == null || v == null) return null;
    return { u, v, speed: Math.hypot(u, v), dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
  }
  const val = read(comps[0]);
  return val == null ? null : header.kind === "category" ? { cat: Math.floor(val / 4096), rate: (val % 4096) * 0.05 } : { value: val };
}
