// Color legend for the active layer, with ticks in the user's units and a live hover marker.
import { h, esc } from "../util.js";
import { cssGradient, legendPos } from "../colormaps.js";
import { toDisplay, label, units } from "../units.js";

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

export class Legend {
  constructor(app) {
    this.app = app;
    this.el = h("div", { class: "legend glass" });
    document.getElementById("ui").append(this.el);
    this.marker = null;
  }

  render() {
    const app = this.app, s = app.state.source;
    this.el.replaceChildren();
    this.marker = null;
    this.el.style.display = "";
    if (!s || s.type === "sat") {
      if (s?.type === "sat") {
        const sp = app.catalog.satellite.find((x) => x.id === s.product);
        this.el.append(h("div", { class: "lh" }, h("b", {}, sp?.name || "Satellite"), h("span", {}, "SSEC RealEarth")),
          h("div", { class: "method", style: { marginTop: 0 } }, sp?.desc || ""));
      } else this.el.style.display = "none";
      return;
    }
    let cmapId, title, desc = "";
    if (s.type === "radar") { cmapId = "mrms"; title = "Radar reflectivity"; desc = "NOAA MRMS merged composite."; }
    else {
      const p = app.catalog.products.find((x) => x.id === s.product);
      cmapId = p.cmap; title = p.name; desc = p.desc;
      if (p.method) desc += ` ${p.method}`;
    }
    const cm = app.catalog.colormaps[cmapId];
    const kind = cm.unit;
    this.kind = kind; this.cm = cm;
    if (cm.mode === "category") {
      const cols = cssGradient(cm);
      this.el.append(h("div", { class: "lh" }, h("b", {}, title), h("span", {}, "lighter = lighter rate")),
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
      this.el.append(h("div", { class: "lh" }, h("b", {}, title), h("span", {}, label(kind))), barWrap, ticks);
    }
    if (desc) this.el.append(h("div", { class: "method" }, desc));
  }

  hover(value) {
    if (!this.marker) return;
    if (value == null) { this.marker.style.display = "none"; return; }
    this.marker.style.display = "";
    this.marker.style.left = `${legendPos(this.cm, value) * 100}%`;
  }
}
