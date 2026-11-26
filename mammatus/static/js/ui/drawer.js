// Side drawer (bottom sheet on phones): Forecast, Sounding, Alerts, Places, Inbox.
import { h, $, fmtLatLon, esc } from "../util.js";
import { icon } from "./icons.js";
import { logoSVG } from "./logo.js";
import { get, post, del, patch } from "../api.js";
import { Meteogram } from "./meteogram.js";
import { Sounding } from "./sounding.js";
import { toast, toastError } from "./toast.js";
import { promptDialog } from "./modal.js";
import { full, ago, rel } from "../time.js";
import { fmt } from "../units.js";

const TABS = [["forecast", "Forecast"], ["sounding", "Sounding"], ["alerts", "Alerts"], ["places", "Places"], ["inbox", "Inbox"]];

export class Drawer {
  constructor(app) {
    this.app = app;
    this.el = h("aside", { class: "drawer glass-strong", "aria-label": "Details" });
    this.title = h("b");
    this.sub = h("small");
    this.star = h("button", { class: "closex", title: "Save this place", html: icon("star", 18) });
    this.tabsEl = h("div", { class: "tabs", role: "tablist" });
    this.body = h("div", { class: "body" });
    this.el.append(h("div", { class: "grab" }),
      h("div", { class: "dh" }, h("div", { class: "t" }, this.title, this.sub), this.star,
        h("button", { class: "closex", "aria-label": "Close", html: icon("x", 18), onclick: () => this.close() })),
      this.tabsEl, this.body);
    document.getElementById("ui").append(this.el);
    for (const [id, label] of TABS) this.tabsEl.append(h("button", { role: "tab", "data-id": id, onclick: () => this.show(id) }, label));
    this.star.addEventListener("click", () => this.toggleSave());
    this.point = null;
    this.tab = "forecast";
    this.swipe();
  }

  isOpen() { return this.el.classList.contains("open"); }

  open(tab, point) {
    if (point) this.setPoint(point);
    this.el.classList.add("open");
    this.app.onDrawer(true);
    this.show(tab || this.tab);
  }

  close() {
    this.el.classList.remove("open");
    this.app.onDrawer(false);
    this.views?.forEach((v) => v.destroy?.());
    this.views = [];
    this.abort?.abort();
  }

  setPoint(p) {
    this.point = p;
    this.cache = {};
  }

  header() {
    const p = this.point;
    const saved = p && this.app.savedPoint(p);
    if (["forecast", "sounding", "alerts"].includes(this.tab) && p) {
      this.title.textContent = saved?.name || p.name || fmtLatLon(p.lat, p.lon);
      this.sub.textContent = `${fmtLatLon(p.lat, p.lon)}${p.elev != null ? ` · ${fmt("height", p.elev)}` : ""}`;
      this.star.style.display = "";
      this.star.innerHTML = icon(saved ? "starFill" : "star", 18);
      this.star.style.color = saved ? "var(--warn)" : "";
    } else {
      this.title.textContent = { places: "Your places", inbox: "Inbox", forecast: "Forecast", sounding: "Sounding", alerts: "Alerts" }[this.tab];
      this.sub.textContent = { places: "Saved locations and their alerts", inbox: "Notifications sent to you" }[this.tab] || "Tap the map or pick a place";
      this.star.style.display = "none";
    }
  }

  async show(tab) {
    this.tab = tab;
    [...this.tabsEl.children].forEach((b) => { const on = b.dataset.id === tab; b.classList.toggle("sel", on); b.setAttribute("aria-selected", String(on)); });
    this.header();
    this.views?.forEach((v) => v.destroy?.());
    this.views = [];
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    try {
      if (tab === "places") return await this.renderPlaces();
      if (tab === "inbox") return await this.renderInbox();
      if (!this.point) return this.body.append(this.emptyPoint());
      if (tab === "forecast") await this.renderForecast(signal);
      else if (tab === "sounding") await this.renderSounding(signal);
      else if (tab === "alerts") await this.renderAlerts(signal);
    } catch (err) {
      if (err.name === "AbortError") return;
      this.body.replaceChildren(h("div", { class: "warnbox" }, err.status === 503 || err.status === 429 ? "The point-forecast service is busy right now. Try again in a minute." : err.message));
    }
  }

  loading(text) {
    return h("div", { class: "empty" }, h("div", { html: logoSVG({ size: 44, cls: "loading" }) }), text);
  }

