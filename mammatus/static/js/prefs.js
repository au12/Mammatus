// Saved preferences sync across devices and outlive app versions, so every value is checked before
// the app uses it: a wrong type or an out-of-range value falls back to the default instead of
// breaking startup on every device the account signs in on. Unknown keys (from a newer version)
// pass through untouched; invalid known keys are dropped and disappear on the next save.

const UNIT_CHOICES = {
  temp: ["F", "C"], precip: ["in", "mm"], snow: ["in", "cm"], wind: ["mph", "kt", "kmh", "ms"],
  pressure: ["mb", "inHg"], dist: ["mi", "km"], height: ["ft", "m"],
};

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (max) => (v) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const bool = (v) => (typeof v === "boolean" ? v : undefined);
const oneOf = (...opts) => (v) => (opts.includes(v) ? v : undefined);

function units(v) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const [k, choices] of Object.entries(UNIT_CHOICES)) if (choices.includes(v[k])) out[k] = v[k];
  return Object.keys(out).length ? out : undefined;
}

function timeZone(v) {
  if (typeof v !== "string" || !v || v.length > 64) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return v; } catch { return undefined; }
}

function source(v) {
  if (!isObj(v)) return undefined;
  const id = str(40);
  if (v.type === "radar") return { type: "radar" };
  if (v.type === "sat" && id(v.product)) return { type: "sat", product: v.product };
  if (v.type === "model" && id(v.model) && id(v.product)) return { type: "model", model: v.model, product: v.product };
  return undefined;
}

const SCHEMA = {
  units,
  tz: timeZone,
  mode: oneOf("globe", "auto", "map"),
  opacity: (v) => (typeof v === "number" && v >= 0.2 && v <= 1 ? v : undefined),
  speed: (v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined),
  lastSource: source,
  lastProduct: str(40),
  mgHidden: (v) => (Array.isArray(v) && v.length <= 40 && v.every((x) => typeof x === "string" && x.length <= 60) ? v : undefined),
  mgRange: oneOf(2, 5, 10, 16),
  sndModel: str(60),
  parcel: oneOf("sb", "ml", "mu"),
};
for (const k of ["smooth", "lightningAnim", "lowPower", "rememberView", "alerts", "lightning", "fronts", "liveClouds",
  "particles", "cities", "counties", "realistic"]) SCHEMA[k] = bool;

export function sanitizePrefs(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const check = SCHEMA[k];
    if (!check) { out[k] = v; continue; }
    const ok = check(v);
    if (ok !== undefined) out[k] = ok;
  }
  return out;
}
