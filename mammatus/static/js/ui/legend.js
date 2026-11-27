// Color legend for the active layer, with ticks in the user's units and a live hover marker.
import { h, esc } from "../util.js";
import { cssGradient, legendPos } from "../colormaps.js";
import { toDisplay, label, units } from "../units.js";
import { when } from "../time.js";

// Units the server writes each colormap's ticks in -> canonical.
const REF = {
  temp: ["F", (v) => (v - 32) * 5 / 9 + 273.15], dewpoint: ["F", (v) => (v - 32) * 5 / 9 + 273.15],
  t850: ["C", (v) => v + 273.15], precip: ["in", (v) => v * 25.4], snow: ["in", (v) => v * 25.4],
  ice: ["in", (v) => v * 25.4], pwat: ["in", (v) => v * 25.4], wind: ["mph", (v) => v * 0.44704],
  jet: ["kt", (v) => v * 0.514444], vis: ["mi", (v) => v * 1609.34],
};

function niceLabel(kind, canon, cmapId, raw) {
  const ref = REF[cmapId];
  const U = units();
  const same = !ref || (kind === "temp" && U.temp === ref[0]) || ((kind === "precip" || kind === "pwat") && U.precip === ref[0])
    || (kind === "snow" && U.snow === ref[0]) || (kind === "wind" && U.wind === ref[0]) || (kind === "vis" && U.dist === ref[0]);
  if (same) return kind === "thick" ? String(raw / 10) : String(raw);
  const d = toDisplay(kind, canon);
  const a = Math.abs(d);
  return a >= 10 ? String(Math.round(d)) : a >= 1 ? String(Math.round(d * 10) / 10) : String(Math.round(d * 100) / 100);
}

const BOLT_PATH = "M13.2 2.8 5.8 13.2h5.4l-1.4 8 7.4-10.4h-5.4z";
const BOLT = `<svg viewBox="0 0 24 24" width="15" height="15"><path d="${BOLT_PATH}" fill="#ffd36b" stroke="#ffb52e" stroke-width="1" stroke-linejoin="round"/></svg>`;
// Newest strikes are the biggest and whitest; they shrink and redden with age (matches the map).
const BOLT_RAMP = (() => {
  const steps = [[19, "#fffef4"], [15, "#ffec8f"], [12, "#ffb53a"], [9.5, "#ff7a2c"], [7.5, "#e0344f"]];
  let x = 0;
  const parts = steps.map(([size, color]) => {
    const k = size / 24, tx = x - 5.4 * k, ty = (20 - size) / 2;
    x += size * 0.62 + 7;
    return `<path d="${BOLT_PATH}" transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(3)})" fill="${color}" stroke="rgba(4,6,12,.75)" stroke-width="${(1.4 / k).toFixed(2)}" stroke-linejoin="round" paint-order="stroke"/>`;
  });
  return `<svg viewBox="0 0 ${x.toFixed(1)} 20" height="18" preserveAspectRatio="xMinYMid meet" aria-hidden="true">${parts.join("")}</svg>`;
})();
const FRONT_KEY = '<svg viewBox="0 0 44 14" width="44" height="14"><path d="M1 10h21" stroke="#4d8dff" stroke-width="2.2"/><path d="m6 10 3.2-5.2L12.4 10z" fill="#4d8dff"/><path d="M22 10h21" stroke="#ff4f62" stroke-width="2.2"/><path d="M29.5 10a3.6 3.6 0 0 1 7.2 0z" fill="#ff4f62"/></svg>';
const hhz = (d) => when(d);

export class Legend {
  constructor(app) {
    this.app = app;
    this.el = h("div", { class: "legend glass" });
    this.main = h("div");
    this.extra = h("div", { class: "ovl-rows" });
    this.el.append(this.main, this.extra);
    document.getElementById("ui").append(this.el);
    this.marker = null;
  }

  updateVisibility() {
    this.el.style.display = this.main.childNodes.length || this.extra.childNodes.length ? "" : "none";
  }

  render() {
    this.renderMain();
    this.updateVisibility();
  }

