// Skew-T log-p diagram, hodograph and indices for a model sounding.
import { h, clamp } from "../util.js";
import { buildProfile, analyze, theta, mixr, moistAscent, tdFromW, KAPPA, K0 } from "../thermo.js";
import { toDisplay, toCanonical, fmt, label, units } from "../units.js";
import { when } from "../time.js";

const PB = 1050, PT = 100;
const COL = { t: "#ff6b6b", td: "#4ade80", parcel: "#f4f6fb", cape: "rgba(255,107,107,.18)", cin: "rgba(96,165,250,.16)", wb: "#67e8f9" };
const HODO_COL = [[1000, "#ff6b8b"], [3000, "#4ade80"], [6000, "#fde047"], [9000, "#67e8f9"], [13000, "#c4b5fd"]];

export class Sounding {
  constructor(app, container) {
    this.app = app;
    this.el = container;
    this.parcel = app.prefs.parcel || "ml";
    this.ro = new ResizeObserver(() => { if (this.data && this.el.clientWidth !== this.w) this.draw(); });
    this.ro.observe(this.el);
  }

  destroy() { this.ro.disconnect(); }

  set(data, targetTime) {
    this.data = data;
    const times = data.time.map((t) => t * 1000);
    let best = 0, bd = Infinity;
    times.forEach((t, i) => { const d = Math.abs(t - targetTime); if (d < bd) { bd = d; best = i; } });
    this.ti = best;
    this.draw();
  }

