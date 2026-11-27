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
import { Loader, plan, frameIds, mergeBands, inConus, N, ZTOP } from "./data.js";
import * as A from "./astro.js";
import { Storm } from "./bolts.js";
import { Ambience } from "./audio.js";

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapDeg = (a) => ((a % 360) + 540) % 360 - 180;
const DRIFT = 4;           // clouds drift at 4x real time
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
    this.p = { ...p, lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3) };
    this.blocked.clear();
    this.display = { A: null, B: null, mix: 0, morph: null };
    this.appear = { v: 0, t0: null };
    this.cur = null;
    this.obs = null;
    this.heightOf = null;
    this.headingSet = false;
    this.cityGlow = null;
    this.renderTitle();
    this.onTime();
    if (this.prefs.skyObs !== false) this.loadObserved();
    this.measureCityGlow();
    if (!first) this.kick();
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
    this.t = t;
    const pl = plan(this.app, t, this.p.lat, this.p.lon, { source: this.source, blocked: this.blocked });
    this.plan = pl;
    const [ida, idb] = frameIds(pl, this.p.lat, this.p.lon);
    this.want = { a: ida, b: idb, mix: pl.mix };
    const quick = pl.kind === "model" && !this.loader.peek(ida, 1);
    const load = (id) => {
      if (quick) this.loader.get(id, 0).then((f) => this.got(f), () => {});
      return this.loader.get(id, pl.kind === "model" ? 1 : 0).then((f) => this.got(f));
    };
    this.loading = true;
    this.renderStatus();
    Promise.all([load(ida), idb !== ida ? load(idb) : null]).then(() => {
      if (this.want?.a === ida) { this.loading = false; this.renderStatus(); }
      this.prefetch();
    }, (err) => {
      if (this.want?.a !== ida) return;
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

  prefetch() {
    const L = this.app.layers;
    if (this.amb || !L?.steps?.length) return;
    const dir = this.app.playing ? 1 : 0;
    for (const d of dir ? [1, 2, 3] : [1, -1]) {
      const st = L.steps[L.index + d];
      if (!st) continue;
      const pl = plan(this.app, st.time.getTime() / 1000, this.p.lat, this.p.lon, { source: this.source, blocked: this.blocked });
      for (const id of new Set(frameIds(pl, this.p.lat, this.p.lon))) this.loader.get(id, pl.kind === "model" ? 1 : 0).catch(() => {});
    }
  }

  got(f) {
    if (!this.isOpen) return;
    this.frames.set(f.key, f);
    while (this.frames.size > 16) this.frames.delete(this.frames.keys().next().value);
    this.r.frame(f.key, f);
    if (this.p && Math.abs(f.head.lat - this.p.lat) < 1e-3 && Math.abs(f.head.lon - this.p.lon) < 1e-3) {
      this.r.setTerrain(f.terrain);
      this.terrain = f.terrain;
    }
    this.kick();
  }

  // the best loaded version (full volume, else the quick sketch) of a frame id
  best(id) {
    if (!id) return null;
    for (const d of [1, 0]) if (this.frames.has(`${id}#${d}`)) return `${id}#${d}`;
    return null;
  }

  // move what's displayed toward what's wanted, with a morph so clouds grow and fade instead of popping
  updateDisplay(now) {
    const D = this.display;
    if (D.morph) {
      const m = D.morph;
      const u = clamp((now - m.t0) / m.dur, 0, 1);
      D.mix = lerp(m.from, m.to, ease(u));
      if (u >= 1) {
        D.morph = null;
        if (m.collapse) { D.A = D.B; D.mix = 0; }
      }
      return true;
    }
    if (!this.want) return false;
    const ta = this.best(this.want.a), tb = this.best(this.want.b) || ta;
    if (!ta) return false;
    const dur = this.app.playing ? 380 : 900;
    if (!D.A) {
      D.A = ta; D.B = tb; D.mix = tb === ta ? 0 : this.want.mix;
      this.onShown(true);
      return true;
    }
    const single = tb === ta || this.want.mix < 0.002;
    if (single) {
      if (D.A === ta && (D.mix < 0.002 || D.B === ta)) return false;
      const from = D.mix > 0.5 ? D.B : D.A;
      D.A = from; D.B = ta; D.mix = 0;
      D.morph = { t0: now, dur, from: 0, to: 1, collapse: true };
    } else if (D.A === ta && D.B === tb) {
      if (Math.abs(D.mix - this.want.mix) < 0.004) return false;
      D.morph = { t0: now, dur: 300, from: D.mix, to: this.want.mix };
    } else {
      const from = D.mix > 0.5 ? D.B : D.A;
      if (from === ta) { D.A = ta; D.B = tb; D.morph = { t0: now, dur, from: 0, to: this.want.mix }; }
      else { D.A = from; D.B = ta; D.mix = 0; D.morph = { t0: now, dur, from: 0, to: 1, collapse: true }; }
    }
    this.onShown(false);
    return true;
  }

  // the frame that dominates the display changed: labels, storm cells, sounds
  onShown(first) {
    const D = this.display;
    const key = D.morph?.collapse ? D.B : (D.mix > 0.5 ? D.B : D.A);
    const f = this.frames.get(key);
    if (!f) return;
    this.cur = f;
    const hd = f.head;
    if (first && !this.appear.t0) this.appear.t0 = performance.now() + (this.intro && this.intro.dir > 0 ? Math.max(0, this.intro.dur * 0.55 - (performance.now() - this.intro.t0)) : 0);
    const anvilTop = Math.max(0, ...hd.layers.filter((l) => l.genus === "Cb").map((l) => l.top / 1000));
    this.storm.setCells(hd.cells, anvilTop || 12);
    this.renderLayers();
    this.renderTitle();
    this.renderStatus();
    this.updateSound();
    if (!this.headingSet) { this.view.heading = this.defaultHeading(); this.headingSet = true; }
  }

  // ---------------------------------------------------------------- environment (sun, moon, light)
  env() {
    const t = new Date(this.t * 1000);
    const { lat, lon } = this.p;
    const sun = A.sun(t, lat, lon), moon = A.moon(t, lat, lon);
    const sunDir = A.dirOf(sun.az, sun.el), moonDir = A.dirOf(moon.az, moon.el);
    const day = A.daylight(sun.el);
    const night = 1 - smooth(-14, -3, sun.el);
    const elev = (this.cur?.head.elev || 0) / 1000;
    const moonUp = smooth(-1, 3, moon.el) * (0.15 + 0.85 * moon.illum);
    const useSun = sun.el > -7 || moonUp < 0.02;
    const lightEl = useSun ? sun.el : moon.el;
    const tint = useSun ? [1, 1, 1] : [0.78, 0.86, 1.0];
    const lightI = useSun ? 1 : 0.06 * moonUp;
    const lut = new Float32Array(64 * 4);
    for (let i = 0; i < 64; i++) {
      const c = A.sunlight(lightEl, (i / 63) * 20);
      lut.set([c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], 1], i * 4);
    }
    const sunCol = A.sunlight(sun.el, elev + (this.camZ || 0));
    // skylight from above and light bounced off the ground
    const golden = smooth(-6, 2, sun.el) * (1 - smooth(4, 18, sun.el));
    const sky = [0.33 * day + 0.004, 0.47 * day + 0.006, 0.86 * day + 0.012].map((x, i) => x * (1 - golden * 0.35) + golden * [0.42, 0.28, 0.36][i] * 0.6);
    const moonAmb = moonUp * 0.012;
    const ambTop = sky.map((x, i) => x * 0.95 + moonAmb * [0.6, 0.7, 1][i]);
    const s0 = Math.max(Math.sin(sun.el * DEG), 0);
    const ground = [0.16, 0.15, 0.12];
    // cloud bases see the ground's bounce and the horizon sky
    const ambBot = ground.map((g, i) => g * (sunCol[i] * s0 * 1.2 + sky[i] * 0.5) + sky[i] * 0.3 + moonAmb * 0.3);
    const glow = this.cityGlow ?? 0.2;
    const cityCol = [1.0, 0.56, 0.24].map((x) => x * glow * 0.05 * night);
    const exposure = lerp(1.0, 4.2, night) * lerp(1, 1.2, golden);
    const sfc = this.cur?.head.sfc || {};
    const snowing = this.cur?.head.precip?.kind === "snow";
    const snow = (sfc.t2m != null && sfc.t2m < 272.5 && (snowing || Math.abs(lat) > 40)) ? (snowing ? 0.75 : 0.35) : 0;
    // equatorial -> local sky, for the stars
    const d = t.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const lst = (((280.46061837 + 360.98564736629 * d) % 360) + lon) * DEG;
    const ph = lat * DEG;
    const cl = Math.cos(lst), sl = Math.sin(lst), cp = Math.cos(ph), sp = Math.sin(ph);
    // columns: images of the equatorial x, y, z axes in (east, north, up)
    const eq = new Float32Array([-sl, -sp * cl, cp * cl, cl, -sp * sl, cp * sl, 0, cp, sp]);
    return {
      light: useSun ? sunDir : moonDir, lightI, sunDir, sunCol, moonDir, moonCol: [0.9, 0.92, 1.0].map((x) => x * 0.55),
      moonIllum: moon.illum, night, ambTop, ambBot, cityCol, exposure, lut, elev, lat, lon, snow, cityGlow: glow,
      starVis: Math.pow(night, 2) * (1 - 0.5 * moonUp), rays: day * 0.9, eq, sun, moon,
    };
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
  // the box's terrain (km, relative to the point)
  groundAt(x, y) {
    const T = this.terrain;
    if (!T) return 0;
    const fx = clamp((x + 60) / 3 - 0.5, 0, N - 1.001), fy = clamp((y + 60) / 3 - 0.5, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const at = (a, b) => T[b * N + a];
    return lerp(lerp(at(i, j), at(i + 1, j), u), lerp(at(i, j + 1), at(i + 1, j + 1), u), v);
  }

  // a safe height to keep the camera above (the shader adds hills and ridges on top of the box terrain)
  terrainAt(x, y) {
    const T = this.terrain;
    if (!T) return 0;
    const fx = clamp((x + 60) / 3 - 0.5, 0, N - 1.001), fy = clamp((y + 60) / 3 - 0.5, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const at = (a, b) => T[b * N + a];
    const val = lerp(lerp(at(i, j), at(i + 1, j), u), lerp(at(i, j + 1), at(i + 1, j + 1), u), v);
    const out = Math.max(Math.abs(x), Math.abs(y)) - 60;
    return out > 0 ? lerp(val, 0, smooth(0, 30, out)) + 0.35 : val + 0.1;
  }

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

  camFrom(q, aspect) {
    const { heading: hd, pitch } = q;
    const fwd = [Math.sin(hd) * Math.cos(pitch), Math.cos(hd) * Math.cos(pitch), -Math.sin(pitch)];
    const hint = norm([lerp(0, Math.sin(hd), smooth(60 * DEG, 88 * DEG, pitch)), lerp(0, Math.cos(hd), smooth(60 * DEG, 88 * DEG, pitch)), lerp(1, 0.02, smooth(60 * DEG, 88 * DEG, pitch))]);
    const right = norm(cross(fwd, hint));
    const up = cross(right, fwd);
    const half = Math.tan(q.fov / 2) * q.D;
    let s = q.s;
    const T = [0, 0, q.zT];
    let pos = [T[0] - up[0] * s * half - fwd[0] * q.D, T[1] - up[1] * s * half - fwd[1] * q.D, T[2] - up[2] * s * half - fwd[2] * q.D];
    // never under the ground: lift the camera and shift the lens back so the point stays framed
    const g = this.terrainAt(pos[0], pos[1]) + 0.12;
    if (pos[2] < g) {
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
    let c, cut = [0, 1, -1e4, 0], stylize = 0, refDist = 30;
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
      c = this.camFrom(q, aspect);
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
        const fwd2 = norm(c.fwd.map((x, i) => lerp(x, g.fwd[i], w)));
        const fov2 = lerp(c.fov, g.fov, w);
        const hint2 = Math.abs(fwd2[2]) > 0.99 ? [Math.sin(hd), Math.cos(hd), 0] : [0, 0, 1];
        c = { pos: pos2, fwd: fwd2, right: norm(cross(fwd2, hint2)), up: [0, 0, 1], view: M4.lookDir(pos2, fwd2, hint2), proj: M4.persp(fov2, aspect, 0.001, 900, lerp(side.s, 0, w)), fov: fov2 };
        cut[3] = w > 0.3 ? 0 : cut[3];
        stylize *= 1 - w;
        if (u >= 1) this.modeAnim = null;
      } else c = g;
    }
    c.vp = M4.mul(c.proj, c.view);
    c.invVP = M4.inv(c.vp);
    c.cut = cut;
    c.stylize = stylize;
    c.hazeK = lerp(1, 0.18, stylize);
    c.slab = this.view.mode === "side" || this.modeAnim ? this.slab : [1e4, 1];
    c.refDist = refDist;
    c.far = 880;
    this.camZ = c.pos[2];
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
    let busy = false;
    if (this.intro) {
      busy = true;
      if (now - this.intro.t0 >= this.intro.dur) this.intro = null;
    }
    if (this.modeAnim) busy = true;
    const changed = this.updateDisplay(now);
    if (changed || this.display.morph) busy = true;
    if (this.appear.t0) {
      const a = clamp((now - this.appear.t0) / (reducedMotion() ? 1 : 1700), 0, 1);
      if (a < 1) busy = true;
      this.appear.v = a;
    }
    const interacting = now - this.lastInteract < 180 || this.fling;
    if (this.fling) this.stepFling(dt);
    // drift clock: real time sped up, frozen for reduced motion
    if (motion) this.driftT = (this.driftT || 0) + dt * DRIFT;
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
        this.draw(now, { moving: interacting || !!this.intro || !!this.modeAnim || !this.display.A, dataChanged: !!this.display.morph || changed || fl.lights.length > 0, flashes: fl.lights, bolts: fl.bolts });
        this.fails = 0;
      } catch (err) {
        if (!this.fails) console.error("Mammatus: sky view failed to draw", err);
        this.fails = (this.fails || 0) + 1;
        if (this.fails > 30) { toastError(err, "The Sky view can't draw on this device"); this.exit(); return; }
      }
      if (this.display.A) this.adapt(now);
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
    this.r.setSunLUT(e.lut);
    const D = this.display;
    const fa = this.frames.get(D.A), fb = this.frames.get(D.B);
    if (fa && this._windKey !== D.A) { this.r.setWind(fa.wind); this._windKey = D.A; }
    const bands = mergeBands([...(fa?.bands || []), ...(fb && D.mix > 0.002 ? fb.bands : [])]);
    const mam = Math.max(fa?.head.mammatus || 0, D.mix > 0.002 ? fb?.head.mammatus || 0 : 0);
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
      cam, env: e, time: this.driftT || 0, moving, dataChanged,
      weather: { a: D.A, b: D.B || D.A, mix: D.mix, appear: this.appear.v, mammatus: mam, bands, ext: 0.4 },
      flashes, bolts,
    };
    this.lastState = s;
    this.r.render(s, now);
    this.placeOverlay(cam);
  }

  // keep the frame time in budget by trading cloud resolution
  adapt(now) {
    const ms = this.r.stats.ms;
    this._adaptT ||= now;
    if (now - this._adaptT < 1500) return;
    this._adaptT = now;
    const budget = this.r.lowPower ? 22 : 14;
    if (ms > budget * 1.25) this.r.setScale(this.r.scale - 0.06);
    else if (ms < budget * 0.55) this.r.setScale(this.r.scale + 0.04);
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
    const g = this.cur ? ` · ground ${heightOne(this.cur.head.elev)}` : "";
    this.titleEl.lastChild.textContent = `${when(t)}${g}`;
    const hd = this.cur?.head;
    if (hd) {
      const est = hd.estimated;
      const res = { hrrr: "3 km", rrfs: "3 km", gfs: "25 km" }[hd.model] || "";
      this.srcBtn.innerHTML = `${est ? '<i class="est">Estimated</i>' : ""}<b>${hd.source}</b>${res ? `<small>${res}</small>` : ""}${hd.run ? `<small>${hd.run.slice(8, 10)}z</small>` : ""}`;
      this.srcBtn.classList.toggle("estimated", !!est);
      this.srcBtn.title = est ? "Estimated: Open-Meteo derives cloud by height from humidity, not from the model's own cloud water." : `${hd.source} cloud water, ice, rain and snow · ${hd.attribution}`;
      const attr = this.app.attrib;
      if (attr) attr.textContent = `Sky: ${hd.source} · ${hd.attribution}${est ? " · estimated" : ""}`;
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
  }

  renderLayers() {
    const hd = this.cur?.head;
    if (!hd || !this.layersEl) return;
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
    const blob = await this.r.snapshot(this.lastState);
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

export { inConus };
