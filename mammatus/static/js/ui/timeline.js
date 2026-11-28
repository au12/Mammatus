// Timeline: play/pause, time-proportional track with days, night shading, buffered frames, "now".
import { h, $, clamp } from "../util.js";
import { icon } from "./icons.js";
import { when, dayKey, dayLabel, weekday, solarElevation, rel } from "../time.js";

export class Timeline {
  constructor(app) {
    this.app = app;
    this.el = h("div", { class: "timeline glass" });
    this.play = h("button", { class: "play", "aria-label": "Play", html: icon("play", 22) });
    this.whenEl = h("span", { class: "when num" });
    this.subEl = h("span", { class: "sub" });
    this.speedBtn = h("button", { class: "chip", title: "Playback speed" });
    this.liveBtn = h("button", { class: "chip keep", title: "Jump to now" }, "Now");
    this.track = h("div", { class: "track", role: "slider", tabindex: "0", "aria-label": "Forecast time" });
    this.rail = h("div", { class: "rail" }, h("div", { class: "loaded" }));
    this.thumb = h("div", { class: "thumb" });
    this.nowEl = h("div", { class: "now" });
    this.deco = h("div");
    this.track.append(this.deco, this.rail, this.nowEl, this.thumb);
    this.el.append(this.play, h("div", { class: "tl-main" },
      h("div", { class: "tl-head" }, this.whenEl, this.subEl, h("div", { class: "right" }, this.speedBtn, this.liveBtn)), this.track));
    document.getElementById("ui").append(this.el);

    this.speeds = [["0.5×", 900], ["1×", 520], ["2×", 280], ["4×", 150]];
    this.speed = clamp(app.prefs.speed ?? 1, 0, 3);
    this.renderSpeed();
    this.speedBtn.addEventListener("click", () => { this.speed = (this.speed + 1) % 4; this.renderSpeed(); app.savePref("speed", this.speed); });
    this.liveBtn.addEventListener("click", () => app.jumpToNow());
    this.play.addEventListener("click", () => app.togglePlay());
    this.bindDrag();
    this.track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { app.stepBy(1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { app.stepBy(-1); e.preventDefault(); }
      else if (e.key === "Home") app.showIndex(0);
      else if (e.key === "End") app.showIndex(this.steps.length - 1);
    });
    this.steps = [];
    setInterval(() => { if (!document.hidden) this.placeNow(); }, 60000);
  }

  frameMs() { return this.speeds[this.speed][1]; }
  renderSpeed() { this.speedBtn.textContent = this.speeds[this.speed][0]; }

  setPlaying(on, buffering = false) {
    this.play.innerHTML = icon(buffering ? "spinner" : on ? "pause" : "play", 22);
    this.play.classList.toggle("buffering", buffering);
    this.play.setAttribute("aria-label", on ? "Pause" : "Play");
  }

  pos(t) {
    const s = this.steps;
    if (s.length < 2) return 0.5;
    return clamp((t - s[0].time) / (s[s.length - 1].time - s[0].time), 0, 1);
  }

