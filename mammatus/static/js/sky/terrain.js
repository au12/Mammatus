// The ground of the Sky view: three nested square height grids centred on the point (+-16, +-64 and
// +-256 km), finest in the middle. The server builds them from open elevation tiles (data/terrain.py);
// when it can't, the same shape is filled from the weather model's own coarse terrain, so the renderer
// only ever knows one kind of ground.
//
// Heights here are kilometres relative to the ground at the point; rows run south to north.
import { ApiError } from "../api.js";

export const HALF = [16, 64, 256];
export const EARTH_R = 6371 * 7 / 6;      // km: the earth's radius as light sees it (standard refraction)
const RIM = 0.15;                         // share of a grid blended into the next coarser one (as on the server)

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const pause = () => new Promise((r) => setTimeout(r, 0));

export class Terrain {
  // layers: one Float32Array(size * size) per grid, km relative to the point
  constructor({ size, layers, elev = 0, base = 0, real = false, attribution = "", key = "" }) {
    this.size = size;
    this.half = HALF;
    this.layers = layers;
    this.elev = elev;                // metres above sea level at the point
    this.base = base;                // the level plain beyond the outer grid, km
    this.real = real;
    this.sea = real ? -elev / 1000 : -1e4;      // sea level in these heights (only the real ground knows where the sea is)
    this.attribution = attribution;
    this.key = key;
    let lo = Infinity, hi = -Infinity;
    for (const a of layers) for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    this.min = Math.min(lo, base);
    this.max = Math.max(hi, base);
    this.levels = Math.round(Math.log2(size)) + 1;
  }

  // which grid draws the ground at (x, y): the finest one that reaches it
  layerAt(x, y) {
    const m = Math.max(Math.abs(x), Math.abs(y)), k = 1 - 1 / this.size;
    return m < HALF[0] * k ? 0 : m < HALF[1] * k ? 1 : 2;
  }

  // ground height (km, relative to the point), as the GPU reads it
  heightAt(x, y) {
    const k = this.layerAt(x, y), S = this.size, a = this.layers[k], H = HALF[k];
    const fx = Math.min(S - 1, Math.max(0, (x + H) / (2 * H) * S - 0.5)), fy = Math.min(S - 1, Math.max(0, (y + H) / (2 * H) * S - 0.5));
    const i = Math.min(S - 2, Math.floor(fx)), j = Math.min(S - 2, Math.floor(fy)), u = fx - i, v = fy - j;
    const r0 = j * S + i, r1 = r0 + S;
    return (a[r0] * (1 - u) + a[r0 + 1] * u) * (1 - v) + (a[r1] * (1 - u) + a[r1 + 1] * u) * v;
  }

  // What the GPU needs: for each grid a mip chain of (mean height, highest ground) pairs. The highest
  // ground of a texel covers its neighbours too (a bilinear read never exceeds it), and a coarser grid's
  // maxima also cover the finer grid lying inside it, so a ray may skip any block it clears.
  pyramids() {
    const out = [];
    for (let k = 0; k < this.layers.length; k++) out.push(pyramid(this.layers[k], this.size, k ? out[k - 1][2] : null));
    return out;
  }

  // the same, a grid at a time with a breath between, so a big patch doesn't stall the animation
  async pyramidsLater() {
    const out = [];
    for (let k = 0; k < this.layers.length; k++) {
      out.push(pyramid(this.layers[k], this.size, k ? out[k - 1][2] : null));   // [2]: 4x4 texels = one texel of the next grid
      await pause();
    }
    return out;
  }
}

