// Sounding thermodynamics and kinematics. Temperatures in °C, pressure hPa, heights m, winds m/s.

const Rd = 287.04, Cp = 1005.7, Lv = 2.501e6, G = 9.80665, EPS = 0.622, K0 = 273.15, KAPPA = Rd / Cp;

export const es = (t) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));
export const mixr = (t, p) => { const e = es(t); return (EPS * e) / Math.max(p - e, 1e-3); };
export const theta = (t, p) => (t + K0) * Math.pow(1000 / p, KAPPA);
export const tv = (t, td, p) => { const w = mixr(td, p); return (t + K0) * (1 + w / EPS) / (1 + w) - K0; };
export function thetaE(t, td, p) {
  const T = t + K0, w = mixr(td, p);
  const tl = lclTemp(t, td);
  return T * Math.pow(1000 / p, 0.2854 * (1 - 0.28 * w)) * Math.exp((3376 / tl - 2.54) * w * (1 + 0.81 * w));
}
export function lclTemp(t, td) {  // Bolton (1980), K
  const T = t + K0, D = td + K0;
  return 1 / (1 / (D - 56) + Math.log(T / D) / 800) + 56;
}
export function lcl(t, td, p) {
  const tl = lclTemp(t, td);
  return { p: p * Math.pow(tl / (t + K0), 1 / KAPPA), t: tl - K0 };
}
// Temperature at the dew point for a given mixing ratio and pressure.
export function tdFromW(w, p) { const e = (w * p) / (EPS + w); const l = Math.log(e / 6.112); return (243.5 * l) / (17.67 - l); }

// Saturated (pseudo-adiabatic) lapse rate dT/dp in K/hPa
function moistLapse(t, p) {
  const T = t + K0, w = mixr(t, p);
  const num = (Rd * T + Lv * w) / p;
  const den = Cp + (Lv * Lv * w * EPS) / (Rd * T * T);
  return num / den;
}

// Lift saturated parcel from (t,p0) to p1; RK2 in small steps.
export function moistAscent(t, p0, p1) {
  const n = Math.max(1, Math.ceil(Math.abs(p1 - p0) / 5));
  const dp = (p1 - p0) / n;
  let p = p0;
  for (let i = 0; i < n; i++) {
    const k1 = moistLapse(t, p);
    const k2 = moistLapse(t + k1 * dp, p + dp);
    t += 0.5 * (k1 + k2) * dp;
    p += dp;
  }
  return t;
}

const interp = (x, x0, x1, y0, y1) => (x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));

// Build a clean profile (surface first, pressure decreasing) from Open-Meteo sounding data at index ti.
export function buildProfile(s, ti) {
  const sfc = s.surface;
  const psfc = sfc.surface_pressure?.[ti];
  const elev = s.elevation ?? 0;
  const lv = [];
  for (const [pk, v] of Object.entries(s.levels)) {
    const p = +pk;
    const t = v.temperature?.[ti], td = v.dew_point?.[ti] ?? (v.relative_humidity?.[ti] != null && t != null ? tdFromRh(t, v.relative_humidity[ti]) : null);
    const z = v.geopotential_height?.[ti];
    if (t == null || z == null) continue;
    if (psfc != null && p > psfc - 1) continue;
    lv.push({ p, t, td: td == null ? null : Math.min(td, t), z, ws: v.wind_speed?.[ti] ?? null, wd: v.wind_direction?.[ti] ?? null });
  }
  lv.sort((a, b) => b.p - a.p);
  const t2 = sfc.temperature_2m?.[ti], td2 = sfc.dew_point_2m?.[ti];
  const prof = [];
  if (psfc != null && t2 != null && td2 != null) prof.push({ p: psfc, t: t2, td: Math.min(td2, t2), z: elev, ws: sfc.wind_speed_10m?.[ti] ?? null, wd: sfc.wind_direction_10m?.[ti] ?? null, sfc: true });
  for (const l of lv) if (!prof.length || l.p < prof[prof.length - 1].p - 0.5) prof.push(l);
  for (const l of prof) {
    if (l.ws != null && l.wd != null) { const r = (l.wd * Math.PI) / 180; l.u = -l.ws * Math.sin(r); l.v = -l.ws * Math.cos(r); }
    l.agl = l.z - (prof[0]?.z ?? elev);
  }
  return prof;
}
function tdFromRh(t, rh) { const e = es(t) * Math.max(rh, 1) / 100; const l = Math.log(e / 6.112); return (243.5 * l) / (17.67 - l); }