  setSteps(steps) {
    this.steps = steps;
    this.deco.replaceChildren();
    if (!steps.length) { this.whenEl.textContent = "No data yet"; this.subEl.textContent = ""; return; }
    const t0 = steps[0].time.getTime(), t1 = steps[steps.length - 1].time.getTime();
    const span = t1 - t0;
    const pct = (t) => `${(this.pos(new Date(t)) * 100).toFixed(3)}%`;
    // day boundaries & labels (local midnight in the display tz)
    const hourMs = 3600000;
    const step = span > 5 * 86400000 ? 6 * hourMs : span > 36 * hourMs ? 3 * hourMs : span > 6 * hourMs ? hourMs : 15 * 60000;
    let prevDay = dayKey(steps[0].time);
    const wide = this.track.clientWidth || 600;
    const dayW = span > 0 ? (86400000 / span) * wide : wide;
    const labels = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const d = new Date(t);
      const k = dayKey(d);
      if (k !== prevDay) { labels.push(t); prevDay = k; }
    }
    if (span <= 6 * hourMs) {
      // short spans (radar/satellite): hour labels
      for (let t = Math.ceil(t0 / hourMs) * hourMs; t <= t1; t += hourMs) this.deco.append(h("span", { class: "day", style: { left: pct(t) } }, when(new Date(t)).split(" ").slice(1).join(" ")));
    } else {
      // day labels, kept from colliding on narrow tracks: the start label shortens or yields to a
      // nearby day boundary, and boundaries too close together drop out
      const long = dayW > 70;
      const est = (txt) => txt.length * 6.2 + 10;
      const px = (t) => this.pos(new Date(t)) * wide;
      const marks = labels.filter((t) => (t - t0) / span >= 0.02).map((t) => ({ t, x: px(t), txt: long ? dayLabel(new Date(t)) : weekday(new Date(t)) }));
      let startTxt = long ? dayLabel(steps[0].time) : weekday(steps[0].time);
      if (marks.length && est(startTxt) > marks[0].x - est(marks[0].txt) / 2) startTxt = weekday(steps[0].time);
      let lastRight = -Infinity;
      if (!marks.length || est(startTxt) <= marks[0].x - est(marks[0].txt) / 2) {
        this.deco.append(h("span", { class: "day", style: { left: "0%", transform: "none" } }, startTxt));
        lastRight = est(startTxt);
      }
      for (const m of marks) {
        const w = est(m.txt);
        if (m.x - w / 2 < lastRight + 6 || m.x + w / 2 > wide + 4) continue;
        lastRight = m.x + w / 2;
        this.deco.append(h("span", { class: "day", style: { left: pct(m.t) } }, m.txt));
        this.deco.append(h("i", { class: "tick", style: { left: pct(m.t), top: "9px", height: "12px", background: "rgba(255,255,255,.28)" } }));
      }
      // night shading at the map center
      const c = this.app.renderer.camera;
      const lat = c.lat, lon = c.lon;
      let nightStart = null;
      const sstep = Math.max(15 * 60000, span / 300);
      for (let t = t0; t <= t1 + sstep; t += sstep) {
        const night = solarElevation(new Date(Math.min(t, t1)), lat, lon) < -3;
        if (night && nightStart == null) nightStart = t;
        if ((!night || t > t1) && nightStart != null) {
          const a = this.pos(new Date(nightStart)), b = this.pos(new Date(Math.min(t, t1)));
          if (b > a) this.deco.append(h("i", { class: "night", style: { left: `${a * 100}%`, width: `${(b - a) * 100}%` } }));
          nightStart = null;
        }
      }
    }
    // step ticks (sparse when dense)
    const every = Math.max(1, Math.ceil(steps.length / (wide / 7)));
    steps.forEach((s, i) => { if (i % every === 0) this.deco.append(h("i", { class: "tick", style: { left: pct(s.time) } })); });
    this.track.setAttribute("aria-valuemin", "0");
    this.track.setAttribute("aria-valuemax", String(steps.length - 1));
    this.placeNow();
    this.renderLoaded();
  }

  placeNow() {
    const s = this.steps;
    const now = Date.now();
    const vis = s.length > 1 && now >= s[0].time && now <= s[s.length - 1].time;
    this.nowEl.style.display = vis ? "" : "none";
    if (vis) this.nowEl.style.left = `${this.pos(new Date(now)) * 100}%`;
  }

  setIndex(i, step) {
    if (!step) return;
    this.thumb.style.left = `${this.pos(step.time) * 100}%`;
    this.whenEl.textContent = when(step.time);
    const src = this.app.state.source;
    const parts = [];
    if (src?.type === "model") parts.push(`Hour ${step.fhr}`);
    parts.push(rel(step.time));
    this.subEl.textContent = parts.join(" · ");
    this.track.setAttribute("aria-valuenow", String(i));
    this.track.setAttribute("aria-valuetext", when(step.time));
  }

  renderLoaded() {
    const box = $(".loaded", this.rail);
    const s = this.steps;
    if (!s.length) { box.replaceChildren(); return; }
    const L = this.app.layers;
    const frag = [];
    let start = -1;
    const flush = (end) => {
      if (start < 0) return;
      const a = this.pos(s[start].time), b = end >= s.length - 1 ? this.pos(s[end].time) : this.pos(s[end + 1].time);
      frag.push(h("i", { style: { left: `${a * 100}%`, width: `${Math.max(0.4, (b - a) * 100)}%` } }));
      start = -1;
    };
    for (let i = 0; i < s.length; i++) {
      if (L.isLoaded(i)) { if (start < 0) start = i; } else { flush(i - 1); }
    }
    flush(s.length - 1);
    box.replaceChildren(...frag);
  }

  indexAt(x) {
    const r = this.track.getBoundingClientRect();
    const f = clamp((x - r.left) / r.width, 0, 1);
    const s = this.steps;
    if (!s.length) return 0;
    const t = s[0].time.getTime() + f * (s[s.length - 1].time - s[0].time);
    let best = 0, bd = Infinity;
    s.forEach((st, i) => { const d = Math.abs(st.time - t); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  bindDrag() {
    let dragging = false, last = -1;
    const move = (e) => {
      const i = this.indexAt(e.clientX);
      if (i !== last) { last = i; this.app.showIndex(i, { scrub: true }); }
    };
    this.track.addEventListener("pointerdown", (e) => {
      dragging = true; last = -1;
      this.track.setPointerCapture(e.pointerId);
      this.track.classList.add("drag");
      this.app.stopPlay();
      move(e);
    });
    this.track.addEventListener("pointermove", (e) => { if (dragging) move(e); });
    const end = () => { if (!dragging) return; dragging = false; this.track.classList.remove("drag"); this.app.layers.prefetch(); };
    this.track.addEventListener("pointerup", end);
    this.track.addEventListener("pointercancel", end);
  }
}