function pyramid(h, S, inner) {
  const base = new Float32Array(S * S * 2), tmp = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    const r = j * S;
    for (let i = 0; i < S; i++) {
      const a = h[r + (i > 0 ? i - 1 : 0)], b = h[r + i], c = h[r + (i < S - 1 ? i + 1 : i)];
      tmp[r + i] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
  }
  for (let j = 0; j < S; j++) {
    const r = j * S, ra = (j > 0 ? j - 1 : 0) * S, rc = (j < S - 1 ? j + 1 : j) * S;
    for (let i = 0; i < S; i++) {
      const a = tmp[ra + i], b = tmp[r + i], c = tmp[rc + i];
      base[(r + i) * 2] = h[r + i];
      base[(r + i) * 2 + 1] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
  }
  if (inner) {
    // the finer grid sits in the middle quarter: its peaks count here too
    const q = S / 4, o = (S * 3) / 8, src = inner.data;
    for (let j = 0; j < q; j++) for (let i = 0; i < q; i++) {
      const d = ((j + o) * S + i + o) * 2 + 1, m = src[(j * q + i) * 2 + 1];
      if (m > base[d]) base[d] = m;
    }
  }
  const chain = [{ w: S, data: base }];
  for (let w = S >> 1, prev = base; w >= 1; w >>= 1) {
    const cur = new Float32Array(w * w * 2), pw = w * 2;
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
      const a = (j * 2 * pw + i * 2) * 2, b = a + 2, c = a + pw * 2, d = c + 2, o = (j * w + i) * 2;
      cur[o] = (prev[a] + prev[b] + prev[c] + prev[d]) * 0.25;
      cur[o + 1] = Math.max(prev[a + 1], prev[b + 1], prev[c + 1], prev[d + 1]);
    }
    chain.push({ w, data: cur });
    prev = cur;
  }
  return chain;
}

// ------------------------------------------------------------------ the real ground, from the server
export function decodePatch(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 12 || u8[0] !== 77 || u8[1] !== 77 || u8[2] !== 84 || u8[3] !== 49) throw new Error("Not a terrain patch");
  const hlen = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  const S = head.size, n = S * S;
  if (!(S >= 64 && S <= 2048) || (S & (S - 1)) || head.half?.length !== 3 || u8.length < 8 + hlen + n * 6) throw new Error("Damaged terrain patch");
  const layers = [];
  let off = 8 + hlen;
  for (let k = 0; k < 3; k++) {
    // second differences (west, then south), zigzag-coded, low bytes then high bytes; int16 metres
    const g = new Int16Array(n);
    for (let j = 0, p = 0; j < S; j++) for (let i = 0; i < S; i++, p++) {
      const z = u8[off + p] | (u8[off + n + p] << 8);
      g[p] = ((z >>> 1) ^ -(z & 1)) + (i ? g[p - 1] : 0) + (j ? g[p - S] : 0) - (i && j ? g[p - S - 1] : 0);
    }
    off += n * 2;
    const f = new Float32Array(n);
    for (let p = 0; p < n; p++) f[p] = (g[p] - head.elev) / 1000;
    layers.push(f);
  }
  return new Terrain({ size: S, layers, elev: head.elev, base: ((head.base ?? head.elev) - head.elev) / 1000, real: true,
    attribution: head.attribution || "", key: `real@${head.lat},${head.lon}` });
}

export async function fetchTerrain(lat, lon, size, signal) {
  let resp;
  try {
    resp = await fetch(`/api/sky/terrain?lat=${lat}&lon=${lon}&size=${size}`, { credentials: "same-origin", headers: { "X-Mammatus": "1" }, signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError(navigator.onLine ? "Can't reach the server." : "You're offline.", 0);
  }
  if (!resp.ok) throw new ApiError(resp.statusText || "No terrain", resp.status);
  return decodePatch(await resp.arrayBuffer());
}

// ------------------------------------------------------------------ the stand-in: the model's own terrain
// The weather model's 3 km (or coarser) ground inside its 120 km box, carried on with rolling hills, as
// the Sky view drew it before it had real terrain. Used until the real ground arrives, and when it can't.
function hash12(x, y) {
  let a = (x * 0.1031) % 1, b = (y * 0.1031) % 1;
  if (a < 0) a += 1;
  if (b < 0) b += 1;
  const d = a * (b + 33.33) + b * (a + 33.33) + a * (a + 33.33);
  const p = a + d, q = b + d;
  const r = ((p + q) * p) % 1;
  return r < 0 ? r + 1 : r;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy), c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
function fbm(x, y, oct) {
  let s = 0, a = 0.5;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); x = x * 2.03 + 17.1; y = y * 2.03 + 17.1; a *= 0.5; }
  return s;
}

