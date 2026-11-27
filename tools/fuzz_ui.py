"""Fuzz the web app in headless Chrome against the demo server (tools/demo_server.py).

Boots with randomized (and corrupted) saved preferences, saved views and deep links, then runs
random sequences of real interactions: taps, drags, pinches, wheel zooms, double taps, long
presses, keys, the layer picker, the layers menu, the timeline, the drawer, search, resizes,
going offline and hiding/showing the page. After every step it checks invariants:

  - no uncaught exceptions or console errors
  - the camera is finite and in range, and no pointer is left stuck in the gesture tracker
  - the renderer still draws when asked (and has not lost its context)
  - nothing invisible covers the map (a hidden popover swallowing gestures)

    python tools/demo_server.py --port 8099 &
    python tools/fuzz_ui.py --runs 6 --steps 60          # needs playwright + Chrome
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
import traceback

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8099"
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding"]
MOBILE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=1.5, is_mobile=True, has_touch=True,
              user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
DESKTOP = dict(viewport={"width": 1180, "height": 760}, device_scale_factor=1)
BENIGN = ("Service Worker", "GL Driver Message", "net::ERR_INTERNET_DISCONNECTED", "Failed to load resource",
          "ERR_NETWORK_CHANGED", "net::ERR_ABORTED", "status of 404", "status of 502", "status of 503")

INVARIANTS = r"""
() => {
  const app = window.mammatus;
  const out = [];
  if (!app || !app.renderer) return ["app not booted"];
  const cam = app.renderer.camera;
  for (const k of ["lon", "lat", "zoom", "t"]) if (!Number.isFinite(cam[k])) out.push(`camera.${k} = ${cam[k]}`);
  if (cam.zoom < 0.4 || cam.zoom > 13) out.push(`zoom out of range ${cam.zoom}`);
  if (Math.abs(cam.lat) > 89.5) out.push(`lat out of range ${cam.lat}`);
  if (app.renderer.lost) out.push("WebGL context lost");
  const c = app.controls;
  if (c && c.pointers.size && !window.__touching) out.push(`stuck pointers: ${c.pointers.size}`);
  // anything that takes pointer events over the map must be visible
  const W = innerWidth, H = innerHeight;
  const pts = [[W * 0.5, H * 0.42], [W * 0.25, H * 0.3], [W * 0.75, H * 0.55], [W * 0.5, H * 0.2], [W * 0.3, H * 0.6]];
  for (const [x, y] of pts) {
    let el = document.elementFromPoint(x, y);
    if (!el || el.id === "globe" || el.closest(".modal-back.open")) continue;  // a modal blocks on purpose
    let op = 1, hidden = false, moving = false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      op *= parseFloat(cs.opacity);
      if (cs.visibility === "hidden" || cs.display === "none") hidden = true;
      if (e.getAnimations().length) moving = true;   // mid fade-in or fade-out
    }
    if (moving) continue;
    if (op < 0.05 || hidden) out.push(`invisible element ${el.tagName}.${el.className} intercepts (${x|0},${y|0})`);
  }
  return out;
}
"""

ALIVE = r"""
async () => {
  const r = window.mammatus.renderer;
  const f0 = r.frames;
  r.requestRender();
  for (let i = 0; i < 60; i++) { await new Promise((res) => setTimeout(res, 100)); if (r.frames > f0) return true; }
  return document.hidden || r.frames > f0;
}
"""


def rand_prefs(rng: random.Random) -> dict:
    vals = lambda: rng.choice([None, True, False, 0, -1, 3, 1e9, "x", "", [], {}, [1, "a"], {"a": 1}, 0.5, -0.5, "NaN"])  # noqa: E731
    keys = ["units", "tz", "mode", "opacity", "speed", "smooth", "lightningAnim", "lowPower", "rememberView", "alerts",
            "lightning", "fronts", "liveClouds", "particles", "cities", "counties", "realistic", "lastSource", "lastProduct",
            "mgHidden", "mgRange", "sounding", "mgModels"]
    p = {}
    for k in rng.sample(keys, rng.randint(0, len(keys))):
        p[k] = vals()
    if rng.random() < 0.5:
        p["mode"] = rng.choice(["globe", "map", "auto", "flat", 3])
    if rng.random() < 0.6:
        p["lastSource"] = rng.choice([
            {"type": "model", "model": rng.choice(["gfs", "hrrr", "ecmwf", "nope", None]), "product": rng.choice(["t2m", "mslp", "wind10", "refc", "zzz", 5])},
            {"type": "radar"}, {"type": "sat", "product": rng.choice(["globalir", "globalvis", "globalwv", "bogus"])},
            {"type": "weird"}, "radar", None])
    if rng.random() < 0.4:
        p["units"] = rng.choice(["us", "metric", "uk", {"temp": "C", "wind": "kt"}, {"temp": 7}, "zz"])
    if rng.random() < 0.3:
        p["tz"] = rng.choice(["America/New_York", "UTC", "Not/AZone", "", 42])
    if rng.random() < 0.5:
        p["lightning"] = True
    return p


def rand_view(rng: random.Random) -> str:
    return rng.choice([
        json.dumps({"lon": rng.uniform(-200, 200), "lat": rng.uniform(-100, 100), "zoom": rng.uniform(-3, 20)}),
        json.dumps({"lon": -95, "lat": 38, "zoom": 4.2}), '{"lon": null, "lat": "x"}', "not json", "null", "[]",
        json.dumps({"lon": 1e308, "lat": -1e308, "zoom": 1e308})])


def rand_hash(rng: random.Random) -> str:
    return rng.choice(["", "#m=gfs&p=mslp", "#m=hrrr&p=refc&f=6", "#layer=radar", "#ll=35.6,-82.5,7", "#ll=999,999,999",
                       "#ll=NaN,1,2", "#ll=1,2,1e309", "#point=999", "#alert=x", "#m=gfs&r=1999010100&p=t2m", "#model=gfs&run=bad",
                       "#m=bogus&p=t2m", "#f=-5&m=gfs", "#p=%E2%9C%93", "#" + "a" * 500])


class Fuzzer:
    def __init__(self, page, rng: random.Random, mobile: bool, log):
        self.page, self.rng, self.mobile, self.log = page, rng, mobile, log
        self.cdp = page.context.new_cdp_session(page) if mobile else None

    def W(self):
        return self.page.viewport_size["width"]

    def H(self):
        return self.page.viewport_size["height"]

    def map_point(self):
        return self.rng.uniform(20, self.W() - 20), self.rng.uniform(80, self.H() * 0.62)

    # ---- touch through CDP
    def touch(self, kind, pts):
        self.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [
            {"x": x, "y": y, "id": i, "radiusX": 3, "radiusY": 3, "force": 1} for i, (x, y) in pts]})

    def gesture(self, frames):
        self.page.evaluate("window.__touching = true")
        try:
            self.touch("touchStart", frames[0])
            for f in frames[1:]:
                self.touch("touchMove", f)
            self.touch("touchEnd", [])
        finally:
            self.page.evaluate("window.__touching = false")

    # ---- actions
    def a_tap(self):
        x, y = self.map_point()
        if self.mobile:
            self.gesture([[(x, y)]])
        else:
            self.page.mouse.click(x, y)

    def a_drag(self):
        x0, y0 = self.map_point()
        x1, y1 = x0 + self.rng.uniform(-300, 300), y0 + self.rng.uniform(-300, 300)
        n = self.rng.randint(2, 12)
        if self.mobile:
            self.gesture([[(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n)] for k in range(n + 1)])
        else:
            self.page.mouse.move(x0, y0)
            self.page.mouse.down()
            for k in range(1, n + 1):
                self.page.mouse.move(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n)
            self.page.mouse.up()

    def a_pinch(self):
        if not self.mobile:
            return self.a_wheel()
        cx, cy = self.map_point()
        d0, d1 = self.rng.uniform(30, 250), self.rng.uniform(5, 400)
        n = self.rng.randint(2, 10)
        self.gesture([[(cx - (d0 + (d1 - d0) * k / n) / 2, cy), (cx + (d0 + (d1 - d0) * k / n) / 2, cy)] for k in range(n + 1)])

    def a_wheel(self):
        x, y = self.map_point()
        self.page.mouse.move(x, y)
        for _ in range(self.rng.randint(1, 6)):
            self.page.mouse.wheel(0, self.rng.choice([-2000, -400, -100, -3, 3, 100, 400, 5000]))

    def a_double_tap(self):
        x, y = self.map_point()
        if self.mobile:
            self.gesture([[(x, y)]])
            self.gesture([[(x, y)]])
        else:
            self.page.mouse.dblclick(x, y)

    def a_two_finger_tap(self):
        if not self.mobile:
            return self.a_tap()
        x, y = self.map_point()
        self.gesture([[(x - 30, y), (x + 30, y)]])

    def a_quick_zoom(self):
        if not self.mobile:
            return self.a_wheel()
        x, y = self.map_point()
        self.gesture([[(x, y)]])
        self.gesture([[(x, y)], [(x, y + 40)], [(x, y + 90)], [(x, y + 20)]])

    def a_long_press(self):
        x, y = self.map_point()
        if self.mobile:
            self.page.evaluate("window.__touching = true")
            self.touch("touchStart", [(x, y)])
            self.page.wait_for_timeout(700)
            self.touch("touchEnd", [])
            self.page.evaluate("window.__touching = false")
        else:
            self.page.mouse.move(x, y)
            self.page.mouse.down()
            self.page.wait_for_timeout(700)
            self.page.mouse.up()

    def a_key(self):
        self.page.keyboard.press(self.rng.choice([" ", "ArrowLeft", "ArrowRight", "g", "l", "/", "+", "-", "Escape", "f", "Escape", "q", "Home"]))

    def click_any(self, selector):
        loc = self.page.locator(selector)
        n = loc.count()
        if not n:
            return False
        el = loc.nth(self.rng.randrange(n))
        try:
            if self.mobile:
                el.tap(timeout=1500)
            else:
                el.click(timeout=1500)
            return True
        except Exception:
            return False

    def a_picker(self):
        self.click_any(".layerpill")
        self.page.wait_for_timeout(200)
        if self.rng.random() < 0.5:
            self.click_any(".picker .mrow")
            self.page.wait_for_timeout(150)
            self.click_any(".picker .chip")
        self.click_any(".picker .prod:not(.dis)")

    def a_layers(self):
        self.click_any("button[aria-label='Map layers']")
        self.page.wait_for_timeout(200)
        self.click_any(".layersmenu .seg button" if self.rng.random() < 0.5 else ".layersmenu .lrow")
        if self.rng.random() < 0.5:
            self.page.keyboard.press("Escape")
            self.click_any("button[aria-label='Map layers']")

    def a_timeline(self):
        r = self.rng.random()
        if r < 0.35:
            box = self.page.locator(".timeline .track").bounding_box()
            if box:
                x, y = box["x"] + self.rng.uniform(0, box["width"]), box["y"] + box["height"] / 2
                (self.page.touchscreen.tap if self.mobile else self.page.mouse.click)(x, y)
        elif r < 0.6:
            self.click_any(".timeline .play")
            self.page.wait_for_timeout(self.rng.randint(200, 1500))
            self.click_any(".timeline .play")
        else:
            self.click_any(".timeline .chip")

    def a_fab(self):
        self.click_any(".fab button")

    def a_drawer(self):
        if not self.page.locator(".drawer.open").count():
            self.click_any(".pointcard .pc-actions .btn") or self.a_long_press()
        self.page.wait_for_timeout(300)
        self.click_any(".drawer .tabs button")
        self.page.wait_for_timeout(400)
        if self.rng.random() < 0.4:
            self.click_any(".drawer .closex")

    def a_search(self):
        self.click_any("button[aria-label='Search']")
        self.page.wait_for_timeout(150)
        self.page.keyboard.type(self.rng.choice(["ash", "a", "35.6, -82.5", "zzzz", "✓", "Tok", "-91,200", "new york"]))
        self.page.wait_for_timeout(500)
        self.page.keyboard.press(self.rng.choice(["Enter", "Escape", "ArrowDown"]))

    def a_resize(self):
        sizes = [(390, 844), (844, 390), (1180, 760), (768, 1024), (320, 568), (1440, 900)]
        w, h = self.rng.choice(sizes)
        self.page.set_viewport_size({"width": w, "height": h})

    def a_offline(self):
        ctx = self.page.context
        ctx.set_offline(True)
        for _ in range(self.rng.randint(1, 3)):
            self.rng.choice([self.a_drag, self.a_picker, self.a_timeline, self.a_tap])()
        self.page.wait_for_timeout(500)
        ctx.set_offline(False)

    def a_hide(self):
        self.page.evaluate("""() => {
          Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
          Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
          document.dispatchEvent(new Event('visibilitychange'));
        }""")
        self.page.wait_for_timeout(self.rng.randint(100, 800))
        self.page.evaluate("""() => {
          delete document.hidden; delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
        }""")

    def a_hash(self):
        self.page.evaluate(f"location.hash = {json.dumps(rand_hash(self.rng))}")

    def a_pointcard(self):
        self.a_tap()
        self.page.wait_for_timeout(300)
        self.click_any(".pointcard button")

    def a_api_junk(self):
        # in-page APIs fed junk: decoders, labels, lightning sync, camera math
        self.page.evaluate(r"""async () => {
          const app = window.mammatus, rnd = Math.random;
          const junk = () => [NaN, Infinity, -Infinity, 1e308, -1e308, 0, -0, null, undefined, "x", {}, []][Math.floor(rnd() * 12)];
          const { decodeChunk } = await import("/js/lightning.js");
          for (let i = 0; i < 20; i++) {
            const n = Math.floor(rnd() * 64);
            const b = new Uint8Array(n); crypto.getRandomValues(b);
            if (rnd() < 0.5 && n > 8) { b.set([0x4d, 0x4d, 0x4c, 0x31]); new DataView(b.buffer).setUint32(4, Math.floor(rnd() * 80), true); }
            try { decodeChunk(b.buffer); } catch (e) { /* rejected cleanly */ }
          }
          const L = app.renderer.labels;
          L.setContourLabels([{ lon: junk(), lat: junk(), text: "1004" }, { lon: 10, lat: 10, text: "" }, { lon: 1, lat: 2, text: String(junk()) }]);
          L.setHilo([{ lon: junk(), lat: 40, value: junk(), type: 1 }]);
          app.lightning.sync({ mode: ["live", "step", "off", "bogus"][Math.floor(rnd() * 4)], T: junk(), prevT: junk(), window: junk(), spread: junk() });
          const cam = app.renderer.camera;
          cam.panBy(junk(), junk()); cam.zoomAround(junk(), junk(), junk()); cam.flyTo({ lon: junk(), lat: junk(), zoom: junk() }, 10);
          cam.project(junk(), junk()); cam.unproject(junk(), junk());
          app.renderer.requestRender();
          await new Promise((r) => setTimeout(r, 200));
          L.setContourLabels([]); L.setHilo([]);
          app.syncOverlays(null);
        }""")

    ACTIONS = ["a_tap", "a_drag", "a_drag", "a_pinch", "a_wheel", "a_double_tap", "a_two_finger_tap", "a_quick_zoom",
               "a_long_press", "a_key", "a_picker", "a_picker", "a_layers", "a_layers", "a_timeline", "a_fab", "a_drawer",
               "a_search", "a_resize", "a_offline", "a_hide", "a_hash", "a_pointcard", "a_api_junk"]


COOKIES: list = []


def run_one(pw, seed: int, mobile: bool, steps: int, report: list) -> None:
    rng = random.Random(seed)
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=ARGS)
    ctx = browser.new_context(**(MOBILE if mobile else DESKTOP), service_workers="block")
    H = {"X-Mammatus": "1", "Content-Type": "application/json"}
    if COOKIES:
        ctx.add_cookies(COOKIES)
    if not COOKIES or not ctx.request.get(f"{BASE}/api/auth/me").ok:
        r = ctx.request.post(f"{BASE}/api/auth/login", data=json.dumps({"username": "demo", "password": "synthetic-weather-42"}), headers=H)
        if not r.ok:
            raise RuntimeError(f"login failed: {r.text()}")
        COOKIES[:] = ctx.cookies()
    prefs = rand_prefs(rng)
    ctx.request.patch(f"{BASE}/api/auth/me", data=json.dumps({"prefs": prefs}), headers=H)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e} @ {(getattr(e, 'stack', '') or '').splitlines()[1:3]}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" and not any(b in m.text for b in BENIGN) else None)
    view = rand_view(rng)
    page.add_init_script(f"try {{ localStorage.setItem('mm.view', {json.dumps(view)}); }} catch (e) {{}}")
    hash_ = rand_hash(rng)
    history = [f"boot prefs={json.dumps(prefs)} view={view} hash={hash_}"]
    tag = f"{'mobile' if mobile else 'desktop'} seed {seed}"

    def fail(why):
        report.append({"run": tag, "why": why, "history": history[-12:]})
        print(f"  !! {tag}: {why}", flush=True)

    try:
        page.goto(f"{BASE}/{hash_}")
        page.wait_for_function("() => window.mammatus && window.mammatus.layers && !document.getElementById('splash')", timeout=90000)
    except Exception as exc:
        txt = page.evaluate("document.querySelector('#splash .msg')?.textContent || ''")
        fail(f"boot failed: {exc.__class__.__name__} splash={txt!r} errors={errors[:3]}")
        browser.close()
        return
    fz = Fuzzer(page, rng, mobile, history)
    for step in range(steps):
        name = rng.choice(Fuzzer.ACTIONS)
        history.append(name)
        try:
            getattr(fz, name)()
            page.wait_for_timeout(rng.choice([50, 150, 400, 900]))
        except Exception as exc:
            if "Target page, context or browser has been closed" in str(exc):
                fail("page crashed")
                break
            tb = traceback.extract_tb(exc.__traceback__)[-1]
            history.append(f"  (driver {name}: {exc.__class__.__name__}: {str(exc)[:100]} at line {tb.lineno})")
        if errors:
            fail("; ".join(dict.fromkeys(errors))[:900])
            errors.clear()
        try:
            bad = page.evaluate(INVARIANTS)
            if bad:
                fail("invariants: " + "; ".join(bad))
            if step % 5 == 4 and not page.evaluate(ALIVE):
                fail("renderer stopped drawing")
        except Exception as exc:
            fail(f"invariant check failed: {exc}")
    browser.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=4)
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--only", choices=["mobile", "desktop"])
    args = ap.parse_args()
    report: list = []
    t0 = time.time()
    with sync_playwright() as pw:
        for k in range(args.runs):
            for mobile in (True, False):
                if args.only and args.only != ("mobile" if mobile else "desktop"):
                    continue
                seed = args.seed + k
                print(f"run {'mobile' if mobile else 'desktop'} seed {seed}", flush=True)
                try:
                    run_one(pw, seed, mobile, args.steps, report)
                except Exception:
                    report.append({"run": f"seed {seed}", "why": traceback.format_exc()[-600:], "history": []})
    print(f"\n{len(report)} problems in {time.time() - t0:.0f}s")
    for p in report:
        print(f"\n[{p['run']}] {p['why']}\n   last steps: {' > '.join(p['history'][-8:])}")
    sys.exit(1 if report else 0)


if __name__ == "__main__":
    main()
