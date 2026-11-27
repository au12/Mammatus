<p align="center">
  <img src="docs/logo.svg" width="128" alt="Mammatus icon">
</p>

<h1 align="center">Mammatus</h1>

<p align="center">
  A self-hosted weather model viewer on a living globe.<br>
  HRRR · RRFS · GFS · ECMWF IFS · ECMWF AIFS · MRMS radar · global satellite · GOES lightning · WPC fronts · NWS alerts
</p>

<p align="center">
  <img src="docs/screenshots/desktop-globe.jpg" alt="ECMWF temperature on the 3D globe" width="100%">
</p>

Mammatus pulls model data straight from NOAA and ECMWF open data, renders it on the GPU over a
realistic Earth (day/night terminator, city lights, atmosphere, stars) that morphs into a flat map as you
zoom in, and adds the tools you actually reach for: multi-model meteograms, skew-T soundings with
hodographs, live radar and satellite, NWS warnings, saved places and real push notifications. It is one
Docker container with a single `/data` volume, built for Unraid behind a reverse proxy, with accounts so
family can use it from anywhere.

## Highlights

- **Five models, one timeline.** HRRR and RRFS (3 km CONUS, hourly), GFS (0.25°, to 16 days), ECMWF IFS and
  AIFS (0.25°, open data). New runs appear automatically; a toast offers to load them.
- **32 products**: temperature, dewpoint, wind with animated flow, gusts, pressure & precipitation type
  with isobars and H/L centers, simulated radar, 1/6/24-h and total precipitation, snowfall at 10:1 and
  **Kuchera** ratios (plus each model's own), freezing rain, snow depth, CAPE (SB/ML/MU), helicity,
  updraft helicity, PWAT, 500 mb vorticity & heights, 850 mb temps, 250 mb jet, 700 mb RH, thickness.
- **Globe ↔ map.** A WebGL2 engine draws the data with per-pixel projection (no tile seams), cross-fades
  between hours, decodes frames off the main thread and draws contours and labels without blocking.
- **Live radar & satellite.** MRMS composite reflectivity every few minutes; global IR / visible / water
  vapor mosaics that also appear as live clouds on the globe.
- **Lightning.** Every flash seen by the GOES-East and GOES-West Geostationary Lightning Mappers, about a
  minute behind real time, drawn as lightning bolts: the newest are the biggest and white-hot, and they
  shrink and cool through gold and amber to crimson over half an hour. New strikes flash as they happen,
  flickering through their return strokes with a bloom and a ring. When storms come into view, their
  bolts flash in the order they struck, and the replay comes back every half minute so active cells
  stay easy to spot. Step or play a radar or satellite loop and the lightning that led up to each
  frame flashes along with it. Tap anywhere for the nearest strike ("Lightning 6 mi away · 3 min ago").
- **Fronts.** NOAA WPC's hand-drawn surface analysis (every 3 hours) and its 12–48 hour forecast fronts,
  matched to the timeline: cold, warm, stationary and occluded fronts with proper symbols, troughs, and
  WPC highs and lows when the map isn't already showing model pressure centers.
- **Sky view.** Press **Sky** on any point card (or **S**) and the map swoops down into a 3D side view of
  the atmosphere above that place: a cut-away diorama from the ground to 52,000 ft, with real volumetric
  clouds of the right type, amount and height, built from the model's own cloud water and ice (HRRR,
  then RRFS, then GFS; Open-Meteo profiles marked *Estimated* only for ECMWF or outages). Clouds condense
  in when it opens and drift with the model's winds at 4× real time; the timeline keeps working.
  Thunderstorms flash with lightning that lights the cloud from inside (real GOES strikes when they are
  near), cirrostratus throws a 22° halo and sun dogs, sunlit rain makes rainbows, and nights have the
  real stars, the moon in its phase and city glow on the cloud bases. Labels name each layer with its
  heights; observed METAR ceilings, a view from the ground, a gentle soundscape, tilt parallax, an
  ambient mode for a spare screen and save-as-image are in the ⋯ menu.
- **Point forecasts.** Tap anywhere: the value under your finger, active NWS alerts, then a multi-model
  meteogram (HRRR, RRFS, NBM, GFS, ECMWF, AIFS, ICON, GEM, UKMO) with daily consensus highs/lows,
  model spread, accumulated precip and snow, wind, pressure and cloud cover.
- **Soundings.** Skew-T log-p with surface/mixed-layer/most-unstable parcels (virtual-temperature
  corrected CAPE/CIN, LCL/LFC/EL), PWAT, lapse rates, shear, Bunkers storm motion, SRH, STP/SCP and a
  height-colored hodograph.
- **Alerts that reach your phone.** Saved places plus rules: NWS warnings/watches, thresholds
  ("≥ 4 in of snow in the next 3 days" across models), "precipitation starting soon", or new model runs.
  Delivered with standards-based Web Push (VAPID, RFC 8291) — no third-party service.
- **Accounts.** Invite-only users, admin and user roles, TOTP two-step verification, session management,
  password resets by link, an audit log.
