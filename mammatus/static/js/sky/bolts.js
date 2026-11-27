// Lightning for the Sky view: when and where storms flash, the branching channel of a strike to the
// ground, crawlers under the anvil, and the flicker of return strokes.

const rnd = (a, b) => a + Math.random() * (b - a);

// A jagged channel from a to b with branches (midpoint displacement). Returns segments
// [ax, ay, az, bx, by, bz, width] packed in a Float32Array.
export function channel(a, b, { depth = 7, rough = 0.36, branches = 0.32, width = 1, horizontal = false } = {}) {
  const segs = [];
  const walk = (p, q, d, w, br) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    const len = Math.hypot(dx, dy, dz);
    if (d === 0 || len < 0.04) { segs.push(p[0], p[1], p[2], q[0], q[1], q[2], w); return; }
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const k = len * rough;
    m[0] += rnd(-k, k);
    m[1] += rnd(-k, k);
    m[2] += horizontal ? rnd(-k, k) * 0.15 : rnd(-k, k) * 0.35;
    walk(p, m, d - 1, w, br);
    walk(m, q, d - 1, w, br);
    if (br && d <= depth - 2 && d >= 2 && Math.random() < branches) {
      // a branch heads off downward (or sideways for a crawler) and fades out
      const bl = len * rnd(0.8, 2.2);
      const dir = horizontal ? [rnd(-1, 1), rnd(-1, 1), rnd(-0.08, 0.02)] : [rnd(-0.7, 0.7), rnd(-0.7, 0.7), -rnd(0.4, 1.0)];
      const n = Math.hypot(...dir) || 1;
      const end = [m[0] + dir[0] / n * bl, m[1] + dir[1] / n * bl, Math.max(0.05, m[2] + dir[2] / n * bl)];
      walk(m, end, Math.max(1, d - 2), w * 0.42, false);
    }
  };
  walk(a, b, depth, width, true);
  return new Float32Array(segs);
}

// Return strokes: 1-4 brief pulses with a stepped-leader flicker before the first.
function strokes() {
  const n = Math.random() < 0.45 ? 1 : 1 + Math.floor(rnd(1, 4));
  const out = [];
  let t = rnd(0.02, 0.06);
  for (let i = 0; i < n; i++) {
    out.push({ t, dur: rnd(0.035, 0.07), i: i === 0 ? 1 : rnd(0.55, 0.9) });
    t += rnd(0.05, 0.14);
  }
  return { list: out, end: t + 0.25 };
}

function envelope(st, age) {
  let v = 0;
  if (age < st.list[0].t) v = 0.05 + 0.1 * Math.random();   // leader
  for (const s of st.list) {
    const a = age - s.t;
    if (a >= 0) v = Math.max(v, s.i * (a < s.dur ? 1 : Math.exp(-(a - s.dur) / 0.06)));
  }
  return v;
}

export class Storm {
  constructor() {
    this.cells = [];
    this.flashes = [];       // {x, y, z, kind, t0, st, segs, n, dist}
    this.real = [];          // queued real strikes {x, y, t}
    this.onFlash = null;
  }

  setCells(cells, anvilTop = 12) {
    this.cells = (cells || []).map((c) => ({ x: c.x, y: c.y, base: c.base / 1000, top: c.top / 1000, w: c.w }));
    this.anvilTop = anvilTop;
  }

  // real strikes (from the GOES lightning mapper) in scene km, to flash as they come
  addReal(list) { for (const s of list) this.real.push(s); }

  rate() { return this.cells.reduce((s, c) => s + c.w, 0) * 9 / 60; }   // flashes per second

  update(now, dt, terrainAt) {
    // synthetic flashes from the model's storm cells (when no real strikes are coming in)
    if (!this.real.length && this.cells.length && dt > 0) {
      for (const c of this.cells) {
        if (Math.random() < c.w * 9 / 60 * Math.min(dt, 0.25)) this._spawn(c, now, terrainAt);
      }
    }
    while (this.real.length) {
      const s = this.real.shift();
      const c = this.cells.length ? this.cells.reduce((b, x) => ((x.x - s.x) ** 2 + (x.y - s.y) ** 2 < (b.x - s.x) ** 2 + (b.y - s.y) ** 2 ? x : b))
        : { x: s.x, y: s.y, base: 1.2, top: 11, w: 1 };
      this._spawn({ ...c, x: s.x, y: s.y }, now, terrainAt, true);
    }
    this.flashes = this.flashes.filter((f) => now - f.t0 < f.st.end);
  }

  _spawn(c, now, terrainAt, cg = null) {
    if (this.flashes.length > 5) return;
    const toGround = cg ?? Math.random() < 0.3;
    const x = c.x + rnd(-2.5, 2.5), y = c.y + rnd(-2.5, 2.5);
    const st = strokes();
    let f;
    if (toGround) {
      const top = [x, y, c.base + rnd(0.6, 2.0)];
      const g = terrainAt(x + rnd(-1.5, 1.5), y + rnd(-1.5, 1.5));
      const segs = channel(top, [top[0] + rnd(-1.6, 1.6), top[1] + rnd(-1.6, 1.6), g], { depth: 7 });
      f = { x, y, z: c.base + 0.8, kind: "cg", t0: now, st, segs, n: segs.length / 7 };
    } else {
      const z = c.base + (c.top - c.base) * rnd(0.4, 0.8);
      f = { x, y, z, kind: "ic", t0: now, st, segs: null, n: 0 };
      // now and then a crawler races along the underside of the anvil
      if (Math.random() < 0.18 && c.top > 8) {
        const zb = Math.min(c.top - 1.5, this.anvilTop - 1.5);
        const a = [x, y, zb], b = [x + rnd(-14, 14), y + rnd(-14, 14), zb + rnd(-0.4, 0.2)];
        f.segs = channel(a, b, { depth: 7, rough: 0.28, branches: 0.5, width: 0.55, horizontal: true });
        f.n = f.segs.length / 7;
        f.crawler = true;
      }
    }
    this.flashes.push(f);
    this.onFlash?.(f);
  }

  // what the renderer needs this frame
  frame(now) {
    const lights = [], bolts = [];
    for (const f of this.flashes) {
      const v = envelope(f.st, (now - f.t0) / 1000);
      if (v <= 0.002) continue;
      lights.push({ x: f.x, y: f.y, z: f.z, i: v * (f.kind === "cg" ? 9 : 6) });
      if (f.segs) bolts.push({ segs: f.segs, n: f.n, i: v * (f.crawler ? 0.6 : 1) });
    }
    lights.sort((a, b) => b.i - a.i);
    return { lights, bolts, active: this.flashes.length > 0 };
  }
}
