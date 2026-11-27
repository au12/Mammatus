// Sun and moon for a place and time: direction in the local sky, moon phase, atmospheric colour.
// Low-precision formulas (Astronomical Almanac / Meeus): about 0.01 deg for the sun, 0.3 deg for the moon.

const D = Math.PI / 180;
const wrap360 = (a) => ((a % 360) + 360) % 360;

function daysJ2000(date) { return date.getTime() / 86400000 + 2440587.5 - 2451545.0; }

function gmstDeg(d) { return wrap360(280.46061837 + 360.98564736629 * d); }

// right ascension / declination (deg) -> local azimuth (deg from north, clockwise) and elevation (deg)
function toHorizontal(ra, dec, lat, lon, d) {
  const H = (gmstDeg(d) + lon - ra) * D;
  const phi = lat * D, de = dec * D;
  const sinEl = Math.sin(phi) * Math.sin(de) + Math.cos(phi) * Math.cos(de) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(H) * Math.cos(de), Math.cos(phi) * Math.sin(de) - Math.sin(phi) * Math.cos(de) * Math.cos(H));
  return { az: wrap360(az / D), el: el / D };
}

function eclToEq(lam, beta, d) {
  const eps = (23.439 - 0.0000004 * d) * D;
  const l = lam * D, b = beta * D;
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l));
  return { ra: wrap360(ra / D), dec: dec / D };
}

function sunEcliptic(d) {
  const L = wrap360(280.460 + 0.9856474 * d);
  const g = wrap360(357.528 + 0.9856003 * d) * D;
  return { lam: wrap360(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), dist: 1.00014 - 0.01671 * Math.cos(g) };
}

export function sun(date, lat, lon) {
  const d = daysJ2000(date);
  const { lam } = sunEcliptic(d);
  const { ra, dec } = eclToEq(lam, 0, d);
  const h = toHorizontal(ra, dec, lat, lon, d);
  // refraction lifts the sun near the horizon (Saemundsson)
  const r = h.el > -1.5 ? 1.02 / Math.tan((h.el + 10.3 / (h.el + 5.11)) * D) / 60 : 0;
  return { az: h.az, el: h.el + r, lam };
}

export function moon(date, lat, lon) {
  const d = daysJ2000(date);
  const L = wrap360(218.316 + 13.176396 * d);
  const M = wrap360(134.963 + 13.064993 * d) * D;
  const F = wrap360(93.272 + 13.229350 * d) * D;
  const Ms = wrap360(357.529 + 0.98560028 * d) * D;
  const Dm = wrap360(297.850 + 12.190749 * d) * D;
  const lam = L + 6.289 * Math.sin(M) + 1.274 * Math.sin(2 * Dm - M) + 0.658 * Math.sin(2 * Dm) - 0.186 * Math.sin(Ms) + 0.214 * Math.sin(2 * M);
  const beta = 5.128 * Math.sin(F);
  const dist = 385001 - 20905 * Math.cos(M);
  const { ra, dec } = eclToEq(lam, beta, d);
  const h = toHorizontal(ra, dec, lat, lon, d);
  // topocentric parallax (about a degree at the horizon)
  const par = Math.asin(6378.14 / dist) / D;
  const el = h.el - par * Math.cos(h.el * D);
  const s = sunEcliptic(d);
  const cpsi = Math.cos(beta * D) * Math.cos((lam - s.lam) * D);
  const illum = (1 - cpsi) / 2;
  const waxing = wrap360(lam - s.lam) < 180;
  return { az: h.az, el, illum, waxing, dist };
}

// unit vector in the scene frame (x east, y north, z up)
export function dirOf(az, el) {
  const a = az * D, e = el * D;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

// Colour of sunlight after the atmosphere, for a sun at elevation el (deg) seen from altitude zKm.
// Rayleigh + aerosol + ozone optical depths along an air-mass path (Kasten & Young), normalized to noon.
const BETA_R = [5.8e-3, 13.5e-3, 33.1e-3];   // per km at sea level, 680/550/440 nm
const BETA_M = 3.6e-3;
const BETA_O = [0.65e-3, 1.881e-3, 0.085e-3];
export function sunlight(el, zKm = 0) {
  const e = Math.max(el, -2.5);
  const am = 1 / (Math.sin(Math.max(e, -1.0) * D + 1e-4) + 0.50572 * Math.pow(Math.max(e + 6.07995, 0.1), -1.6364));
  const hr = 8.0 * Math.exp(-zKm / 8.0), hm = 1.2 * Math.exp(-zKm / 1.2);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const tau = (BETA_R[i] * hr + BETA_M * hm * 1.1 + BETA_O[i] * 6.5) * Math.min(am, 40);
    out[i] = Math.exp(-tau);
  }
  // the sun dips below the local horizon: fade over its own disc, a little lower from altitude
  const dip = Math.sqrt(2 * Math.max(zKm, 0) / 6371) / D;
  const vis = smooth(-0.6 - dip, 0.4 - dip, el);
  return out.map((x) => x * vis);
}

export function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// A single "how bright is it" number from the sun and moon, used for exposure and for the night look.
export function daylight(sunEl) { return smooth(-12, 6, sunEl); }
