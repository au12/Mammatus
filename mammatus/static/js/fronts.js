// WPC fronts overlay: picks the analysis or forecast that matches the displayed time.
//
//  - Near the present and in the recent past, the newest analysis issued for that time is shown
//    (WPC analyzes every 3 hours and publishes about 90 minutes later), up to 6 hours old.
//  - Further ahead, the 12-48 hour forecast fronts are used within 3 hours of their valid time.
import { get } from "./api.js";

const HOUR = 3600000;

export class Fronts extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.enabled = false;
    this.sets = [];
    this.current = null;
    this.centers = false;
    this.fetchedAt = 0;
    this.error = null;
    this.T = Date.now();
    document.addEventListener("visibilitychange", () => { if (!document.hidden && this.enabled) this.refresh(); });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async setEnabled(on) {
    this.enabled = on;
    clearInterval(this.timer);
    if (!on) {
      this.current = null;
      this.draw(null, false);
      this.emit("status", this.info());
      return;
    }
    await this.refresh(true);
    this.timer = setInterval(() => { if (!document.hidden) this.refresh(); }, 10 * 60000);
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.fetchedAt < 9 * 60000) return;
    try {
      const data = await get("/fronts", { quiet: true });
      this.sets = data.sets.map((s) => ({ ...s, validMs: Date.parse(s.valid), issuedMs: Date.parse(s.issued) }))
        .sort((a, b) => a.validMs - b.validMs);
      this.fetchedAt = Date.now();
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
    this.current = undefined;  // force a redraw with the new sets
    this.sync(this.T, { centers: this.centers });
  }

  pick(T) {
    const now = Date.now();
    if (T <= now + 1.5 * HOUR) {
      const an = this.sets.filter((s) => s.kind === "analysis" && s.validMs <= T + 1.5 * HOUR && T - s.validMs <= 6 * HOUR);
      if (an.length) return an[an.length - 1];
    }
    let best = null, bd = Infinity;
    for (const s of this.sets) {
      if (s.kind !== "forecast") continue;
      const d = Math.abs(s.validMs - T);
      if (d <= 3 * HOUR && d < bd) { best = s; bd = d; }
    }
    return best;
  }

  // centers: also draw WPC highs and lows (skipped when the map already shows model pressure centers)
  sync(T, { centers = false } = {}) {
    this.T = T;
    if (!this.enabled) return;
    const set = this.pick(T);
    if (set !== this.current || centers !== this.centers) {
      this.current = set;
      this.centers = centers;
      this.draw(set, centers);
      this.emit("status", this.info());
    }
  }

  draw(set, centers) {
    this.app.renderer.frontLayer.set(set || null);
    this.app.overlay.setFrontCenters(centers && set ? set.highs : [], centers && set ? set.lows : []);
  }

  info() {
    const s = this.current;
    return {
      enabled: this.enabled, error: this.error,
      set: s ? { kind: s.kind, hours: s.hours, valid: new Date(s.validMs) } : null,
    };
  }
}
