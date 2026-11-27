// Sky frames: which model hours to show for a time and place, fetching and decoding them, and what the
// renderer derives from them (terrain, wind by height, the anvil map for mammatus, height bands).
import { ApiError } from "../api.js";

export const N = 40, NZ = 64, DZ = 0.25, ZTOP = 16;
const REGIONAL = new Set(["hrrr", "rrfs"]);
export const ESTIMATED = new Set(["ecmwf_ifs025", "icon_seamless", "gem_seamless", "best_match"]);

export function inConus(lat, lon) { return lat > 21.5 && lat < 52.5 && lon > -133 && lon < -61; }
export const runTime = (run) => Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8), +run.slice(8, 10)) / 1000;

// The model hours that bracket time t (epoch s): HRRR, then RRFS, then GFS (or the map's own model/run when
// it has cloud water), then the Open-Meteo estimate. `blocked` holds models that failed for this point.
export function plan(app, t, lat, lon, { source = "auto", blocked = new Set() } = {}) {
  if (ESTIMATED.has(source)) return estimatedPlan(source, t);
  const models = app.catalog.sky?.models || [];
  const map = app.state.source;
  const order = [];
  if (source !== "auto" && models.includes(source)) order.push(source);
  else if (map?.type === "model" && models.includes(map.model)) order.push(map.model);
  for (const m of ["hrrr", "rrfs", "gfs"]) if (models.includes(m) && !order.includes(m)) order.push(m);
  for (const m of order) {
    if (blocked.has(m) || (REGIONAL.has(m) && !inConus(lat, lon))) continue;
    const runs = app.runs[m] || [];
    const list = map?.type === "model" && map.model === m ? [runs.find((r) => r.run === map.run), ...runs].filter(Boolean) : runs;
    for (const r of list) {
      const steps = r.steps || [];
      if (!steps.length) continue;
      const hr = (t - runTime(r.run)) / 3600;
      if (hr < steps[0] - 1e-6 || hr > steps[steps.length - 1] + 1e-6) continue;
      let i = steps.findIndex((s) => s >= hr - 1e-6);
      const fb = steps[i];
      const fa = fb > hr + 1e-6 && i > 0 ? steps[i - 1] : fb;
      return { kind: "model", model: m, run: r.run, fa, fb, mix: fb === fa ? 0 : (hr - fa) / (fb - fa) };
    }
  }
  return estimatedPlan("ecmwf_ifs025", t);
}

function estimatedPlan(model, t) {
  const ta = Math.floor(t / 3600) * 3600;
  const mix = (t - ta) / 3600;
  return { kind: "estimated", model, ta, tb: mix > 0.001 ? ta + 3600 : ta, mix: mix > 0.001 ? mix : 0 };
}

// identity of one frame
export function frameIds(p, lat, lon) {
  const ll = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (p.kind === "model") return [`${p.model}/${p.run}/${p.fa}@${ll}`, `${p.model}/${p.run}/${p.fb}@${ll}`];
  return [`est/${p.model}/${p.ta}@${ll}`, `est/${p.model}/${p.tb}@${ll}`];
}

function urlFor(id) {
  const [path, ll] = id.split("@");
  const [lat, lon] = ll.split(",");
  const parts = path.split("/");
  if (parts[0] === "est") return `/api/sky/estimated?model=${parts[1]}&t=${parts[2]}&lat=${lat}&lon=${lon}`;
  return `/api/sky/frame/${parts[0]}/${parts[1]}/${parts[2]}?lat=${lat}&lon=${lon}`;
}

export function decodeFrame(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 77 || u8[1] !== 77 || u8[2] !== 83 || u8[3] !== 49) throw new Error("Not a sky frame");
  const hlen = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  const size = head.n * head.n * head.nz * 4;
  const off = 8 + hlen;
  return derive(head, u8.subarray(off, off + size), u8.subarray(off + size, off + 2 * size));
}

const wc = (c) => (c > 0 ? Math.pow(10, (c - 1) / 253 * 4.5 - 4) : 0);

