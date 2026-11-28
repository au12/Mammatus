// The Sky view is half of the app's code (its shaders alone are a quarter): it is loaded the first time it
// is wanted (the Sky button is hovered or pressed, the S key, a #sky= link), not on every start. Until then
// app.sky is this stand-in, which answers the questions the rest of the app asks of a closed Sky view.
export class LazySky {
  constructor(app) {
    this.app = app;
    this.isOpen = false;
    this.p = null;
  }

  load() {
    this._loading ||= import("./view.js").then(({ SkyView }) => {
      const sky = new SkyView(this.app);
      if (this.app.sky === this) this.app.sky = sky;
      return sky;
    });
    this._loading.catch(() => { this._loading = null; });   // (offline: try again next time)
    return this._loading;
  }

  prewarm(p) { this.load().then((s) => s.prewarm(p), () => {}); }
  enter(p) { return this.load().then((s) => s.enter(p)); }
  setPoint(p) { return this.enter(p); }
  key() { return false; }
  ensure() { return Promise.resolve(); }
  shown() { return Promise.resolve(); }
}
