// Mammatus app bootstrap and glue.
import { h, $, isMobile, isTouch, debounce, throttle, hashParams, setHash, haversineKm, fmtLatLon, onOutside } from "./util.js";
import * as API from "./api.js";
import { Renderer } from "./engine/renderer.js";
import { Controls } from "./engine/controls.js";
import { decodeBoundaries, decodeStars } from "./data/basemap.js";
import { loadImage } from "./engine/gl.js";
import { Layers } from "./layers.js";
import { setUnits, fmt, compass, toDisplay, label } from "./units.js";
import { setTimeZone, runLabel } from "./time.js";
import { icon } from "./ui/icons.js";
import { logoSVG } from "./ui/logo.js";
import { authFlow } from "./ui/auth.js";
import { Picker } from "./ui/picker.js";
import { Timeline } from "./ui/timeline.js";
import { Legend } from "./ui/legend.js";
import { Drawer } from "./ui/drawer.js";
import { PointCard } from "./ui/pointcard.js";
import { Search } from "./ui/search.js";
import { toast, toastError } from "./ui/toast.js";
import { AlertsLayer } from "./alerts-layer.js";
import { Lightning } from "./lightning.js";
import { Fronts } from "./fronts.js";
import * as pwa from "./pwa.js";
import { sanitizePrefs } from "./prefs.js";
import { LazySky } from "./sky/lazy.js";

const splashMsg = (t) => { const m = $("#splash .msg"); if (m) m.textContent = t; };
const VIEW_KEY = "mm.view";

class App {
  constructor(user, { safe = false } = {}) {
    this.user = user;
    this.prefs = sanitizePrefs(user.prefs);
    // safe mode (after a failed start): leave out the saved layer, view mode and position
    if (safe) { delete this.prefs.lastSource; delete this.prefs.mode; this.safe = true; }
    this.state = { source: null };
    this.points = [];
    this.runs = {};
    this.cities = [];
    this.playing = false;
    this.unread = 0;
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    setUnits(this.prefs.units);
    const lowPower = this.prefs.lowPower ?? (isMobile() || isTouch());
    document.body.classList.toggle("low-power", lowPower);
    const canvas = $("#globe");
    this.renderer = new Renderer(canvas, { lowPower });
    const r = this.renderer;
    const cam = r.camera;
    this.restoreView();
    splashMsg("Loading the planet…");
    const assetsP = Promise.all([
      fetch("/data/boundaries.bin").then((x) => x.arrayBuffer()),
      fetch("/data/stars.bin").then((x) => x.arrayBuffer()),
      fetch("/data/cities.json").then((x) => x.json()),
    ]);
    const [catalog, runs, points] = await Promise.all([API.get("/catalog"), API.get("/runs"), API.get("/points")]);
    this.catalog = catalog;
    this.runs = sortRuns(runs.runs);
    this.points = points;
    setTimeZone(this.prefs.tz || catalog.tz);
    await r.loadEarth(!lowPower);
    const [bnd, stars, cities] = await assetsP;
    r.setStars(decodeStars(stars));
    this.basemap(decodeBoundaries(bnd));
    this.cities = cities.map(([name, adm, cc, lat, lon, pop, rank]) => ({ name, adm, cc, lat, lon, pop, rank }));

    this.overlay = r.labels;
    this.overlay.setCities(cities);
    this.overlay.setPoints(this.points);
    this.layers = new Layers(this);
    this.alerts = new AlertsLayer(this);
    this.lightning = new Lightning(this);
    this.fronts = new Fronts(this);
    this.buildUI();
    this.sky = new LazySky(this);
    this.bindLayers();
    this.bindControls();
    this.bindKeys();
    this.startEvents();

    const deepLink = hashParams();  // read before the app starts rewriting the hash with its own state
    const initial = this.initialSource();
    await this.setSource(initial.source, { fhrTarget: initial.fhr });
    if (this.prefs.alerts !== false) this.alerts.setEnabled(true);
    this.bindOverlays();
    if (this.prefs.lightning) this.setLightning(true);
    if (this.prefs.fronts) this.setFronts(true);
    if (this.prefs.liveClouds !== false) this.loadLiveClouds();
    if (["point", "alert", "layer", "model", "ll", "sky"].some((k) => deepLink.has(k))) this.handleDeepLink(deepLink);
    window.addEventListener("hashchange", () => this.handleDeepLink());
    r.requestRender();
    // hide the splash once the globe has drawn
    await new Promise((res) => { const f = () => { r.removeEventListener("frame", f); res(); }; r.addEventListener("frame", f); r.requestRender(); });
    setTimeout(() => $("#splash")?.classList.add("gone"), 350);
    setTimeout(() => $("#splash")?.remove(), 1400);
    pwa.register(() => toast("Mammatus was updated", { body: "Reload to use the new version.", ms: 0, action: { label: "Reload", fn: () => location.reload() } }));
    pwa.onMessage((m) => { if (m?.type === "open") this.openUrl(m.url); });
    pwa.resync();
    API.get("/notifications?limit=50").then((n) => this.setUnread(n.filter((x) => !x.read).length)).catch(() => {});
  }