  renderMain() {
    const app = this.app, s = app.state.source;
    const el = this.main;
    el.replaceChildren();
    this.marker = null;
    if (!s || s.type === "sat") {
      if (s?.type === "sat") {
        const sp = app.catalog.satellite.find((x) => x.id === s.product);
        el.append(h("div", { class: "lh" }, h("b", {}, sp?.name || "Satellite"), h("span", {}, "SSEC RealEarth")),
          h("div", { class: "method", style: { marginTop: 0 } }, sp?.desc || ""));
      }
      return;
    }
    let cmapId, title, desc = "";
    if (s.type === "radar") { cmapId = "mrms"; title = "Radar reflectivity"; desc = "NOAA MRMS merged composite."; }
    else {
      const p = app.catalog.products.find((x) => x.id === s.product);
      if (!p) return;          // (a product this server doesn't have: a stale link or saved view)
      cmapId = p.cmap; title = p.name; desc = p.desc;
      if (p.method) desc += ` ${p.method}`;
    }
    const cm = app.catalog.colormaps[cmapId];
    const kind = cm.unit;
    this.kind = kind; this.cm = cm;
    if (cm.mode === "category") {
      const cols = cssGradient(cm);
      el.append(h("div", { class: "lh" }, h("b", {}, title), h("span", {}, "lighter = lighter rate")),
        h("div", { class: "cats" }, ...cm.categories.map((c, i) => h("div", {}, h("i", { style: { background: `linear-gradient(90deg, ${c.stops[0][1]}, ${cols[i]}, ${c.stops[c.stops.length - 1][1]})` } }), c.name))));
    } else {
      const bar = h("div", { class: "bar", style: { background: cssGradient(cm) } });
      this.marker = h("i", { style: { position: "absolute", top: "-3px", width: "3px", height: "15px", borderRadius: "2px", background: "#fff", boxShadow: "0 0 0 1.5px rgba(0,0,0,.6)", display: "none", transform: "translateX(-50%)", transition: "left .08s" } });
      const barWrap = h("div", { style: { position: "relative" } }, bar, this.marker);
      const ticks = h("div", { class: "ticks" });
      const refConv = REF[cmapId]?.[1] || ((v) => v);
      (cm.ticks || []).forEach((t) => {
        const canon = refConv(t);
        const pos = legendPos(cm, canon);
        if (pos <= 0.01 || pos >= 0.99) return;
        ticks.append(h("span", { style: { left: `${pos * 100}%` } }, niceLabel(kind, canon, cmapId, t)));
      });
      el.append(h("div", { class: "lh" }, h("b", {}, title), h("span", {}, label(kind))), barWrap, ticks);
    }
    if (desc) el.append(h("div", { class: "method" }, desc));
  }

  // Rows for the observation overlays (lightning, fronts) under the main legend.
  renderOverlays(lightning, fronts) {
    const rows = [];
    if (lightning?.enabled) {
      const mins = Math.round((lightning.window || 1800) / 60);
      let status;
      if (!lightning.available) status = h("span", { class: "ovl-note" }, "Turned off on this server");
      else if (lightning.warming) status = h("span", { class: "ovl-note" }, "Connecting to GOES…");
      else if (lightning.mode === "off") status = h("button", { class: "ovl-note ovl-link", title: "Lightning is live data; jump the timeline to now", onclick: () => this.app.jumpToNow() }, "Jump to now");
      else status = h("span", { class: "ovl-count num" }, `${lightning.count.toLocaleString()} in view`);
      rows.push(h("div", { class: "ovl" },
        h("span", { class: `ovl-ic bolt${lightning.mode === "live" && !lightning.warming ? " live" : ""}`, html: BOLT, title: lightning.mode === "live" ? "Live" : "" }),
        h("b", {}, "Lightning"),
        lightning.mode !== "off" && lightning.available && !lightning.warming
          ? h("span", { class: "ovl-bolts", title: `Newest strikes are the biggest; they shrink and redden over ${mins} minutes` },
            h("span", { html: BOLT_RAMP }), h("small", {}, "now"), h("small", {}, `${mins} min`)) : null,
        status));
    }
    if (fronts?.enabled) {
      const s = fronts.set;
      let what;
      if (fronts.error && !s) what = "Unavailable";
      else if (!s) what = "None near this time";
      else if (s.kind === "analysis") what = `WPC analysis · ${hhz(s.valid)}`;
      else what = `WPC ${s.hours}-h forecast · ${hhz(s.valid)}`;
      rows.push(h("div", { class: "ovl" }, h("span", { class: "ovl-ic", html: FRONT_KEY }), h("b", {}, "Fronts"),
        h("span", { class: s ? "ovl-count" : "ovl-note" }, what)));
    }
    this.extra.replaceChildren(...rows);
    this.updateVisibility();
  }

  hover(value) {
    if (!this.marker) return;
    if (value == null) { this.marker.style.display = "none"; return; }
    this.marker.style.display = "";
    this.marker.style.left = `${legendPos(this.cm, value) * 100}%`;
  }
}
