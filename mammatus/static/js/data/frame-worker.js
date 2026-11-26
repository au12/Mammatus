// Off-main-thread frame decoding, contouring and pressure-center detection.

const R_EARTH = 6371;
const DEG = Math.PI / 180;

function decodeFrame(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "MMF1") throw new Error("bad frame");
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const n = header.w * header.h;
  const bytes = new Uint8Array(buf);
  let off = 8 + hlen;
  const comps = [];
  for (let c = 0; c < header.comps; c++) {
    const out = new Uint16Array(n);
    const lo = off, hi = off + n;
    const w = header.w;
    let prevFirst = 0;
    for (let j = 0; j < header.h; j++) {
      const row = j * w;
      let prev = 0;
      for (let i = 0; i < w; i++) {
        const k = row + i;
        const z = bytes[lo + k] | (bytes[hi + k] << 8);
        const d = (z >>> 1) ^ -(z & 1);
        let v;
        if (i === 0) { v = (prevFirst + d) & 0xffff; prevFirst = v; } else v = (prev + d) & 0xffff;
        out[k] = v;
        prev = v;
      }
    }
    comps.push(out);
    off += 2 * n;
  }
  return { header, comps };
}

function toFloat(q, header, comp2) {
  const n = q.length;
  const out = new Float32Array(n);
  const s = header.scale, o = header.offset;
  if (comp2) {
    for (let i = 0; i < n; i++) {
      const a = q[i], b = comp2[i];
      out[i] = a === 0 || b === 0 ? NaN : Math.hypot((a - 1) * s + o, (b - 1) * s + o);
    }
  } else {
    for (let i = 0; i < n; i++) { const a = q[i]; out[i] = a === 0 ? NaN : (a - 1) * s + o; }
  }
  return out;
}