  basemap(b) {
    const r = this.renderer;
    const line = (id, color, width, z, minZoom = -9, extra = {}) => r.setLines(`base:${id}`, b[id], { color, width, z, minZoom, halo: 0.6, haloColor: [0, 0, 0, 0.35], ...extra });
    line("coast", [0.86, 0.9, 1, 0.55], 1.0, 1);
    line("countries", [0.86, 0.9, 1, 0.48], 0.95, 2);
    // faint lines skip the halo pass: it was invisible under them and doubled their vertex work
    line("provinces", [0.86, 0.9, 1, 0.28], 0.7, 2, 3, { halo: 0 });
    line("states", [0.86, 0.9, 1, 0.5], 0.9, 2, 2.6);
    line("lakes", [0.86, 0.9, 1, 0.35], 0.7, 2, 3, { halo: 0 });
    line("counties", [0.86, 0.9, 1, 0.16], 0.6, 1, 5.6, { halo: 0 });
    if (this.prefs.counties === false) r.setLineStyle("base:counties", { visible: false });
  }

  restoreView() {
    const cam = this.renderer.camera;
    cam.mode = ["globe", "auto", "map"].includes(this.prefs.mode) ? this.prefs.mode : "auto";
    let v = null;
    try { v = this.safe ? null : JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); } catch { /* private mode or junk */ }
    const ok = v && [v.lon, v.lat, v.zoom].every(Number.isFinite);
    if (ok && this.prefs.rememberView !== false) { cam.lon = v.lon; cam.lat = v.lat; cam.zoom = v.zoom; }
    else { cam.lon = -82.5; cam.lat = 34.5; cam.zoom = 1.5; this.introFly = true; }
    cam.sanitize();
  }

  saveView = debounce(() => {
    const c = this.renderer.camera;
    if (![c.lon, c.lat, c.zoom].every(Number.isFinite)) return;
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lon: +c.lon.toFixed(3), lat: +c.lat.toFixed(3), zoom: +c.zoom.toFixed(2) })); } catch { /* ignore */ }
  }, 800);

  initialSource() {
    const hp = this.safe ? new URLSearchParams() : hashParams();
    const last = this.prefs.lastSource;
    const models = this.catalog.models.map((m) => m.id);
    const pickRun = (m) => this.runs[m]?.[0]?.run;
    // a product id from a link or an older version may not exist (or not for this model)
    const productFor = (m, p) => (this.catalog.products.some((x) => x.id === p && x.models.includes(m)) ? p : "t2m");
    if (hp.get("m") && models.includes(hp.get("m"))) {
      const m = hp.get("m");
      const run = (this.runs[m] || []).find((x) => x.run === hp.get("r")) ? hp.get("r") : pickRun(m);
      const f = hp.get("f") != null ? Number(hp.get("f")) : null;
      if (run) return { source: { type: "model", model: m, run, product: productFor(m, hp.get("p")), pinned: hp.get("r") === run && run !== pickRun(m) }, fhr: Number.isInteger(f) ? f : null };
    }
    if (last?.type === "radar") return { source: { type: "radar" } };
    if (last?.type === "sat" && this.catalog.satellite.some((x) => x.id === last.product)) return { source: last };
    const m = last?.model && models.includes(last.model) && pickRun(last.model) ? last.model : models.find((x) => pickRun(x)) || models[0];
    return { source: { type: "model", model: m, run: pickRun(m), product: productFor(m, last?.product) } };
  }

  model(id) { return this.catalog.models.find((m) => m.id === id); }
  mobile() { return isMobile(); }
  frameMs() { return this.timeline.frameMs(); }
  currentTime() { return this.layers.step()?.time || new Date(); }

  // ------------------------------------------------------------------ UI
  buildUI() {
    const ui = $("#ui");
    this.pill = h("button", { class: "layerpill glass", "aria-haspopup": "dialog", "aria-expanded": "false" },
      h("span", { class: "swatch" }), h("span", { class: "t" }, h("b", {}, "…"), h("span", {}, "")), h("span", { class: "chev", html: icon("chevron", 16) }));
    this.bell = h("button", { class: "iconbtn glass", "aria-label": "Inbox", title: "Inbox", html: icon("bell", 20), onclick: () => this.drawer.open("inbox") });
    this.avatar = h("button", { class: "iconbtn glass", "aria-label": "Settings", title: "Settings", onclick: () => this.openSettings() });
    this.renderAvatar();
    const layersBtn = h("button", { class: "iconbtn glass", "aria-label": "Map layers", title: "Map layers (globe, alerts, labels)", html: icon("layers", 20) });
    const brand = h("button", { class: "brand glass", title: "Mammatus", onclick: () => this.flyHome() }, h("span", { html: logoSVG({ size: 28 }) }), h("span", { class: "word" }, h("b", {}, "Mammatus")));
    const searchBtn = h("button", { class: "iconbtn glass", "aria-label": "Search", title: "Search ( / )", html: icon("search", 20), onclick: () => this.search.open() });
    const placesBtn = h("button", { class: "iconbtn glass hide-m", "aria-label": "Places", title: "Your places", html: icon("star", 20), onclick: () => this.drawer.open("places") });
    ui.append(h("header", { class: "topbar" }, brand, this.pill, h("div", { class: "spacer" }), searchBtn, placesBtn, layersBtn, this.bell, this.avatar));
    this.picker = new Picker(this, this.pill);
    this.search = new Search(this);
    this.layersMenu(layersBtn);

    const cam = this.renderer.camera;
    this.modeBtn = h("button", { "aria-label": "Globe or map", title: "Globe / map (G)", onclick: () => this.cycleMode() });
    ui.append(h("div", { class: "fab glass" },
      h("button", { "aria-label": "Zoom in", title: "Zoom in", html: icon("plus", 18), onclick: () => this.zoomBy(0.8) }),
      h("button", { "aria-label": "Zoom out", title: "Zoom out", html: icon("minus", 18), onclick: () => this.zoomBy(-0.8) }),
      h("hr"), this.modeBtn,
      h("button", { "aria-label": "My location", title: "My location", html: icon("locate", 18), onclick: () => this.locate() })));
    this.renderModeBtn();
    this.timeline = new Timeline(this);
    this.legend = new Legend(this);
    this.drawer = new Drawer(this);
    this.card = new PointCard(this);
    this.readout = h("div", { class: "readout glass-strong" });
    this.attrib = h("div", { class: "attrib" });
    this.loadbar = h("div", { class: "loadingbar" });
    ui.append(this.readout, this.attrib);
    document.body.append(this.loadbar);
  }

  renderAvatar() {
    const n = (this.user.displayName || this.user.username || "?").trim();
    this.avatar.replaceChildren(h("span", { class: "avatar" }, n[0].toUpperCase()));
  }

  layersMenu(btn) {
    const r = this.renderer;
    const menu = h("div", { class: "popover layersmenu glass-strong", role: "dialog", "aria-label": "Map layers" });
    $("#ui").append(menu);
    const row = (ic, title, sub, key, def, apply) => {
      const on = this.prefs[key] ?? def;
      const sw = h("span", { class: `switch${on ? " on" : ""}` });
      const b = h("button", { class: "lrow", role: "switch", "aria-checked": String(on) }, h("span", { html: icon(ic, 18), style: { opacity: 0.8 } }), h("span", { class: "tt" }, h("b", {}, title), h("small", {}, sub)), sw);
      b.addEventListener("click", () => {
        const v = !(this.prefs[key] ?? def);
        sw.classList.toggle("on", v);
        b.setAttribute("aria-checked", String(v));
        this.savePref(key, v);
        apply(v);
      });
      return b;
    };
    const render = () => {
      const cam = r.camera;
      const modeSeg = h("div", { class: "seg", style: { width: "100%", marginBottom: "6px" } }, ...[["globe", "Globe"], ["auto", "Auto"], ["map", "Flat map"]].map(([m, l]) =>
        h("button", { class: cam.mode === m ? "sel" : "", style: { flex: 1 }, onclick: () => {
          this.setMode(m);
          if (this.mobile()) { menu.classList.remove("open"); this._offMenu?.(); } else render();
        } }, l)));
      menu.replaceChildren(h("div", { style: { padding: "6px 6px 4px" } }, modeSeg),
        row("alert", "Weather alerts", "NWS warnings and advisories", "alerts", true, (v) => this.alerts.setEnabled(v)),
        row("bolt", "Lightning", "Live GOES satellite strikes; follows radar loops", "lightning", false, (v) => this.setLightning(v)),
        row("front", "Fronts", "WPC analysis and 48-hour forecast fronts", "fronts", false, (v) => this.setFronts(v)),
        row("cloud", "Live clouds", "Latest satellite clouds on the globe", "liveClouds", true, (v) => (v ? this.loadLiveClouds() : this.clearLiveClouds())),
        row("wind", "Wind animation", "Flowing particles on wind layers", "particles", true, () => this.layers.show(this.layers.index, { crossfade: false })),
        row("pin", "Place labels", "Cities and towns", "cities", true, (v) => this.overlay.setShowCities(v)),
        row("map", "County lines", "When zoomed in", "counties", true, (v) => r.setLineStyle("base:counties", { visible: v })),
        row("globe", "Realistic earth", "Satellite imagery, night lights, atmosphere", "realistic", true, (v) => { r.look.realism = v ? 1 : 0; r.look.styled = v ? 0 : 1; r.requestRender(); }));
      if (pwa.canInstall() && !pwa.isStandalone()) menu.append(h("button", { class: "lrow", onclick: () => pwa.install() }, h("span", { html: icon("download", 18) }), h("span", { class: "tt" }, h("b", {}, "Install app"), h("small", {}, "Full screen, faster start, notifications"))));
    };
    btn.addEventListener("click", () => {
      const open = !menu.classList.contains("open");
      if (open) {
        render();
        const b = btn.getBoundingClientRect();
        menu.style.top = `${b.bottom + 8}px`;
        menu.style.left = `${Math.max(8, Math.min(innerWidth - 298, b.right - 290))}px`;
        menu.style.transformOrigin = "top right";
        this._offMenu?.();
        this._offMenu = onOutside(menu, () => { menu.classList.remove("open"); this._offMenu?.(); }, [btn]);
      } else this._offMenu?.();
      menu.classList.toggle("open", open);
    });
    if (this.prefs.realistic === false) { r.look.realism = 0; r.look.styled = 1; }
    if (this.prefs.cities === false) this.overlay.setShowCities(false);
  }

  renderModeBtn() {
    const m = this.renderer.camera.mode;
    this.modeBtn.innerHTML = icon(m === "map" ? "map" : "globe", 18);
  }

  cycleMode() {
    const cam = this.renderer.camera;
    const t = cam.derived().t;
    // Toggle between a 3D globe and a flat map; "auto" morphs by zoom.
    this.setMode(cam.mode === "auto" ? (t > 0.5 ? "globe" : "map") : cam.mode === "globe" ? "map" : "globe");
  }

  setMode(m) {
    const cam = this.renderer.camera;
    cam.setMode(m);
    if (m === "globe" && cam.zoom > 6) cam.flyTo({ lon: cam.lon, lat: cam.lat, zoom: 3.2 }, 1000);
    this.savePref("mode", m);
    this.renderModeBtn();
    this.renderer.poke();
  }

  zoomBy(dz) {
    const cam = this.renderer.camera;
    cam.zoomAt(cam.w / 2, cam.h / 2, dz, 320);
    this.renderer.poke();
  }

  flyHome() {
    const home = this.points[0];
    const cam = this.renderer.camera;
    if (home) cam.flyTo({ lon: home.lon, lat: home.lat, zoom: 6.4 });
    else cam.fitBounds([-126, 23, -66, 50]);
    this.renderer.poke();
  }

  // Sky view for a point (the selected one, else the map centre)
  openSky(p = null) {
    const cam = this.renderer.camera;
    p ||= this.selected || { lat: cam.lat, lon: cam.lon, name: this.nearestCity(cam.lat, cam.lon, 25)?.name || null };
    if (!p.name) p = { ...p, name: this.nearestCity(p.lat, p.lon, 25)?.name || null };
    this.selected = p;
    cam.flyTo({ lon: p.lon, lat: p.lat, zoom: Math.max(Math.min(cam.zoom, 8.2), 7.6) }, 650);
    this.renderer.poke();
    this.sky.enter(p)?.catch?.((err) => toastError(err, "Sky view isn't available"));
  }

  locate() {
    if (!navigator.geolocation) return toast("Location isn't available in this browser", { type: "error" });
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      this.selectPoint({ lat, lon, name: this.nearestCity(lat, lon)?.name || "My location" }, { fly: true, card: true });
    }, (err) => toast("Couldn't get your location", { body: err.code === 1 ? "Location permission was denied." : "Try again in a moment.", type: "error" }), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  // ------------------------------------------------------------------ source & time
  async setSource(src, { fhrTarget = null } = {}) {
    this.stopPlay();
    this.state.source = src;
    this.picker.updatePill();
    this.legend.render();
    this.updateAttribution();
    if (src.type === "model") this.savePref("lastSource", { type: "model", model: src.model, product: src.product });
    else this.savePref("lastSource", src);
    if (src.type === "model") this.savePref("lastProduct", src.product);
    // live clouds are the satellite layer itself when a satellite product is chosen
    if (src.type !== "sat") { if (this.prefs.liveClouds !== false) this.loadLiveClouds(); else this.clearLiveClouds(); }
        try { await this.layers.setSource({ ...src, fhr: fhrTarget }); } catch (err) { toastError(err, "Couldn't load that layer"); }
    if (this.alerts?.enabled) this.alerts.draw();
    this.syncOverlays(null);
    this.updateHash();
  }

  bindLayers() {
    const L = this.layers;
    L.addEventListener("steps", (e) => this.timeline.setSteps(e.detail));
    L.addEventListener("index", (e) => {
      this.timeline.setIndex(e.detail.index, e.detail.step);
      this.updateHash();
      this.syncOverlays(this._lastIndex);
      this._lastIndex = e.detail.index;
    });
    L.addEventListener("source", () => { this._lastIndex = null; });
    L.addEventListener("frame", () => { this.card.update(); this.timeline.renderLoaded(); this.updateAttribution(); });
    L.addEventListener("loaded", throttle(() => this.timeline.renderLoaded(), 200));
    L.addEventListener("loading", (e) => {
      const n = e.detail;
      clearTimeout(this._lb);
      if (n > 0) { this._lb = setTimeout(() => { this.loadbar.classList.add("on"); this.loadbar.style.width = "70%"; }, 180); }
      else { this.loadbar.style.width = "100%"; this._lb = setTimeout(() => { this.loadbar.classList.remove("on"); this.loadbar.style.width = "0"; }, 300); }
    });
    L.addEventListener("error", (e) => {
      const { status, message } = e.detail;
      if (this.playing) return;
      if (status === 404) toast("This hour isn't available yet", { body: "The model may still be publishing it.", type: "error", ms: 3000 });
      else if (status !== 0) toast("Couldn't build this frame", { body: message, type: "error" });
    });
  }

  showIndex(i, { scrub = false } = {}) {
    if (!scrub) this.stopPlay();
    this.layers.show(i, { crossfade: !scrub });
  }

  stepBy(d) {
    const n = this.layers.steps.length;
    if (!n) return;
    this.showIndex((this.layers.index + d + n) % n);
  }

  jumpToNow() {
    const s = this.layers.steps;
    if (!s.length) return;
    let best = 0, bd = Infinity;
    const now = Date.now();
    s.forEach((st, i) => { const d = Math.abs(st.time - now); if (d < bd) { bd = d; best = i; } });
    if (this.state.source.type !== "model") best = s.length - 1;
    this.showIndex(best);
  }

  togglePlay() { this.playing ? this.stopPlay() : this.startPlay(); }

  startPlay() {
    if (this.layers.steps.length < 2) return;
    this.playing = true;
    this.renderer.poke();
    this.timeline.setPlaying(true);
    this.layers.prefetch();
    const tick = async () => {
      if (!this.playing) return;
      const L = this.layers;
      const n = L.steps.length;
      let next = L.index + 1;
      let hold = this.frameMs();
      if (next >= n) { next = 0; }
      if (next === n - 1) hold = this.frameMs() + 900;  // linger on the last frame
      if (!L.isLoaded(next)) {
        this.timeline.setPlaying(true, true);
        try { await L.ensure(next); } catch { /* skip missing */ }
        if (!this.playing) return;
        this.timeline.setPlaying(true, false);
      }
      // with the Sky view open the timeline keeps its pace: the next hour's sky is fetched before the step,
      // and the step after waits until the clouds have finished moving into this one
      const sky = this.sky?.isOpen ? this.sky : null;
      if (sky) {
        const wait = sky.ensure(L.steps[next].time);
        let late = false;
        const spin = setTimeout(() => { late = true; this.timeline.setPlaying(true, true); }, 250);
        await wait;
        clearTimeout(spin);
        if (!this.playing) return;
        if (late) this.timeline.setPlaying(true, false);
      }
      const t0 = performance.now();
      await L.show(next);
      if (!this.playing) return;
      this.renderer.poke();
      if (sky?.isOpen) await sky.shown();
      if (!this.playing) return;
      this._play = setTimeout(tick, Math.max(sky ? 0 : 30, hold - (performance.now() - t0)));
    };
    this._play = setTimeout(tick, 60);
  }

  stopPlay() {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this._play);
    this.timeline?.setPlaying(false);
    this.syncOverlays(null);
  }

  // ------------------------------------------------------------------ map interaction
  bindControls() {
    const r = this.renderer;
    const c = new Controls($("#globe"), r);
    const cam = r.camera;
    c.addEventListener("tap", (e) => {
      const p = cam.unproject(e.detail.x, e.detail.y);
      if (!p) { this.card.close(); return; }
      this.picker.toggle(false);
      const city = this.nearestCity(p.lat, p.lon, Math.max(4, 40 / Math.pow(2, cam.zoom - 6)));
      this.selectPoint({ lat: p.lat, lon: p.lon, name: city ? city.name : null }, { card: true });
    });
    c.addEventListener("longpress", (e) => {
      const p = cam.unproject(e.detail.x, e.detail.y);
      if (p) this.selectPoint({ lat: p.lat, lon: p.lon, name: this.nearestCity(p.lat, p.lon, 15)?.name || null }, { tab: "forecast" });
    });
    let hoverRaf = 0, hoverPt = null;
    c.addEventListener("hover", (e) => {
      hoverPt = e.detail;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; this.hover(hoverPt); });
    });
    c.addEventListener("doubletap", (e) => { cam.zoomAt(e.detail.x, e.detail.y, 1, 300); r.poke(); });
    c.addEventListener("zoomout", (e) => { cam.zoomAt(e.detail.x, e.detail.y, -1, 300); r.poke(); });
    c.addEventListener("move", () => { this.readout.classList.remove("on"); if (this.introFly) this.introFly = false; this.lightning?.wake(); });
    c.addEventListener("tap", () => this.lightning?.wake());
    this.controls = c;
    // settle detection: any camera change, debounced
    let lastV = -1;
    const settled = debounce(() => {
      this.layers.onCameraSettled();
      this.lightning?.onCameraSettled();
      this.saveView();
      this.updateHash();
      if (Math.abs(this._tlLat - cam.lat) > 8 || Math.abs(this._tlLon - cam.lon) > 15) { this._tlLat = cam.lat; this._tlLon = cam.lon; this.timeline.setSteps(this.layers.steps); this.timeline.setIndex(this.layers.index, this.layers.step()); }
    }, 260);
    this._tlLat = cam.lat; this._tlLon = cam.lon;
    r.addEventListener("frame", () => { if (cam.version !== lastV) { lastV = cam.version; settled(); } });
    window.addEventListener("resize", debounce(() => { this.timeline.setSteps(this.layers.steps); this.timeline.setIndex(this.layers.index, this.layers.step()); }, 200));
    if (this.introFly) {
      setTimeout(() => {
        if (!this.introFly) return;
        const home = this.points[0];
        cam.flyTo(home ? { lon: home.lon, lat: home.lat, zoom: 5.2 } : { lon: -96, lat: 38, zoom: 3.6 }, 2600);
        r.poke();
      }, 900);
    }
  }

  hover(p) {
    if (!p || this.mobile()) { this.readout.classList.remove("on"); this.legend.hover(null); return; }
    const ll = this.renderer.camera.unproject(p.x, p.y);
    const v = ll && this.layers.sample(ll.lon, ll.lat);
    if (!v) { this.readout.classList.remove("on"); this.legend.hover(null); return; }
    this.readout.innerHTML = this.formatSample(v);
    this.readout.style.left = `${p.x}px`;
    this.readout.style.top = `${p.y}px`;
    this.readout.classList.add("on");
    this.legend.hover(v.value ?? v.speed ?? null);
  }

  formatSample(v, big = false) {
    const s = this.state.source;
    if (!s) return "";
    const cm = s.type === "radar" ? this.catalog.colormaps.mrms : this.catalog.colormaps[this.layers.product()?.cmap];
    const kind = cm?.unit;
    const sm = (t) => (big ? `<small>${t}</small>` : `<small>${t}</small>`);
    if (v.cat != null) {
      if (v.rate < 0.01 || v.cat === 0) return `Dry`;
      const name = cm.categories?.find((c) => c.id === v.cat)?.name || "Precip";
      return `${name}${sm(fmt("rate", v.rate))}`;
    }
    if (v.speed != null) return `${fmt("wind", v.speed, { unit: false })}${sm(`${label("wind")} ${compass(v.dir)}`)}`;
    if (kind === "refl" && v.value < 5) return `—${sm("no echo")}`;
    if (kind === "temp") return `${Math.round(toDisplay("temp", v.value))}°${sm(label("temp"))}`;
    return `${fmt(kind, v.value, { unit: false })}${sm(label(kind))}`;
  }

  nearestCity(lat, lon, maxKm = 30) {
    let best = null, bd = maxKm;
    for (const c of this.cities) {
      if (Math.abs(c.lat - lat) > 1 || Math.abs(c.lon - lon) > 1.5) continue;
      const d = haversineKm(lat, lon, c.lat, c.lon) * (1 + c.rank * 0.04);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  savedPoint(p) { return this.points.find((x) => Math.abs(x.lat - p.lat) < 0.002 && Math.abs(x.lon - p.lon) < 0.002) || (p.id && this.points.find((x) => x.id === p.id)); }

  selectPoint(p, { fly = false, card = false, tab = null } = {}) {
    const cam = this.renderer.camera;
    if (fly) { cam.flyTo({ lon: p.lon, lat: p.lat, zoom: Math.max(cam.zoom, 6.2) }); this.renderer.poke(); }
    this.selected = p;
    if (card) {
      if (this.mobile() && this.drawer.isOpen()) this.drawer.close();
      this.card.show(p);
    }
    if (tab) {
      this.card.close(false);
      this.drawer.setPoint(p);
      this.drawer.open(tab);
    } else if (this.drawer.isOpen() && ["forecast", "sounding", "alerts"].includes(this.drawer.tab)) {
      this.drawer.setPoint(p);
      this.drawer.show(this.drawer.tab);
    }
  }

  onDrawer(open) {
    document.body.classList.toggle("drawer-open", open);
    if (open && this.mobile()) this.card.close(false);
  }

  async loadPoints() {
    this.points = await API.get("/points");
    this.overlay.setPoints(this.points);
  }

  // ------------------------------------------------------------------ observation overlays (lightning, fronts)
  bindOverlays() {
    const legendRows = () => this.legend.renderOverlays(this.lightning.info(), this.fronts.info());
    this.lightning.addEventListener("status", () => { legendRows(); if (this.card.el) this.card.update(); });
    this.fronts.addEventListener("status", legendRows);
    this.lightning.addEventListener("flash", () => {
      const ic = document.querySelector(".legend .ovl-ic.bolt");
      if (!ic) return;
      ic.classList.remove("flash");
      void ic.offsetWidth;
      ic.classList.add("flash");
    });
    // the live window slides even when nothing else changes
    setInterval(() => { if (!document.hidden && this.lightning.enabled) { this.syncOverlays(null, true); } }, 60000);
  }

  async setLightning(on) {
    await this.lightning.setEnabled(on);
    if (on && !this.lightning.available) toast("Lightning is turned off on this server", { type: "error" });
    this.syncOverlays(null);
    this.updateAttribution();
    this.card.update();
  }

  async setFronts(on) {
    await this.fronts.setEnabled(on);
    this.syncOverlays(null);
    this.updateAttribution();
  }

  // Keep lightning and fronts in step with the displayed time.
  // prevIndex: the previous timeline index, so a single step forward can flash the strikes it reveals.
  syncOverlays(prevIndex, quiet = false) {
    const s = this.state.source, L = this.layers;
    if (!s || !L) return;
    const step = L.step();
    const nowS = Date.now() / 1000;
    const T = step ? step.time.getTime() / 1000 : nowS;
    if (this.lightning.enabled) {
      let mode = "off", window = 1800, prevT = null, spread = 0.9;
      if (s.type === "model") {
        if (Math.abs(T - nowS) <= 5400) mode = "live";
      } else {
        const st = L.steps;
        const spacing = st.length > 1 ? (st[st.length - 1].time - st[0].time) / 1000 / (st.length - 1) : 600;
        window = Math.max(600, Math.min(3600, spacing * 2.5));
        // the newest radar or satellite frame shows live lightning; stepping back shows what led up to each frame
        if (L.index === st.length - 1 && !this.playing) { mode = "live"; window = Math.min(1800, Math.max(900, window)); }
        else {
          mode = "step";
          if (prevIndex != null && L.index === prevIndex + 1 && st[prevIndex]) {
            prevT = st[prevIndex].time.getTime() / 1000;
            spread = this.playing ? Math.min(1.6, (this.frameMs() / 1000) * 0.85) : 0.9;
          }
        }
      }
      if (!(quiet && mode === "step")) this.lightning.sync({ mode, T, prevT, window, spread });
    }
    if (this.fronts.enabled) {
      const modelCenters = s.type === "model" && (L.product()?.contours || []).some((c) => c.hilo && c.models.includes(s.model));
      this.fronts.sync(T * 1000, { centers: !modelCenters });
    }
  }

  lightningLine(p) {
    const n = this.lightning?.nearest(p.lon, p.lat);
    if (!n) return null;
    const mins = Math.round(n.window / 60);
    if (n.km == null) return { text: `No lightning within ${fmt("vis", 80000)} in the last ${mins} min`, close: false };
    const ago = n.age < 90 ? "just now" : `${Math.round(n.age / 60)} min ago`;
    return { text: `Lightning ${fmt("vis", n.km * 1000)} away · ${ago}`, close: n.km < 16 };
  }

  // ------------------------------------------------------------------ live clouds
  async loadLiveClouds() {
    const now = Date.now();
    if (this._clouds && now - this._clouds.at < 30 * 60000) { if (this.state.source?.type !== "sat") { this.renderer.setClouds(this._clouds.img); this.renderer.look.clouds = 0.85; } return; }
    try {
      const { times } = await API.get("/sat/globalir/times?count=1", { quiet: true });
      const stamp = times[times.length - 1];
      const img = await loadImage(`/api/sat/globalir/${stamp}.webp?v=2`);
      this._clouds = { img, at: now };
      if (this.state.source?.type !== "sat" && this.prefs.liveClouds !== false) { this.renderer.setClouds(img); this.renderer.look.clouds = 0.85; this.renderer.requestRender(); }
    } catch { /* clouds are decoration */ }
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => { if (this.prefs.liveClouds !== false && !document.hidden) this.loadLiveClouds(); }, 31 * 60000);
  }

  clearLiveClouds() {
    if (this.state.source?.type === "sat") return;
    this.renderer.setClouds(null);
    this.renderer.requestRender();
  }

  // ------------------------------------------------------------------ server events (only while visible)
  startEvents() {
    const open = () => {
      if (this.es || document.hidden) return;
      this.es = new EventSource("/api/events");
      this.es.addEventListener("runs", (e) => this.onRun(JSON.parse(e.data)));
      this.es.addEventListener("notification", (e) => this.onNotification(JSON.parse(e.data)));
    };
    const close = () => { this.es?.close(); this.es = null; };
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", async () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        close();
        this.stopPlay();
        // frames queued ahead of the timeline would otherwise keep downloading in the background
        this.layers?.store.cancelPending((j) => j.priority >= 5);
        return;
      }
      open();
      this.layers?.prefetch();
      // catch up on anything missed while hidden (a glance at the phone needs no round trip)
      if (Date.now() - hiddenAt < 60000) return;
      try { this.applyRuns(sortRuns((await API.get("/runs", { quiet: true })).runs)); } catch { /* offline */ }
    });
    open();
  }

  applyRuns(runs) {
    const old = this.runs;
    this.runs = runs;
    const s = this.state.source;
    if (s?.type !== "model") return;
    const latest = runs[s.model]?.[0];
    const cur = runs[s.model]?.find((r) => r.run === s.run);
    const prevCur = old[s.model]?.find((r) => r.run === s.run);
    if (cur && prevCur && cur.steps.length !== prevCur.steps.length) {
      const fhr = this.layers.step()?.fhr;
      this.layers.setSource({ ...s, fhr }, true).catch(() => {});
    }
    if (latest && latest.run !== s.run && !s.pinned && old[s.model]?.[0]?.run !== latest.run && latest.steps.length >= Math.min(12, this.runs[s.model]?.[1]?.steps.length || 12)) {
      toast(`New ${this.model(s.model).short} ${runLabel(latest.run).split(" ")[0]} run`, { body: `${latest.steps.length} hours ready.`, action: { label: "Load", fn: () => this.setSource({ ...s, run: latest.run, pinned: false }) }, ms: 9000 });
    }
    if (this.picker.el.classList.contains("open")) this.picker.render();
  }

  onRun({ model, run }) {
    const runs = { ...this.runs };
    const list = [...(runs[model] || [])];
    const i = list.findIndex((r) => r.run === run.run);
    if (i >= 0) list[i] = run; else list.push(run);
    runs[model] = list.sort((a, b) => b.run.localeCompare(a.run));
    this.applyRuns(runs);
  }

  onNotification(n) {
    this.setUnread(this.unread + 1);
    toast(n.title, { body: n.body, ms: 8000, action: n.data?.url ? { label: "View", fn: () => this.openUrl(n.data.url) } : null });
  }

  setUnread(n) {
    this.unread = n;
    this.bell.querySelector(".badge")?.remove();
    if (n > 0) this.bell.append(h("span", { class: "badge" }, n > 9 ? "9+" : String(n)));
  }

  openNotification(n) {
    if (n.data?.url) this.openUrl(n.data.url);
  }

  openUrl(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin) return;
      history.replaceState(null, "", u.pathname + u.hash);
      this.handleDeepLink();
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ deep links & hash state
  handleDeepLink(params = null) {
    const hp = params || hashParams();
    // a link that picks the view wins over the first-visit fly-in, which is still on a timer at startup
    if (["point", "alert", "ll", "sky"].some((k) => hp.has(k))) this.introFly = false;
    if (hp.get("sky")) {
      const [lat, lon] = hp.get("sky").split(",").map(Number);
      const same = this.sky.isOpen && this.sky.p && Math.abs(this.sky.p.lat - lat) < 1e-3 && Math.abs(this.sky.p.lon - lon) < 1e-3;
      if (!same && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 89 && Math.abs(lon) <= 180) {
        const saved = this.savedPoint({ lat, lon });
        const p = saved ? { ...saved } : { lat, lon, name: this.nearestCity(lat, lon, 25)?.name || null };
        if (this.sky.isOpen) { this.selected = p; this.sky.setPoint(p); } else setTimeout(() => this.openSky(p), 300);
      }
      return;
    }
    if (hp.get("point")) {
      const p = this.points.find((x) => x.id === +hp.get("point"));
      if (p && hp.get("tab") === "sky") { setTimeout(() => this.openSky({ ...p }), 300); return; }
      if (p) this.selectPoint({ ...p }, { fly: true, tab: hp.get("tab") === "meteogram" ? "forecast" : hp.get("tab") || "forecast" });
    } else if (hp.get("alert")) {
      const p = this.points[0];
      if (p) this.selectPoint({ ...p }, { fly: true, tab: "alerts" });
      if (this.prefs.alerts === false) { this.savePref("alerts", true); this.alerts.setEnabled(true); }
    } else if (hp.get("layer") === "radar") {
      this.setSource({ type: "radar" });
    } else if (hp.get("model") && hp.get("run")) {
      const m = hp.get("model");
      if (this.model(m)) this.setSource({ type: "model", model: m, run: hp.get("run"), product: this.state.source?.product || "t2m", pinned: true });
    } else if (hp.get("ll")) {
      const [lat, lon, z] = hp.get("ll").split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const cam = this.renderer.camera;
        cam.cancelAnimation();
        cam.setCenter(lon, lat);
        if (Number.isFinite(z)) cam.zoom = cam.clampZoom(z);
        cam.sanitize();
        cam.changed();
        this.renderer.poke();
      }
      return;
    } else return;
    this._skipHash = 0;
  }

  updateHash = debounce(() => {
    const s = this.state.source, cam = this.renderer.camera;
    if (!s) return;
    const p = {};
    if (s.type === "model") { p.m = s.model; p.p = s.product; if (s.pinned) p.r = s.run; const st = this.layers.step(); if (st) p.f = st.fhr; }
    else p.layer = s.type === "radar" ? "radar" : `sat:${s.product}`;
    p.ll = `${cam.lat.toFixed(2)},${cam.lon.toFixed(2)},${cam.zoom.toFixed(1)}`;
    if (p.layer && p.layer.startsWith("sat")) delete p.layer;
    if (this.sky?.isOpen && this.sky.p) p.sky = `${this.sky.p.lat.toFixed(3)},${this.sky.p.lon.toFixed(3)}`;
    setHash(p);
  }, 400);

  updateAttribution() {
    if (this.sky?.isOpen) return;
    const s = this.state.source;
    let t = "";
    if (s?.type === "model") { const m = this.model(s.model); t = `${m.name}${m.attribution ? ` · ${m.attribution}` : " · NOAA"}`; }
    else if (s?.type === "radar") t = "NOAA MRMS";
    else if (s?.type === "sat") t = this.catalog.satAttribution;
    if (this.prefs.liveClouds !== false && s?.type !== "sat") t += " · Clouds: SSEC RealEarth";
    if (this.lightning?.enabled) t += " · Lightning: NOAA GOES GLM";
    if (this.fronts?.enabled) t += " · Fronts: NOAA WPC";
    this.attrib.textContent = t;
  }

  // ------------------------------------------------------------------ keyboard
  bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector(".modal-back")) return;
      if (this.sky?.key(e)) { e.preventDefault(); return; }
      const k = e.key;
      if (k === " ") { e.preventDefault(); this.togglePlay(); }
      else if (k === "ArrowRight") { e.preventDefault(); this.stepBy(1); }
      else if (k === "ArrowLeft") { e.preventDefault(); this.stepBy(-1); }
      else if (k === "/") { e.preventDefault(); this.search.open(); }
      else if (k === "l" || k === "L") this.picker.toggle();
      else if (k === "g" || k === "G") this.cycleMode();
      else if (k === "s" || k === "S") this.openSky();
      else if ((k === "f" || k === "F") && this.selected) this.selectPoint(this.selected, { tab: "forecast" });
      else if (k === "+" || k === "=") this.zoomBy(0.6);
      else if (k === "-") this.zoomBy(-0.6);
      else if (k === "Escape") { this.search.close(); this.picker.toggle(false); if (this.card.el) this.card.close(); else if (this.drawer.isOpen()) this.drawer.close(); }
    });
  }

  // ------------------------------------------------------------------ prefs
  savePref(key, value, quick = false) {
    if (JSON.stringify(this.prefs[key]) === JSON.stringify(value)) return;
    this.prefs[key] = value;
    clearTimeout(this._prefT);
    this._prefT = setTimeout(() => API.patch("/auth/me", { prefs: this.prefs }).catch(() => {}), quick ? 600 : 1200);
  }

  applyOpacity() {
    const f = this.renderer.field;
    if (f) { f.opacity = this.prefs.opacity ?? 0.88; this.renderer.requestRender(); }
  }

  onUnitsChanged() {
    this.legend.render();
    this.card.update();
    this.timeline.setSteps(this.layers.steps);
    this.timeline.setIndex(this.layers.index, this.layers.step());
    if (this.drawer.isOpen()) this.drawer.show(this.drawer.tab);
  }

  async openSettings(section) {
    const { openSettings } = await import("./ui/settings.js");
    openSettings(this, section);
  }

  async logout() {
    await pwa.unsubscribe().catch(() => {});
    await API.post("/auth/logout").catch(() => {});
    location.replace("/");
  }
}

