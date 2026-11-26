// Place search: instant local matches (bundled cities + saved places), then the geocoder.
import { h, $, debounce, onOutside, esc } from "../util.js";
import { icon } from "./icons.js";
import { get } from "../api.js";

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export class Search {
  constructor(app) {
    this.app = app;
    this.input = h("input", { type: "search", placeholder: "Search places or coordinates", autocomplete: "off", spellcheck: "false", "aria-label": "Search places" });
    this.results = h("div", { class: "results", role: "listbox" });
    this.el = h("div", { class: "popover search glass-strong" },
      h("div", { class: "sbox" }, h("span", { html: icon("search", 18), style: { opacity: 0.6 } }), this.input, h("span", { class: "kbd hide-m" }, "esc")),
      this.results);
    document.getElementById("ui").append(this.el);
    this.sel = 0;
    this.items = [];
    this.input.addEventListener("input", () => this.query());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { this.sel = Math.min(this.items.length - 1, this.sel + 1); this.paint(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { this.sel = Math.max(0, this.sel - 1); this.paint(); e.preventDefault(); }
      else if (e.key === "Enter") { const it = this.items[this.sel]; if (it) this.pick(it); }
      else if (e.key === "Escape") this.close();
    });
    this.remote = debounce((q) => this.geocode(q), 260);
  }

  open() {
    this.el.classList.add("open");
    this.input.value = "";
    this.query();
    setTimeout(() => this.input.focus(), 30);
    this.off = onOutside(this.el, () => this.close());
  }

  close() { this.el.classList.remove("open"); this.off?.(); this.input.blur(); }
  isOpen() { return this.el.classList.contains("open"); }

  query() {
    const q = this.input.value.trim();
    const app = this.app;
    this.items = [];
    if (!q) {
      for (const p of app.points.slice(0, 8)) this.items.push({ kind: "saved", name: p.name, sub: "Saved place", lat: p.lat, lon: p.lon, elev: p.elev });
      for (const r of app.catalog.regions) this.items.push({ kind: "region", name: r.name, sub: "Region", bbox: r.bbox });
      this.paint();
      return;
    }
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = +m[1], lon = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) this.items.push({ kind: "coord", name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, sub: "Coordinates", lat, lon });
    }
    const nq = norm(q);
    for (const p of app.points) if (norm(p.name).includes(nq)) this.items.push({ kind: "saved", name: p.name, sub: "Saved place", lat: p.lat, lon: p.lon, elev: p.elev });
    for (const r of app.catalog.regions) if (norm(r.name).includes(nq)) this.items.push({ kind: "region", name: r.name, sub: "Region", bbox: r.bbox });
    const local = [];
    for (const c of app.cities) {
      const n = norm(c.name);
      if (n.startsWith(nq)) local.push([c, 0]);
      else if (nq.length > 2 && n.includes(nq)) local.push([c, 1]);
      if (local.length > 60) break;
    }
    local.sort((a, b) => a[1] - b[1] || b[0].pop - a[0].pop);
    for (const [c] of local.slice(0, 6)) this.items.push({ kind: "city", name: c.name, sub: [c.adm, c.cc].filter(Boolean).join(", "), lat: c.lat, lon: c.lon });
    this.sel = 0;
    this.paint();
    if (q.length >= 3 && !m) this.remote(q);
  }

  async geocode(q) {
    try {
      const { results } = await get(`/geocode?q=${encodeURIComponent(q)}`, { quiet: true });
      if (this.input.value.trim() !== q) return;
      const seen = new Set(this.items.map((i) => `${i.name}|${Math.round(i.lat * 10)}|${Math.round(i.lon * 10)}`));
      for (const r of results) {
        const k = `${r.name}|${Math.round(r.lat * 10)}|${Math.round(r.lon * 10)}`;
        if (seen.has(k)) continue;
        this.items.push({ kind: "geo", name: r.name, sub: [r.admin1, r.country].filter(Boolean).join(", "), lat: r.lat, lon: r.lon, elev: r.elevation });
      }
      this.paint();
    } catch { /* geocoder is optional */ }
  }

  paint() {
    const ic = { saved: "starFill", region: "map", coord: "locate", city: "pin", geo: "pin" };
    this.results.replaceChildren(...this.items.map((it, i) => h("button", { class: `sres${i === this.sel ? " sel" : ""}`, role: "option", onclick: () => this.pick(it), onmouseenter: () => { this.sel = i; this.paint(); } },
      h("span", { class: "ic", html: icon(ic[it.kind], 16), style: it.kind === "saved" ? { color: "var(--warn)" } : null }),
      h("span", {}, h("b", {}, it.name), h("small", {}, it.sub)))));
    if (!this.items.length && this.input.value.trim()) this.results.replaceChildren(h("div", { class: "empty" }, "No matches yet…"));
  }

  pick(it) {
    this.close();
    if (it.bbox) { this.app.renderer.camera.fitBounds(it.bbox); this.app.renderer.poke(); return; }
    this.app.selectPoint({ name: it.name, lat: it.lat, lon: it.lon, elev: it.elev ?? null }, { fly: true, card: true });
  }
}
