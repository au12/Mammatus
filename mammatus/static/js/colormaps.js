// Colormap LUT textures, built from the server's stops. Smooth ramps interpolate
// in OKLab so gradients stay perceptually even.
import { texture } from "./engine/gl.js";

const LUT_W = 1024;

function hexToRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255);
}
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function toOklab([r, g, b]) {
  r = srgbToLin(r); g = srgbToLin(g); b = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((c) => Math.min(1, Math.max(0, linToSrgb(c))));
}

// Fill one LUT row; stops are placed at equal spacing (the shader maps value -> stop index).
function fillRow(out, row, stops, step) {
  const n = stops.length;
  const labs = stops.map((s) => toOklab(hexToRgb(s[1])));
  for (let x = 0; x < LUT_W; x++) {
    const t = (x / (LUT_W - 1)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(t));
    const f = step ? 0 : t - i;
    const c = fromOklab(labs[i].map((v, k) => v + (labs[i + 1][k] - v) * f));
    const a = (stops[i][2] ?? 1) + ((stops[i + 1][2] ?? 1) - (stops[i][2] ?? 1)) * f;
    const o = (row * LUT_W + x) * 4;
    out[o] = c[0] * 255; out[o + 1] = c[1] * 255; out[o + 2] = c[2] * 255; out[o + 3] = a * 255;
  }
}

const RATE_STOPS_MAX = 60; // must match rateT() in the shader: log(rate/0.05)/log(1200)

export function buildColormap(gl, cmap) {
  if (cmap.mode === "category") {
    const rows = cmap.categories.length;
    const data = new Uint8Array(LUT_W * rows * 4);
    cmap.categories.forEach((cat, r) => {
      // remap category stops (mm/h) onto the shader's log rate axis
      const lr = (v) => Math.min(1, Math.max(0, Math.log(Math.max(v, 0.05) / 0.05) / Math.log(1200)));
      const stops = cat.stops;
      for (let x = 0; x < LUT_W; x++) {
        const t = x / (LUT_W - 1);
        let i = 0;
        while (i < stops.length - 2 && lr(stops[i + 1][0]) < t) i++;
        const t0 = lr(stops[i][0]), t1 = lr(stops[i + 1][0]);
        const f = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
        const ca = toOklab(hexToRgb(stops[i][1])), cb = toOklab(hexToRgb(stops[i + 1][1]));
        const c = fromOklab(ca.map((v, k) => v + (cb[k] - v) * f));
        const a0 = stops[i][2] ?? 1, a1 = stops[i + 1][2] ?? 1;
        const o = (r * LUT_W + x) * 4;
        data[o] = c[0] * 255; data[o + 1] = c[1] * 255; data[o + 2] = c[2] * 255;
        data[o + 3] = (t < t0 ? (stops[0][2] ?? 1) * 0.6 : a0 + (a1 - a0) * f) * 255;
      }
    });
    const tex = texture(gl, { filter: gl.LINEAR });
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_W, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { tex, rows, stops: new Float32Array(32), nstops: 2, hemi: false };
  }
  const data = new Uint8Array(LUT_W * 4);
  fillRow(data, 0, cmap.stops, cmap.mode === "step");
  const tex = texture(gl, { filter: gl.LINEAR });
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_W, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const stops = new Float32Array(32);
  cmap.stops.slice(0, 32).forEach((s, i) => { stops[i] = s[0]; });
  return { tex, rows: 1, stops, nstops: Math.min(32, cmap.stops.length), hemi: !!cmap.hemi };
}

// CSS gradient for legends / product thumbnails.
export function cssGradient(cmap, cats = false) {
  if (cmap.mode === "category") {
    return cmap.categories.map((c) => c.stops[Math.floor(c.stops.length / 2)][1]);
  }
  const n = cmap.stops.length;
  const parts = cmap.stops.map((s, i) => {
    const [r, g, b] = hexToRgb(s[1]).map((v) => Math.round(v * 255));
    const a = Math.max(0.15, s[2] ?? 1);
    return `rgba(${r},${g},${b},${a}) ${((i / (n - 1)) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

// Position (0..1) of a canonical value on the legend (equal stop spacing).
export function legendPos(cmap, v) {
  const s = cmap.stops;
  if (v <= s[0][0]) return 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (v < s[i + 1][0]) return (i + (v - s[i][0]) / (s[i + 1][0] - s[i][0])) / (s.length - 1);
  }
  return 1;
}

export function colorAt(cmap, v) {
  const s = cmap.stops;
  const t = legendPos(cmap, v) * (s.length - 1);
  const i = Math.min(s.length - 2, Math.floor(t));
  const f = cmap.mode === "step" ? 0 : t - i;
  const a = toOklab(hexToRgb(s[i][1])), b = toOklab(hexToRgb(s[i + 1][1]));
  return fromOklab(a.map((x, k) => x + (b[k] - x) * f)).map((c) => Math.round(c * 255));
}