const at = (prof, p, key) => {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (p <= a.p && p >= b.p && a[key] != null && b[key] != null) return interp(Math.log(p), Math.log(a.p), Math.log(b.p), a[key], b[key]);
  }
  return null;
};
const atHeight = (prof, h, key) => {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (h >= a.agl && h <= b.agl && a[key] != null && b[key] != null) return interp(h, a.agl, b.agl, a[key], b[key]);
  }
  return null;
};

// Parcel trace: list of {p, t (parcel temp), tv (parcel virtual)} from the start pressure upward.
export function parcelTrace(prof, start) {
  const { t, td, p } = start;
  const L = lcl(t, td, p);
  const w = mixr(td, p);
  const th = theta(t, p);
  const pts = [];
  const top = prof[prof.length - 1].p;
  const plist = [p];
  for (let pp = Math.floor(p / 10) * 10; pp > top; pp -= 10) if (pp < p) plist.push(pp);
  plist.push(top);
  let tm = null, pm = null;
  for (const pp of plist) {
    let tp, tvp;
    if (pp >= L.p) {
      tp = th * Math.pow(pp / 1000, KAPPA) - K0;
      tvp = (tp + K0) * (1 + w / EPS) / (1 + w) - K0;
    } else {
      if (tm == null) { tm = moistAscent(L.t, L.p, pp); pm = pp; } else { tm = moistAscent(tm, pm, pp); pm = pp; }
      tp = tm;
      const ws = mixr(tp, pp);
      tvp = (tp + K0) * (1 + ws / EPS) / (1 + ws) - K0;
    }
    pts.push({ p: pp, t: tp, tv: tvp });
  }
  return { pts, lcl: L };
}

export function cape(prof, trace) {
  let capeV = 0, cin = 0, lfc = null, el = null;
  let posLayers = [];
  const pts = trace.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ta = at(prof, a.p, "t"), tda = at(prof, a.p, "td"), tb = at(prof, b.p, "t"), tdb = at(prof, b.p, "td");
    if (ta == null || tb == null) continue;
    const tva = tv(ta, tda ?? ta - 30, a.p), tvb = tv(tb, tdb ?? tb - 30, b.p);
    const ba = (a.tv - tva), bb = (b.tv - tvb);
    const dlnp = Math.log(a.p / b.p);
    const area = Rd * 0.5 * (ba + bb) * dlnp;
    if (area > 0) {
      if (lfc == null && b.p < trace.lcl.p + 1) lfc = ba <= 0 ? interp(0, ba, bb, a.p, b.p) : a.p;
      capeV += area;
      el = bb < 0 ? interp(0, ba, bb, a.p, b.p) : b.p;
    } else if (lfc == null) cin += area;
  }
  if (capeV < 1) { lfc = null; el = null; }
  return { cape: capeV, cin: lfc == null ? 0 : cin, lfc, el };
}

