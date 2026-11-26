// Tap card: place name, the active layer's value, NWS alerts, and quick actions.
import { h, fmtLatLon, clamp } from "../util.js";
import { icon } from "./icons.js";
import { get } from "../api.js";

export class PointCard {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.marker = h("div", { class: "marker", style: { display: "none" } }, h("div", { class: "pulse" }), h("div", { class: "pin" }));
    document.getElementById("ui").append(this.marker);
    app.renderer.addEventListener("frame", () => this.place());
  }

  show(p, screen) {
    this.close(false);
    this.p = p;
    this.screen = screen;
    const app = this.app;
    const saved = app.savedPoint(p);
    this.valueEl = h("div", { class: "big num" });
    this.alertsEl = h("div", { class: "alerts" });
    this.el = h("div", { class: "pointcard glass-strong", role: "dialog", "aria-label": "Point details" },
      h("div", { class: "pc-h" },
        h("div", { class: "t" }, h("b", {}, saved?.name || p.name || fmtLatLon(p.lat, p.lon)), h("small", {}, p.name || saved ? fmtLatLon(p.lat, p.lon) : "")),
        h("button", { class: "closex", "aria-label": "Close", html: icon("x", 16), onclick: () => this.close() })),
      this.valueEl, this.alertsEl,
      h("div", { class: "pc-actions" },
        h("button", { class: "btn sm", onclick: () => app.selectPoint(p, { tab: "forecast" }) }, h("span", { html: icon("chart", 15) }), "Forecast"),
        h("button", { class: "btn sm", onclick: () => app.selectPoint(p, { tab: "sounding" }) }, h("span", { html: icon("skewt", 15) }), "Sounding"),
        h("button", { class: "btn sm", onclick: () => app.selectPoint(p, { tab: "alerts" }) }, h("span", { html: icon("alert", 15) }), "Alerts")));
    document.getElementById("ui").append(this.el);
    this.update();
    this.place();
    this.marker.style.display = "";
    this.loadAlerts();
  }

  update() {
    if (!this.el) return;
    const v = this.app.layers.sample(this.p.lon, this.p.lat);
    const src = this.app.state.source;
    if (src?.type === "sat") this.valueEl.style.display = "none";
    else {
      this.valueEl.style.display = "";
      this.valueEl.innerHTML = v ? this.app.formatSample(v, true) : `<span style="font-size:15px;color:var(--text-3);font-weight:500">${this.app.layers.current ? "No value here" : "Loading…"}</span>`;
    }
  }

  async loadAlerts() {
    const p = this.p;
    if (!(p.lat > 17 && p.lat < 72 && p.lon > -180 && p.lon < -60)) return;
    try {
      const { alerts } = await get(`/alerts/point?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`, { quiet: true });
      if (this.p !== p || !this.el) return;
      this.alertsEl.replaceChildren(...alerts.slice(0, 3).map((a) => h("button", { class: "alertchip", onclick: () => this.app.selectPoint(p, { tab: "alerts" }) },
        h("i", { style: { background: a.color, boxShadow: `0 0 8px ${a.color}` } }), a.event)));
      if (alerts.length > 3) this.alertsEl.append(h("small", { class: "note" }, `+${alerts.length - 3} more`));
      this.place();
    } catch { /* alerts are best-effort here */ }
  }

  place() {
    if (!this.p) return;
    const cam = this.app.renderer.camera;
    const pr = cam.project(this.p.lon, this.p.lat);
    const vis = pr.vis > 0;
    this.marker.style.display = vis ? "" : "none";
    this.marker.style.left = `${pr.x}px`;
    this.marker.style.top = `${pr.y}px`;
    if (!this.el || this.app.mobile()) return;
    const w = this.el.offsetWidth || 288, hh = this.el.offsetHeight || 200;
    let x = pr.x + 18, y = pr.y - hh / 2;
    if (x + w > innerWidth - 70) x = pr.x - w - 18;
    x = clamp(x, 12, innerWidth - w - 12);
    y = clamp(y, 70, innerHeight - hh - 110);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    this.el.style.opacity = vis ? "" : "0";
  }

  close(clearMarker = true) {
    this.el?.remove();
    this.el = null;
    if (clearMarker) { this.p = null; this.marker.style.display = "none"; }
  }
}
