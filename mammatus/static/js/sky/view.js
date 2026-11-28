// Sky view: the atmosphere above a point in 3D. Opened from the point card ("Sky"), the S key or a
// #sky= link; the map's timeline keeps driving the time.
//
// The camera swoops from the map's top-down view into a side view at true scale: the ground at the bottom,
// 52,000 ft at the top, the altitude ruler exact on the point's vertical plane. Pinching out pulls back and
// up to about 100 km across. "From the ground" puts you under the sky at the point, looking up.
import { h, clamp, reducedMotion, isTouch } from "../util.js";
import * as API from "../api.js";
import { icon } from "../ui/icons.js";
import { toast, toastError } from "../ui/toast.js";
import { fmt, units, compass, toDisplay, label } from "../units.js";
import { when } from "../time.js";
import { decodeStars } from "../data/basemap.js";
import { SkyRenderer, M4, norm, cross } from "./render.js";
import { Loader, plan, frameIds, mergeBands, flow, inConus, N, NZ, ZTOP } from "./data.js";
import { fetchTerrain, modelTerrain, EARTH_R } from "./terrain.js";
import * as A from "./astro.js";
import { Storm } from "./bolts.js";
import { Ambience } from "./audio.js";

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapDeg = (a) => ((a % 360) + 540) % 360 - 180;
const DRIFT = 4;           // clouds drift at 4x real time
const WRAP = 25.6 * 4096;  // km: the drift offsets start over here (days away), on a multiple of the noise's tiles
const RISE = 0.016, EVOLVE = 0.03, FALL = 0.13;      // km/s: billowing of the cloud shapes, of their fine detail, falling rain
const EXPOSURE = 3.3;      // daylight exposure: a sunlit cloud top just reaches white
const DAY_SKY = 0.0214;    // the low sky's radiance (per unit of sunlight) under a high sun, which that exposure is for
const DUSK_SKY = 0.0004;    // ... and with the sun 3 degrees down
const MOONLIGHT = 0.004;   // the full moon against the sun (really 400 times less again: this is a night you can see)
const hermite = (t) => t * t * (3 - 2 * t);
const H0 = 16.8;           // km of height shown at true scale (ground to just above 52,000 ft)

