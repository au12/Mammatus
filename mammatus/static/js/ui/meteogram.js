// Multi-model meteogram: daily consensus strip, then temperature, precipitation, snow, wind, pressure
// and cloud panels sharing one time axis with a synced crosshair.
import { h, clamp } from "../util.js";
import { toDisplay, label, fmt, units } from "../units.js";
import { dayKey, weekday, hourLabel, when, solarElevation, localHour } from "../time.js";

const W_PAD = { l: 34, r: 10 };

const median = (arr) => {
  const v = arr.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return { ticks: out, lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step };
}

export function weatherGlyph(code, night = false, size = 26) {
  const sun = night
    ? `<path d="M16 6.5a6 6 0 1 0 5.5 8.6A7 7 0 0 1 16 6.5z" fill="#c9d2ff"/>`
    : `<circle cx="12" cy="11" r="4.6" fill="#ffc46b"/><g stroke="#ffc46b" stroke-width="1.6" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => { const r = a * Math.PI / 180; return `<line x1="${12 + Math.cos(r) * 6.8}" y1="${11 + Math.sin(r) * 6.8}" x2="${12 + Math.cos(r) * 8.6}" y2="${11 + Math.sin(r) * 8.6}"/>`; }).join("")}</g>`;
  const cloud = (fill = "#dfe5f2", dy = 0) => `<path transform="translate(0 ${dy})" d="M8.5 21h11a4.2 4.2 0 0 0 .4-8.4 5.6 5.6 0 0 0-10.6-1.2A4.8 4.8 0 0 0 8.5 21z" fill="${fill}"/>`;
  const drops = (c = "#7fb2ff") => `<g stroke="${c}" stroke-width="1.7" stroke-linecap="round"><line x1="11" y1="23.5" x2="10" y2="26"/><line x1="15" y1="23.5" x2="14" y2="26"/><line x1="19" y1="23.5" x2="18" y2="26"/></g>`;
  const flakes = `<g fill="#e8f1ff"><circle cx="10.5" cy="24.6" r="1.25"/><circle cx="15" cy="25.6" r="1.25"/><circle cx="19.5" cy="24.6" r="1.25"/></g>`;
  let body;
  if (code <= 1) body = sun;
  else if (code === 2) body = sun + cloud("#dfe5f2", 1);
  else if (code === 3) body = cloud("#b9c2d6", -2);
  else if (code === 45 || code === 48) body = `<g stroke="#b9c2d6" stroke-width="2" stroke-linecap="round"><line x1="6" y1="11" x2="24" y2="11"/><line x1="8" y1="16" x2="26" y2="16"/><line x1="6" y1="21" x2="22" y2="21"/></g>`;
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) body = cloud("#c9d2e6", -3) + flakes;
  else if (code >= 95) body = cloud("#9aa3bb", -3) + `<path d="M15.5 18.5l-3 5h3l-1.5 4 4.5-6h-3l1.5-3z" fill="#ffd166"/>`;
  else if (code === 56 || code === 57 || code === 66 || code === 67) body = cloud("#c9d2e6", -3) + drops("#f58bc8");
  else if (code >= 51) body = cloud("#c9d2e6", -3) + drops();
  else body = cloud();
  return `<svg viewBox="0 0 30 30" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

export class Meteogram {
  constructor(app, container) {
    this.app = app;
    this.el = container;
    this.hidden = new Set(app.prefs.mgHidden || []);
    this.range = app.prefs.mgRange || 5;
    this.data = null;
    this.ro = new ResizeObserver(() => { if (this.data && this.el.clientWidth !== this.w) this.draw(); });
    this.ro.observe(this.el);
  }

  destroy() { this.ro.disconnect(); }

  set(data, point) {
    this.data = data;
    this.point = point;
    this.draw();
  }

  series(model, v, conv) {
    const m = this.data.models[model];
    return m && m[v] ? m[v].map((x) => (x == null ? null : conv ? conv(x) : x)) : null;
  }

  draw() {
    const d = this.data;
    const app = this.app;
    this.w = this.el.clientWidth || 440;
    const W = this.w;
    const meta = Object.fromEntries(app.catalog.meteogramModels.map((m) => [m.id, m]));
    const models = Object.keys(d.models).filter((m) => meta[m]);
    const times = d.time.map((t) => t * 1000);
    const now = Date.now();
    const tStart = now - 3 * 3600000;
    const tEnd = Math.min(times[times.length - 1], now + this.range * 86400000);
    const idx = times.map((t, i) => (t >= tStart && t <= tEnd ? i : -1)).filter((i) => i >= 0);
    const x = (t) => W_PAD.l + ((t - tStart) / (tEnd - tStart)) * (W - W_PAD.l - W_PAD.r);
    this.x = x; this.times = times; this.idx = idx; this.tStart = tStart; this.tEnd = tEnd; this.models = models;
    const visible = models.filter((m) => !this.hidden.has(m));
    const lat = this.point.lat, lon = this.point.lon;

    // background: night bands, day separators, labels
    const nightRects = (H) => {
      let s = "", start = null;
      for (let t = tStart; t <= tEnd + 1800000; t += 1800000) {
        const night = solarElevation(new Date(Math.min(t, tEnd)), lat, lon) < -0.8;
        if (night && start == null) start = t;
        if ((!night || t > tEnd) && start != null) { s += `<rect class="night" x="${x(start)}" y="0" width="${Math.max(0, x(Math.min(t, tEnd)) - x(start))}" height="${H}"/>`; start = null; }
      }
      return s;
    };
    const dayLines = (H) => {
      let s = "", prev = dayKey(new Date(tStart));
      for (let t = Math.ceil(tStart / 3600000) * 3600000; t <= tEnd; t += 3600000) {
        const k = dayKey(new Date(t));
        if (k !== prev) { s += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H}" stroke-dasharray="2 3"/>`; prev = k; }
      }
      return s;
    };

    const panel = (title, unitLabel, H, build, opts = {}) => {
      let lo = Infinity, hi = -Infinity;
      const lines = build();
      for (const l of lines) for (const i of idx) { const v = l.vals[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      if (opts.zero) lo = Math.min(0, lo);
      if (opts.minSpan && hi - lo < opts.minSpan) { const c = (hi + lo) / 2; lo = opts.zero ? 0 : c - opts.minSpan / 2; hi = lo + opts.minSpan; }
      if (!Number.isFinite(lo)) return null;
      const nt = niceTicks(lo, hi, H > 110 ? 4 : 3);
      const pt = 8, pb = 4;
      const y = (v) => pt + (1 - (v - nt.lo) / (nt.hi - nt.lo)) * (H - pt - pb);
      let svg = nightRects(H) + dayLines(H);
      for (const t of nt.ticks) svg += `<line class="grid" x1="${W_PAD.l}" x2="${W - W_PAD.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${W_PAD.l - 6}" y="${y(t) + 3}" text-anchor="end">${opts.tickFmt ? opts.tickFmt(t) : t}</text>`;
      if (opts.freezing != null && opts.freezing > nt.lo && opts.freezing < nt.hi) svg += `<line x1="${W_PAD.l}" x2="${W - W_PAD.r}" y1="${y(opts.freezing)}" y2="${y(opts.freezing)}" stroke="#7fb2ff" stroke-opacity=".45" stroke-dasharray="4 4"/>`;
      // spread band (min-max across visible models) for the primary var
      if (opts.band && visible.length > 2) {
        const prim = lines.filter((l) => l.primary);
        let up = "", dn = "";
        for (const i of idx) {
          const vals = prim.map((l) => l.vals[i]).filter((v) => v != null);
          if (vals.length < 2) continue;
          up += `${up ? "L" : "M"}${x(times[i]).toFixed(1)} ${y(Math.max(...vals)).toFixed(1)}`;
          dn = `L${x(times[i]).toFixed(1)} ${y(Math.min(...vals)).toFixed(1)}` + dn;
        }
        if (up) svg += `<path d="${up}${dn}Z" fill="rgba(255,255,255,.055)"/>`;
      }
      for (const l of lines) {
        let p = "", pen = false;
        for (const i of idx) {
          const v = l.vals[i];
          if (v == null) { pen = false; continue; }
          p += `${pen ? "L" : "M"}${x(times[i]).toFixed(1)} ${y(v).toFixed(1)}`;
          pen = true;
        }
        if (p) svg += `<path d="${p}" fill="none" stroke="${l.color}" stroke-width="${l.width || 1.6}" stroke-opacity="${l.alpha ?? 0.95}" ${l.dash ? `stroke-dasharray="${l.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      const el = h("div", { class: "chart" }, h("h5", {}, h("span", {}, title), h("span", {}, unitLabel)));
      el.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 ${W} ${H}" height="${H}" data-h="${H}">${svg}<line class="xh" x1="0" x2="0" y1="0" y2="${H}" style="display:none"/></svg>`);
      el._lines = lines; el._y = y; el._fmt = opts.valFmt;
      return el;
    };

    const charts = [];
    const tempConv = (c) => toDisplay("temp", c + 273.15);
    charts.push(panel("Temperature", label("temp"), 150, () => {
      const out = [];
      for (const m of visible) {
        const t = this.series(m, "temperature_2m", tempConv);
        if (t) out.push({ model: m, var: "Temp", vals: t, color: meta[m].color, primary: true });
        if (this.showDew) { const dw = this.series(m, "dew_point_2m", tempConv); if (dw) out.push({ model: m, var: "Dew", vals: dw, color: meta[m].color, dash: "3 3", width: 1.2, alpha: 0.7 }); }
      }
      return out;
    }, { band: true, freezing: units().temp === "C" ? 0 : 32, valFmt: (v) => `${Math.round(v)}°` }));

    // accumulated precipitation since the start of the window
    const accum = (vals, conv) => {
      if (!vals) return null;
      let s = 0;
      return vals.map((v, i) => { if (times[i] < now - 3600000) return null; if (v != null) s += v; return conv(s); });
    };
    const pConv = (mm) => toDisplay("precip", mm);
    charts.push(panel("Precipitation (accumulated)", label("precip"), 112, () => visible.map((m) => ({ model: m, var: "Precip", vals: accum(this.series(m, "precipitation"), pConv), color: meta[m].color, primary: true })).filter((l) => l.vals),
      { zero: true, minSpan: units().precip === "mm" ? 5 : 0.2, valFmt: (v) => v.toFixed(units().precip === "mm" ? 1 : 2) }));
    const sConv = (cm) => toDisplay("snow", cm * 10);
    const snowLines = visible.map((m) => ({ model: m, var: "Snow", vals: accum(this.series(m, "snowfall"), sConv), color: meta[m].color, primary: true })).filter((l) => l.vals && l.vals.some((v) => v > 0.05));
    if (snowLines.length) charts.push(panel("Snowfall (accumulated, 7:1 model ratio)", label("snow"), 112, () => snowLines, { zero: true, minSpan: 1, valFmt: (v) => v.toFixed(1) }));
    const wConv = (ms) => toDisplay("wind", ms);
    charts.push(panel("Wind & gusts", label("wind"), 112, () => {
      const out = [];
      for (const m of visible) {
        const s = this.series(m, "wind_speed_10m", wConv); if (s) out.push({ model: m, var: "Wind", vals: s, color: meta[m].color, primary: true });
        const g = this.series(m, "wind_gusts_10m", wConv); if (g) out.push({ model: m, var: "Gust", vals: g, color: meta[m].color, dash: "1.5 3", width: 1.3, alpha: 0.75 });
      }
      return out;
    }, { zero: true, minSpan: 10, valFmt: (v) => Math.round(v) }));
    const prConv = (hpa) => toDisplay("pressure", hpa);
    charts.push(panel("Sea-level pressure", label("pressure"), 96, () => visible.map((m) => ({ model: m, var: "MSLP", vals: this.series(m, "pressure_msl", prConv), color: meta[m].color, primary: true })).filter((l) => l.vals),
      { minSpan: units().pressure === "inHg" ? 0.3 : 10, tickFmt: (t) => (units().pressure === "inHg" ? t.toFixed(1) : t), valFmt: (v) => (units().pressure === "inHg" ? v.toFixed(2) : Math.round(v)) }));

    // cloud strip: one row per model
    const rowH = 9;
    let cs = nightRects(visible.length * (rowH + 3));
    visible.forEach((m, r) => {
      const cc = this.series(m, "cloud_cover");
      if (!cc) return;
      for (const i of idx) {
        const v = cc[i];
        if (v == null) continue;
        const x0 = x(times[i]), x1 = x(times[Math.min(times.length - 1, i + 1)]) || x0 + 3;
        cs += `<rect x="${x0.toFixed(1)}" y="${r * (rowH + 3)}" width="${Math.max(1, x1 - x0 + 0.4).toFixed(1)}" height="${rowH}" fill="rgb(220,228,242)" fill-opacity="${(v / 100 * 0.85).toFixed(2)}"/>`;
      }
      cs += `<text class="axis" x="${W_PAD.l - 6}" y="${r * (rowH + 3) + 8}" text-anchor="end" fill="${meta[m].color}">${meta[m].name.slice(0, 4)}</text>`;
    });
    const cloud = h("div", { class: "chart" }, h("h5", {}, h("span", {}, "Cloud cover"), h("span", {}, "%")));
    const ch = Math.max(12, visible.length * (rowH + 3));
    cloud.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 ${W} ${ch}" height="${ch}" data-h="${ch}">${cs}<line class="xh" x1="0" x2="0" y1="0" y2="${ch}" style="display:none"/></svg>`);
    cloud._lines = [];

    // time axis
    let ax = "";
    const stepH = (tEnd - tStart) / 3600000 > 100 ? 24 : (tEnd - tStart) / 3600000 > 50 ? 12 : 6;
    for (let t = Math.ceil(tStart / 3600000) * 3600000; t <= tEnd; t += 3600000) {
      const dt = new Date(t);
      const hr = localHour(dt);
      if (hr === 0) ax += `<text class="axis" x="${x(t) + 3}" y="11" fill="var(--text-2)" style="font-weight:600">${weekday(dt)}</text>`;
      else if (stepH < 24 && hr % stepH === 0) ax += `<text class="axis" x="${x(t)}" y="11" text-anchor="middle">${hourLabel(dt)}</text>`;
    }
    ax += `<line x1="${x(now)}" x2="${x(now)}" y1="0" y2="14" stroke="var(--warm)" stroke-width="2"/>`;
    const axis = h("div", { class: "chart", style: { margin: "0 0 4px" } });
    axis.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 ${W} 14" height="14">${ax}</svg>`);

    // daily consensus strip
    const days = h("div", { style: { display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(58px, 1fr)", gap: "6px", overflowX: "auto", margin: "2px 0 14px", scrollbarWidth: "none" } });
    const byDay = new Map();
    idx.forEach((i) => { if (times[i] < now - 3600000) return; const k = dayKey(new Date(times[i])); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(i); });
    for (const [, ii] of [...byDay].slice(0, Math.ceil(this.range) + 1)) {
      if (ii.length < 3) continue;
      const hi = median(visible.map((m) => { const s = this.series(m, "temperature_2m"); return s ? Math.max(...ii.map((i) => s[i] ?? -999)) : null; }).filter((v) => v > -900));
      const lo = median(visible.map((m) => { const s = this.series(m, "temperature_2m"); return s ? Math.min(...ii.map((i) => s[i] ?? 999)) : null; }).filter((v) => v < 900));
      const pr = median(visible.map((m) => { const s = this.series(m, "precipitation"); return s ? ii.reduce((a, i) => a + (s[i] || 0), 0) : null; }).filter((v) => v != null));
      const codes = [];
      for (const m of visible) { const s = this.series(m, "weather_code"); if (s) for (const i of ii) if (localHour(new Date(times[i])) >= 9 && localHour(new Date(times[i])) <= 18 && s[i] != null) codes.push(s[i]); }
      const code = dominantCode(codes);
      days.append(h("div", { style: { padding: "8px 6px", borderRadius: "12px", background: "rgba(255,255,255,.035)", textAlign: "center", display: "grid", justifyItems: "center", gap: "2px" } },
        h("small", { style: { color: "var(--text-2)", fontWeight: 600, fontSize: "11px" } }, weekday(new Date(times[ii[0]]))),
        h("span", { html: weatherGlyph(code, false, 28) }),
        h("b", { class: "num", style: { fontSize: "13px" } }, hi != null ? `${Math.round(tempConv(hi))}°` : "—", h("span", { style: { color: "var(--text-3)", fontWeight: 500 } }, lo != null ? ` ${Math.round(tempConv(lo))}°` : "")),
        h("small", { class: "num", style: { color: pr > 0.25 ? "#8fc2ff" : "var(--text-3)", fontSize: "10.5px" } }, pr != null && pr > 0.05 ? fmt("precip", pr) : "dry")));
    }

    // model chips + controls
    const chips = h("div", { class: "mlegend" });
    for (const m of models) {
      chips.append(h("button", { class: `chip${this.hidden.has(m) ? " off" : ""}`, onclick: () => {
        this.hidden.has(m) ? this.hidden.delete(m) : this.hidden.add(m);
        app.savePref("mgHidden", [...this.hidden]);
        this.draw();
      } }, h("i", { style: { background: meta[m].color } }), meta[m].name));
    }
    const ctrl = h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "10px" } });
    const rangeSeg = h("div", { class: "seg" }, ...[[2, "2d"], [5, "5d"], [10, "10d"], [16, "16d"]].map(([v, l]) => h("button", { class: this.range === v ? "sel" : "", onclick: () => { this.range = v; app.savePref("mgRange", v); this.draw(); } }, l)));
    const dew = h("button", { class: `chip${this.showDew ? " sel" : ""}`, onclick: () => { this.showDew = !this.showDew; this.draw(); } }, "Dewpoint");
    ctrl.append(rangeSeg, dew);

    const wrap = h("div", { class: "mg", style: { position: "relative" } });
    const tip = h("div", { class: "tip glass-strong", style: { display: "none" } });
    wrap.append(axis, ...charts.filter(Boolean), cloud, tip);
    this.el.replaceChildren(days, ctrl, chips, wrap);
    if (!models.length) this.el.replaceChildren(h("div", { class: "empty" }, "No model data for this location."));
    this.bindCrosshair(wrap, tip, charts.filter(Boolean).concat([cloud]), meta);
  }

  bindCrosshair(wrap, tip, charts, meta) {
    const move = (clientX) => {
      const r = wrap.getBoundingClientRect();
      const px = clientX - r.left;
      const t = this.tStart + ((px - W_PAD.l) / (this.w - W_PAD.l - W_PAD.r)) * (this.tEnd - this.tStart);
      if (t < this.tStart || t > this.tEnd) { hide(); return; }
      let best = this.idx[0], bd = Infinity;
      for (const i of this.idx) { const d = Math.abs(this.times[i] - t); if (d < bd) { bd = d; best = i; } }
      const xx = this.x(this.times[best]);
      for (const c of charts) { const l = c.querySelector(".xh"); if (l) { l.style.display = ""; l.setAttribute("x1", xx); l.setAttribute("x2", xx); } }
      let html = `<b>${when(new Date(this.times[best]))}</b>`;
      for (const c of charts) {
        const prim = (c._lines || []).filter((l) => l.primary && l.vals[best] != null);
        if (!prim.length) continue;
        const title = c.querySelector("h5 span").textContent.split(" (")[0];
        html += `<div style="margin-top:5px;color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">${title}</div>`;
        for (const l of prim) html += `<div class="tr"><span><i style="background:${l.color}"></i>${meta[l.model].name}</span><span class="num">${c._fmt ? c._fmt(l.vals[best]) : l.vals[best]}</span></div>`;
      }
      tip.innerHTML = html;
      tip.style.display = "";
      const tw = tip.offsetWidth;
      tip.style.left = `${clamp(xx + 12 + tw > this.w ? xx - tw - 12 : xx + 12, 0, this.w - tw)}px`;
      tip.style.top = "18px";
    };
    const hide = () => { tip.style.display = "none"; for (const c of charts) { const l = c.querySelector(".xh"); if (l) l.style.display = "none"; } };
    wrap.addEventListener("pointermove", (e) => move(e.clientX));
    wrap.addEventListener("pointerdown", (e) => move(e.clientX));
    wrap.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  }
}

function dominantCode(codes) {
  if (!codes.length) return 2;
  // severity-weighted mode: storms/snow/rain beat clouds when they show up in a third of hours
  const count = new Map();
  for (const c of codes) count.set(c, (count.get(c) || 0) + 1);
  const n = codes.length;
  const share = (pred) => codes.filter(pred).length / n;
  if (share((c) => c >= 95) > 0.15) return 95;
  if (share((c) => (c >= 71 && c <= 77) || c === 85 || c === 86) > 0.25) return 73;
  if (share((c) => c === 66 || c === 67 || c === 56 || c === 57) > 0.2) return 66;
  if (share((c) => c >= 51) > 0.3) return 61;
  const avgCloud = share((c) => c === 3) * 3 + share((c) => c === 2) * 2 + share((c) => c === 1) * 1;
  return avgCloud > 2.2 ? 3 : avgCloud > 1.2 ? 2 : avgCloud > 0.5 ? 1 : 0;
}