export function modelTerrain(box, n, { elev = 0, size = 128, key = "" } = {}) {
  const cell = 120 / n;
  const boxAt = (x, y) => {
    const fx = Math.min(n - 1, Math.max(0, (x + 60) / cell - 0.5)), fy = Math.min(n - 1, Math.max(0, (y + 60) / cell - 0.5));
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fy)), u = fx - i, v = fy - j;
    return (box[j * n + i] * (1 - u) + box[j * n + i + 1] * u) * (1 - v) + (box[(j + 1) * n + i] * (1 - u) + box[(j + 1) * n + i + 1] * u) * v;
  };
  const layers = HALF.map((H, k) => {
    const a = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      const y = ((j + 0.5) / size * 2 - 1) * H;
      for (let i = 0; i < size; i++) {
        const x = ((i + 0.5) / size * 2 - 1) * H;
        const m = Math.max(Math.abs(x), Math.abs(y));
        const b = boxAt(x, y), inside = 1 - smooth(60, 90, m);
        const relief = 0.12 + 0.6 * smooth(0, 1.2, Math.abs(b) + 0.15);
        const hills = inside < 1 ? (fbm(x * 0.045 + 3, y * 0.045 + 3, 3) - 0.5) * 0.8 * relief : 0;
        // fine ridges near the point (the inner grid can carry them), but never right where the ground view stands
        const fine = k === 0 ? (fbm(x * 0.6, y * 0.6, 2) - 0.5) * 0.18 * relief * smooth(0.05, 1.5, Math.hypot(x, y)) * (1 - smooth(9, 13, m)) : 0;
        a[j * size + i] = hills + (b - hills) * inside + fine;
      }
    }
    return a;
  });
  const base = nest(layers, size);
  return new Terrain({ size, layers, elev, base, real: false, key });
}

// Blend each grid's rim into the next coarser grid (read as the GPU reads it) and the outermost into a
// level plain, so the grids meet without a seam. Returns the plain's height.
export function nest(layers, S) {
  const rim = (blend) => {
    const w = new Float32Array(S);
    for (let i = 0; i < S; i++) w[i] = smooth(1 - blend, 1 - 1 / S, Math.abs((i + 0.5) / S * 2 - 1));
    return w;
  };
  const last = layers[layers.length - 1];
  const ring = [];
  for (let i = 0; i < S; i++) ring.push(last[i], last[(S - 1) * S + i], last[i * S], last[i * S + S - 1]);
  ring.sort((a, b) => a - b);
  const base = ring[ring.length >> 1];
  let w = rim(0.12);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const t = Math.max(w[i], w[j]); if (t > 0) last[j * S + i] += (base - last[j * S + i]) * t; }
  w = rim(RIM);
  for (let k = layers.length - 2; k >= 0; k--) {
    const fine = layers[k], coarse = layers[k + 1], ratio = HALF[k] / HALF[k + 1];
    // where each fine texel centre falls in the coarser grid
    const at = new Float32Array(S);
    for (let i = 0; i < S; i++) at[i] = (((i + 0.5) / S * 2 - 1) * ratio + 1) / 2 * S - 0.5;
    for (let j = 0; j < S; j++) {
      if (w[j] === 0) {
        // only the two ends of this row are in the rim
        for (let i = 0; i < S; i++) if (w[i] > 0) fine[j * S + i] += (bilerp(coarse, S, at[i], at[j]) - fine[j * S + i]) * w[i];
      } else for (let i = 0; i < S; i++) fine[j * S + i] += (bilerp(coarse, S, at[i], at[j]) - fine[j * S + i]) * Math.max(w[i], w[j]);
    }
  }
  return base;
}

function bilerp(a, S, fx, fy) {
  const i = Math.min(S - 2, Math.max(0, Math.floor(fx))), j = Math.min(S - 2, Math.max(0, Math.floor(fy)));
  const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
  const r0 = j * S + i, r1 = r0 + S;
  return (a[r0] * (1 - u) + a[r0 + 1] * u) * (1 - v) + (a[r1] * (1 - u) + a[r1 + 1] * u) * v;
}
