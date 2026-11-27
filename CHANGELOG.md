# Changelog

## 1.2.0 — 2026-11-27

### Real terrain in the Sky view
- **The ground is the real ground.** The Sky view now draws surveyed terrain for 250 km around the point
  instead of the weather model's 3 km terrain and made-up hills: the cut of the side view shows the true
  profile of the land, real ranges stand behind it in layers of haze, ridges poke through a low cloud
  deck like islands, and from the ground the skyline is the one outside your window. The title shows
  the surveyed elevation of the point.
- **Free, open data, fetched by the server.** Elevation comes from Terrain Tiles on AWS Open Data
  (Mapzen/Tilezen: USGS 3DEP, SRTM, GMTED2010, ETOPO1 and national surveys): no key, no account, and
  the browser never talks to anyone but your server. The first visit to a place downloads about 75
  tiles (7 MB, a couple of seconds); the finished patch (1.8 MB, or 0.6 MB for phones) is then cached
  for good, as are the tiles, which neighbouring places share. `MAMMATUS_TERRAIN_CACHE_GB` caps the
  cache (default 1); `MAMMATUS_TERRAIN_URL` points at any other Terrarium tile server (Mapterhorn
  works, see the README) or turns terrain `off`.
- **Bad data mended.** The tiles' coarse zooms have false needles and pits (a kilometre-high spike on the
  plain near Boulder, a dozen or more around most US places). Each lone spike in the middle grid is
  checked against a finer zoom and replaced only when that zoom shows level ground, so real pinnacles
  and summits are untouched.
- **Three nested grids.** ±16 km at 31 m, ±64 km at 125 m and ±256 km at 500 m, blended at their rims
  so they meet without a seam: fine ground underfoot, whole ranges on the horizon, in 17 MB of GPU memory
  (4 MB on a phone, which gets grids of half the size).
- **Faster than the noise it replaces.** Each grid's mips carry the highest ground of every block, so a
  ray strides over country it clears and only tests the surface where it might touch: about 11 steps a
  pixel instead of up to 96 steps of procedural noise for every pixel, sky included. Whole frames
  measured in software rendering (SwiftShader, 1280×800, clear sky): the true-scale side view about 3×
  faster and the views from the ground 1.5–2.3× faster; the pulled-back view, where every pixel is now
  detailed, shadowed ground, about 1.5× slower.
- **The earth curves.** From the ground, distant country drops behind the horizon as it should (a range
  200 km away stands 2.7 km lower). The side view is a diagram at true scale, so there the ground stays
  level and the altitude ruler stays exact.
- **Lit like land.** Slopes are shaded from the real surface, ridges throw long soft shadows when the sun
  is low, valleys see less of the sky than crests, steep ground shows rock, and the sea is level water:
  dark from above, mirroring the sky toward the horizon, with the sun's glitter.
- **Honest air.** How far you can see along the ground now follows the model's humidity there: about
  180 km in dry air, 60 km at 70 %, under 20 km near saturation.
- **Smooth edges.** The skyline is anti-aliased, and clouds (drawn at reduced resolution) are fitted to
  the ground's outline when they are scaled up, so a ridge in front of a cloud deck has a clean edge.
- **Arrives gracefully.** The view opens on level ground and the land rises into place when its terrain
  is in (at once for places seen before); moving to another point sinks one landscape and raises the
  next. If the tiles can't be reached, the model's own terrain stands in as before.
- Fixed stray light pixels along the screen's diagonal in the Sky view's ground (the ground texture was
  read with undefined derivatives).
- Settings → System shows the terrain cache. The demo server makes up a landscape
  (`MAMMATUS_DEMO_TERRAIN=real` uses the real tiles), and the UI fuzzer now opens, moves and closes the
  Sky view and feeds its terrain decoder junk.

## 1.1.0 — 2026-11-27

### Sky view
- A new **Sky** action on the point card (shortcut **S**) swoops from the map into a 3D side view of the
  atmosphere above the point: a cut-away diorama at true scale from the ground to 52,000 ft, with the
  sky graded from pale blue through violet to the black of space. Pinch or scroll out to about 100 km
  to see neighbouring cells and watch a line of storms arrive; drag to turn; **G** switches to a view
  from the ground. The FAB becomes a single exit button and the timeline keeps working.
- **Real cloud water.** The server reads cloud water, ice, rain, snow and graupel on the model's
  pressure levels (HRRR, then RRFS, then GFS) for a 120 km box and packs a 40×40×64 voxel grid with
  coverage, convectiveness, layer bases and tops, winds and terrain. ECMWF, or an outage, falls back to
  an Open-Meteo profile shown with an *Estimated* badge. Boxes are cached on disk
  (`MAMMATUS_SKY_CACHE_GB`, default 2).
- **Cloud types.** Each layer is classified (cumulus, towering cumulus, cumulonimbus with anvil,
  stratocumulus, stratus, nimbostratus, altocumulus, altostratus, cirrus, cirrostratus, cirrocumulus,
  fog) and labelled with its heights; tap a label for what it means.