function blur(f, w, h, passes) {
  let a = f, b = new Float32Array(f.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++) {
      const r = j * w;
      for (let i = 0; i < w; i++) {
        let s = 0, c = 0;
        for (let k = -1; k <= 1; k++) {
          const ii = Math.min(w - 1, Math.max(0, i + k));
          const v = a[r + ii];
          if (v === v) { s += v; c++; }
        }
        b[r + i] = c ? s / c : NaN;
      }
    }
    [a, b] = [b, a];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let s = 0, c = 0;
        for (let k = -1; k <= 1; k++) {
          const jj = Math.min(h - 1, Math.max(0, j + k));
          const v = a[jj * w + i];
          if (v === v) { s += v; c++; }
        }
        b[j * w + i] = c ? s / c : NaN;
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

// Grid index -> lon/lat (degrees)
function makeInverse(g) {
  if (g.type === "latlon") {
    return (i, j) => [((g.lo1 + i * g.dlon + 540) % 360) - 180, g.la1 + j * g.dlat];
  }
  const n = g.n, RF = g.RF, rho0 = g.rho0, sgn = Math.sign(n);
  const jdir = g.jpos === 0 ? -1 : 1;
  return (i, j) => {
    const x = g.x1 + i * g.dx, y = g.y1 + j * g.dy * jdir;
    const dy = rho0 - y;
    const rho = sgn * Math.hypot(x, dy);
    const th = Math.atan2(sgn * x, sgn * dy);
    const lat = 2 * Math.atan(Math.pow(RF / rho, 1 / n)) - Math.PI / 2;
    const lon = g.lov + th / n / DEG;
    return [((lon + 540) % 360) - 180, lat / DEG];
  };
}

function hav(a, b) {
  const dlat = (b[1] - a[1]) * DEG, dlon = (b[0] - a[0]) * DEG;
  const s = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dlon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Marching squares with segment linking. Returns polylines in grid coordinates.
function contourLevel(f, w, h, level, wrap) {
  const W = wrap ? w : w - 1;
  const edgeKey = (i, j, vert) => ((j * (w + 1) + i) * 2 + (vert ? 1 : 0));
  const pts = new Map();
  const adj = new Map();
  const addSeg = (k1, p1, k2, p2) => {
    pts.set(k1, p1); pts.set(k2, p2);
    if (!adj.has(k1)) adj.set(k1, []);
    if (!adj.has(k2)) adj.set(k2, []);
    adj.get(k1).push(k2); adj.get(k2).push(k1);
  };
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < W; i++) {
      const i1 = (i + 1) % w;
      const a = f[j * w + i], b = f[j * w + i1], c = f[(j + 1) * w + i1], d = f[(j + 1) * w + i];
      if (!(a === a && b === b && c === c && d === d)) continue;
      const idx = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const ip = i + 1;
      const e = {
        b: () => [edgeKey(i, j, false), [i + (level - a) / (b - a), j]],
        r: () => [edgeKey(ip, j, true), [ip, j + (level - b) / (c - b)]],
        t: () => [edgeKey(i, j + 1, false), [i + (level - d) / (c - d), j + 1]],
        l: () => [edgeKey(i, j, true), [i, j + (level - a) / (d - a)]],
      };
      const seg = (x, y) => { const [k1, p1] = e[x](); const [k2, p2] = e[y](); addSeg(k1, p1, k2, p2); };
      switch (idx) {
        case 1: case 14: seg("b", "l"); break;
        case 2: case 13: seg("b", "r"); break;
        case 3: case 12: seg("l", "r"); break;
        case 4: case 11: seg("r", "t"); break;
        case 6: case 9: seg("b", "t"); break;
        case 7: case 8: seg("l", "t"); break;
        case 5: { const m = (a + b + c + d) / 4; if (m > level) { seg("b", "r"); seg("t", "l"); } else { seg("b", "l"); seg("r", "t"); } break; }
        case 10: { const m = (a + b + c + d) / 4; if (m > level) { seg("b", "l"); seg("r", "t"); } else { seg("b", "r"); seg("t", "l"); } break; }
      }
    }
  }
  // wrap: unify keys at i = w with i = 0
  const lines = [];
  const used = new Set();
  const walk = (start) => {
    const line = [pts.get(start)];
    used.add(start);
    let cur = start;
    for (;;) {
      const next = (adj.get(cur) || []).find((k) => !used.has(k));
      if (next === undefined) break;
      used.add(next);
      line.push(pts.get(next));
      cur = next;
    }
    return line;
  };
  for (const [k, nb] of adj) if (nb.length === 1 && !used.has(k)) lines.push(walk(k));
  for (const k of adj.keys()) if (!used.has(k)) { const l = walk(k); l.push(l[0]); lines.push(l); }
  return lines;
}

function contours(f, header, spec) {
  const { w, h } = header;
  const g = header.grid;
  const wrap = g.type === "latlon" && g.wrap;
  const inv = makeInverse(g);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  let levels = spec.levels;
  if (!levels) {
    levels = [];
    const iv = spec.interval, base = spec.base ?? 0;
    const start = base + Math.ceil((lo - base) / iv) * iv;
    for (let v = start; v <= hi && levels.length < 200; v += iv) levels.push(v);
  }
  if (spec.min != null) levels = levels.filter((v) => v >= spec.min);
  if (spec.max != null) levels = levels.filter((v) => v <= spec.max);
  const out = [];
  const labels = [];
  const labelEvery = spec.labelKm ?? 900;
  for (const level of levels) {
    for (const line of contourLevel(f, w, h, level, wrap)) {
      if (line.length < 3) continue;
      let dist = 0, prev = null, sinceLabel = labelEvery * 0.45;
      for (let k = 0; k < line.length; k++) {
        const ll = inv(line[k][0] >= w ? line[k][0] - w : line[k][0], line[k][1]);
        if (prev) {
          if (Math.abs(ll[0] - prev[0]) > 180) { out.push(999, 0, 0); dist = 0; prev = null; }
          else { const d = hav(prev, ll); dist += d; sinceLabel += d; }
        }
        out.push(ll[0], ll[1], dist);
        if (spec.label && prev && sinceLabel >= labelEvery && k < line.length - 1) {
          labels.push(ll[0], ll[1], level);
          sinceLabel = 0;
        }
        prev = ll;
      }
      out.push(999, 0, 0);
    }
  }
  return { lines: new Float32Array(out), labels: new Float32Array(labels), levels };
}