function derive(head, vol, aux) {
  const terrain = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) terrain[i] = (head.terrain[i] || 0) / 1000;
  const wind = new Float32Array(NZ * 4);
  for (let k = 0; k < NZ; k++) { wind[k * 4] = head.profile.u[k] || 0; wind[k * 4 + 1] = head.profile.v[k] || 0; }
  // anvils: ice cloud aloft with clear air under it; mammatus hang from their base
  const anvil = new Float32Array(N * N * 2);
  if (head.mammatus > 0) {
    const strength = new Float32Array(N * N), base = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const at = (k) => ((k * N + j) * N + i) * 4;
      let k = NZ - 1;
      while (k >= 20 && !(aux[at(k)] > 18 && vol[at(k) + 1] >= vol[at(k)])) k--;
      if (k < 20) continue;
      let kb = k;
      while (kb > 18 && aux[at(kb - 1)] > 18) kb--;
      let clear = 0;
      for (let q = kb - 1; q >= Math.max(0, kb - 6); q--) if (aux[at(q)] < 8) clear++;
      if (clear < 5 || kb * DZ < 5) continue;
      base[j * N + i] = kb * DZ;
      strength[j * N + i] = Math.min(1, wc(vol[at(kb) + 1]) * 25 + 0.3);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, w = 0, b = 0, bw = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = Math.min(N - 1, Math.max(0, j + dj)), ii = Math.min(N - 1, Math.max(0, i + di));
        s += strength[jj * N + ii]; w++;
        if (base[jj * N + ii] > 0) { b += base[jj * N + ii]; bw++; }
      }
      anvil[(j * N + i) * 2] = bw ? b / bw / ZTOP : 0;
      anvil[(j * N + i) * 2 + 1] = (s / w) * (base[j * N + i] > 0 ? 1 : 0.6);
    }
  }
  // height bands holding anything to draw (the clouds are ray-marched only through these)
  const occ = head.occ || [];
  const levels = [];
  for (let k = 0; k < NZ; k++) if ((occ[k] || 0) > 0.008) levels.push(k);
  const bands = [];
  for (const k of levels) {
    const lo = Math.max(0, k - 1) * DZ, hi = Math.min(NZ, k + 2) * DZ;
    if (bands.length && lo <= bands[bands.length - 1][1] + 0.01) bands[bands.length - 1][1] = Math.max(bands[bands.length - 1][1], hi);
    else bands.push([lo, hi]);
  }
  if (head.mammatus > 0) {
    let lowest = 99;
    for (let i = 0; i < N * N; i++) if (anvil[i * 2] > 0) lowest = Math.min(lowest, anvil[i * 2] * ZTOP);
    if (lowest < 99) bands.push([lowest - 1.7, lowest + 0.3]);
  }
  // which levels hold anything, widened by the three levels the renderer's warp can reach
  const filled = new Uint8Array(NZ);
  for (const k of levels) for (let q = Math.max(0, k - 3); q <= Math.min(NZ - 1, k + 3); q++) filled[q] = 1;
  return { head, vol, aux, terrain, wind, anvil, bands: mergeBands(bands), filled };
}

// How far (km east, north) the clouds of each height band moved between two frames of the same place: the
// shift that best lines up the earlier frame's cloud cover with the later one's. This is what lets the view
// carry clouds across the sky between model hours instead of fading one hour out and the next in. Bands
// with nothing to follow (clear, or a featureless overcast) and pairs that don't match anywhere get zero,
// as does anything that would have to move more than 36 km.
const CELL = 3, REACH = 12;
function coverMap(f, z0, z1) {
  const m = new Float32Array(N * N);
  const k0 = Math.max(0, Math.floor(z0 / DZ)), k1 = Math.min(NZ - 1, Math.ceil(z1 / DZ));
  for (let k = k0; k <= k1; k++) {
    const o = k * N * N * 4;
    for (let i = 0; i < N * N; i++) { const c = f.aux[o + i * 4]; if (c > m[i]) m[i] = c; }
  }
  let mean = 0;
  for (let i = 0; i < N * N; i++) mean += m[i];
  mean /= N * N;
  let v = 0;
  for (let i = 0; i < N * N; i++) { m[i] -= mean; v += m[i] * m[i]; }
  return { m, v: v / (N * N) };
}
export function flow(fa, fb, bands, guess = []) {
  return bands.map(([z0, z1], bi) => {
    const A = coverMap(fa, z0, z1), B = coverMap(fb, z0, z1);
    if (A.v < 40 || B.v < 40) return [0, 0];             // (cover is in bytes: under about 2.5 % variation)
    const g = guess[bi] || [0, 0];
    const score = (sx, sy) => {
      let ab = 0, aa = 0, bb = 0;
      const x0 = Math.max(0, -sx), x1 = Math.min(N, N - sx), y0 = Math.max(0, -sy), y1 = Math.min(N, N - sy);
      for (let y = y0; y < y1; y++) {
        const ra = y * N, rb = (y + sy) * N + sx;
        for (let x = x0; x < x1; x++) { const a = A.m[ra + x], b = B.m[rb + x]; ab += a * b; aa += a * a; bb += b * b; }
      }
      return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    };
    // a coarse pass over every other cell, then the cells around the best of those
    let best = -2, bx = 0, by = 0;
    const consider = (sx, sy) => {
      // (ties go to the wind's own guess, and to staying put)
      const sc = score(sx, sy) - 0.004 * Math.hypot(sx - g[0] / CELL, sy - g[1] / CELL);
      if (sc > best) { best = sc; bx = sx; by = sy; }
    };
    for (let sy = -REACH; sy <= REACH; sy += 2) for (let sx = -REACH; sx <= REACH; sx += 2) consider(sx, sy);
    const cx = bx, cy = by;
    for (let sy = cy - 1; sy <= cy + 1; sy++) for (let sx = cx - 1; sx <= cx + 1; sx++) if (Math.abs(sx) <= REACH && Math.abs(sy) <= REACH) consider(sx, sy);
    const here = score(bx, by), stay = score(0, 0);
    if (here < 0.35 || here < stay + 0.04) return [0, 0];
    // between cells: the top of a parabola through the scores either side
    const sub = (m, c, p) => { const d = m - 2 * c + p; return d < -1e-6 ? Math.max(-0.5, Math.min(0.5, 0.5 * (m - p) / d)) : 0; };
    const fx = Math.abs(bx) < REACH ? sub(score(bx - 1, by), here, score(bx + 1, by)) : 0;
    const fy = Math.abs(by) < REACH ? sub(score(bx, by - 1), here, score(bx, by + 1)) : 0;
    return [(bx + fx) * CELL, (by + fy) * CELL];
  });
}