  draw() {
    const d = this.data;
    this.w = this.el.clientWidth || 440;
    const prof = buildProfile(d, this.ti);
    const A = analyze(prof);
    this.el.replaceChildren();
    // time scrubber
    const times = d.time.map((t) => t * 1000);
    const slider = h("input", { type: "range", min: 0, max: times.length - 1, value: this.ti, step: 1, style: { width: "100%", accentColor: "#c3a8ff" }, "aria-label": "Sounding time" });
    const tl = h("b", { class: "num" }, when(new Date(times[this.ti])));
    slider.addEventListener("input", () => { this.ti = +slider.value; tl.textContent = when(new Date(times[this.ti])); this.redrawSoon(); });
    const pseg = h("div", { class: "seg" }, ...[["sb", "Surface"], ["ml", "Mixed"], ["mu", "Most unst."]].map(([k, l]) =>
      h("button", { class: this.parcel === k ? "sel" : "", onclick: () => { this.parcel = k; this.app.savePref("parcel", k); this.draw(); } }, l)));
    this.el.append(h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } }, tl, pseg), slider);
    if (!A) { this.el.append(h("div", { class: "empty" }, "This model has no upper-air data here at this time.")); return; }
    const wrap = h("div", { class: "skewt-wrap" });
    wrap.innerHTML = this.skewT(A);
    this.el.append(wrap);
    // indices
    const par = A[this.parcel] || A.sb;
    const z = (m) => (m == null ? "—" : units().height === "m" ? `${Math.round(m)} m` : `${Math.round(m * 3.28084).toLocaleString()} ft`);
    const kt = (ms) => (ms == null ? "—" : fmt("wind", ms));
    const lclZ = par.lcl ? heightFromP(prof, par.lcl.p) : null;
    const cells = [
      ["CAPE", `${Math.round(par.cape)}`, "J/kg", capeColor(par.cape)],
      ["CIN", `${Math.round(par.cin)}`, "J/kg"],
      ["LCL", z(lclZ)],
      ["LI", A.li == null ? "—" : A.li.toFixed(1), "°C", A.li != null && A.li < -6 ? "#ff8f70" : null],
      ["PWAT", fmt("pwat", A.pwat)],
      ["Frz level", z(A.frz)],
      ["0–1 km shear", kt(A.shear01)],
      ["0–6 km shear", kt(A.shear06), "", A.shear06 > 20 ? "#ffc65c" : null],
      ["700–500 lapse", A.lapse75 == null ? "—" : `${A.lapse75.toFixed(1)}`, "°C/km", A.lapse75 > 7.5 ? "#ff8f70" : null],
      ["0–1 km SRH", A.srh01 == null ? "—" : `${Math.round(A.srh01)}`, "m²/s²", A.srh01 > 150 ? "#ff8f70" : null],
      ["0–3 km SRH", A.srh03 == null ? "—" : `${Math.round(A.srh03)}`, "m²/s²"],
      ["STP / SCP", A.stp == null ? "—" : `${A.stp.toFixed(1)} / ${A.scp.toFixed(1)}`, "", A.stp > 1 ? "#ff6b8b" : null],
    ];
    const grid = h("div", { class: "indices" });
    for (const [k, v, u, color] of cells) grid.append(h("div", {}, h("small", {}, k), h("b", { class: "num", style: color ? { color } : null }, v, u ? h("span", { style: { fontSize: "11px", color: "var(--text-3)", fontWeight: 500 } }, ` ${u}`) : null)));
    const hodo = h("div", { style: { display: "grid", gridTemplateColumns: this.w > 520 ? "1fr 1fr" : "1fr", gap: "10px", marginTop: "12px", alignItems: "start" } });
    const hsvg = h("div", { class: "chart", style: { margin: 0 } }, h("h5", {}, h("span", {}, "Hodograph"), h("span", {}, label("wind"))));
    hsvg.insertAdjacentHTML("beforeend", this.hodograph(A, Math.min(this.w > 520 ? this.w / 2 - 5 : this.w, 320)));
    hodo.append(hsvg);
    this.el.append(grid, hodo,
      h("p", { class: "note", style: { marginTop: "10px" } }, `Model ${d.model.replace(/_/g, " ").toUpperCase()} via Open-Meteo, ${prof.length} levels. Parcel uses the virtual-temperature correction; storm motion is Bunkers right-mover.`));
  }

  redrawSoon() { cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame(() => this.draw()); }

  skewT(A) {
    const W = this.w, H = Math.round(clamp(W * 1.08, 340, 560));
    const L = 36, R = 36, T = 6, B = 18;
    const pw = W - L - R, ph = H - T - B;
    const lnB = Math.log(PB), lnT = Math.log(PT);
    const y = (p) => T + ((Math.log(p) - lnT) / (lnB - lnT)) * ph;
    const tmin = -40, tmax = 50, skew = 0.95;
    const x = (t, p) => L + ((t - tmin) / (tmax - tmin)) * pw + (ph - (y(p) - T)) * skew;
    const pathOf = (pts) => pts.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join("");
    let s = `<defs><clipPath id="skclip"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath></defs>`;
    s += `<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="rgba(0,0,0,.18)" rx="6"/>`;
    s += `<g clip-path="url(#skclip)">`;
    // isotherms
    for (let t = -100; t <= 50; t += 10) s += `<line x1="${x(t, PB)}" y1="${y(PB)}" x2="${x(t, PT)}" y2="${y(PT)}" stroke="${t === 0 ? "rgba(127,178,255,.5)" : "rgba(255,255,255,.07)"}" stroke-width="${t === 0 ? 1.2 : 1}"/>`;
    // dry adiabats
    for (let th = -30; th <= 170; th += 10) {
      const pts = [];
      for (let p = PB; p >= PT; p -= 25) pts.push([x((th + K0) * Math.pow(p / 1000, KAPPA) - K0, p), y(p)]);
      s += `<path d="${pathOf(pts)}" fill="none" stroke="rgba(255,179,138,.13)"/>`;
    }
    // moist adiabats
    for (let t0 = -10; t0 <= 32; t0 += 6) {
      const pts = [];
      let t = t0, pp = 1000;
      pts.push([x(t, 1000), y(1000)]);
      for (let p = 1000; p >= 200; p -= 25) { t = moistAscent(t, pp, p); pp = p; pts.push([x(t, p), y(p)]); }
      s += `<path d="${pathOf(pts)}" fill="none" stroke="rgba(94,224,160,.12)" stroke-dasharray="3 3"/>`;
    }
    // mixing ratio
    for (const w of [2, 4, 8, 12, 16, 20]) {
      const pts = [];
      for (let p = PB; p >= 600; p -= 50) pts.push([x(tdFromW(w / 1000, p), p), y(p)]);
      s += `<path d="${pathOf(pts)}" fill="none" stroke="rgba(195,168,255,.12)" stroke-dasharray="1 3"/>`;
    }
    // pressure lines
    for (const p of [1000, 850, 700, 500, 400, 300, 250, 200, 150, 100]) s += `<line x1="${L}" x2="${L + pw}" y1="${y(p)}" y2="${y(p)}" stroke="rgba(255,255,255,.08)"/>`;
    const prof = A.profile;
    const par = A[this.parcel] || A.sb;
    // CAPE / CIN shading between parcel and environment
    if (par?.trace) {
      const pts = par.trace.pts;
      const envAt = (p) => A.at(p, "t");
      let pos = [], neg = [];
      const flush = (arr, fill) => {
        if (arr.length < 2) return "";
        const up = arr.map((q) => [x(q.tp, q.p), y(q.p)]), dn = arr.slice().reverse().map((q) => [x(q.te, q.p), y(q.p)]);
        return `<path d="${pathOf(up.concat(dn))}Z" fill="${fill}"/>`;
      };
      for (const q of pts) {
        const te = envAt(q.p);
        if (te == null) continue;
        const o = { p: q.p, tp: q.t, te };
        if (q.t > te && (par.lfc == null || q.p <= par.lfc + 1) && (par.el == null || q.p >= par.el - 1) && par.cape > 10) { pos.push(o); if (neg.length) { s += flush(neg, COL.cin); neg = []; } }
        else if (q.t <= te && par.lfc != null && q.p > par.lfc) { neg.push(o); }
        else { if (pos.length) { s += flush(pos, COL.cape); pos = []; } if (neg.length) { s += flush(neg, COL.cin); neg = []; } }
      }
      s += flush(pos, COL.cape) + flush(neg, COL.cin);
      s += `<path d="${pathOf(pts.map((q) => [x(q.t, q.p), y(q.p)]))}" fill="none" stroke="${COL.parcel}" stroke-opacity=".7" stroke-width="1.3" stroke-dasharray="5 4"/>`;
    }
    // environment
    const tPath = pathOf(prof.map((l) => [x(l.t, l.p), y(l.p)]));
    const dPath = pathOf(prof.filter((l) => l.td != null).map((l) => [x(l.td, l.p), y(l.p)]));
    s += `<path d="${dPath}" fill="none" stroke="${COL.td}" stroke-width="2.4" stroke-linejoin="round"/>`;
    s += `<path d="${tPath}" fill="none" stroke="${COL.t}" stroke-width="2.4" stroke-linejoin="round"/>`;
    s += `</g>`;
    // level markers
    const mark = (p, text, color) => { if (p == null || p < PT || p > PB) return ""; return `<line x1="${L + pw - 34}" x2="${L + pw - 4}" y1="${y(p)}" y2="${y(p)}" stroke="${color}" stroke-width="1.5"/><text x="${L + pw - 38}" y="${y(p) + 3}" text-anchor="end" font-size="10" fill="${color}" font-weight="600">${text}</text>`; };
    s += mark(par?.lcl?.p, "LCL", "#9ee6b8") + mark(par?.lfc, "LFC", "#ffc65c") + mark(par?.el, "EL", "#c4b5fd");
    // axes
    for (const p of [1000, 850, 700, 500, 300, 200, 100]) s += `<text class="axis" x="${L - 4}" y="${y(p) + 3}" text-anchor="end">${p}</text>`;
    for (let t = -30; t <= 40; t += 10) { const xx = x(t, PB); if (xx > L && xx < L + pw) s += `<text class="axis" x="${xx}" y="${H - 4}" text-anchor="middle">${units().temp === "F" ? Math.round(t * 9 / 5 + 32) : t}°</text>`; }
    // wind barbs (knots) on the right
    const bx = L + pw + 18;
    let lastY = -99;
    for (const l of prof) {
      if (l.u == null || l.p < PT) continue;
      const yy = y(l.p);
      if (yy - lastY < 16 && lastY > 0 && Math.abs(yy - lastY) < 16) continue;
      lastY = yy;
      s += barb(bx, yy, l.ws * 1.943844, l.wd);
    }
    // surface values
    const sfc = prof[0];
    s += `<text x="${x(sfc.t, sfc.p) + 4}" y="${y(sfc.p) - 4}" font-size="11" font-weight="700" fill="${COL.t}">${Math.round(toDisplay("temp", sfc.t + K0))}</text>`;
    if (sfc.td != null) s += `<text x="${x(sfc.td, sfc.p) - 4}" y="${y(sfc.p) - 4}" font-size="11" font-weight="700" fill="${COL.td}" text-anchor="end">${Math.round(toDisplay("temp", sfc.td + K0))}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Skew-T diagram">${s}</svg>`;
  }

  hodograph(A, size) {
    const prof = A.profile.filter((l) => l.u != null && l.agl <= 12000);
    const maxW = Math.max(15, ...prof.map((l) => Math.hypot(l.u, l.v)), A.storm ? Math.hypot(A.storm.u, A.storm.v) : 0);
    const maxD = toDisplay("wind", maxW);
    const stepD = maxD > 120 ? 40 : maxD > 60 ? 20 : 10;
    const nRings = Math.ceil(maxD / stepD);
    const R = size / 2 - 8, c = size / 2;
    const k = R / toCanonical("wind", nRings * stepD);
    const X = (u) => c + u * k, Y = (v) => c - v * k;
    let s = "";
    for (let i = 1; i <= nRings; i++) {
      const r = toCanonical("wind", i * stepD) * k;
      s += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,.08)"/>`;
      s += `<text class="axis" x="${c + r * 0.707 + 2}" y="${c - r * 0.707 - 2}">${i * stepD}</text>`;
    }
    s += `<line x1="${c - R}" x2="${c + R}" y1="${c}" y2="${c}" stroke="rgba(255,255,255,.1)"/><line y1="${c - R}" y2="${c + R}" x1="${c}" x2="${c}" stroke="rgba(255,255,255,.1)"/>`;
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      const col = (HODO_COL.find(([hh]) => a.agl < hh) || HODO_COL[HODO_COL.length - 1])[1];
      s += `<line x1="${X(a.u)}" y1="${Y(a.v)}" x2="${X(b.u)}" y2="${Y(b.v)}" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/>`;
    }
    for (const [hh, , lab] of [[1000, 0, "1"], [3000, 0, "3"], [6000, 0, "6"], [9000, 0, "9"]]) {
      const p = interpAgl(prof, hh);
      if (p) s += `<circle cx="${X(p.u)}" cy="${Y(p.v)}" r="2.5" fill="#fff"/><text x="${X(p.u) + 5}" y="${Y(p.v) - 4}" font-size="9.5" fill="var(--text-2)">${lab}</text>`;
    }
    if (A.storm) {
      s += `<circle cx="${X(A.storm.u)}" cy="${Y(A.storm.v)}" r="5" fill="none" stroke="#ff6b8b" stroke-width="2"/><text x="${X(A.storm.u) + 7}" y="${Y(A.storm.v) + 4}" font-size="10" fill="#ff8fa6" font-weight="700">RM</text>`;
      s += `<circle cx="${X(A.stormL.u)}" cy="${Y(A.stormL.v)}" r="4" fill="none" stroke="#7fb2ff" stroke-width="1.6"/><text x="${X(A.stormL.u) + 6}" y="${Y(A.stormL.v) + 4}" font-size="10" fill="#9fc4ff">LM</text>`;
      s += `<rect x="${X(A.mean06.u) - 3}" y="${Y(A.mean06.v) - 3}" width="6" height="6" fill="#fde047" transform="rotate(45 ${X(A.mean06.u)} ${Y(A.mean06.v)})"/>`;
    }
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Hodograph" style="max-width:100%">${s}</svg>`;
  }
}