- **Installable PWA.** Home-screen app on iOS and Android, offline shell, deep links from notifications.
- **Smooth and easy on batteries.** Labels and map symbols are drawn on the GPU, pixel-snapped and placed
  with hysteresis, so nothing flickers or jumps while you pan. Nothing renders unless something changes;
  the globe and data field are cached so lightning and wind frames redraw only what moves; animation
  idles after 20 s on phones, caps at 30 fps in battery-saver mode and stops entirely in the background.
  Live updates disconnect when the app is hidden. Frames are compact (quantized, delta-coded, gzip) and
  cached immutably.

## Screenshots

| | |
|---|---|
| ![GFS pressure and precipitation type](docs/screenshots/desktop-mslp.jpg) | ![HRRR wind with animated flow](docs/screenshots/desktop-wind.jpg) |
| GFS precipitation type with isobars and pressure centers | HRRR 10 m wind with animated particles |
| ![GOES lightning over South America](docs/screenshots/desktop-lightning.jpg) | ![WPC fronts with GFS pressure](docs/screenshots/desktop-fronts.jpg) |
| Live GOES lightning over Mexico, the Andes and the Amazon, with the infrared satellite | WPC fronts over GFS precipitation type and isobars |
| ![Regional view with point card](docs/screenshots/desktop-regional.jpg) | ![Skew-T sounding](docs/screenshots/desktop-sounding.jpg) |
| HRRR simulated radar at county level, tap for details | Skew-T and indices (demo profile) |
| ![Sky view: a thunderstorm in the afternoon](docs/screenshots/desktop-sky.jpg) | ![Sky view: the same storm at night, lit by lightning](docs/screenshots/desktop-sky-night.jpg) |
| Sky view: a thunderstorm's dark base under its anvil, with mammatus (demo scene) | The same storm at night, lit from inside by a lightning flash |

<p align="center">
  <img src="docs/screenshots/mobile-map.jpg" width="19%" alt="Mobile map">
  <img src="docs/screenshots/mobile-fronts.jpg" width="19%" alt="Mobile fronts">
  <img src="docs/screenshots/mobile-globe.jpg" width="19%" alt="Mobile globe">
  <img src="docs/screenshots/mobile-forecast.jpg" width="19%" alt="Mobile meteogram">
  <img src="docs/screenshots/mobile-sky.jpg" width="19%" alt="Mobile Sky view">
</p>

<p align="center"><sub>Meteogram, sounding and Sky view screenshots use demo data; the maps are real model output.</sub></p>

## Install on Unraid

1. **Apps → search "Mammatus"** if the template is listed, or add the template URL
   `https://raw.githubusercontent.com/au12/Mammatus/main/unraid/mammatus.xml` under
   *Docker → Add Container → Template repositories*.
2. Set the **Data** path (default `/mnt/user/appdata/mammatus`) and the **Public URL** you'll use
   (for example `https://wx.example.com`).
3. Start the container and open the log: it prints a one-time **setup code**. Open the web UI, enter the
   code and create the admin account. (Or set `MAMMATUS_ADMIN_USER` / `MAMMATUS_ADMIN_PASSWORD` for the
   first start.)
4. Settings → Users → **Create invite link** for each person you want to add.

### Docker Compose

```yaml
services:
  mammatus:
    image: ghcr.io/au12/mammatus:latest
    container_name: mammatus
    restart: unless-stopped
    ports: ["8080:8080"]
    volumes: ["./data:/data"]
    environment:
      MAMMATUS_PUBLIC_URL: https://wx.example.com
      MAMMATUS_CONTACT: you@example.com
      TZ: America/New_York
```

## Remote access

Put Mammatus behind HTTPS (Nginx Proxy Manager, Caddy, Traefik…). HTTPS is required for sign-in from
outside, installing the app and push notifications. See **[docs/reverse-proxy.md](docs/reverse-proxy.md)**
for an Nginx Proxy Manager walkthrough and the security model.

### Notifications on phones

- **Android / desktop:** Settings → Notifications → turn on *Push notifications*.
- **iPhone / iPad (iOS 16.4+):** open the site in Safari, *Share → Add to Home Screen*, open Mammatus from
  the home screen, then turn on notifications in Settings.
- Add places (tap the map, then ★) and create rules in Settings → Notifications.

## Configuration