const MEANING = {
  Fg: "Cloud at ground level: water droplets so dense that visibility drops below a kilometre.",
  St: "A low, flat, grey sheet with a featureless base. Drizzle at most; it forms where moist air is cooled from below or lifted gently.",
  Sc: "Low heaps and rolls joined into a layer, with darker and brighter patches. Usually dry, sometimes light drizzle or flurries.",
  Cu: "Heaps of cloud on rising thermals: flat bases at the condensation level, sunlit cauliflower tops.",
  TCu: "Cumulus growing tall in unstable air. Showers are possible, and some grow into thunderstorms.",
  Cb: "A thunderstorm: from near the ground to the top of the troposphere. Lightning, heavy rain, gusts and possibly hail. The anvil spreads where the updraft meets the stable stratosphere.",
  Ns: "A thick, dark rain or snow cloud with a ragged base. Steady precipitation; the sun is completely hidden.",
  Ac: "Mid-level patches and rolls of small cloudlets, often in rows. On a humid summer morning they can hint at storms later.",
  As: "A grey or bluish mid-level sheet; the sun shows as if through frosted glass, with no halo. Often comes ahead of a warm front.",
  Ci: "High, thin fibres of ice crystals, combed out by the wind aloft. Fair weather, but a thickening deck can mean a front is coming.",
  Cs: "A thin, milky veil of ice crystals high up. It makes halos around the sun and moon, and often precedes rain by 12 to 24 hours.",
  Cc: "Tiny high ripples of ice or supercooled droplets, like fish scales. Short-lived and uncommon.",
};
// heights rounded the way a pilot would read them: 31,200 ft, 9.5 km
function heightOne(m) {
  if (units().height === "m") return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2).replace(/\.?0+$/, "")} km` : `${Math.round(m / 10) * 10} m`;
  const ft = m / 0.3048;
  return `${(Math.round(ft / (ft < 3000 ? 50 : 100)) * (ft < 3000 ? 50 : 100)).toLocaleString()} ft`;
}
function heightRange(a, b) {
  const x = heightOne(a), y = heightOne(b);
  const u = units().height === "m" ? "" : " ft";
  return u && x.endsWith(u) && y.endsWith(u) ? `${x.slice(0, -u.length)}–${y}` : `${x}–${y}`;
}

const PRECIP = { rain: "Rain reaching the ground", snow: "Snow reaching the ground", virga: "Virga: precipitation evaporating before it lands", none: "" };

export class SkyView {
  constructor(app) {
    this.app = app;
    this.isOpen = false;
    this.loader = new Loader();
    this.storm = new Storm();
    this.sound = new Ambience();
    this.view = { mode: "side", heading: 0, zoom: 0, pitchU: 0, look: 22, fov: 74 };
    this.display = { A: null, B: null, mix: 0, morph: null };
    this.frames = new Map();    // key -> decoded frame
    this.blocked = new Set();
    this.bandDrift = [];        // how far each height band's clouds have drifted
    this.rise = 0; this.evo = 0; this.fall = 0;
    this.flows = new Map();     // "A|B|bands" -> how far each band's clouds move between the two frames
    this.waiters = [];
  }

  // Fetch the sky for a point before it is opened (the pointer is on the Sky button): by the time the camera
  // has swooped in, the clouds are usually there.
  prewarm(p) {
    if (this.isOpen || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    try {
      const lat = +p.lat.toFixed(3), lon = +p.lon.toFixed(3);
      const st = this.app.layers.step();
      const pl = plan(this.app, (st?.time || new Date()).getTime() / 1000, lat, lon, { source: this.app.prefs.skySource || "auto" });
      for (const id of new Set(frameIds(pl, lat, lon))) this.loader.get(id).catch(() => {});
    } catch { /* not ready yet */ }
  }

  // ---------------------------------------------------------------- open / close
  async enter(p) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    const app = this.app;
    if (this.isOpen) { this.setPoint(p); return; }
    try {
      if (!this.r) {
        this.canvas = h("canvas", { id: "skycanvas", "aria-label": "Sky view. Drag to look around, pinch or scroll to zoom." });
        document.body.insertBefore(this.canvas, document.getElementById("ui"));
        this.r = new SkyRenderer(this.canvas, { lowPower: app.renderer.lowPower });
        this.r.onLost = () => { if (this.isOpen) { toast("The Sky view lost its graphics context", { type: "error" }); this.exit(true); } };
        this.r.loadEarth(!app.renderer.lowPower);
        fetch("/data/stars.bin").then((x) => x.arrayBuffer()).then((b) => this.r.setStars(decodeStars(b))).catch(() => {});
      }
    } catch (err) {
      toastError(err, "Sky view isn't available");
      return;
    }
    this.isOpen = true;
    this.prefs = app.prefs;
    this.view.mode = app.prefs.skyView === "ground" ? "ground" : "side";
    this.source = app.prefs.skySource || "auto";
    app.card?.close(false);
    if (app.drawer?.isOpen()) app.drawer.close();
    app.stopPlay?.();
    document.body.classList.add("sky-open");
    this.canvas.classList.remove("out");
    this.buildUI();
    this.r.resize();
    this.r.makeNoise();
    this.relief = 0;            // the ground rises out of a level plain once its terrain is in
    this.reliefAnim = null;
    this.setPoint(p, true);
    this.intro = { t0: performance.now(), dur: reducedMotion() ? 10 : 2300, dir: 1 };
    this.canvas.classList.add("in");
    // the map stops drawing underneath (once it has drawn at all: the app's start-up waits on that)
    const pause = () => { if (!this.isOpen || this.leaving) return; if (app.renderer.frames > 0) app.renderer.paused = true; else setTimeout(pause, 300); };
    setTimeout(pause, 700);
    this._onIndex = () => this.onTime();
    app.layers.addEventListener("index", this._onIndex);
    this._onResize = () => { this.r.resize(); this.dirty = true; };
    window.addEventListener("resize", this._onResize);
    this._onPop = () => { if (this.isOpen) this.exit(true); };
    history.pushState({ sky: 1 }, "");
    window.addEventListener("popstate", this._onPop);
    this._onVis = () => { if (document.hidden) this.sound.stop(); else { if (this.prefs.skySound) this.sound.start().catch(() => {}); this.kick(); } };
    document.addEventListener("visibilitychange", this._onVis);
    if (app.prefs.skySound) this.sound.start().catch(() => {});
    if (app.prefs.skyTilt) this.enableTilt(false);
    this.lastInteract = performance.now();
    this.time0 = performance.now();
    this.kick();
    app.updateHash?.();
  }

  exit(fromHistory = false) {
    if (!this.isOpen || this.leaving) return;
    const app = this.app;
    this.leaving = true;
    this.intro = { t0: performance.now(), dur: reducedMotion() ? 10 : 1100, dir: -1 };
    app.renderer.paused = false;
    app.renderer.poke();
    this.canvas.classList.add("out");
    this.ui?.classList.add("out");
    this.exitFab?.classList.add("out");
    this.ambient(false);
    this.sound.stop();
    this.disableTilt();
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(); }      // (the timeline's play loop may be waiting on this sky)
    this.waiters = [];
    if (!fromHistory && history.state?.sky) history.back();
    window.removeEventListener("popstate", this._onPop);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVis);
    app.layers.removeEventListener("index", this._onIndex);
    setTimeout(() => {
      this.isOpen = false;
      this.leaving = false;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      document.body.classList.remove("sky-open");
      this.canvas.classList.remove("in", "out");
      this.ui?.remove();
      this.exitFab?.remove();
      this.ui = null;
      if (app.selected) app.card.show(app.selected);
      app.updateAttribution?.();
      app.updateHash?.();
    }, reducedMotion() ? 50 : 1050);
  }

  setPoint(p, first = false) {
    const lat = +p.lat.toFixed(3), lon = +p.lon.toFixed(3);
    const moved = !this.p || this.p.lat !== lat || this.p.lon !== lon;
    this.p = { ...p, lat, lon };
    this.blocked.clear();
    // another place's clouds don't linger while this one's load: they evaporate at once, and everything said
    // about them (layer names, winds, the freezing level, storms) goes with them
    if (!first && this.display.A && moved) this.vanish = { t0: performance.now(), dur: reducedMotion() ? 1 : 240, D: { ...this.display, morph: null } };
    if (moved || first) {
      this.display = { A: null, B: null, mix: 0, morph: null };
      this.appear = { v: 0, t0: null };
      this.cur = null;
      this.storm.setCells([], 12);
      this.loader.drop((id) => id.endsWith(`@${lat.toFixed(3)},${lon.toFixed(3)}`));
    }
    this.obs = null;
    this.heightOf = null;
    this.headingSet = false;
    this.cityGlow = null;
    this._hazeAt = 0;
    this.tDisp = null;
    this.renderTitle();
    this.renderLayers();
    this.loadTerrain();
    this.onTime();
    if (this.prefs.skyObs !== false) this.loadObserved();
    this.measureCityGlow();
    if (!first) this.kick();
  }

  // ---------------------------------------------------------------- the ground
  // Real terrain around the point (terrain.js). Until it arrives the ground is a level plain; when it does,
  // the land rises into place. If the server has none (turned off, or the tiles can't be reached), the
  // weather model's own coarse terrain stands in, as before.
  loadTerrain() {
    const token = (this._demToken = (this._demToken || 0) + 1);
    this._demAbort?.abort();
    this._demAbort = null;
    this._demKey = null;
    this.demFailed = false;
    const key = `real@${this.p.lat},${this.p.lon}`;
    if (this.dem?.key === key) { this.reliefTo(1, 900); return; }      // the same place again: its ground is still loaded
    if (this.relief > 0) this.reliefTo(0, 320);                         // another place's ground sinks away
    if (this.app.catalog?.sky?.terrain === false) { this.demFailed = true; return; }
    const ac = (this._demAbort = new AbortController());
    fetchTerrain(this.p.lat, this.p.lon, this.r.lowPower ? 512 : 1024, ac.signal).then((t) => this.showTerrain(t, token), (err) => {
      if (err?.name === "AbortError" || token !== this._demToken || !this.isOpen) return;
      this.demFailed = true;
      const f = this.cur || [...this.frames.values()].reverse().find((x) => this.isHere(x));
      if (f && this.isHere(f)) this.useModelTerrain(f);
    });
  }

  isHere(f) { return !!this.p && Math.abs(f.head.lat - this.p.lat) < 1e-3 && Math.abs(f.head.lon - this.p.lon) < 1e-3; }

  useModelTerrain(f) {
    const key = `model:${f.head.model}@${this.p.lat},${this.p.lon}`;
    if (this.dem?.key === key || this._demKey === key) return;
    this._demKey = key;
    this.showTerrain(modelTerrain(f.terrain, N, { elev: f.head.elev, key }), this._demToken);
  }

  async showTerrain(t, token) {
    const pyr = await t.pyramidsLater();
    if (token !== this._demToken || !this.isOpen) return;
    const swap = () => {
      if (token !== this._demToken || !this.isOpen) return;
      this.r.setDem(t, pyr);
      this.dem = t;
      this._demKey = t.key;
      this.reliefTo(1, 1150);
      this.renderTitle();
    };
    // whatever ground is showing sinks first, then the new one rises
    if (this.relief > 0.001) this.reliefTo(0, 320 * this.relief, swap); else swap();
  }

  reliefTo(v, dur, then) {
    this.reliefAnim = { from: this.relief, to: v, t0: performance.now(), dur: reducedMotion() ? 1 : Math.max(1, dur), then };
    this.kick();
  }

  stepRelief(now) {
    const a = this.reliefAnim;
    if (!a) return false;
    const u = clamp((now - a.t0) / a.dur, 0, 1);
    this.relief = lerp(a.from, a.to, ease(u));
    if (u >= 1) {
      this.reliefAnim = null;
      a.then?.();
    }
    return true;
  }

  // ---------------------------------------------------------------- time and data
  currentTime() {
    if (this.amb) return Date.now() / 1000;
    const st = this.app.layers.step();
    return (st?.time || new Date()).getTime() / 1000;
  }

  onTime() {
    if (!this.isOpen || !this.p) return;
    const t = this.currentTime();
    const now = performance.now();
    // the sun and moon move to the new time along with the clouds (a jump of many hours just jumps)
    const dur = this.morphMs();
    if (this.tDisp == null || Math.abs(t - this.tDisp) > 6.5 * 3600 || reducedMotion()) { this.tDisp = t; this.tAnim = null; }
    else if (t !== this.t) this.tAnim = { from: this.tDisp, to: t, t0: now, dur };
    this.t = t;
    const pl = plan(this.app, t, this.p.lat, this.p.lon, { source: this.source, blocked: this.blocked });
    this.plan = pl;
    const [ida, idb] = frameIds(pl, this.p.lat, this.p.lon);
    this.want = { a: ida, b: idb, mix: pl.mix };
    // a change already under way hurries up when something else is wanted now
    const m = this.display.morph;
    if (m && !this.app.playing) m.dur = Math.min(m.dur, now - m.t0 + 180);
    const load = (id) => (this.frames.has(id) ? Promise.resolve() : this.loader.get(id).then((f) => this.got(f)));
    this.loading = !(this.frames.has(ida) && this.frames.has(idb));
    this.renderStatus();
    Promise.all([load(ida), idb !== ida ? load(idb) : null]).then(() => {
      if (this.want?.a === ida && this.want?.b === idb) { this.loading = false; this.renderStatus(); }
      this.prefetch();
    }, (err) => {
      if (this.want?.a !== ida || err.status === -1) return;
      this.loading = false;
      // that model can't do this point (outside its domain, not published, upstream trouble): fall back
      if (pl.kind === "model" && this.source === "auto" && [404, 502, 503, 0].includes(err.status ?? 0)) {
        this.blocked.add(pl.model);
        this.onTime();
        return;
      }
      if (pl.kind === "model" && this.source !== "auto" && err.status === 404) {
        toast(`${pl.model.toUpperCase()} has no sky here`, { body: err.message });
        this.source = "auto";
        this.onTime();
        return;
      }
      this.renderStatus(err.message || "Couldn't load the sky");
    });
    this.kick();
  }

  // how long a change of hour takes on screen: the timeline's own pace while it plays
  morphMs() { return reducedMotion() ? 1 : (this.app.playing ? clamp(this.app.frameMs(), 120, 1500) : 650); }

  // the hours either side of this one (further ahead while the timeline plays), fetched before they are asked for
  prefetch() {
    const L = this.app.layers;
    if (this.amb || !L?.steps?.length || !this.p) return;
    const n = L.steps.length;
    for (const d of this.app.playing ? [1, 2, 3, 4, 5] : [1, -1, 2, -2]) {
      const st = L.steps[this.app.playing ? (L.index + d) % n : L.index + d];
      if (!st) continue;
      const pl = plan(this.app, st.time.getTime() / 1000, this.p.lat, this.p.lon, { source: this.source, blocked: this.blocked });
      for (const id of new Set(frameIds(pl, this.p.lat, this.p.lon))) if (!this.frames.has(id)) this.loader.get(id, false).then((f) => this.got(f), () => {});
    }
  }

  // For the timeline's play loop: resolves when the sky for that time is loaded (or can't be) ...
  async ensure(date) {
    if (!this.isOpen || !this.p || this.amb) return;
    const pl = plan(this.app, date.getTime() / 1000, this.p.lat, this.p.lon, { source: this.source, blocked: this.blocked });
    const ids = [...new Set(frameIds(pl, this.p.lat, this.p.lon))].filter((id) => !this.frames.has(id));
    if (!ids.length) return;
    await Promise.race([
      Promise.all(ids.map((id) => this.loader.get(id).then((f) => this.got(f), () => {}))),
      new Promise((r) => setTimeout(r, 20000)),
    ]);
  }

  // ... and when the change to the current time has finished on screen
  shown() {
    if (!this.isOpen || this.amb) return Promise.resolve();
    return new Promise((resolve) => {
      const w = { resolve, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(); }, 5000) };
      this.waiters.push(w);
      this.kick();
    });
  }

  atTarget() {
    const D = this.display, W = this.want;
    if (!W || D.morph || this.vanish || !D.A) return false;
    if (W.b === W.a || W.mix < 0.002) return D.A === W.a && D.mix < 0.002;
    return D.A === W.a && D.B === W.b && Math.abs(D.mix - W.mix) < 0.004;
  }

  got(f) {
    if (!this.isOpen) return;
    const cap = this.r.lowPower ? 24 : 48;
    this.frames.delete(f.key);
    this.frames.set(f.key, f);
    for (const k of this.frames.keys()) {
      if (this.frames.size <= cap) break;
      if (k !== this.display.A && k !== this.display.B && k !== this.want?.a && k !== this.want?.b) this.frames.delete(k);
    }
    this.r.frame(f.key, f);
    if (this.demFailed && this.isHere(f)) this.useModelTerrain(f);
    this.kick();
  }

  best(id) { return id && this.frames.has(id) ? id : null; }

  // Move what's displayed toward what's wanted. Between two hours the clouds are carried along (each band by
  // how far its clouds really moved between the two) while one hour's cover turns into the other's, so they
  // travel, grow and thin instead of one picture fading out and another in.
  updateDisplay(now) {
    const D = this.display;
    if (this.vanish) {
      if (now - this.vanish.t0 < this.vanish.dur) return true;
      this.vanish = null;
    }
    if (D.morph) {
      const m = D.morph;
      const u = clamp((now - m.t0) / m.dur, 0, 1);
      D.mix = lerp(m.from, m.to, m.linear ? u : hermite(u));
      if (u < 1) return true;
      D.morph = null;
      if (D.mix > 0.998) { D.A = D.B; D.mix = 0; }         // arrived: showing just that hour now
      else if (D.mix < 0.002) { D.B = D.A; D.mix = 0; }
    }
    const W = this.want;
    if (!W) return false;
    const pair = W.b !== W.a && W.mix > 0.002;
    const ta = this.best(W.a), tb = pair ? this.best(W.b) : ta;
    if (!ta || !tb) return false;
    const playing = !!this.app.playing;
    // (while the timeline plays, each step's change takes the whole step, so the motion never pauses)
    const go = (from, to, dur = this.morphMs()) => { D.morph = { t0: now, dur: Math.max(1, playing ? dur : dur * Math.max(0.4, Math.abs(to - from))), from, to, linear: playing }; };
    if (!D.A) {
      D.A = ta; D.B = tb; D.mix = pair ? W.mix : 0;
      this.onShown(true);
      return true;
    }
    if (!pair) {
      if (D.A === ta && D.mix < 0.002) return false;
      if (D.A === ta) go(D.mix, 0);
      else if (D.B === ta && D.mix > 0.002) go(D.mix, 1);
      else {
        // from whichever of the two showing is the nearer
        if (D.mix > 0.5) D.A = D.B;
        D.B = ta; D.mix = 0;
        go(0, 1);
      }
    } else if (D.A === ta && D.B === tb) {
      if (Math.abs(D.mix - W.mix) < 0.004) return false;
      go(D.mix, W.mix);
    } else if (D.A === tb && D.B === ta && D.mix > 0.002) {
      D.A = ta; D.B = tb; D.mix = 1 - D.mix;
      go(D.mix, W.mix);
    } else {
      const from = D.mix > 0.5 ? D.B : D.A;
      if (from === ta) { D.A = ta; D.B = tb; D.mix = 0; go(0, W.mix); }
      else if (from === tb) { D.A = ta; D.B = tb; D.mix = 1; go(1, W.mix); }
      else { D.A = from; D.B = W.mix < 0.5 ? ta : tb; D.mix = 0; go(0, 1); }      // to the nearer of the pair, then between them
    }
    this.onShown(false);
    return true;
  }

  // the frame that dominates the display changed: labels, storm cells, sounds
  onShown(first) {
    const D = this.display;
    const key = D.morph ? (D.morph.to > 0.5 ? D.B : D.A) : (D.mix > 0.5 ? D.B : D.A);
    const f = this.frames.get(key);
    if (!f || f === this.cur) return;
    this.cur = f;
    const hd = f.head;
    // the clouds condense in as the camera arrives (or at once, at a new place)
    if (first && !this.appear.t0) this.appear.t0 = performance.now() + (this.intro && this.intro.dir > 0 ? Math.max(0, this.intro.dur * 0.5 - (performance.now() - this.intro.t0)) : 0);
    const anvilTop = Math.max(0, ...hd.layers.filter((l) => l.genus === "Cb").map((l) => l.top / 1000));
    this.storm.setCells(hd.cells, anvilTop || 12);
    this.renderLayers();
    this.renderTitle();
    this.renderStatus();
    this.updateSound();
    if (!this.headingSet) { this.view.heading = this.defaultHeading(); this.headingSet = true; }
  }

  // How far each band's clouds move between two frames (see flow() in data.js), with the wind there as the
  // first guess. Only for neighbouring hours of the same model: across a longer gap the clouds just change.
  flowFor(fa, fb, bands) {
    const key = `${fa.key}|${fb.key}|${bands.map((b) => b.join("-"))}`;
    let v = this.flows.get(key);
    if (v) return v;
    const ta = Date.parse(fa.head.valid), tb = Date.parse(fb.head.valid);
    const dt = Number.isFinite(ta) && Number.isFinite(tb) ? (tb - ta) / 1000 : 0;
    if (fa.head.model !== fb.head.model || !dt || Math.abs(dt) > 3.2 * 3600) v = bands.map(() => [0, 0]);
    else {
      const guess = bands.map((b) => { const w = bandWind(fa, b); return [w[0] * dt / 1000 * 0.7, w[1] * dt / 1000 * 0.7]; });
      v = flow(fa, fb, bands, guess);
    }
    this.flows.set(key, v);
    while (this.flows.size > 60) this.flows.delete(this.flows.keys().next().value);
    return v;
  }

  // Each height band's clouds drift with the wind there, as one body (a tower isn't sheared apart by the
  // wind changing with height inside it). A band keeps its drift when the bands around it change.
  stepDrift(dt, bands, fa, fb, mix) {
    const prev = this.bandDrift;
    const next = bands.map((b) => {
      // the old band this one mostly is
      let from = null, ov = 0;
      for (const d of prev) {
        const o = Math.min(b[1], d.z1) - Math.max(b[0], d.z0);
        if (o > ov) { ov = o; from = d; }
      }
      if (!from && prev.length) from = prev.reduce((m, d) => (Math.abs((d.z0 + d.z1) - (b[0] + b[1])) < Math.abs((m.z0 + m.z1) - (b[0] + b[1])) ? d : m));
      const d = from ? { ...from } : { x: 0, y: 0, run: 0, dx: 1, dy: 0 };
      d.z0 = b[0]; d.z1 = b[1];
      let w = fa ? bandWind(fa, b) : [0, 0];
      if (fb && fb !== fa && mix > 0.002) { const w2 = bandWind(fb, b); w = [lerp(w[0], w2[0], mix), lerp(w[1], w2[1], mix)]; }
      const sp = Math.hypot(w[0], w[1]);
      d.vx = w[0] * dt * DRIFT / 1000; d.vy = w[1] * dt * DRIFT / 1000;
      d.x = (d.x + d.vx + WRAP) % WRAP; d.y = (d.y + d.vy + WRAP) % WRAP;
      d.run = (d.run + sp * dt * DRIFT / 1000) % WRAP;
      // the way the wind blows (cirrus is combed along it), turning gradually
      if (sp > 0.5) {
        const k = from ? 1 - Math.exp(-dt / 2.5) : 1;
        const nx = lerp(d.dx, w[0] / sp, k), ny = lerp(d.dy, w[1] / sp, k), nl = Math.hypot(nx, ny) || 1;
        d.dx = nx / nl; d.dy = ny / nl;
      }
      return d;
    });
    this.bandDrift = next;
    this.rise = (this.rise + dt * RISE) % (25.6 * 64);
    this.evo = (this.evo + dt * EVOLVE) % 0.8;
    this.fall = (this.fall + dt * FALL) % 51.2;
    return next;
  }

  // ---------------------------------------------------------------- environment (sun, moon, light)
  env() {
    const t = new Date((this.tDisp ?? this.t) * 1000);
    const { lat, lon } = this.p;
    const sun = A.sun(t, lat, lon), moon = A.moon(t, lat, lon);
    const sunDir = A.dirOf(sun.az, sun.el), moonDir = A.dirOf(moon.az, moon.el);
    const day = A.daylight(sun.el);
    const night = 1 - smooth(-14, -4, sun.el);
    const elev = (this.cur?.head.elev || 0) / 1000;
    const moonUp = smooth(-1, 3, moon.el) * (0.15 + 0.85 * moon.illum);
    // the sun lights the clouds until its last light has left even the highest of them; then the moon fades in
    const useSun = sun.el > -7.5 || moonUp < 0.02;
    const lightEl = useSun ? sun.el : moon.el;
    const tint = useSun ? [1, 1, 1] : [0.74, 0.84, 1.0];
    const lightI = useSun ? 1 : MOONLIGHT * moonUp * smooth(-7.5, -10.5, sun.el);
    const lut = new Float32Array(64 * 4);
    for (let i = 0; i < 64; i++) {
      const c = A.sunlight(lightEl, (i / 63) * 20);
      lut.set([c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], 1], i * 4);
    }
    const sunCol = A.sunlight(sun.el, elev + (this.camZ || 0));
    const golden = smooth(-6, 1, sun.el) * (1 - smooth(4, 16, sun.el));
    const glow = this.cityGlow ?? 0.2;
    const moonK = MOONLIGHT * moonUp * night;
    // airglow, and a town's light in the air above it
    const nightAir = [1.0e-5, 1.3e-5, 2.2e-5].map((x, i) => (x + [9e-5, 5e-5, 2.2e-5][i] * glow) * night);
    const sfc = this.cur?.head.sfc || {};
    // How far you can see along the ground follows the humidity there: about 180 km in dry air, 60 km at
    // 70 %, under 20 km when it is nearly saturated. (Real ranges on the horizon deserve honest air.)
    let hazeLow = 0.6;
    if (sfc.t2m != null && sfc.d2m != null) {
      const es = (k) => Math.exp(17.625 * (k - 273.15) / (k - 30.11));
      const rh = clamp(es(sfc.d2m) / es(sfc.t2m), 0, 1);
      hazeLow = 0.22 + 0.55 * smooth(0.3, 0.75, rh) + 1.6 * smooth(0.75, 0.98, rh);
    }
    // eased, so stepping through the hours doesn't make the horizon jump
    const nowMs = performance.now();
    const dtH = Math.min(1, (nowMs - (this._hazeAt || 0)) / 600);
    this._haze = this._haze == null || !this._hazeAt ? hazeLow : lerp(this._haze, hazeLow, dtH);
    this._hazeAt = nowMs;
    const mie = Math.round(clamp(0.55 + 0.75 * this._haze, 0.6, 2.2) * 20) / 20;
    // Exposure, the way an eye or a camera sets it: by how bright the sky is. Set for a sunlit cloud top to
    // just reach white by day, it opens up as the light goes (not quite keeping pace: dusk looks like dusk)
    // so that the afterglow, a moonlit night and a starry one are all seen, each darker than the last.
    const hEye = (this.camZ || 0) + elev;
    const sky = this.r.skyBrightness(mie, hEye < 0.25 ? 0.02 : Math.min(12, 2 ** Math.round(Math.log2(hEye))));
    const lum = sky(sun.el) + moonK * sky(moon.el) + 0.2126 * nightAir[0] + 0.7152 * nightAir[1] + 0.0722 * nightAir[2];
    // (down to deep twilight it nearly keeps pace; below that it gives ground, and night is dark)
    const open = lum > DUSK_SKY ? Math.pow(DAY_SKY / lum, 0.85) : Math.pow(DAY_SKY / DUSK_SKY, 0.85) * Math.pow(DUSK_SKY / lum, 0.25);
    // Under cloud, from the ground, there is no sky to go by: the eye adapts to the cloud base itself, which
    // is what the cloud lets through of the sun and of the sky above it. A stratus deck then shows light
    // grey, a deep rain cloud a darker one, the belly of a storm darker still, but none of them black.
    const oc = this.overcast();
    const lightLum = (0.2126 * lut[0] + 0.7152 * lut[1] + 0.0722 * lut[2]) * lightI;
    const falling = lightLum * Math.max(Math.sin(lightEl * DEG), 0.03) + Math.PI * lum / 3.8;      // on the cloud tops (the dome is about a quarter as bright as the low sky that lum measures)
    const deckLum = Math.max(falling * oc.deck / Math.PI, 1e-9);
    const shown = clamp(0.24 * Math.pow(oc.deck / 0.3, 0.3), 0.07, 0.28);        // how bright that base should come out
    let dull = clamp(Math.pow(shown / deckLum / (EXPOSURE * Math.pow(DAY_SKY / lum, 0.85)), (1 - oc.open) * (this.grounded || 0)), 1, 40);
    // (by day and through dusk; a clouded night stays a dark one)
    dull = Math.min(dull, lerp(3, 40, clamp(Math.log10(lum / DUSK_SKY), 0, 1)));
    const exposure = Math.min((this.tune?.exposure ?? EXPOSURE) * open * dull, 400);
    const snowing = this.cur?.head.precip?.kind === "snow";
    const snow = (sfc.t2m != null && sfc.t2m < 272.5 && (snowing || Math.abs(lat) > 40)) ? (snowing ? 0.75 : 0.35) : 0;
    // equatorial -> local sky, for the stars (and back, for the Milky Way)
    const d = t.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const lst = (((280.46061837 + 360.98564736629 * d) % 360) + lon) * DEG;
    const ph = lat * DEG;
    const cl = Math.cos(lst), sl = Math.sin(lst), cp = Math.cos(ph), sp = Math.sin(ph);
    // columns: images of the equatorial x, y, z axes in (east, north, up)
    const eq = new Float32Array([-sl, -sp * cl, cp * cl, cl, -sp * sl, cp * sl, 0, cp, sp]);
    const eqInv = new Float32Array([eq[0], eq[3], eq[6], eq[1], eq[4], eq[7], eq[2], eq[5], eq[8]]);
    // the side view's backdrop, redrawn when the sun has moved
    const moonF = moon.illum * smooth(-2, 15, moon.el);
    const rampKey = `${sun.el.toFixed(2)}|${moonF.toFixed(2)}|${glow.toFixed(2)}`;
    if (rampKey !== this._rampKey) {
      this._rampKey = rampKey;
      this._ramp = backdropRamp(sun.el, moonF, glow);
      // the backdrop's own light on the clouds in front of it: its colour through the troposphere, and near the ground
      const mean = (z0, z1) => {
        const c = [0, 0, 0];
        let n = 0;
        for (let i = Math.round(z0 / 18 * 255); i <= Math.round(z1 / 18 * 255); i++, n += 2) for (let k = 0; k < 3; k++) c[k] += this._ramp[i * 4 + k] + this._ramp[(256 + i) * 4 + k];
        return c.map((x) => x / n * 0.35);
      };
      this._stDome = mean(1.5, 13);
      this._stRim = mean(0, 4);
    }
    return {
      light: useSun ? sunDir : moonDir, lightI, sunDir, sunCol, moonDir,
      moonCol: [0.96, 0.94, 0.9].map((x) => x * 1.25 / exposure), moonIllum: moon.illum, moonK, night, nightAir,
      cityCol: [1.0, 0.56, 0.24].map((x) => x * glow * 0.2 * night / exposure),
      flashCol: [0.8, 0.84, 1.0].map((x) => x * 60 / exposure),
      exposure, starGain: 4.2 / exposure, lut, elev, lat, lon, snow, cityGlow: glow, groundAlb: 0.16 + 0.5 * snow,
      starVis: Math.pow(night, 2) * (1 - 0.5 * moonUp), rays: day * 0.9, eq, eqInv, sun, moon, hazeLow: this._haze,
      mie, fill: this.openSky(), stDome: this._stDome, stRim: this._stRim,
      sunAbove: smooth(-2.5, 2.5, lightEl), ramp: this._ramp, rampKey, grade: 1, golden,
    };
  }

  // how much of the sky is open (not under cloud) around the point: 1 clear, 0 under an overcast
  openSky() {
    let open = 1;
    for (const L of this.cur?.head.layers || []) open *= 1 - clamp(L.cover, 0, 1) * (L.genus === "Ci" || L.genus === "Cs" || L.genus === "Cc" ? 0.3 : 1);
    this._open = this._open == null ? open : lerp(this._open, open, 0.05);
    return clamp(this._open * 1.15, 0, 1);
  }

  // the cloud over the point as the light meets it: how much of the sky there is open, and how much of the
  // daylight the rest lets through (data.js works both out for each frame; eased, so they never jump)
  overcast() {
    const D = this.vanish ? this.vanish.D : this.display;
    const a = this.frames.get(D?.A)?.overhead, b = this.frames.get(D?.B)?.overhead || a;
    const m = b && b !== a ? D.mix || 0 : 0;
    const t = a ? { open: lerp(a.open, b.open, m), deck: lerp(a.deck, b.deck, m) } : { open: 1, deck: 1 };
    const o = this._over ||= { ...t };
    o.open = lerp(o.open, t.open, 0.05); o.deck = lerp(o.deck, t.deck, 0.05);
    return { open: clamp(o.open, 0, 1), deck: clamp(o.deck, 0.004, 1) };
  }

  defaultHeading() {
    const t = new Date(this.t * 1000);
    const sun = A.sun(t, this.p.lat, this.p.lon), moon = A.moon(t, this.p.lat, this.p.lon);
    if (sun.el > -4 && sun.el < 16) return sun.az + 3;          // golden hour: face the sun, low in the frame
    if (sun.el >= 16) return sun.az + 105;                       // side-lit
    if (moon.el > 2 && moon.el < 30) return moon.az + 3;
    return 0;
  }

  // ---------------------------------------------------------------- camera
  // the ground as drawn (km, relative to the point): the terrain at its current relief, less the earth's curve
  groundAt(x, y) {
    const h = this.dem && this.relief > 0 ? this.dem.heightAt(x, y) * this.relief : 0;
    return h - (this.curve || 0) * (x * x + y * y);
  }

  // a height the camera must stay above
  terrainAt(x, y) { return this.groundAt(x, y); }

  // Side view framing. At true scale the ground sits just above the timeline and 52,000 ft just under the
  // header: the whole screen spans a little more than that, centred so those two land where they should.
  sideParams(k) {
    const W = this.r.W / this.r.dpr, Hh = this.r.H / this.r.dpr;
    const aspect = W / Hh;
    const mob = W < 760;
    const top = (mob ? 58 : 62) / Hh, bot = (this.amb ? 24 : mob ? 100 : 112) / Hh;
    const z0 = -0.35, z1 = 16.25;
    const Hfull = (z1 - z0) / Math.max(0.3, 1 - top - bot);
    const W0 = Hfull * aspect;
    const Wt = W0 * Math.pow(Math.max(100 / W0, 1.0), k);
    const Hp = Wt / aspect;
    // far back with a long lens at true scale (nearly orthographic, so heights read true across the slab),
    // closer with a wide lens when pulled out
    const D1 = (100 / aspect) / 2 / Math.tan(23 * DEG);
    const D = Math.exp(lerp(Math.log(180), Math.log(Math.max(D1, 30)), smooth(0, 1, k)));
    const fov = 2 * Math.atan(Hp / 2 / D);
    const pitch = clamp(this.view.pitchU + lerp(0, 26, smooth(0.12, 1, k)), -3, 70) * DEG;
    const zMid = z0 + Hfull * (0.5 - bot);
    const zT = lerp(zMid, 1.6, smooth(0, 1, k));
    // lens shift: the camera sits about a kilometre up (the horizon near the bottom) and the frame slides up
    const s = lerp(clamp((zMid - 1.0) / (Hfull / 2), 0, 0.97), 0, smooth(0, 0.55, k));
    return { heading: this.view.heading * DEG, pitch, D, fov, zT, s, Hp, aspect };
  }

  camFrom(q, aspect, cut) {
    const { heading: hd, pitch } = q;
    const fwd = [Math.sin(hd) * Math.cos(pitch), Math.cos(hd) * Math.cos(pitch), -Math.sin(pitch)];
    const hint = norm([lerp(0, Math.sin(hd), smooth(60 * DEG, 88 * DEG, pitch)), lerp(0, Math.cos(hd), smooth(60 * DEG, 88 * DEG, pitch)), lerp(1, 0.02, smooth(60 * DEG, 88 * DEG, pitch))]);
    const right = norm(cross(fwd, hint));
    const up = cross(right, fwd);
    const half = Math.tan(q.fov / 2) * q.D;
    let s = q.s;
    const T = [0, 0, q.zT];
    let pos = [T[0] - up[0] * s * half - fwd[0] * q.D, T[1] - up[1] * s * half - fwd[1] * q.D, T[2] - up[2] * s * half - fwd[2] * q.D];
    // never under the ground: lift the camera and shift the lens back so the point stays framed. (Not when
    // the camera stands in the part of the world the side view has cut away: real mountains out there, a
    // hundred kilometres in front of the point, are not drawn and must not change the framing.)
    const cutAway = cut && cut[3] > 0.5 && pos[0] * cut[0] + pos[1] * cut[1] < cut[2];
    const g = this.terrainAt(pos[0], pos[1]) + 0.12;
    if (!cutAway && pos[2] < g) {
      const dz = g - pos[2];
      pos[2] = g;
      s -= dz / Math.max(up[2], 0.2) / half;
    }
    const view = M4.lookDir(pos, fwd, hint);
    const proj = M4.persp(q.fov, aspect, 0.01, 900, s);
    return { pos, fwd, right, up, view, proj, fov: q.fov };
  }

  camera(now) {
    const aspect = this.r.W / this.r.H;
    let c, cut = [0, 1, -1e4, 0], stylize = 0, refDist = 30, grounded = 0;
    const k = this.view.zoom;
    const side = this.sideParams(k);
    const tilt = this.tilt || { yaw: 0, pitch: 0 };
    if (this.view.mode === "side" || this.modeAnim) {
      const q = { ...side, heading: side.heading + tilt.yaw * DEG, pitch: side.pitch - tilt.pitch * DEG };
      if (this.intro) {
        const e = ease(clamp((now - this.intro.t0) / this.intro.dur, 0, 1));
        const u = this.intro.dir > 0 ? e : 1 - e;
        const top = { heading: 0, pitch: 89.4 * DEG, D: 420, fov: 40 * DEG, zT: 0, s: 0 };
        // the cut and the slab open up during the swoop
        const dh = wrapDeg(q.heading / DEG) * DEG;
        q.heading = lerp(top.heading, dh, u);
        q.pitch = lerp(top.pitch, q.pitch, u);
        q.D = Math.exp(lerp(Math.log(top.D), Math.log(q.D), u));
        q.fov = lerp(top.fov, q.fov, u);
        q.zT = lerp(top.zT, q.zT, u);
        q.s = lerp(top.s, q.s, u);
      }
      const fh = [Math.sin(q.heading), Math.cos(q.heading)];
      cut = [fh[0], fh[1], -(6 + 140 * smooth(0.15, 0.8, k)), this.intro && this.intro.dir < 0 ? 0 : 1];
      this.slab = [9 + 170 * smooth(0.1, 0.6, k), 5 + 20 * smooth(0.1, 0.6, k)];
      stylize = 1 - smooth(0.3, 0.9, k);
      refDist = side.D * Math.cos(q.pitch);
      if (this.intro) {
        const u = clamp((now - this.intro.t0) / this.intro.dur, 0, 1);
        const open = this.intro.dir > 0 ? 1 - smooth(0.45, 1, u) : smooth(0, 0.6, u);
        cut[2] -= open * 200;
        this.slab = [this.slab[0] + open * 200, this.slab[1]];
        stylize *= this.intro.dir > 0 ? smooth(0.35, 0.9, u) : 1 - smooth(0, 0.5, u);
      }
      c = this.camFrom(q, aspect, cut);
    }
    if (this.view.mode === "ground" || this.modeAnim) {
      const hd = (this.view.heading + tilt.yaw) * DEG, pt = clamp(this.view.look + tilt.pitch, -8, 88) * DEG;
      const fwd = [Math.sin(hd) * Math.cos(pt), Math.cos(hd) * Math.cos(pt), Math.sin(pt)];
      const hint = Math.abs(fwd[2]) > 0.995 ? [Math.sin(hd), Math.cos(hd), 0] : [0, 0, 1];
      const pos = [0, 0, this.groundAt(0, 0) + 0.0018];
      const fov = this.view.fov * DEG;
      const g = { pos, fwd, right: norm(cross(fwd, hint)), up: [0, 0, 1], view: M4.lookDir(pos, fwd, hint), proj: M4.persp(fov, aspect, 0.001, 900, 0), fov };
      if (this.modeAnim && c) {
        const u = ease(clamp((now - this.modeAnim.t0) / this.modeAnim.dur, 0, 1));
        const toGround = this.modeAnim.to === "ground";
        const w = toGround ? u : 1 - u;
        const pos2 = c.pos.map((x, i) => lerp(x, g.pos[i], w));
        // once the cut-away closes the flight is over real country: stay above it
        if (w > 0.3) pos2[2] = Math.max(pos2[2], this.groundAt(pos2[0], pos2[1]) + 0.0018 + 0.15 * (1 - w));
        const fwd2 = norm(c.fwd.map((x, i) => lerp(x, g.fwd[i], w)));
        const fov2 = lerp(c.fov, g.fov, w);
        const hint2 = Math.abs(fwd2[2]) > 0.99 ? [Math.sin(hd), Math.cos(hd), 0] : [0, 0, 1];
        c = { pos: pos2, fwd: fwd2, right: norm(cross(fwd2, hint2)), up: [0, 0, 1], view: M4.lookDir(pos2, fwd2, hint2), proj: M4.persp(fov2, aspect, 0.001, 900, lerp(side.s, 0, w)), fov: fov2 };
        cut[3] = w > 0.3 ? 0 : cut[3];
        stylize *= 1 - w;
        grounded = w;
        if (u >= 1) this.modeAnim = null;
      } else { c = g; grounded = 1; }
    }
    // From the ground the earth curves away under distant country (a range 200 km off stands 2.7 km lower
    // against the horizon). The side view is a diagram at true scale, so there the ground stays level.
    this.curve = grounded / (2 * EARTH_R);
    this.grounded = grounded;
    c.vp = M4.mul(c.proj, c.view);
    c.invVP = M4.inv(c.vp);
    c.cut = cut;
    c.stylize = stylize;
    c.hazeK = lerp(1, 0.18, stylize);
    c.slab = this.view.mode === "side" || this.modeAnim ? this.slab : [1e4, 1];
    c.refDist = refDist;
    c.far = 880;
    this.camZ = c.pos[2];
    // The side view's lens is far too long to show the night sky (a few degrees of it, at the horizon), so
    // there the stars are seen through a wide one looking up the same way.
    const sh = Math.atan2(c.fwd[0], c.fwd[1]), sa = 34 * DEG;
    const sf = [Math.sin(sh) * Math.cos(sa), Math.cos(sh) * Math.cos(sa), Math.sin(sa)];
    const sr = [Math.cos(sh), -Math.sin(sh), 0], su = cross(sr, sf);
    c.starCam = new Float32Array([...sr, ...su, ...sf]);
    c.starVP = stylize > 0.5 ? M4.mul(M4.persp(2 * Math.atan(0.55), aspect, 0.5, 6000, 0), M4.lookDir([0, 0, 0], sf, [0, 0, 1])) : null;
    // (the two skies swap half way through a zoom or a change of view: the stars dim across the swap)
    c.starFade = stylize > 0 && stylize < 1 ? smooth(0, 0.3, Math.abs(stylize - 0.5)) : 1;
    return c;
  }

  // ---------------------------------------------------------------- loop
  kick() {
    if (!this.isOpen || this.raf) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  frame(now) {
    this.raf = 0;
    if (!this.isOpen || document.hidden) return;
    const motion = !reducedMotion();
    const dt = this.lastNow ? Math.min(0.25, (now - this.lastNow) / 1000) : 0;
    let busy = !this.r.ready;
    if (this.intro) {
      busy = true;
      if (now - this.intro.t0 >= this.intro.dur) this.intro = null;
    }
    if (this.modeAnim) busy = true;
    const rising = this.stepRelief(now);
    if (rising) busy = true;
    const changed = this.updateDisplay(now);
    if (changed || this.display.morph || this.vanish) busy = true;
    if (this.tAnim) {
      const a = this.tAnim, u = clamp((now - a.t0) / a.dur, 0, 1);
      this.tDisp = lerp(a.from, a.to, this.app.playing ? u : hermite(u));
      if (u >= 1) this.tAnim = null;
      busy = true;
    }
    if (this.appear.t0) {
      const a = clamp((now - this.appear.t0) / (reducedMotion() ? 1 : 950), 0, 1);
      if (a < 1 || this.appear.v < 1) busy = true;
      this.appear.v = a;
    }
    if (this.waiters.length && this.atTarget()) {
      for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(); }
      this.waiters = [];
    }
    const interacting = now - this.lastInteract < 180 || this.fling;
    if (this.fling) this.stepFling(dt);
    this.storm.update(now, dt, (x, y) => this.groundAt(x, y));
    this.pullRealLightning();
    const fl = this.storm.frame(now);
    if (fl.active) busy = true;
    // ambient frame rate: slower on phones, slower still when nobody has touched it for a while
    const idleMin = (now - this.lastInteract) / 60000;
    const ambientFps = this.r.lowPower ? (idleMin > 3 ? 12 : 20) : (idleMin > 10 ? 20 : 30);
    const due = busy || interacting || this.dirty || (motion && now - (this.lastDraw || 0) >= 1000 / ambientFps - 2);
    if (due) {
      this.dirty = false;
      try {
        // with nothing loaded yet the empty sky still draws, so the swoop happens
        this.draw(now, {
          moving: interacting || !!this.intro || !!this.modeAnim || rising,
          dataChanged: !!this.display.morph || changed || !!this.vanish || (this.appear.t0 && this.appear.v < 1) || !!this.tAnim || fl.lights.length > 0,
          flashes: fl.lights, bolts: fl.bolts,
        });
        this.fails = 0;
      } catch (err) {
        if (!this.fails) console.error("Mammatus: sky view failed to draw", err);
        this.fails = (this.fails || 0) + 1;
        if (this.fails > 30) { toastError(err, "The Sky view can't draw on this device"); this.exit(); return; }
      }
      // how long frames really take, while they come one after another
      if ((busy || interacting) && this.lastDraw && now - this.lastDraw < 120) this.pace = lerp(this.pace ?? 16.7, now - this.lastDraw, 0.12);
      if (this.display.A) this.adapt(now, busy || interacting);
      this.lastDraw = now;
    }
    this.lastNow = now;
    const still = !motion && !busy && !interacting && !this.dirty && this.settled > 24;
    this.settled = due ? (this.settled || 0) + 1 : this.settled;
    if (busy || interacting) this.settled = 0;
    if (!still || this.intro) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  draw(now, { moving, dataChanged, flashes, bolts }) {
    // opened from a link while the app was still starting: the sky is what shows, so lift the splash
    if (!this.splashGone) { this.splashGone = true; const sp = document.getElementById("splash"); if (sp && !sp.classList.contains("gone")) { sp.classList.add("gone"); setTimeout(() => sp.remove(), 1400); } }
    const cam = this.camera(now);
    const e = this.env();
    e.starVis *= cam.starFade;
    this.r.setSunLUT(e.lut);
    // what is showing: this place's clouds, or the last place's on their way out
    const V = this.vanish;
    const D = V ? V.D : this.display;
    const fa = this.frames.get(D.A), fb = this.frames.get(D.B);
    if (fa) this.r.frame(D.A, fa);
    if (fb && fb !== fa) this.r.frame(D.B, fb);
    const two = !!fb && fb !== fa && (D.mix > 0.002 || !!D.morph);
    const bands = mergeBands([...(fa?.bands || []), ...(two ? fb.bands : [])]);
    const mam = Math.max(fa?.head.mammatus || 0, two ? fb.head.mammatus || 0 : 0);
    const occ = new Uint8Array(NZ);
    if (fa) for (let k = 0; k < NZ; k++) occ[k] = fa.filled[k] | (two ? fb.filled[k] : 0);
    const adv = two ? this.flowFor(fa, fb, bands) : null;
    const dt = !reducedMotion() && this._driftAt ? Math.min(0.12, (now - this._driftAt) / 1000) : 0;
    this._driftAt = now;
    const drift = this.stepDrift(dt, bands, fa, two ? fb : null, D.mix);
    const appear = V ? 1 - hermite(clamp((now - V.t0) / V.dur, 0, 1)) : this.appear.v;
    // side view: a storm cell standing in the cut-away part still flashes, on the face of the cut
    if (cam.cut[3] > 0.5 && (flashes?.length || bolts?.length)) {
      const [nx, ny, cz] = cam.cut;
      const push = (x, y) => Math.max(0, cz + 2.5 - (x * nx + y * ny));
      flashes = (flashes || []).map((f) => { const d = push(f.x, f.y); return d ? { ...f, x: f.x + nx * d, y: f.y + ny * d } : f; });
      bolts = (bolts || []).map((b) => {
        const d = push(b.segs[0], b.segs[1]);
        if (!d) return b;
        const segs = b.segs.slice();
        for (let i = 0; i < segs.length; i += 7) { segs[i] += nx * d; segs[i + 1] += ny * d; segs[i + 3] += nx * d; segs[i + 4] += ny * d; }
        return { ...b, segs };
      });
    }
    const s = {
      cam, env: e, moving, dataChanged,
      weather: {
        a: D.A, b: D.B || D.A, mix: two ? D.mix : 0, adv, occ, appear, mammatus: mam, bands, drift,
        rise: this.rise, evo: this.evo, fall: this.fall, ext: this.tune?.ext ?? 1, morphing: !!D.morph,
      },
      ground: { relief: this.relief, curve: this.curve || 0 },
      flashes, bolts,
    };
    this.lastState = s;
    this.r.render(s, now);
    this.placeOverlay(cam);
  }

  // draw a few more frames right now (a still picture needs the 2x2 cycle to come round)
  settle(n = 8) {
    for (let i = 0; i < n; i++) {
      const fl = this.storm.frame(performance.now());
      this._driftAt = performance.now();      // (the same moment, drawn again: the clouds don't move on meanwhile)
      this.draw(performance.now(), { moving: false, dataChanged: false, flashes: fl.lights, bolts: fl.bolts });
    }
  }

  // keep the frame time in budget by trading cloud resolution
  adapt(now, continuous) {
    this._adaptT ||= now;
    if (now - this._adaptT < 1500) return;
    this._adaptT = now;
    const ms = this.r.stats.ms;
    const budget = this.r.lowPower ? 22 : 14;
    // too slow: frames arriving late while animating, or the drawing itself over budget
    if ((continuous && this.pace > 27) || ms > budget * 1.25) { this.r.setScale(this.r.scale - 0.07); this.pace = 16.7; }
    else if (ms < budget * 0.5 && !(continuous && this.pace > 19)) this.r.setScale(this.r.scale + 0.04);
  }

  // ---------------------------------------------------------------- interaction
  bindInput() {
    const el = this.canvas;
    const pts = new Map();
    let last = null, pinch = null, vel = [0, 0], lastT = 0, downAt = null;
    const pos = (e) => [e.clientX, e.clientY];
    const touched = () => { this.lastInteract = performance.now(); this.kick(); if (this.amb) this.ambientPoke(); };
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, pos(e));
      this.fling = null;
      if (pts.size === 1) { last = pos(e); downAt = { p: pos(e), t: performance.now() }; vel = [0, 0]; lastT = performance.now(); }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.view.zoom, fov: this.view.fov }; }
      touched();
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, pos(e));
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.zoomTo(pinch, d / pinch.d);
      } else if (pts.size === 1 && last) {
        const p = pos(e), now = performance.now();
        const dx = p[0] - last[0], dy = p[1] - last[1];
        this.dragBy(dx, dy);
        const dtm = Math.max(1, now - lastT);
        vel = [lerp(vel[0], dx / dtm, 0.4), lerp(vel[1], dy / dtm, 0.4)];
        last = p; lastT = now;
      }
      touched();
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        if (downAt && performance.now() - downAt.t < 260 && Math.hypot(e.clientX - downAt.p[0], e.clientY - downAt.p[1]) < 8) this.onTap(e);
        else if (performance.now() - lastT < 80 && Math.hypot(vel[0], vel[1]) > 0.15) this.fling = { vx: vel[0] * 1000, vy: vel[1] * 1000 };
        last = null;
      } else last = [...pts.values()][0];
      touched();
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
      this.zoomTo({ zoom: this.view.zoom, fov: this.view.fov }, f);
      touched();
    }, { passive: false });
    el.addEventListener("dblclick", () => this.resetView());
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  onTap(e) {
    this.card?.remove();
    this.card = null;
    if (this.amb) return;
    this.menu?.classList.remove("open");
    if (isTouch() && this._lastTap && performance.now() - this._lastTap < 320) this.resetView();
    this._lastTap = performance.now();
  }

  dragBy(dx, dy) {
    const fovY = this.view.mode === "ground" ? this.view.fov : lerp(14, 46, this.view.zoom);
    const degPerPx = fovY / (this.r.H / this.r.dpr);
    this.view.heading -= dx * degPerPx * (this.view.mode === "ground" ? 1 : 1.6);
    if (this.view.mode === "ground") this.view.look = clamp(this.view.look + dy * degPerPx, -8, 88);
    else this.view.pitchU = clamp(this.view.pitchU + dy * degPerPx * 0.9, -2, 45);
    this.dirty = true;
  }

  stepFling(dt) {
    const f = this.fling;
    this.dragBy(f.vx * dt, f.vy * dt);
    const k = Math.exp(-dt * 4);
    f.vx *= k; f.vy *= k;
    if (Math.hypot(f.vx, f.vy) < 8) this.fling = null;
  }

  zoomTo(start, factor) {
    if (this.view.mode === "ground") this.view.fov = clamp(start.fov / factor, 22, 100);
    else this.view.zoom = clamp(start.zoom - Math.log(factor) * 0.55, 0, 1);
    this.dirty = true;
  }

  resetView() {
    this.view.zoom = 0; this.view.pitchU = 0; this.view.look = 22; this.view.fov = 74;
    this.view.heading = this.defaultHeading();
    this.dirty = true;
    this.kick();
  }

  setMode(mode) {
    if (mode === this.view.mode) return;
    this.modeAnim = { t0: performance.now(), dur: reducedMotion() ? 10 : 1100, to: mode };
    this.view.mode = mode;
    if (mode === "ground") { this.view.look = 24; this.view.fov = 74; }
    this.app.savePref("skyView", mode);
    this.ui?.classList.toggle("ground", mode === "ground");
    this.r.reset = true;
    this.kick();
  }

  // ---------------------------------------------------------------- overlay (ruler, layers, compass)
  buildUI() {
    const hu = units().height === "m";
    this.titleEl = h("div", { class: "sky-title glass" }, h("b", {}, ""), h("small", {}, ""));
    this.srcBtn = h("button", { class: "sky-src glass", title: "Where this sky comes from" });
    this.moreBtn = h("button", { class: "iconbtn glass", "aria-label": "Sky options", title: "Sky options", html: icon("more", 20) });
    this.ruler = h("div", { class: "sky-ruler", "aria-hidden": "true" });
    this.layersEl = h("div", { class: "sky-layers" });
    this.windEl = h("div", { class: "sky-winds", "aria-hidden": "true" });
    this.obsEl = h("div", { class: "sky-obs", "aria-hidden": "true" });
    this.compassEl = h("button", { class: "sky-compass glass", title: "Face the default way", "aria-label": "Compass", onclick: () => this.resetView() }, h("i", {}), h("span", {}, "N"));
    this.statusEl = h("div", { class: "sky-status" });
    this.groundList = h("div", { class: "sky-glist glass" });
    this.ui = h("div", { class: `sky-ui${this.view.mode === "ground" ? " ground" : ""}` },
      h("header", { class: "sky-head" }, this.titleEl, h("div", { class: "spacer" }), this.srcBtn, this.moreBtn),
      this.ruler, this.layersEl, this.windEl, this.obsEl, this.compassEl, this.statusEl, this.groundList);
    document.getElementById("ui").append(this.ui);
    this.exitFab = h("div", { class: "fab glass sky-exit" },
      h("button", { "aria-label": "Close sky view", title: "Back to the map (Esc)", html: icon("x", 20), onclick: () => this.exit() }));
    document.getElementById("ui").append(this.exitFab);
    // ruler ticks: every 1,000 ft (labels every 5,000) or every 500 m (labels every 2 km)
    this.ticks = [];
    const step = hu ? 500 : 304.8, lab = hu ? 2000 : 1524;
    for (let m = 0; m <= 16000 + 1; m += step) {
      const major = Math.abs(m / lab - Math.round(m / lab)) < 1e-6;
      const txt = major ? (hu ? `${m / 1000} km` : `${Math.round(m / 0.3048).toLocaleString()} ft`) : "";
      const el = h("div", { class: `tick${major ? " major" : ""}` }, txt ? h("span", {}, m === 0 ? (hu ? "0 m" : "0 ft") : txt) : null);
      this.ruler.append(el);
      this.ticks.push({ el, z: m / 1000 });
    }
    if (!hu) {
      const el = h("div", { class: "tick top" }, h("span", {}, "52,000 ft"));
      this.ruler.append(el);
      this.ticks.push({ el, z: 52000 * 0.3048 / 1000 });
    }
    this.frzEl = h("div", { class: "sky-frz" }, h("span", {}, ""));
    this.ruler.append(this.frzEl);
    this.colEl = h("div", { class: "sky-col" });
    this.ruler.append(this.colEl);
    this.moreBtn.addEventListener("click", () => this.toggleMenu());
    this.srcBtn.addEventListener("click", () => this.toggleMenu(true));
    this.bindInput();
    this.renderTitle();
  }

  renderTitle() {
    if (!this.titleEl || !this.p) return;
    const name = this.app.savedPoint?.(this.p)?.name || this.p.name || "this point";
    this.titleEl.firstChild.textContent = `Sky over ${name}`;
    const t = new Date((this.t || Date.now() / 1000) * 1000);
    // the surveyed height when the real terrain is in, else the weather model's idea of it
    const elev = this.dem?.real && this.dem.key === `real@${this.p.lat},${this.p.lon}` ? this.dem.elev : this.cur?.head.elev;
    const g = elev != null ? ` · ground ${heightOne(elev)}` : "";
    this.titleEl.lastChild.textContent = `${when(t)}${g}`;
    const hd = this.cur?.head;
    if (hd) {
      const est = hd.estimated;
      const res = { hrrr: "3 km", rrfs: "3 km", gfs: "25 km" }[hd.model] || "";
      this.srcBtn.innerHTML = `${est ? '<i class="est">Estimated</i>' : ""}<b>${hd.source}</b>${res ? `<small>${res}</small>` : ""}${hd.run ? `<small>${hd.run.slice(8, 10)}z</small>` : ""}`;
      this.srcBtn.classList.toggle("estimated", !!est);
      this.srcBtn.title = est ? "Estimated: Open-Meteo derives cloud by height from humidity, not from the model's own cloud water." : `${hd.source} cloud water, ice, rain and snow · ${hd.attribution}`;
      const attr = this.app.attrib;
      const land = this.dem?.real && this.dem.attribution ? ` · Terrain: ${this.dem.attribution.split(" (")[0]}` : "";
      if (attr) attr.textContent = `Sky: ${hd.source} · ${hd.attribution}${est ? " · estimated" : ""}${land}`;
    } else this.srcBtn.innerHTML = "<b>Loading…</b>";
  }

  renderStatus(msg) {
    if (!this.statusEl) return;
    const loadingTxt = this.loading && !this.display.A ? `Condensing ${this.plan?.kind === "model" ? this.plan.model.toUpperCase() : "estimated"} clouds…` : "";
    const text = msg || loadingTxt;
    const clear = this.cur && !this.cur.head.layers.length && !this.loading ? "Clear sky" : "";
    this.statusEl.textContent = text || clear;
    this.statusEl.classList.toggle("on", !!(text || clear));
    this.statusEl.classList.toggle("err", !!msg);
    this.statusEl.classList.toggle("busy", !msg && !!loadingTxt);
  }

  renderLayers() {
    const hd = this.cur?.head;
    if (!this.layersEl) return;
    if (!hd) {
      // nothing known about this sky yet
      this.layerTags = [];
      this.winds = [];
      this.frz = null;
      this.layersEl.replaceChildren();
      this.windEl.replaceChildren();
      this.obsEl.replaceChildren();
      this.frzEl.firstChild.textContent = "";
      this.groundList.replaceChildren(h("h6", {}, "Overhead"), h("small", { class: "wait" }, "Loading…"));
      this.card?.remove();
      this.card = null;
      this._ovSig = null;
      this.dirty = true;
      return;
    }
    this.layerTags = hd.layers.map((L) => {
      const el = h("button", { class: `sky-tag g-${L.genus}`, title: L.name, onclick: (e) => { e.stopPropagation(); this.showLayer(L); } },
        h("i", {}), h("b", {}, L.name), h("small", {}, heightRange(L.base, L.top)));
      return { el, L };
    });
    this.layersEl.replaceChildren(...this.layerTags.map((x) => x.el));
    // freezing level from the profile
    const t = hd.profile.t;
    let frz = null;
    for (let k = 1; k < t.length; k++) if (t[k - 1] >= 273.15 && t[k] < 273.15) { frz = (k - 0.5 + (t[k - 1] - 273.15) / (t[k - 1] - t[k]) - 0.5) * 0.25; break; }
    this.frz = frz;
    if (this.frzEl) this.frzEl.firstChild.textContent = frz != null ? `0°C  ${heightOne(frz * 1000)}` : "";
    // wind arrows every 2 km
    this.winds = [];
    const wl = [];
    for (let z = 1; z <= 14; z += 2) {
      const k = Math.round(z / 0.25 - 0.5);
      const u = hd.profile.u[k], v = hd.profile.v[k];
      const spd = Math.hypot(u, v);
      const el = h("div", { class: "wind" }, h("i", {}), h("span", {}, fmt("wind", spd)));
      this.winds.push({ el, z, u, v, spd });
      wl.push(el);
    }
    this.windEl.replaceChildren(...wl);
    // ground view: a compact list
    this._ovSig = null;
    this.groundList.replaceChildren(h("h6", {}, "Overhead"), ...(hd.layers.length ? [...hd.layers].reverse().map((L) =>
      h("button", { class: "row", onclick: () => this.showLayer(L) }, h("i", { class: `g-${L.genus}` }), h("b", {}, L.name), h("small", {}, heightRange(L.base, L.top)))) : [h("small", {}, "Clear sky")]));
    this.dirty = true;
  }

  placeOverlay(cam) {
    if (!this.ui) return;
    const W = this.r.W / this.r.dpr, H = this.r.H / this.r.dpr;
    const proj = (z) => {
      const q = M4.project(cam.vp, [0, 0, z]);
      return { x: (q[0] * 0.5 + 0.5) * W, y: (1 - (q[1] * 0.5 + 0.5)) * H, ok: q[2] > 0 };
    };
    const side = this.view.mode === "side" && !this.modeAnim;
    const show = side && !this.intro && this.view.pitchU < 12 && this.view.zoom < 0.6;
    this.ui.classList.toggle("noruler", !show);
    if (!show) { this.placeCompass(cam); return; }
    const sig = `${cam.vp.slice(0, 16).map((x) => x.toFixed(5))}|${W}|${H}|${this.cur?.key}|${this.obs?.length}`;
    if (sig === this._ovSig) return;
    this._ovSig = sig;
    for (const t of this.ticks) {
      const p = proj(t.z);
      t.el.style.transform = `translateY(${p.y.toFixed(1)}px)`;
      t.el.style.opacity = p.ok && p.y > 54 && p.y < H - 8 ? "" : "0";
    }
    if (this.frz != null) {
      const p = proj(this.frz);
      this.frzEl.style.transform = `translateY(${p.y.toFixed(1)}px)`;
      this.frzEl.style.display = "";
    } else this.frzEl.style.display = "none";
    const c0 = proj(0), c1 = proj(ZTOP);
    this.colEl.style.transform = `translate(${c0.x.toFixed(1)}px, ${c1.y.toFixed(1)}px)`;
    this.colEl.style.height = `${Math.max(0, c0.y - c1.y).toFixed(1)}px`;
    // layer tags beside their heights; they nudge apart instead of overlapping
    const placed = [];
    for (const { el, L } of this.layerTags || []) {
      const pb = proj(L.base / 1000), pt = proj(L.top / 1000);
      let y = (pb.y + pt.y) / 2;
      for (const q of placed) if (Math.abs(q - y) < 40) y = q - 40;
      placed.push(y);
      el.style.transform = `translateY(${(y - 18).toFixed(1)}px)`;
      el.style.setProperty("--span", `${Math.max(4, pb.y - pt.y).toFixed(1)}px`);
      el.style.setProperty("--off", `${(pt.y - (y - 18)).toFixed(1)}px`);
    }
    // wind: arrows turned to how the wind blows across this view (up = away from you)
    const hd = (this.view.heading) * DEG;
    for (const w of this.winds || []) {
      const p = proj(w.z);
      const across = w.u * Math.cos(hd) - w.v * Math.sin(hd), away = w.u * Math.sin(hd) + w.v * Math.cos(hd);
      const ang = Math.atan2(across, away) / DEG;
      w.el.style.transform = `translateY(${p.y.toFixed(1)}px)`;
      w.el.firstChild.style.transform = `rotate(${ang.toFixed(0)}deg)`;
      w.el.style.opacity = w.spd < 0.5 || p.y < 60 ? "0" : "";
    }
    // observed bases from the nearest airport
    if (this.obs?.length && this.obsShown()) {
      const s = this.obs[0];
      this.obsEl.replaceChildren(...s.layers.map((l) => {
        const p = proj((l.base - (this.cur?.head.elev || 0) + (s.elev || 0)) / 1000);
        return h("div", { class: "ob", style: { transform: `translateY(${p.y.toFixed(1)}px)`, width: `${Math.max(60, p.x - 20).toFixed(0)}px` } },
          h("i", {}), h("span", {}, `${s.id} ${l.cover} ${heightOne(l.base)}`));
      }));
    } else this.obsEl.replaceChildren();
    this.placeCompass(cam);
  }

  placeCompass(cam) {
    const hd = Math.atan2(cam.fwd[0], cam.fwd[1]) / DEG;
    this.compassEl.firstChild.style.transform = `rotate(${(-hd).toFixed(1)}deg)`;
    this.compassEl.lastChild.textContent = compass(hd);
  }

  showLayer(L) {
    this.card?.remove();
    const hd = this.cur.head;
    const rows = [
      ["Base", heightOne(L.base) + (hd.elev > 50 ? ` above the ground (${heightOne(L.base + hd.elev)} above sea level)` : "")],
      ["Top", heightOne(L.top)],
      ["Thickness", heightOne(L.top - L.base)],
      ["Temperature", `${fmt("temp", L.tBase)} at the base, ${fmt("temp", L.tTop)} at the top`],
      ["Cover", `${Math.round(L.cover * 100)}% of the sky near the point`],
      ["Made of", { liquid: "Water droplets", mixed: "Water droplets and ice crystals", ice: "Ice crystals" }[L.phase]],
    ];
    if (PRECIP[L.precip]) rows.push(["Precipitation", PRECIP[L.precip]]);
    const sp = L.species ? ` ${L.species}` : "";
    this.card = h("div", { class: "sky-card glass-strong", role: "dialog", "aria-label": L.name },
      h("div", { class: "pc-h" }, h("div", { class: "t" }, h("b", {}, `${L.name}${sp}`), h("small", {}, `${L.genus} · from ${hd.source}${hd.estimated ? " (estimated)" : ""}`)),
        h("button", { class: "closex", "aria-label": "Close", html: icon("x", 16), onclick: () => { this.card.remove(); this.card = null; } })),
      h("p", {}, MEANING[L.genus] || ""),
      h("dl", {}, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
    this.ui.append(this.card);
  }

  // ---------------------------------------------------------------- menu
  toggleMenu(sourceFirst = false) {
    if (this.menu?.classList.contains("open")) { this.menu.classList.remove("open"); return; }
    const app = this.app;
    this.menu?.remove();
    const seg = (opts, cur, fn) => h("div", { class: "seg" }, ...opts.map(([v, l]) => h("button", { class: v === cur ? "sel" : "", onclick: () => { fn(v); this.toggleMenu(); this.toggleMenu(sourceFirst); } }, l)));
    const sw = (title, sub, on, fn) => {
      const s = h("span", { class: `switch${on ? " on" : ""}` });
      const b = h("button", { class: "lrow", role: "switch", "aria-checked": String(on) }, h("span", { class: "tt" }, h("b", {}, title), h("small", {}, sub)), s);
      b.addEventListener("click", () => { const v = !s.classList.contains("on"); s.classList.toggle("on", v); b.setAttribute("aria-checked", String(v)); fn(v); });
      return b;
    };
    const srcs = [["auto", "Auto"], ...(app.catalog.sky?.models || []).map((m) => [m, m.toUpperCase()]), ["ecmwf_ifs025", "ECMWF est."]];
    const items = [
      h("h6", {}, "View"),
      seg([["side", "Side"], ["ground", "From the ground"]], this.view.mode, (m) => this.setMode(m)),
      h("h6", {}, "Clouds from"),
      seg(srcs, this.source, (v) => { this.source = v; app.savePref("skySource", v); this.blocked.clear(); this.onTime(); }),
      h("small", { class: "note" }, "Auto uses HRRR, then RRFS, then GFS: the models' own cloud water. ECMWF comes from Open-Meteo and is estimated from humidity."),
      h("h6", {}, "Show"),
      sw("Observed cloud bases", "Nearest airport ceilometer, near the current time", this.prefs.skyObs !== false, (v) => { app.savePref("skyObs", v); if (v) this.loadObserved(); this._ovSig = null; this.dirty = true; this.kick(); }),
      sw("Sound", "Rain, wind and thunder", !!this.prefs.skySound, (v) => { app.savePref("skySound", v); if (v) this.sound.start().then(() => this.updateSound(), (e) => toastError(e)); else this.sound.stop(); }),
    ];
    if (window.DeviceOrientationEvent && isTouch()) items.push(sw("Tilt to look around", "Move your phone for a little parallax", !!this.prefs.skyTilt, (v) => { app.savePref("skyTilt", v); if (v) this.enableTilt(true); else this.disableTilt(); }));
    items.push(h("div", { class: "row-btns" },
      h("button", { class: "btn sm", onclick: () => { this.toggleMenu(); this.ambient(true); } }, h("span", { html: icon("clock", 15) }), "Ambient mode"),
      h("button", { class: "btn sm", onclick: () => { this.toggleMenu(); this.saveImage(); } }, h("span", { html: icon("camera", 15) }), "Save image")));
    this.menu = h("div", { class: "popover sky-menu glass-strong", role: "dialog", "aria-label": "Sky options" }, ...items);
    this.ui.append(this.menu);
    requestAnimationFrame(() => this.menu.classList.add("open"));
  }

  // ---------------------------------------------------------------- extras
  async loadObserved() {
    const p = this.p;
    try {
      const { stations } = await API.get(`/sky/observed?lat=${p.lat}&lon=${p.lon}`, { quiet: true });
      if (this.p === p) { this.obs = stations.filter((s) => s.layers?.length); this._ovSig = null; this.dirty = true; this.kick(); }
    } catch { /* optional */ }
  }

  obsShown() { return this.prefs.skyObs !== false && Math.abs(this.t - Date.now() / 1000) < 5400; }

  // how much the ground glows with city lights at night, from the night-lights image around the point
  async measureCityGlow() {
    const p = this.p;
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "img/earth-night-2k.jpg"; });
      const c = document.createElement("canvas");
      const W = 2048, H = 1024, x = Math.round((p.lon + 180) / 360 * W), y = Math.round((90 - p.lat) / 180 * H);
      c.width = 9; c.height = 9;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, x - 4, y - 4, 9, 9, 0, 0, 9, 9);
      const d = g.getImageData(0, 0, 9, 9).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 765;
      if (this.p === p) this.cityGlow = clamp(Math.pow(s / 81, 0.6) * 1.6, 0.03, 1);
    } catch { /* default */ }
  }

  updateSound() {
    if (!this.sound.on || !this.cur) return;
    const hd = this.cur.head;
    const wc = hd.precip?.wc || 0;
    const rate = Math.pow(wc / 0.072, 1 / 0.88);
    this.sound.set({ rain: hd.precip?.kind === "none" ? 0 : rate, wind: Math.hypot(hd.profile.u[1], hd.profile.v[1]) * 0.7, snow: hd.precip?.kind === "snow" });
  }

  // real strikes from the GOES lightning mapper inside the box, when looking at "now"
  pullRealLightning() {
    const L = this.app.lightning;
    if (!L?.enabled || L.mode !== "live" || !L.n || Math.abs(this.t - Date.now() / 1000) > 3600) return;
    const end = L.playNow();
    const from = Math.max(this._ltT || end - 2, end - 5);
    this._ltT = end;
    const kx = 111.32 * Math.cos(this.p.lat * DEG), ky = 110.57;
    const out = [];
    for (let i = L.n - 1; i >= 0 && L.times[i] > from; i--) {
      if (L.times[i] > end) continue;
      const x = (L.data[i * 5] - this.p.lon) * kx, y = (L.data[i * 5 + 1] - this.p.lat) * ky;
      if (Math.abs(x) < 60 && Math.abs(y) < 60) out.push({ x, y, t: L.times[i] });
    }
    if (out.length) this.storm.addReal(out.slice(0, 4));
  }

  ambient(on) {
    if (on === !!this.amb) return;
    this.amb = on;
    document.body.classList.toggle("sky-ambient", on);
    if (on) {
      this.onTime();
      this._ambTimer = setInterval(() => this.onTime(), 30000);
      this.ambientPoke();
      if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => { this.wake = l; }, () => {});
      this._ambVis = () => { if (!document.hidden && this.amb && "wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => { this.wake = l; }, () => {}); };
      document.addEventListener("visibilitychange", this._ambVis);
      toast("Ambient mode", { body: "Following the real time. Tap to show the controls, Esc to leave.", ms: 3500 });
    } else {
      clearInterval(this._ambTimer);
      this.wake?.release?.().catch(() => {});
      this.wake = null;
      document.removeEventListener("visibilitychange", this._ambVis);
      document.body.classList.remove("sky-ambient-peek");
      if (this.isOpen && !this.leaving) this.onTime();
    }
  }

  ambientPoke() {
    document.body.classList.add("sky-ambient-peek");
    clearTimeout(this._peek);
    this._peek = setTimeout(() => document.body.classList.remove("sky-ambient-peek"), 3500);
  }

  async saveImage() {
    if (!this.lastState || this._saving) return;
    this._saving = true;
    try { await this._saveImage(); } catch (err) { toastError(err, "Couldn't save the image"); } finally { this._saving = false; }
  }

  async _saveImage() {
    const blob = await this.r.snapshot(this.lastState, 16);
    if (!blob) throw new Error("The picture couldn't be captured");
    const img = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const s = c.height / 900;
    const hd = this.cur?.head;
    const name = this.app.savedPoint?.(this.p)?.name || this.p.name || `${this.p.lat.toFixed(2)}, ${this.p.lon.toFixed(2)}`;
    const layers = hd?.layers.length ? [...new Set(hd.layers.map((l) => l.name))].join(", ") : "Clear sky";
    const lines = [`${layers} over ${name}`, `${when(new Date(this.t * 1000))} · ${hd ? `${hd.source}${hd.run ? ` ${hd.run.slice(8, 10)}z` : ""}${hd.estimated ? " (estimated)" : ""}` : ""} · Mammatus`];
    g.font = `600 ${Math.round(22 * s)}px ui-sans-serif, -apple-system, Segoe UI, sans-serif`;
    g.shadowColor = "rgba(0,0,0,.55)";
    g.shadowBlur = 12 * s;
    g.fillStyle = "rgba(255,255,255,.95)";
    g.fillText(lines[0], 28 * s, c.height - 54 * s);
    g.font = `500 ${Math.round(15 * s)}px ui-sans-serif, -apple-system, Segoe UI, sans-serif`;
    g.fillStyle = "rgba(235,240,255,.78)";
    g.fillText(lines[1], 28 * s, c.height - 28 * s);
    const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
    const file = new File([out], `mammatus-sky-${name.replace(/[^\w]+/g, "-").toLowerCase()}.jpg`, { type: "image/jpeg" });
    if (isTouch() && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: lines[0] }); return; } catch { /* fall back to download */ }
    }
    const a = h("a", { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast("Image saved", { body: file.name, ms: 2500 });
  }

  async enableTilt(ask) {
    try {
      if (ask && typeof DeviceOrientationEvent.requestPermission === "function") {
        if ((await DeviceOrientationEvent.requestPermission()) !== "granted") throw new Error("Motion access was denied");
      }
    } catch (err) { toastError(err, "Can't use the phone's motion"); this.app.savePref("skyTilt", false); return; }
    let base = null;
    this.tilt = { yaw: 0, pitch: 0 };
    this._onTilt = (e) => {
      if (e.beta == null || e.gamma == null) return;
      base ||= { b: e.beta, g: e.gamma };
      const ty = clamp((e.gamma - base.g) * 0.12, -4, 4), tp = clamp((e.beta - base.b) * 0.08, -2.5, 2.5);
      this.tilt.yaw = lerp(this.tilt.yaw, ty, 0.15);
      this.tilt.pitch = lerp(this.tilt.pitch, tp, 0.15);
      // drift the reference back to the current hold, so it never gets stuck off-centre
      base.b = lerp(base.b, e.beta, 0.002); base.g = lerp(base.g, e.gamma, 0.002);
      this.dirty = true;
      this.kick();
    };
    window.addEventListener("deviceorientation", this._onTilt);
  }

  disableTilt() {
    if (this._onTilt) window.removeEventListener("deviceorientation", this._onTilt);
    this._onTilt = null;
    this.tilt = null;
  }

  // keyboard, while open (called by the app before its own handling); returns true when used
  key(e) {
    if (!this.isOpen) return false;
    const k = e.key;
    if (k === "Escape") {
      if (this.card) { this.card.remove(); this.card = null; }
      else if (this.menu?.classList.contains("open")) this.menu.classList.remove("open");
      else if (this.amb) this.ambient(false);
      else this.exit();
      return true;
    }
    if (k === "s" || k === "S") { this.exit(); return true; }
    if (k === "g" || k === "G") { this.setMode(this.view.mode === "side" ? "ground" : "side"); return true; }
    if (k === "+" || k === "=") { this.zoomTo({ zoom: this.view.zoom, fov: this.view.fov }, 1.25); this.kick(); return true; }
    if (k === "-") { this.zoomTo({ zoom: this.view.zoom, fov: this.view.fov }, 0.8); this.kick(); return true; }
    if (this.amb) this.ambientPoke();
    return false;
  }
}

// the mean wind (m/s east, north) over a height band of a frame
function bandWind(f, [z0, z1]) {
  const u = f.head.profile.u, v = f.head.profile.v;
  const k0 = clamp(Math.floor(z0 / 0.25), 0, NZ - 1), k1 = clamp(Math.ceil(z1 / 0.25) - 1, k0, NZ - 1);
  let su = 0, sv = 0;
  for (let k = k0; k <= k1; k++) { su += u[k] || 0; sv += v[k] || 0; }
  return [su / (k1 - k0 + 1), sv / (k1 - k0 + 1)];
}

// The side view's backdrop: the colours of the atmosphere by altitude (0 to 18 km), for the half of the sky
// away from the sun and the half toward it. By day pale blue near the ground deepening through blue and
// violet to the black of space; at sunrise and sunset fire and rose toward the sun under a violet sky, the
// Belt of Venus and the earth's blue shadow opposite it; indigo with a last ember on the horizon in twilight;
// navy at night. Written as display colours (what the screen should show; the renderer divides by its exposure),
// blended and interpolated in that space with a curve that has no flat spots, so there are no bands where one
// stop hands over to the next.
const RAMP_Z = [0, 1.5, 3.5, 6, 9, 12, 15, 18];
const RAMPS = {
  day: [[0.50, 0.66, 0.82], [0.40, 0.60, 0.84], [0.26, 0.49, 0.82], [0.13, 0.34, 0.74], [0.045, 0.17, 0.60], [0.022, 0.05, 0.36], [0.018, 0.012, 0.16], [0.002, 0.001, 0.012]],
  goldTo: [[1.0, 0.50, 0.14], [0.92, 0.36, 0.14], [0.70, 0.24, 0.22], [0.40, 0.17, 0.36], [0.16, 0.11, 0.42], [0.05, 0.05, 0.28], [0.014, 0.010, 0.11], [0.0015, 0.001, 0.008]],
  goldAway: [[0.40, 0.40, 0.54], [0.52, 0.37, 0.46], [0.43, 0.33, 0.52], [0.24, 0.26, 0.56], [0.10, 0.14, 0.50], [0.035, 0.05, 0.30], [0.012, 0.010, 0.12], [0.0015, 0.001, 0.008]],
  twiTo: [[0.62, 0.21, 0.07], [0.37, 0.12, 0.10], [0.16, 0.07, 0.15], [0.07, 0.05, 0.17], [0.03, 0.035, 0.14], [0.013, 0.014, 0.08], [0.005, 0.004, 0.035], [0.001, 0.0008, 0.004]],
  twiAway: [[0.07, 0.08, 0.17], [0.11, 0.08, 0.18], [0.08, 0.07, 0.19], [0.05, 0.05, 0.17], [0.028, 0.03, 0.13], [0.012, 0.013, 0.075], [0.005, 0.004, 0.035], [0.001, 0.0008, 0.004]],
  night: [[0.0042, 0.0054, 0.0102], [0.0036, 0.0046, 0.0096], [0.003, 0.0039, 0.0084], [0.0023, 0.0029, 0.0068], [0.0016, 0.0019, 0.0048], [0.001, 0.001, 0.003], [0.0005, 0.0005, 0.0016], [0.00016, 0.00016, 0.0006]],
};
function backdropRamp(sunEl, moonF, glow) {
  const wd = smooth(3, 14, sunEl);
  const up = smooth(-4, 1.5, sunEl);
  const wg = up * (1 - wd);
  const wt = smooth(-12, -5, sunEl) * (1 - up);
  const wn = Math.max(0, 1 - wd - wg - wt);
  // what the old, fixed exposure made of these numbers
  const golden = smooth(-6, 2, sunEl) * (1 - smooth(4, 18, sunEl));
  const shown = lerp(1, 4.2, 1 - smooth(-14, -3, sunEl)) * lerp(1, 1.2, golden);
  const g = (x) => Math.pow(Math.max(x, 0), 1 / 2.2);
  const out = new Float32Array(256 * 2 * 4);
  for (let side = 0; side < 2; side++) {
    const gold = side ? RAMPS.goldTo : RAMPS.goldAway, twi = side ? RAMPS.twiTo : RAMPS.twiAway;
    // the stops for this sun, in display space
    const stops = RAMP_Z.map((z, i) => [0, 1, 2].map((c) => {
      const nite = RAMPS.night[i][c] * (1 + 1.1 * moonF) + [0.030, 0.017, 0.008][c] * glow * 0.32 * (1 - smooth(0, 4, z));
      const day = RAMPS.day[i][c] * (side ? 1.04 : 0.97);
      return g(day) * wd + g(gold[i][c]) * wg + g(twi[i][c]) * wt + g(nite) * wn;
    }));
    for (let c = 0; c < 3; c++) {
      const y = stops.map((s) => s[c]);
      const f = pchip(RAMP_Z, y);
      for (let i = 0; i < 256; i++) {
        const v = Math.pow(Math.max(f((i / 255) * 18), 0), 2.2);
        out[(side * 256 + i) * 4 + c] = v * shown;
      }
    }
    for (let i = 0; i < 256; i++) out[(side * 256 + i) * 4 + 3] = 1;
  }
  return out;
}
// a smooth curve through points that never overshoots them (Fritsch and Carlson)
function pchip(x, y) {
  const n = x.length, h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = x[i + 1] - x[i]; d[i] = (y[i + 1] - y[i]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (t) => {
    let i = 0;
    while (i < n - 2 && t > x[i + 1]) i++;
    const s = clamp((t - x[i]) / h[i], 0, 1), s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y[i] + (s3 - 2 * s2 + s) * h[i] * m[i] + (-2 * s3 + 3 * s2) * y[i + 1] + (s3 - s2) * h[i] * m[i + 1];
  };
}

export { inConus };
