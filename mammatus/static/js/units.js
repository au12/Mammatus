// Unit conversion and formatting. Values arrive in canonical units from the server.

export const DEFAULT_UNITS = { temp: "F", precip: "in", snow: "in", wind: "mph", pressure: "mb", dist: "mi", height: "ft" };

let U = { ...DEFAULT_UNITS };
export function setUnits(u) { U = { ...DEFAULT_UNITS, ...(u || {}) }; }
export function units() { return U; }

const conv = {
  temp: (k) => (U.temp === "C" ? k - 273.15 : (k - 273.15) * 9 / 5 + 32),
  precip: (mm) => (U.precip === "mm" ? mm : mm / 25.4),
  snow: (mm) => (U.snow === "cm" ? mm / 10 : mm / 25.4),
  wind: (ms) => ({ mph: ms * 2.23694, kt: ms * 1.943844, kmh: ms * 3.6, ms }[U.wind] ?? ms * 2.23694),
  pressure: (hpa) => (U.pressure === "inHg" ? hpa * 0.02953 : hpa),
  vis: (m) => (U.dist === "km" ? m / 1000 : m / 1609.34),
  height: (m) => (U.height === "m" ? m : m * 3.28084),
  pwat: (mm) => (U.precip === "mm" ? mm : mm / 25.4),
  rate: (mmh) => (U.precip === "mm" ? mmh : mmh / 25.4),
  thick: (m) => m / 10,
  pct: (x) => x, refl: (x) => x, cape: (x) => x, srh: (x) => x, vort: (x) => x, code: (x) => x,
};
const inverse = {
  temp: (v) => (U.temp === "C" ? v + 273.15 : (v - 32) * 5 / 9 + 273.15),
  precip: (v) => (U.precip === "mm" ? v : v * 25.4),
  snow: (v) => (U.snow === "cm" ? v * 10 : v * 25.4),
  wind: (v) => ({ mph: v / 2.23694, kt: v / 1.943844, kmh: v / 3.6, ms: v }[U.wind] ?? v / 2.23694),
  vis: (v) => (U.dist === "km" ? v * 1000 : v * 1609.34),
  pwat: (v) => (U.precip === "mm" ? v : v * 25.4),
  rate: (v) => (U.precip === "mm" ? v : v * 25.4),
  thick: (v) => v * 10,
};

export function label(kind) {
  return {
    temp: `°${U.temp}`, precip: U.precip, snow: U.snow === "cm" ? "cm" : "in", wind: { mph: "mph", kt: "kt", kmh: "km/h", ms: "m/s" }[U.wind],
    pressure: U.pressure, vis: U.dist, height: U.height, pwat: U.precip, rate: `${U.precip}/h`, thick: "dam",
    pct: "%", refl: "dBZ", cape: "J/kg", srh: "m²/s²", vort: "×10⁻⁵ s⁻¹", code: "",
  }[kind] ?? "";
}

export function toDisplay(kind, v) { return (conv[kind] || ((x) => x))(v); }

// For ticks defined in the reference display unit of a colormap (°F, in, mph, kt...)
export function tickToCanonical(kind, v, ref) {
  // ref = the unit the server's tick list is written in
  const refConv = {
    temp: ref === "C" ? (x) => x + 273.15 : (x) => (x - 32) * 5 / 9 + 273.15,
    precip: (x) => x * 25.4, snow: (x) => x * 25.4, pwat: (x) => x * 25.4,
    vis: (x) => x * 1609.34,
  }[kind];
  return refConv ? refConv(v) : v;
}

export function fmt(kind, v, opts = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const d = toDisplay(kind, v);
  let digits = opts.digits;
  if (digits == null) {
    if (kind === "precip" || kind === "pwat" || kind === "rate") digits = U.precip === "mm" ? 1 : 2;
    else if (kind === "snow") digits = 1;
    else if (kind === "pressure") digits = U.pressure === "inHg" ? 2 : 0;
    else if (kind === "vis") digits = d < 3 ? 1 : 0;
    else if (kind === "vort") digits = 1;
    else digits = 0;
  }
  const s = d.toFixed(digits);
  return opts.unit === false ? s : `${s}${kind === "temp" ? "°" : " " + label(kind)}`;
}

export function toCanonical(kind, v) { return (inverse[kind] || ((x) => x))(v); }

export function compass(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