export function mergeBands(list) {
  const b = list.map((x) => [Math.max(0, x[0]), Math.min(ZTOP, x[1])]).filter((x) => x[1] > x[0]).sort((a, c) => a[0] - c[0]);
  const out = [];
  for (const x of b) {
    if (out.length && x[0] <= out[out.length - 1][1] + 0.05) out[out.length - 1][1] = Math.max(out[out.length - 1][1], x[1]);
    else out.push([...x]);
  }
  while (out.length > 6) {
    let gi = 0, g = 1e9;
    for (let i = 0; i < out.length - 1; i++) if (out[i + 1][0] - out[i][1] < g) { g = out[i + 1][0] - out[i][1]; gi = i; }
    out[gi][1] = out[gi + 1][1];
    out.splice(gi + 1, 1);
  }
  return out;
}

// Fetches frames, a few at a time, and keeps the decoded ones. What the view is waiting for jumps the queue
// ahead of what was only fetched in case it is wanted next.
export class Loader {
  constructor(cap = 48) {
    this.cache = new Map();     // id -> Promise<frame>
    this.done = new Map();      // id -> frame, for the ones that have arrived
    this.cap = cap;
    this.active = 0;
    this.queue = [];
  }

  get(id, urgent = true) {
    let p = this.cache.get(id);
    if (p) {
      this.cache.delete(id); this.cache.set(id, p);
      if (urgent) { const i = this.queue.findIndex((j) => j.id === id); if (i > 0) this.queue.unshift(...this.queue.splice(i, 1)); }
      return p;
    }
    p = new Promise((resolve, reject) => {
      const job = { id, resolve, reject };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
    });
    p.then((f) => { if (this.cache.get(id) === p) this.done.set(id, f); }, () => { if (this.cache.get(id) === p) this.cache.delete(id); });
    this.cache.set(id, p);
    while (this.cache.size > this.cap) { const k = this.cache.keys().next().value; this.cache.delete(k); this.done.delete(k); }
    this._pump();
    return p;
  }

  // the frame, if it has already arrived
  peek(id) { return this.done.get(id) || null; }

  // forget what was only queued in case (the view moved somewhere else)
  drop(keep) {
    this.queue = this.queue.filter((j) => { if (keep(j.id)) return true; this.cache.delete(j.id); j.reject(new ApiError("Cancelled", -1)); return false; });
  }

  _pump() {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this._fetch(job.id).then(job.resolve, job.reject).finally(() => { this.active--; this._pump(); });
    }
  }

  async _fetch(id) {
    let resp;
    try {
      resp = await fetch(urlFor(id), { credentials: "same-origin", headers: { "X-Mammatus": "1" } });
    } catch {
      throw new ApiError(navigator.onLine ? "Can't reach the server." : "You're offline.", 0);
    }
    if (!resp.ok) {
      let msg = resp.statusText;
      try { msg = (await resp.json()).detail || msg; } catch { /* not json */ }
      throw new ApiError(msg, resp.status);
    }
    const f = decodeFrame(await resp.arrayBuffer());
    f.id = id;
    f.key = id;
    return f;
  }
}