function interpAgl(prof, hh) {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (hh >= a.agl && hh <= b.agl) { const f = (hh - a.agl) / (b.agl - a.agl || 1); return { u: a.u + (b.u - a.u) * f, v: a.v + (b.v - a.v) * f }; }
  }
  return null;
}
function heightFromP(prof, p) {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    if (p <= a.p && p >= b.p) { const f = Math.log(a.p / p) / Math.log(a.p / b.p); return a.agl + (b.agl - a.agl) * f; }
  }
  return null;
}
function capeColor(c) { return c > 3000 ? "#ff6b8b" : c > 1500 ? "#ff8f70" : c > 500 ? "#ffc65c" : null; }

// Standard wind barb (knots), pointing into the direction the wind comes from.
function barb(x, y, kt, dir) {
  if (kt == null || dir == null) return "";
  if (kt < 2.5) return `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${COL.wb}" stroke-width="1.2"/>`;
  let n = Math.round(kt / 5) * 5;
  const len = 22;
  let parts = `<line x1="0" y1="0" x2="0" y2="${-len}"/>`;
  let pos = -len;
  while (n >= 50) { parts += `<path d="M0 ${pos} L9 ${pos + 3} L0 ${pos + 6}Z" fill="${COL.wb}"/>`; pos += 7; n -= 50; }
  while (n >= 10) { parts += `<line x1="0" y1="${pos}" x2="9" y2="${pos - 4}"/>`; pos += 4; n -= 10; }
  if (n >= 5) { if (pos === -len) pos += 4; parts += `<line x1="0" y1="${pos}" x2="5" y2="${pos - 2.5}"/>`; }
  return `<g transform="translate(${x} ${y}) rotate(${dir})" stroke="${COL.wb}" stroke-width="1.3" stroke-linecap="round">${parts}</g>`;
}