function slidingExtreme(f, w, h, r, max, wrap) {
  const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
  const better = max ? (a, b) => a > b : (a, b) => a < b;
  const init = max ? -Infinity : Infinity;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = init;
      for (let k = -r; k <= r; k++) {
        let ii = i + k;
        if (wrap) ii = (ii + w) % w; else if (ii < 0 || ii >= w) continue;
        const v = f[j * w + ii];
        if (v === v && better(v, m)) m = v;
      }
      tmp[j * w + i] = m;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = init;
      for (let k = -r; k <= r; k++) {
        const jj = j + k;
        if (jj < 0 || jj >= h) continue;
        const v = tmp[jj * w + i];
        if (better(v, m)) m = v;
      }
      out[j * w + i] = m;
    }
  }
  return out;
}

function pressureCenters(f, header) {
  const { w, h } = header;
  const g = header.grid;
  const cellKm = g.type === "latlon" ? Math.abs(g.dlat) * 111 : g.dx / 1000;
  const r = Math.max(2, Math.round(420 / cellKm));
  const wrap = g.type === "latlon" && g.wrap;
  const mx = slidingExtreme(f, w, h, r, true, wrap);
  const mn = slidingExtreme(f, w, h, r, false, wrap);
  const inv = makeInverse(g);
  const out = [];
  const edge = Math.max(2, Math.round(r / 3));
  for (let j = edge; j < h - edge; j++) {
    for (let i = wrap ? 0 : edge; i < (wrap ? w : w - edge); i++) {
      const k = j * w + i, v = f[k];
      if (!(v === v)) continue;
      const range = mx[k] - mn[k];
      if (range < 3) continue;
      if (v === mx[k]) { const ll = inv(i, j); if (Math.abs(ll[1]) < 80) out.push(ll[0], ll[1], v, 1); }
      else if (v === mn[k]) { const ll = inv(i, j); if (Math.abs(ll[1]) < 80) out.push(ll[0], ll[1], v, -1); }
    }
  }
  // suppress duplicates on flat extremes
  const res = [];
  for (let a = 0; a < out.length; a += 4) {
    let dup = false;
    for (let b = 0; b < res.length; b += 4) {
      if (res[b + 3] === out[a + 3] && Math.abs(res[b] - out[a]) < 2 && Math.abs(res[b + 1] - out[a + 1]) < 2) { dup = true; break; }
    }
    if (!dup) res.push(out[a], out[a + 1], out[a + 2], out[a + 3]);
  }
  return new Float32Array(res);
}

self.onmessage = (e) => {
  const { id, buf, contour } = e.data;
  try {
    const { header, comps } = decodeFrame(buf);
    const msg = { id, header, comps: comps.map((c) => c.buffer) };
    const transfer = comps.map((c) => c.buffer);
    if (contour) {
      let f = toFloat(comps[0], header, header.kind === "vector" ? comps[1] : null);
      if (contour.smooth) f = blur(f, header.w, header.h, contour.smooth);
      const c = contours(f, header, contour);
      msg.contour = { lines: c.lines.buffer, labels: c.labels.buffer };
      transfer.push(c.lines.buffer, c.labels.buffer);
      if (contour.hilo) {
        const hl = pressureCenters(f, header);
        msg.contour.hilo = hl.buffer;
        transfer.push(hl.buffer);
      }
    }
    self.postMessage(msg, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