- **Rendering.** Volumetric ray marching through tileable Perlin–Worley noise with domain warping,
  cauliflower lobes on towers, fibrous cirrus, ragged sheet and rain-curtain edges, mammatus under
  anvils, multiple-scattering light with a powder term, cloud shadows, light shafts, a physical sky,
  temporal accumulation and an invisible dither. Clouds condense in when the view opens and drift with
  the model's winds at 4× real time; frames cross-fade along the timeline.
- **Storms** are dark and heavy underneath, with lightning: cloud-to-ground bolts with branches and
  return strokes, crawlers under the anvil, and flashes that light the cloud from inside. Real GOES
  strikes near the point are used when they arrive.
- **Optics and night.** 22° halos and sun dogs with chromatic dispersion in thin ice cloud, primary and
  secondary rainbows in sunlit rain, sun and moon discs (the moon in its true phase), the real stars,
  and city glow on cloud bases.
- **Extras** in the ⋯ menu: observed METAR ceilings drawn at their heights, a synthesized soundscape
  (rain, wind, thunder timed to the flashes), tilt parallax on phones, an ambient mode for a spare
  screen (keeps it awake, slows the frame rate) and save as image with a caption.
- Deep links: `#sky=lat,lon` opens the view directly; the back button closes it.

## 1.0.0 — 2026-11-26

First release.

### Models, layers and tools
- HRRR, RRFS, GFS, ECMWF IFS and ECMWF AIFS on one timeline, with 32 products, rendered on a WebGL2
  globe that morphs into a flat map. New runs appear automatically.
- MRMS radar, global infrared / visible / water vapor satellite (also shown as live clouds on the
  globe), NWS warnings and watches.
- **Lightning** from the GOES-East and GOES-West Geostationary Lightning Mappers (NOAA open data),
  drawn as lightning bolts:
  - The newest strikes are the biggest and white-hot; bolts shrink and cool through gold and amber to
    crimson over the 30-minute window.
  - Strikes flash as they happen, replayed in their true rhythm about a minute behind real time, with
    1–4 return strokes, a bloom and an expanding ring.
  - When bolts come into view (turning the layer on, or the map settling somewhere new) they flash in
    the order they happened, oldest first, and that replay comes back every half minute or so to keep
    them noticeable. Busy cells stay readable: only part of a dense cluster flashes and glows dim
    when many go off at once.
  - Radar and satellite loops: stepping or playing flashes the strikes each step reveals.
  - Point card shows the nearest strike ("Lightning 6 mi away · 3 min ago"); the legend shows the
    size and color scale and how many strikes are in view.
  - Server ingests only while someone is viewing, backfills 30 minutes on demand, merges the two
    satellites without double counting, and serves immutable 10-minute chunks.
- **Fronts** from NOAA WPC's coded surface bulletins: the 3-hourly analysis and the 12–48 hour
  forecasts, matched to the timeline, with standard symbols, troughs, drylines and WPC highs/lows.
- Multi-model meteograms, skew-T soundings with hodographs, saved places, alert rules and Web Push.
- Accounts with invites, roles, TOTP two-step verification, session management and an audit log.
- Installable PWA, Unraid template, Docker image on GHCR.
- The icon is the underside of a mammatus deck at sunset, and the logo animates: pouches condense out
  of the cloud base and keep moving like slow fluid (off with reduced motion).

### Map engine
- Place names, contour labels, pressure centers and point values are drawn on the GPU from a sprite
  atlas, snapped to whole pixels, with sticky collision placement and fades. They no longer flicker,
  shimmer or reshuffle while panning and zooming.
- Front lines and symbols are drawn on the GPU in the same pass as the map, so they stay attached to
  the map while it moves.
- Touch gestures were rebuilt: pinch, double-tap zoom, double-tap-and-drag zoom, two-finger tap to zoom
  out, fling with momentum, long press, and recovery from interrupted gestures.

### Performance and battery
- Nothing renders unless something changes; during interaction every frame is drawn, and ambient
  animation (wind particles, lightning flashes) is capped at 30 fps in battery-saver mode.
- The sky, globe and data field are cached between frames, so lightning and particle frames redraw
  only what moves. The Milky Way is baked into a texture once.
- Idle animation stops sooner on phones; lightning animation pauses after 10 minutes without
  interaction on phones (30 on desktop) and follows the system's reduced-motion setting.
- The frames on screen are never evicted from the in-browser cache, and cached contour data is kept
  in compact form.
- The WebGL context is restored automatically if the browser drops it.

### Stability
- Fixed: after switching between globe, map and auto (or opening and closing a menu), panning and
  zooming stopped working. Closed menus were invisible but still caught every touch and click.
- Fixed: a closing dialog, a fading toast or a hidden point card could swallow taps.
- Fixed: deep links to a place (including notification taps) could be overridden by the first-visit
  fly-in.
- Fixed: invalid saved preferences or an old link to a product that no longer exists could stop the
  app from starting; preferences are now validated, and the app retries once in safe mode.
- A one-time fuzzing pass (server parsers, rule engine, every API route, and randomized UI sessions on
  desktop and mobile) found and fixed crashes in ECMWF index parsing, WPC bulletins with unusual
  digits, malformed NWS alerts, Open-Meteo responses, alert rule validation (a bad rule returned a
  server error) and out-of-range ids. `tests/test_fuzz.py` keeps these covered; set `MAMMATUS_FUZZ`
  for deeper runs.