export function analyze(prof) {
  if (prof.length < 5) return null;
  const s = prof[0];
  const out = { profile: prof };
  // surface-based
  const sb = parcelTrace(prof, s);
  Object.assign(out, { sb: { ...cape(prof, sb), trace: sb, lcl: sb.lcl } });
  // mixed-layer (lowest 100 hPa)
  const ml = layerMean(prof, s.p, s.p - 100);
  if (ml) { const tr = parcelTrace(prof, ml); out.ml = { ...cape(prof, tr), trace: tr, lcl: tr.lcl }; }
  // most-unstable (max theta-e in lowest 300 hPa)
  let best = s, bte = -Infinity;
  for (const l of prof) { if (l.p < s.p - 300) break; if (l.td == null) continue; const te = thetaE(l.t, l.td, l.p); if (te > bte) { bte = te; best = l; } }
  const mu = parcelTrace(prof, best);
  out.mu = { ...cape(prof, mu), trace: mu, lcl: mu.lcl, p0: best.p };
  // lifted index (surface-based parcel)
  const t500 = at(prof, 500, "t");
  const p500 = sb.pts.find((x) => x.p <= 500);
  out.li = t500 != null && p500 ? t500 - p500.t : null;
  // precipitable water
  let pw = 0;
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (a.td == null || b.td == null || b.p < 300) continue;
    const qa = mixr(a.td, a.p), qb = mixr(b.td, b.p);
    pw += ((qa + qb) / 2) * (a.p - b.p) * 100 / G;
  }
  out.pwat = pw; // mm
  // lapse rate 700-500
  const z7 = at(prof, 700, "z"), z5 = at(prof, 500, "z"), t7 = at(prof, 700, "t");
  out.lapse75 = z7 != null && z5 != null && t7 != null && t500 != null ? ((t7 - t500) / (z5 - z7)) * 1000 : null;
  // freezing level (highest crossing of 0 °C above ground)
  out.frz = null;
  for (let i = prof.length - 2; i >= 0; i--) {
    const a = prof[i], b = prof[i + 1];
    if ((a.t >= 0 && b.t < 0) || (a.t > 0 && b.t <= 0)) { out.frz = interp(0, a.t, b.t, a.agl, b.agl); break; }
  }
  if (out.frz == null && s.t <= 0) out.frz = 0;
  // kinematics
  const wind = (hgt) => { const u = atHeight(prof, hgt, "u"), v = atHeight(prof, hgt, "v"); return u == null || v == null ? null : { u, v }; };
  const sfcW = prof[0].u != null ? { u: prof[0].u, v: prof[0].v } : wind(10);
  const shear = (h1) => { const a = sfcW, b = wind(h1); return a && b ? Math.hypot(b.u - a.u, b.v - a.v) : null; };
  out.shear01 = shear(1000); out.shear06 = shear(6000);
  // Bunkers right-moving storm motion
  const mean = (h0, h1) => {
    let su = 0, sv = 0, n = 0;
    for (let hh = h0; hh <= h1; hh += 250) { const w = hh === 0 ? sfcW : wind(hh); if (w) { su += w.u; sv += w.v; n++; } }
    return n ? { u: su / n, v: sv / n } : null;
  };
  const m06 = mean(0, 6000), lo = mean(0, 500), hi = mean(5500, 6000);
  if (m06 && lo && hi) {
    const su = hi.u - lo.u, sv = hi.v - lo.v, mag = Math.hypot(su, sv) || 1;
    out.storm = { u: m06.u + (7.5 * sv) / mag, v: m06.v - (7.5 * su) / mag };
    out.stormL = { u: m06.u - (7.5 * sv) / mag, v: m06.v + (7.5 * su) / mag };
    out.mean06 = m06;
    const srh = (top) => {
      const c = out.storm;
      let tot = 0, prev = sfcW;
      for (let hh = 100; hh <= top; hh += 100) {
        const w = wind(hh);
        if (!w || !prev) { prev = w; continue; }
        tot += (w.u - c.u) * (prev.v - c.v) - (prev.u - c.u) * (w.v - c.v);
        prev = w;
      }
      return tot;
    };
    out.srh01 = srh(1000); out.srh03 = srh(3000);
  }
  // Significant tornado / supercell composites (simple, effective-layer-free)
  if (out.ml && out.shear06 != null && out.srh01 != null) {
    const lclH = heightAtP(prof, out.ml.lcl.p);
    const lclTerm = lclH == null ? 0 : lclH < 1000 ? 1 : lclH > 2000 ? 0 : (2000 - lclH) / 1000;
    const shr = out.shear06 < 12.5 ? 0 : Math.min(out.shear06, 30) / 20;
    const cinTerm = out.ml.cin > -50 ? 1 : out.ml.cin < -200 ? 0 : (200 + out.ml.cin) / 150;
    out.stp = (out.ml.cape / 1500) * lclTerm * (out.srh01 / 150) * shr * cinTerm;
    out.scp = (out.mu.cape / 1000) * ((out.srh03 ?? 0) / 50) * (out.shear06 < 10 ? 0 : Math.min(out.shear06, 20) / 20);
  }
  out.at = (p, k) => at(prof, p, k);
  return out;
}

export function heightAtP(prof, p) { return at(prof, p, "agl"); }

function layerMean(prof, ptop0, pbot) {
  let sth = 0, sw = 0, n = 0;
  for (let p = ptop0; p >= pbot; p -= 5) {
    const t = at(prof, p, "t"), td = at(prof, p, "td");
    if (t == null || td == null) continue;
    sth += theta(t, p); sw += mixr(td, p); n++;
  }
  if (!n) return null;
  const th = sth / n, w = sw / n, p = prof[0].p;
  const t = th * Math.pow(p / 1000, KAPPA) - K0;
  return { p, t, td: Math.min(t, tdFromW(w, p)) };
}

export { KAPPA, K0 };
