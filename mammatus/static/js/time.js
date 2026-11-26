// Time formatting in the user's chosen time zone.

let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
const cache = new Map();

export function setTimeZone(tz) {
  if (!tz) return;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); TZ = tz; cache.clear(); } catch { /* keep current */ }
}
export const timeZone = () => TZ;

function f(opts) {
  const key = JSON.stringify(opts);
  let fmt = cache.get(key);
  if (!fmt) { fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }); cache.set(key, fmt); }
  return fmt;
}

const parts = (d, opts) => Object.fromEntries(f(opts).formatToParts(d).map((p) => [p.type, p.value]));

export function when(d) {
  const p = parts(d, { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });
  const min = p.minute === "00" ? "" : `:${p.minute}`;
  return `${p.weekday} ${p.hour}${min} ${p.dayPeriod}`;
}
export function hourLabel(d) {
  const p = parts(d, { hour: "numeric", hour12: true });
  return `${p.hour}${p.dayPeriod === "AM" ? "a" : "p"}`;
}
export const dayLabel = (d) => f({ weekday: "short", month: "short", day: "numeric" }).format(d);
export const weekday = (d) => f({ weekday: "short" }).format(d);
export const dayKey = (d) => f({ year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const clock = (d) => f({ hour: "numeric", minute: "2-digit", hour12: true }).format(d);
export const full = (d) => f({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
export const tzAbbr = (d = new Date()) => parts(d, { timeZoneName: "short" }).timeZoneName || "";
export const localHour = (d) => +parts(d, { hour: "numeric", hourCycle: "h23" }).hour;

export function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function rel(d) {
  const h = (d.getTime() - Date.now()) / 3600000;
  if (Math.abs(h) < 0.5) return "now";
  const v = Math.round(Math.abs(h));
  if (v < 48) return h > 0 ? `in ${v} h` : `${v} h ago`;
  const days = Math.round(Math.abs(h) / 24);
  return h > 0 ? `in ${days} d` : `${days} d ago`;
}

export const runLabel = (run) => `${run.slice(8, 10)}z ${+run.slice(6, 8)} ${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+run.slice(4, 6)]}`;
export const runDate = (run) => new Date(Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8), +run.slice(8, 10)));

// Solar elevation (degrees) for night shading in charts.
export function solarElevation(date, lat, lon) {
  const d = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * d;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * d;
  const eps = (23.439 - 0.0000004 * n) * d;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = ((280.46061837 + 360.98564736629 * n) % 360) * d;
  const ha = gmst + lon * d - ra;
  return Math.asin(Math.sin(lat * d) * Math.sin(dec) + Math.cos(lat * d) * Math.cos(dec) * Math.cos(ha)) / d;
}