  emptyPoint() {
    const saved = this.app.points;
    const el = h("div", { class: "empty" }, h("div", { html: logoSVG({ size: 44 }) }), "Tap anywhere on the map, or pick one of your places.");
    if (saved.length) {
      const list = h("div", { class: "list", style: { marginTop: "16px", textAlign: "left" } });
      for (const p of saved) list.append(h("button", { class: "item", onclick: () => this.app.selectPoint({ ...p }, { fly: true, tab: this.tab }) }, h("div", {}, h("b", {}, p.name), h("small", {}, fmtLatLon(p.lat, p.lon))), h("span", { html: icon("right", 16) })));
      el.append(list);
    }
    return el;
  }

  async renderForecast(signal) {
    const p = this.point;
    this.body.append(this.loading("Gathering every model…"));
    const key = `mg`;
    const data = this.cache[key] || (this.cache[key] = await get(`/point/meteogram?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}${p.elev != null ? `&elev=${Math.round(p.elev)}` : ""}`, { signal }));
    if (signal.aborted) return;
    this.body.replaceChildren();
    const box = h("div");
    this.body.append(box);
    const mg = new Meteogram(this.app, box);
    this.views.push(mg);
    mg.set(data, p);
    this.body.append(h("p", { class: "note" }, "Point forecasts from Open-Meteo. The band shows the spread between models; the dashed blue line is freezing."));
  }

  async renderSounding(signal) {
    const p = this.point, app = this.app;
    const models = app.catalog.soundingModels.filter((m) => !m.region || (p.lat > 20 && p.lat < 54 && p.lon > -135 && p.lon < -60));
    let model = app.prefs.sndModel && models.find((m) => m.id === app.prefs.sndModel) ? app.prefs.sndModel : models[0].id;
    const segEl = h("div", { class: "seg", style: { marginBottom: "10px", flexWrap: "wrap" } });
    const box = h("div");
    const load = async () => {
      [...segEl.children].forEach((b) => b.classList.toggle("sel", b.dataset.id === model));
      box.replaceChildren(this.loading("Lifting a parcel…"));
      const key = `snd:${model}`;
      try {
        const data = this.cache[key] || (this.cache[key] = await get(`/point/sounding?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&model=${model}`, { signal }));
        if (signal.aborted) return;
        box.replaceChildren();
        const snd = new Sounding(app, box);
        this.views.forEach((v) => v.destroy?.());
        this.views = [snd];
        snd.set(data, app.currentTime().getTime());
      } catch (err) {
        if (err.name !== "AbortError") box.replaceChildren(h("div", { class: "warnbox" }, err.message));
      }
    };
    for (const m of models) segEl.append(h("button", { "data-id": m.id, onclick: () => { model = m.id; app.savePref("sndModel", m.id); load(); } }, m.name));
    this.body.append(segEl, box);
    await load();
  }

  async renderAlerts(signal) {
    const p = this.point;
    this.body.append(this.loading("Checking the National Weather Service…"));
    let alerts = [];
    try { alerts = (await get(`/alerts/point?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`, { signal })).alerts; } catch (err) {
      if (err.name === "AbortError") return;
      this.body.replaceChildren(h("div", { class: "warnbox" }, err.status === 404 ? "NWS alerts cover the United States only." : err.message));
      return;
    }
    this.body.replaceChildren();
    if (!alerts.length) {
      this.body.append(h("div", { class: "empty" }, h("div", { html: icon("check", 34), style: { color: "var(--ok)", display: "grid", placeItems: "center", marginBottom: "8px" } }), "No active watches, warnings or advisories here."));
      return;
    }
    const list = h("div", { class: "list" });
    for (const a of alerts) list.append(this.alertItem(a));
    this.body.append(list);
  }

  alertItem(a, expand = false) {
    const detail = h("div", { style: { display: "none", gridColumn: "1 / -1", marginTop: "8px", whiteSpace: "pre-wrap", fontSize: "12.5px", color: "var(--text-2)", lineHeight: 1.5 } });
    const el = h("button", { class: "item", style: { gridTemplateColumns: "auto 1fr auto", borderLeft: `3px solid ${a.color}` } },
      h("span", { html: icon("alert", 18), style: { color: a.color } }),
      h("div", {}, h("b", {}, a.event), h("small", {}, `${a.ends ? `Until ${full(new Date(a.ends))}` : "Until further notice"}${a.sender ? ` · ${a.sender}` : ""}`)),
      h("span", { class: "pill" }, a.severity), detail);
    el.addEventListener("click", async () => {
      if (detail.style.display !== "none") { detail.style.display = "none"; return; }
      detail.style.display = "";
      if (!detail.textContent) {
        detail.textContent = "Loading…";
        try {
          const d = await get(`/alerts/detail?id=${encodeURIComponent(a.id)}`);
          detail.textContent = [d.headline, d.description, d.instruction ? `What to do: ${d.instruction}` : ""].filter(Boolean).join("\n\n");
        } catch (err) { detail.textContent = err.message; }
      }
    });
    if (expand) el.click();
    return el;
  }

