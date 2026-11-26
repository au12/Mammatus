// Pointer, touch and wheel interaction with inertia. Emits "tap", "hover", "longpress".

export class Controls extends EventTarget {
  constructor(el, renderer) {
    super();
    this.el = el;
    this.r = renderer;
    this.cam = renderer.camera;
    this.pointers = new Map();
    this.vel = { x: 0, y: 0 };
    this.inertia = 0;
    this.downAt = null;
    this.lastMove = 0;
    this.enabled = true;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.up(e, true));
    el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") this.emit("hover", null); });
    el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    el.addEventListener("dblclick", (e) => this.dbl(e));
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    if (!this.enabled) return;
    this.el.setPointerCapture?.(e.pointerId);
    const p = this.pos(e);
    this.pointers.set(e.pointerId, { ...p, t: performance.now() });
    this.stopInertia();
    this.cam.cancelAnimation();
    if (this.pointers.size === 1) {
      this.downAt = { ...p, t: performance.now(), moved: false };
      clearTimeout(this.lpTimer);
      this.lpTimer = setTimeout(() => {
        if (this.downAt && !this.downAt.moved && this.pointers.size === 1) {
          this.downAt.long = true;
          this.emit("longpress", p);
        }
      }, 550);
    } else {
      this.downAt = null;
      clearTimeout(this.lpTimer);
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    this.r.poke();
  }

  move(e) {
    const p = this.pos(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === "mouse") this.emit("hover", p);
      return;
    }
    const prev = this.pointers.get(e.pointerId);
    const now = performance.now();
    this.pointers.set(e.pointerId, { ...p, t: now });
    if (this.pointers.size === 1) {
      const dx = p.x - prev.x, dy = p.y - prev.y;
      if (this.downAt && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > 6) this.downAt.moved = true;
      if (this.downAt && !this.downAt.moved) return;
      this.cam.panBy(dx, dy);
      const dt = Math.max(1, now - prev.t);
      this.vel = { x: 0.8 * (dx / dt) + 0.2 * this.vel.x, y: 0.8 * (dy / dt) + 0.2 * this.vel.y };
      this.lastMove = now;
      this.emit("move");
    } else if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.cam.panBy(mx - this.pinch.mx, my - this.pinch.my);
      if (this.pinch.d > 10) this.cam.zoomAround(mx, my, Math.log2(d / this.pinch.d));
      this.pinch = { d, mx, my };
      this.emit("move");
    }
    this.r.poke();
  }

  up(e, cancel = false) {
    const p = this.pos(e);
    this.pointers.delete(e.pointerId);
    clearTimeout(this.lpTimer);
    if (this.pointers.size === 0) {
      const now = performance.now();
      if (!cancel && this.downAt && !this.downAt.moved && !this.downAt.long && now - this.downAt.t < 500) {
        this.emit("tap", { ...p, pointerType: e.pointerType });
      } else if (!cancel && now - this.lastMove < 60 && Math.hypot(this.vel.x, this.vel.y) > 0.15) {
        this.startInertia();
      }
      this.downAt = null;
      this.pinch = null;
      this.emit("end");
    } else if (this.pointers.size === 1) {
      this.pinch = null;
    }
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.stopInertia();
    this.cam.cancelAnimation();
    const p = this.pos(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    const scale = e.ctrlKey ? 0.012 : 0.0022;
    this.cam.zoomAround(p.x, p.y, -dy * scale);
    this.r.poke();
    this.emit("move");
    clearTimeout(this.wheelEnd);
    this.wheelEnd = setTimeout(() => this.emit("end"), 180);
  }

  dbl(e) {
    const p = this.pos(e);
    const ll = this.cam.unproject(p.x, p.y);
    if (!ll) return;
    this.cam.flyTo({ lon: ll.lon, lat: ll.lat, zoom: this.cam.zoom + 1.2 }, 650);
    this.r.poke();
  }

  startInertia() {
    let { x, y } = this.vel;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(40, now - last);
      last = now;
      x *= Math.pow(0.992, dt);
      y *= Math.pow(0.992, dt);
      this.cam.panBy(x * dt, y * dt);
      this.r.poke();
      if (Math.hypot(x, y) > 0.02) this.inertia = requestAnimationFrame(step);
      else { this.inertia = 0; this.emit("end"); }
    };
    this.inertia = requestAnimationFrame(step);
  }

  stopInertia() {
    if (this.inertia) cancelAnimationFrame(this.inertia);
    this.inertia = 0;
  }
}