function sortRuns(r) {
  const out = {};
  for (const [m, list] of Object.entries(r || {})) out[m] = [...list].sort((a, b) => b.run.localeCompare(a.run));
  return out;
}

// ------------------------------------------------------------------ start
async function start() {
  API.onUnauthorized(() => location.reload());
  let state;
  for (let attempt = 0; ; attempt++) {
    try { state = await API.get("/auth/state"); break; } catch (err) {
      splashMsg(err.message + " Retrying…");
      await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * 2 ** attempt)));
    }
  }
  if (!state.user) {
    $("#splash")?.classList.add("gone");
    await authFlow(state);
    state = await API.get("/auth/state");
    const s = $("#splash");
    if (s) { s.classList.remove("gone"); }
  }
  let safe = false;
  try { safe = sessionStorage.getItem("mm.safe") === "1"; } catch { /* storage blocked */ }
  const app = new App(state.user, { safe });
  window.mammatus = app;
  try {
    await app.boot();
    try { sessionStorage.removeItem("mm.safe"); } catch { /* ignore */ }
  } catch (err) {
    console.error(err);
    const webgl = /WebGL/.test(err.message);
    // one automatic retry without the saved layer, view and position, which are what a bad
    // saved state or link usually comes down to
    if (!webgl && !safe) {
      try { sessionStorage.setItem("mm.safe", "1"); history.replaceState(null, "", location.pathname); location.reload(); return; } catch { /* fall through */ }
    }
    splashMsg(webgl ? "This browser can't run WebGL2, which Mammatus needs for the globe." : `Couldn't start: ${err.message}`);
  }
}

start();