  async renderPlaces() {
    const app = this.app;
    const pts = app.points;
    if (!pts.length) {
      this.body.append(h("div", { class: "empty" }, h("div", { html: logoSVG({ size: 44 }) }), "No saved places yet. Tap the map, then the star, to save one.",
        h("div", { style: { marginTop: "14px" } }, h("button", { class: "btn", onclick: () => app.locate() }, h("span", { html: icon("locate", 16) }), "Use my location"))));
      return;
    }
    const list = h("div", { class: "list" });
    for (const p of pts) {
      const val = app.layers.current ? app.layers.sample(p.lon, p.lat) : null;
      list.append(h("div", { class: "item", style: { gridTemplateColumns: "1fr auto auto" } },
        h("button", { style: { textAlign: "left" }, onclick: () => app.selectPoint({ ...p }, { fly: true, tab: "forecast" }) }, h("b", {}, p.name), h("small", {}, fmtLatLon(p.lat, p.lon))),
        h("span", { class: "val num" }, val ? app.formatSample(val) : ""),
        h("button", { class: "closex", title: "Remove", html: icon("trash", 16), onclick: async (e) => {
          e.stopPropagation();
          await del(`/points/${p.id}`).catch(toastError);
          await app.loadPoints();
          this.show("places");
        } })));
    }
    this.body.append(list, h("p", { class: "note", style: { marginTop: "12px" } }, "Set up alerts for these places in Settings → Notifications."),
      h("button", { class: "btn sm", onclick: () => app.openSettings("notifications") }, h("span", { html: icon("bell", 14) }), "Notification rules"));
  }

  async renderInbox() {
    const items = await get("/notifications");
    if (!items.length) { this.body.append(h("div", { class: "empty" }, h("div", { html: icon("bell", 34), style: { display: "grid", placeItems: "center", marginBottom: "8px", opacity: 0.6 } }), "Nothing yet. Alerts and new-run notices show up here.")); }
    else {
      const list = h("div", { class: "list" });
      for (const n of items) {
        list.append(h("button", { class: "item", style: { opacity: n.read ? 0.75 : 1 }, onclick: () => this.app.openNotification(n) },
          h("div", {}, h("b", {}, n.title), h("small", { style: { display: "block", marginTop: "2px", color: "var(--text-2)" } }, n.body), h("small", {}, ago(n.at * 1000))),
          n.read ? null : h("i", { style: { width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent)" } })));
      }
      this.body.append(list);
      post("/notifications/read").then(() => this.app.setUnread(0)).catch(() => {});
    }
    this.body.append(h("div", { class: "row", style: { marginTop: "12px" } },
      h("button", { class: "btn sm", onclick: () => this.app.openSettings("notifications") }, h("span", { html: icon("settings", 14) }), "Notification settings")));
  }

  async toggleSave() {
    const app = this.app, p = this.point;
    const saved = app.savedPoint(p);
    try {
      if (saved) { await del(`/points/${saved.id}`); toast("Removed from your places"); }
      else {
        const name = await promptDialog("Save this place", { value: p.name || "", placeholder: "Home, Cabin, Work…" });
        if (!name) return;
        await post("/points", { name, lat: p.lat, lon: p.lon, elev: p.elev ?? null });
        toast("Saved", { body: `${name} is in your places.`, type: "ok" });
      }
      await app.loadPoints();
      this.header();
    } catch (err) { toastError(err); }
  }

  swipe() {
    // drag the grab handle down to dismiss on phones
    const grab = $(".grab", this.el);
    let y0 = null, dy = 0;
    const start = (e) => { y0 = e.clientY; dy = 0; this.el.style.transition = "none"; grab.setPointerCapture?.(e.pointerId); };
    const move = (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); this.el.style.transform = `translateY(${dy}px)`; };
    const end = () => { if (y0 == null) return; this.el.style.transition = ""; this.el.style.transform = ""; if (dy > 90) this.close(); y0 = null; };
    for (const el of [grab, $(".dh", this.el)]) {
      el.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse" && !e.target.closest("button")) start(e); });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
}
