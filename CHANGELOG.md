# Changelog

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
