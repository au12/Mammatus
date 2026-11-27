// Layer pill + picker: models (with runs) and observations on the left, products on the right.
import { h, $, onOutside, esc } from "../util.js";
import { icon } from "./icons.js";
import { cssGradient } from "../colormaps.js";
import { runLabel, ago, runDate } from "../time.js";

const CATS = ["Surface", "Precipitation", "Winter", "Severe", "Upper air"];

export class Picker {
  constructor(app, pill) {
    this.app = app;
    this.pill = pill;
    this.el = h("div", { class: "popover picker glass-strong", role: "dialog", "aria-label": "Choose a layer" });
    document.getElementById("ui").append(this.el);
    pill.addEventListener("click", () => this.toggle());
    this.browse = null; // model id being browsed ('obs' for observations)
  }

  toggle(force) {
    const open = force ?? !this.el.classList.contains("open");
    this.el.classList.toggle("open", open);
    this.pill.setAttribute("aria-expanded", String(open));
    if (open) {
      const s = this.app.state.source;
      this.browse = s?.type === "model" ? s.model : "obs";
      this.render();
      this.off = onOutside(this.el, () => this.toggle(false), [this.pill]);
    } else this.off?.();
  }

  updatePill() {
    const app = this.app, s = app.state.source;
    const sw = $(".swatch", this.pill), b = $(".t b", this.pill), sub = $(".t span", this.pill);
    if (!s) return;
    if (s.type === "model") {
      const p = app.catalog.products.find((x) => x.id === s.product);
      const m = app.model(s.model);
      if (!p || !m) { b.textContent = p?.name || "Layer"; sub.textContent = m?.short || ""; return; }
      const cm = app.catalog.colormaps[p.cmap];
      sw.style.background = cm.mode === "category" ? `linear-gradient(135deg, ${cssGradient(cm).join(", ")})` : cssGradient(cm).replace("90deg", "135deg");
      b.textContent = p.name;
      sub.innerHTML = `<span style="color:${m.color}">●</span> ${esc(m.short)} · ${esc(runLabel(s.run))}`;
    } else if (s.type === "radar") {
      sw.style.background = cssGradient(app.catalog.colormaps.mrms).replace("90deg", "135deg");
      b.textContent = "Radar";
      sub.textContent = "MRMS composite reflectivity · live";
    } else {
      const sp = app.catalog.satellite.find((x) => x.id === s.product);
      sw.style.background = s.product === "globalvis" ? "linear-gradient(135deg,#1b2333,#9aa7bd,#f2f4f8)" : s.product === "globalwv" ? "linear-gradient(135deg,#3a2a12,#7d6a4a,#c9d6e8,#2f6bd6)" : "linear-gradient(135deg,#0b0d14,#566176,#e9edf6)";
      b.textContent = sp?.name || "Satellite";
      sub.textContent = "Global geostationary mosaic · live";
    }
  }

