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
    this.nearEl = h("div", { class: "near" });
    this.alertsEl = h("div", { class: "alerts" });
    this.el = h("div", { class: "pointcard glass-strong", role: "dialog", "aria-label": "Point details" },
      h("div", { class: "pc-h" },
        h("div", { class: "t" }, h("b", {}, saved?.name || p.name || fmtLatLon(p.lat, p.lon)), h("small", {}, p.name || saved ? fmtLatLon(p.lat, p.lon) : "")),
        h("button", { class: "closex", "aria-label": "Close", html: icon("x", 16), onclick: () => this.close() })),
      this.valueEl, this.nearEl, this.alertsEl,
      h("div", { class: "pc-actions" },
        h("button", { class: "btn sm", onclick: () => app.selectPoint(p, { tab: "forecast" }) }, h("span", { html: icon("chart", 15) }), "Forecast"),
        h("button", { class: "btn sm", onclick: () => app.selectPoint(p, { tab: "sounding" }) }, h("span", { html: icon("skewt", 15) }), "Sounding"),
        h("button", { class: "btn sm sky", title: "The clouds above this point in 3D (S)", onclick: () => app.openSky(p), onpointerenter: () => app.sky?.prewarm(p), onpointerdown: () => app.sky?.prewarm(p) }, h("span", { html: icon("sky", 15) }), "Sky"),
        h("button", { class: "btn sm", onclick: () => app.selectPoint(p, { tab: "alerts" }) }, h("span", { html: icon("alert", 15) }), "Alerts")));
    document.getElementById("ui").append(this.el);
    document.body.classList.add("card-open");
    this._placed = null;
    this._size = null;
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
    const near = this.app.lightningLine?.(this.p);
    this.nearEl.style.display = near ? "" : "none";
    if (near) {
      this.nearEl.classList.toggle("close", near.close);
      this.nearEl.innerHTML = `${icon("bolt", 15)}<span></span>`;
      this.nearEl.lastChild.textContent = near.text;
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
      this._placed = null;
      this._size = null;
      this.place();
    } catch { /* alerts are best-effort here */ }
  }

  // Runs on every rendered frame while a point is selected: only touch the DOM when the projected
  // position actually changed, and move things with transforms (no layout).
  place() {
    if (!this.p) return;
    const cam = this.app.renderer.camera;
    const pr = cam.project(this.p.lon, this.p.lat);
    const vis = pr.vis > 0 && Number.isFinite(pr.x) && Number.isFinite(pr.y);
    const x = Math.round(pr.x * 2) / 2, y = Math.round(pr.y * 2) / 2;
    const key = `${vis}|${x}|${y}|${!!this.el}`;
    if (key === this._placed) return;
    this._placed = key;
    this.marker.style.display = vis ? "" : "none";
    if (vis) this.marker.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    if (!this.el || this.app.mobile()) return;
    this._size ||= { w: this.el.offsetWidth || 288, h: this.el.offsetHeight || 200 };
    const { w, h: hh } = this._size;
    let cx = pr.x + 18, cy = pr.y - hh / 2;
    if (cx + w > innerWidth - 70) cx = pr.x - w - 18;
    cx = clamp(cx, 12, innerWidth - w - 12);
    cy = clamp(cy, 70, innerHeight - hh - 110);
    // the `translate` property composes with the card's pop-in transform animation
    this.el.style.left = "0px";
    this.el.style.top = "0px";
    this.el.style.translate = `${Math.round(cx)}px ${Math.round(cy)}px`;
    // a card whose point is behind the globe fades out, and must not keep catching clicks on the map
    this.el.style.opacity = vis ? "" : "0";
    this.el.style.visibility = vis ? "" : "hidden";
  }

  close(clearMarker = true) {
    this.el?.remove();
    this.el = null;
    document.body.classList.remove("card-open");
    if (clearMarker) { this.p = null; this.marker.style.display = "none"; }
  }
}
