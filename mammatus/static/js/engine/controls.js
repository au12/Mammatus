// Pointer, touch and wheel interaction. Emits "tap", "doubletap", "hover", "longpress", "move", "end".
//
// Robust against the ways a gesture can go missing on phones: a finger lifted while the app was
// hidden, a pointer capture taken away by the browser, or a pointerup that never arrives. Any of
// those used to leave a stale pointer behind, after which every one-finger drag was treated as a
// broken pinch and the map stopped moving.
//
// Touch gestures: drag to pan (with momentum), pinch to zoom, double-tap to zoom in, double-tap and
// drag up/down to zoom with one finger, two-finger tap to zoom out, long-press for the forecast.

const TAP_SLOP = { mouse: 5, pen: 7, touch: 10 };
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 42;
const LONG_PRESS_MS = 550;

export class Controls extends EventTarget {
  constructor(el, renderer) {
    super();
    this.el = el;
    this.r = renderer;
    this.cam = renderer.camera;
    this.pointers = new Map();   // pointerId -> {x, y, t, type}
    this.samples = [];           // recent single-pointer positions for the release velocity
    this.enabled = true;
    this.lastTap = null;         // {x, y, t} of the last touch tap (double-tap detection)
    this.quick = null;           // one-finger double-tap-and-drag zoom
    this.twoTap = null;          // two-finger tap detection
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.up(e, true));
    el.addEventListener("lostpointercapture", (e) => { if (this.pointers.has(e.pointerId)) this.up(e, true); });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !this.pointers.size) this.emit("hover", null); });
    el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    el.addEventListener("dblclick", (e) => this.dbl(e));
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    // a gesture interrupted by the app going to the background never gets its pointerup
    const reset = () => this.reset();
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Forget every pointer and in-progress gesture.
  reset() {
    const had = this.pointers.size > 0;
    for (const id of this.pointers.keys()) { try { this.el.releasePointerCapture?.(id); } catch { /* already gone */ } }
    this.pointers.clear();
    this.samples = [];
    this.pinch = null;
    this.downAt = null;
    this.quick = null;
    this.twoTap = null;
    clearTimeout(this.lpTimer);
    if (had) this.emit("end");
  }

  down(e) {
    if (!this.enabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A new primary pointer means every earlier one has ended, whether or not we heard about it.
    if (e.isPrimary && this.pointers.size) this.reset();
    try { this.el.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    const p = this.pos(e);
    const now = performance.now();
    this.pointers.set(e.pointerId, { ...p, t: now, type: e.pointerType });
    this.cam.cancelAnimation();
    if (this.pointers.size === 1) {
      this.samples = [{ x: p.x, y: p.y, t: now }];
      this.downAt = { ...p, t: now, moved: false, type: e.pointerType };
      const lt = this.lastTap;
      if (e.pointerType !== "mouse" && lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(p.x - lt.x, p.y - lt.y) < DOUBLE_TAP_PX) {
        this.quick = { x: p.x, y: p.y, y0: p.y, z0: this.cam.zoom, zoomed: false };
        this.lastTap = null;
      }
      clearTimeout(this.lpTimer);
      const armed = this.downAt;
      const check = () => {
        if (this.downAt !== armed || armed.moved || this.pointers.size !== 1 || this.quick) return;
        // A timer that fires late means the main thread was busy: moves may still be queued behind
        // it, so look again shortly instead of mistaking the start of a drag for a long press.
        const late = performance.now() - (armed.lastMove || armed.t) > LONG_PRESS_MS + 120;
        if (late && !armed.recheck) { armed.recheck = true; this.lpTimer = setTimeout(check, 60); return; }
        armed.long = true;
        this.emit("longpress", p);
      };
      this.lpTimer = setTimeout(check, LONG_PRESS_MS);
    } else {
      clearTimeout(this.lpTimer);
      this.downAt = null;
      this.quick = null;
      this.samples = [];
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        this.twoTap = { t: now, moved: false };
      } else {
        this.pinch = null;
        this.twoTap = null;
      }
    }
    this.r.poke();
  }

  move(e) {
    const p = this.pos(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse" && !this.pointers.size) this.emit("hover", p);
      return;
    }
    // pressure-less mouse moves with no button held mean we missed the pointerup
    if (e.pointerType === "mouse" && e.buttons === 0) { this.up(e, true); return; }
    const now = performance.now();
    this.pointers.set(e.pointerId, { ...p, t: now, type: prev.type });
    if (this.pointers.size === 1) {
      const slop = TAP_SLOP[e.pointerType] ?? 8;
      if (this.downAt) this.downAt.lastMove = now;
      if (this.downAt && !this.downAt.moved && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > slop) {
        this.downAt.moved = true;
        clearTimeout(this.lpTimer);
      }
      if (this.downAt && !this.downAt.moved) return;
      if (this.quick) {
        // drag down to zoom in, up to zoom out, around where the double tap landed
        const dz = (p.y - this.quick.y0) / 110;
        this.cam.zoomAround(this.quick.x, this.quick.y, this.quick.z0 + dz - this.cam.zoom);
        this.quick.zoomed = true;
      } else {
        this.cam.panBy(p.x - prev.x, p.y - prev.y);
        this.samples.push({ x: p.x, y: p.y, t: now });
        while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
      }
      this.emit("move");
    } else if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this.twoTap && (Math.abs(d - this.pinch.d) > 3 || Math.hypot(mx - this.pinch.mx, my - this.pinch.my) > 3)) this.twoTap.moved = true;
      this.cam.panBy(mx - this.pinch.mx, my - this.pinch.my);
      if (this.pinch.d > 10 && d > 1) this.cam.zoomAround(mx, my, Math.log2(d / this.pinch.d));
      this.pinch = { d, mx, my };
      this.emit("move");
    }
    this.r.poke();
  }

  up(e, cancel = false) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.pos(e);
    const before = this.pointers.size;
    const mid = before === 2 && this.pinch ? { x: this.pinch.mx, y: this.pinch.my } : null;
    this.pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    clearTimeout(this.lpTimer);
    const now = performance.now();
    if (e.pointerType !== "mouse") this.lastTouchUp = now;
    if (this.pointers.size === 0) {
      const d = this.downAt;
      if (this.twoTap && before === 2 && !cancel && !this.twoTap.moved && now - this.twoTap.t < 280 && mid) {
        this.emit("zoomout", mid);
      } else if (this.quick && !cancel) {
        if (!this.quick.zoomed) this.emit("doubletap", { x: this.quick.x, y: this.quick.y });
      } else if (!cancel && d && !d.moved && !d.long && now - d.t < 500) {
        this.emit("tap", { ...p, pointerType: e.pointerType });
        this.lastTap = e.pointerType === "mouse" ? null : { x: p.x, y: p.y, t: now };
      } else if (!cancel && d?.moved) {
        this.fling(now);
      }
      this.downAt = null;
      this.pinch = null;
      this.quick = null;
      this.twoTap = null;
      this.samples = [];
      this.emit("end");
    } else if (this.pointers.size === 1) {
      // pinch -> one finger: carry on panning from where that finger is, without a jump or a fling
      this.pinch = null;
      this.downAt = { ...[...this.pointers.values()][0], t: now, moved: true };
      this.samples = [];
    }
    this.r.poke();
  }

  fling(now) {
    const s = this.samples;
    if (s.length < 2) return;
    const last = s[s.length - 1];
    if (now - last.t > 70) return;  // the finger stopped before it lifted
    let first = s[0];
    for (const q of s) if (last.t - q.t <= 90) { first = q; break; }
    const dt = last.t - first.t;
    if (dt < 8) return;
    this.cam.fling((last.x - first.x) / dt, (last.y - first.y) / dt);
    this.r.poke();
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.cam.cancelAnimation();
    const p = this.pos(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    else if (e.deltaMode === 2) dy *= 400;
    if (!Number.isFinite(dy)) return;
    const scale = e.ctrlKey ? 0.012 : 0.0022;
    this.cam.zoomAround(p.x, p.y, Math.max(-1.2, Math.min(1.2, -dy * scale)));
    this.r.poke();
    this.emit("move");
    clearTimeout(this.wheelEnd);
    this.wheelEnd = setTimeout(() => this.emit("end"), 180);
  }

  dbl(e) {
    // touch double-taps are recognized in up(); some browsers also send a dblclick for them
    if (performance.now() - (this.lastTouchUp || -1e9) < 800) return;
    this.emit("doubletap", this.pos(e));
  }
}