  render() {
    const app = this.app, s = app.state.source;
    const models = h("div", { class: "models" }, h("h6", {}, "Forecast models"));
    for (const m of app.catalog.models) {
      const runs = app.runs[m.id] || [];
      const latest = runs[0];
      models.append(h("button", { class: `mrow${this.browse === m.id ? " sel" : ""}${latest ? "" : " dis"}`, title: m.desc, onclick: () => { this.browse = m.id; this.render(); } },
        h("i", { class: "dot", style: { background: m.color, boxShadow: `0 0 10px ${m.color}66` } }),
        h("span", { style: { minWidth: 0 } }, h("b", {}, m.short), h("small", {}, m.desc.split(" · ").slice(1).join(" · ") || m.desc)),
        h("span", { class: "age" }, latest ? `${latest.run.slice(8, 10)}z` : "—")));
      if (this.browse === m.id && runs.length) {
        const chips = h("div", { class: "runs" });
        runs.slice(0, 6).forEach((r, i) => {
          const sel = s?.type === "model" && s.model === m.id && s.run === r.run;
          chips.append(h("button", { class: `chip${sel ? " sel" : ""}`, title: `${r.steps.length} hours available${r.complete ? "" : " (still arriving)"}`,
            onclick: () => this.choose({ type: "model", model: m.id, run: r.run, pinned: i > 0 }) },
          i === 0 && !r.complete ? h("i", { class: "new" }) : null, runLabel(r.run).split(" ")[0], h("span", { style: { opacity: 0.55 } }, ago(runDate(r.run).getTime()).replace(" ago", ""))));
        });
        models.append(chips);
      }
    }
    models.append(h("h6", { style: { marginTop: "12px" } }, "Observations"),
      h("button", { class: `mrow${this.browse === "obs" ? " sel" : ""}`, onclick: () => { this.browse = "obs"; this.render(); } },
        h("i", { class: "dot", style: { background: "#5fd3e8", boxShadow: "0 0 10px #5fd3e866" } }),
        h("span", {}, h("b", {}, "Live"), h("small", {}, "Radar and satellite")), h("span", { class: "age" }, "now")));

    const products = h("div", { class: "products" });
    if (this.browse === "obs") {
      const grid = h("div", { class: "pgrid" });
      const prod = (sel, name, bg, onclick, desc) => h("button", { class: `prod${sel ? " sel" : ""}`, onclick, title: desc }, h("b", {}, name), h("i", { class: "ramp", style: { background: bg } }));
      grid.append(prod(s?.type === "radar", "Radar", cssGradient(app.catalog.colormaps.mrms), () => this.choose({ type: "radar" }), "MRMS composite reflectivity, last 2 hours"));
      for (const sp of app.catalog.satellite) {
        const bg = sp.id === "globalvis" ? "linear-gradient(90deg,#1b2333,#9aa7bd,#f2f4f8)" : sp.id === "globalwv" ? "linear-gradient(90deg,#3a2a12,#c9d6e8,#2f6bd6)" : "linear-gradient(90deg,#0b0d14,#566176,#e9edf6)";
        grid.append(prod(s?.type === "sat" && s.product === sp.id, sp.name, bg, () => this.choose({ type: "sat", product: sp.id }), sp.desc));
      }
      products.append(h("div", { class: "pgroup" }, h("h6", {}, "Live observations"), grid),
        h("p", { class: "note", style: { margin: "8px 6px" } }, "Satellite imagery courtesy of SSEC, University of Wisconsin–Madison. Radar from NOAA MRMS."));
    } else {
      const mid = this.browse;
      for (const cat of CATS) {
        const items = app.catalog.products.filter((p) => p.category === cat);
        if (!items.length) continue;
        const grid = h("div", { class: "pgrid" });
        for (const p of items) {
          const cm = app.catalog.colormaps[p.cmap];
          const ok = p.models.includes(mid);
          const sel = s?.type === "model" && s.model === mid && s.product === p.id;
          const ramp = cm.mode === "category" ? h("span", { class: "cats" }, ...cssGradient(cm).map((c) => h("i", { style: { background: c } })))
            : h("i", { class: "ramp", style: { background: cssGradient(cm) } });
          grid.append(h("button", { class: `prod${sel ? " sel" : ""}${ok ? "" : " dis"}`, title: p.desc, disabled: !ok,
            onclick: () => this.choose({ type: "model", model: mid, product: p.id }) }, h("b", {}, p.name), ramp));
        }
        products.append(h("div", { class: "pgroup" }, h("h6", {}, cat), grid));
      }
    }
    this.el.replaceChildren(models, products);
  }

  choose(next) {
    const app = this.app, s = app.state.source;
    if (next.type === "model") {
      const model = next.model;
      const runs = app.runs[model] || [];
      let product = next.product || (s?.type === "model" ? s.product : app.prefs.lastProduct) || "t2m";
      const prod = app.catalog.products.find((p) => p.id === product);
      if (!prod || !prod.models.includes(model)) product = "t2m";
      const run = next.run || (s?.type === "model" && s.model === model && s.pinned ? s.run : runs[0]?.run);
      if (!run) return;
      app.setSource({ type: "model", model, run, product, pinned: !!next.pinned || (next.run == null && s?.pinned && s.model === model) });
    } else app.setSource(next);
    if (app.mobile() || next.product || next.type !== "model") this.toggle(false); else this.render();
  }
}