| Variable | Default | |
|---|---|---|
| `MAMMATUS_PUBLIC_URL` | — | External `https://` URL; used for invite links, secure cookies and push |
| `MAMMATUS_MODELS` | `hrrr,rrfs,gfs,ecmwf,aifs` | Models to offer |
| `MAMMATUS_CACHE_GB` | `10` | Frame cache size cap |
| `MAMMATUS_SKY_CACHE_GB` | `2` | Sky view cache size cap (3D cloud boxes around viewed points) |
| `MAMMATUS_RETENTION_HOURS` | `54` | How long model frames are kept |
| `MAMMATUS_TRUSTED_PROXIES` | private networks | Who may set `X-Forwarded-For/Proto` |
| `MAMMATUS_HSTS` | `false` | Send `Strict-Transport-Security` |
| `MAMMATUS_SESSION_DAYS` | `30` | Session lifetime |
| `MAMMATUS_CONTACT` | — | Contact email for NOAA/NWS User-Agent and Web Push |
| `MAMMATUS_LIGHTNING` | `east,west` | GOES lightning sources: `east,west`, `east` (covers the lower 48) or `off` |
| `MAMMATUS_LIGHTNING_BACKFILL_MIN` | `30` | History fetched when someone turns lightning on (older radar frames fetch theirs on demand) |
| `MAMMATUS_OPENMETEO_URL` | `https://api.open-meteo.com` | Point forecasts & soundings (self-hosted Open-Meteo works) |
| `MAMMATUS_OPENMETEO_KEY` | — | Optional commercial Open-Meteo key |
| `MAMMATUS_ADMIN_USER` / `_PASSWORD` | — | Create the first admin without the setup code |
| `TZ` | `America/New_York` | Default display time zone (users can override) |
| `PUID` / `PGID` | `99` / `100` | User the app runs as |

## How it works

- **Backend:** Python (FastAPI + uvicorn). Run discovery lists the NOAA/ECMWF buckets once per run; frames
  are fetched with HTTP byte ranges using each file's index (only the fields needed), decoded with
  ecCodes, derived (winds rotated to earth-relative, accumulations, Kuchera snow, precip type, vorticity…),
  quantized to 16-bit, delta-coded and gzip-compressed into three levels of detail. Mirrors are tried in
  order (AWS → Google Cloud → NOMADS/ECMWF). Everything lives in SQLite and a size-capped disk cache.
- **Sky view:** for a point, the server byte-ranges the model's hydrometeor mixing ratios (cloud water,
  ice, rain, snow, graupel) on pressure levels for a 120 km box, places them by hypsometric height, and
  packs a 40×40×64 voxel grid (3 km × 250 m) with coverage, convectiveness and layer base/top, plus a
  cloud classification, storm cells and the nearest METAR. The browser ray-marches it through tileable
  Perlin–Worley noise with multiple-scattering light, temporal accumulation and a physical sky.
- **Lightning:** GLM publishes 20-second netCDF files (170–360 KB, of which the flashes are a few KB).
  Mammatus only downloads them while someone has the layer on (about 100 MB per hour for both
  satellites, 65 MB for East alone), splits the overlap between the satellites at the longitude
  closest to each one's nadir, and serves 10-minute chunks of 7 bytes per flash. Complete chunks are
  immutable, so browsers download each one once; the live edge is polled for just the newest strikes.
  On the map, frames are only drawn while a visible strike is flashing.
- **Frontend:** dependency-free ES modules and a custom WebGL2 renderer: an analytic globe/Mercator
  projection with exact inverse per pixel, data textures sampled in-shader on the model's native grid
  (lat/lon or Lambert conformal), perceptual OKLab color ramps, GPU particle advection with transform
  feedback, instanced anti-aliased lines, GPU text from a sprite atlas, signed-distance-field symbols,
  Web Workers for decoding and contouring. The whole app is about 155 kB gzipped.

## Development

```bash
pip install -r requirements.txt
MAMMATUS_DATA_DIR=./data python -m mammatus          # serves mammatus/static (unbundled) on :8080
cd tools && npm install && npm run build              # production bundle -> mammatus/static-dist
pytest -q
```

No network or model data needed for UI work: `python tools/demo_server.py --port 8099` serves the app
with synthetic models, radar, satellite, lightning, fronts and warnings (sign in as `demo` /
`synthetic-weather-42`).

Fuzzing: `MAMMATUS_FUZZ=20000 pytest tests/test_fuzz.py` runs the parser, rule-engine and API fuzzers
deeper (`MAMMATUS_FUZZ_SEED` picks the seed), and `python tools/fuzz_ui.py --runs 5` drives random
desktop and mobile sessions against the demo server with Playwright, checking that the map keeps
rendering, gestures still reach the map and nothing throws.

Basemap, star and texture assets are prebuilt in `mammatus/static/data` and `mammatus/static/img`
(`tools/fetch_sources.sh`, `tools/build_assets.mjs`, `tools/build_textures.py` regenerate them);
`tools/build_icons.mjs` renders the icon set from the logo source.

## Credits

Model data: NOAA (HRRR, RRFS, GFS via the NOAA Open Data Dissemination program) and ECMWF open data
(IFS, AIFS; CC BY 4.0). Radar: NOAA MRMS. Lightning: NOAA GOES-R Geostationary Lightning Mapper.
Fronts: NOAA/NWS Weather Prediction Center. Satellite: courtesy of SSEC, University of Wisconsin–Madison
(RealEarth). Alerts: National Weather Service. Point forecasts and soundings: Open-Meteo (CC BY 4.0).
Basemap: Natural Earth, US Census via us-atlas. Earth imagery: NASA Blue Marble & Black Marble.
Stars: Yale Bright Star Catalog. QR codes: qrcode-generator (MIT).

## License

MIT
