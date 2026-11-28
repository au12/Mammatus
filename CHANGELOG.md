# Changelog

## 1.3.1 — 2026-11-27

The four roughest things left in the new Sky view.

### Grain at cloud edges
- **Edges are covered, not dotted.** A ray's sample at the edge of a cloud stands for a footprint that is
  part cloud and part clear air. It was treated as an even haze, and since any trace of a dense cloud is
  opaque, an edge came out solid or missing from one ray to the next: the sparkle around every cumulus,
  the dotted veil where a field thins out. Light now passes the clear part of the footprint and meets
  the cloud's own density in the rest, so an edge is as opaque as it is covered.
- **Each pixel keeps count.** The picture is still built from a quarter of its pixels a frame, but every
  pixel now takes the true mean of the samples it has gathered (up to ten when nothing is moving, the
  last few while it is) instead of always leaning a fixed share toward the newest. While you drag or
  the timeline plays, each new sample is also evened out with its neighbours: the noise is blue, all of
  it between neighbouring pixels, so a little smoothing takes most of it out. A moving view is now soft
  and clean where it was sharp and gritty, and sharpens when it stops.
- **Rays spend their steps on cloud.** Two coarse maps of where the weather volumes hold anything let a
  ray cross empty air in a few long strides; between the clouds of a broken field it steps as far as the
  nearest cloud can be; and when a long step lands in cloud it goes back and finds the cloud's edge, so
  the first sample is on the lit skin, not somewhere inside. A ray that is still running out lengthens
  its stride to reach the far end. In the pulled-back side view this is the difference between a whole
  storm and half of one: rays used to give up 6 km into a 90 km slab, leaving holes and ragged bites
  out of whatever stood behind a field of cumulus.
- History is now judged against the exposure. A run through the timeline from afternoon into night used
  to leave sunlit cloud in the picture as white blocks, because the tolerance was a fixed brightness a
  thousand times the night's.
- The sun's disc no longer shows as a white dot through solid overcast (the haze in front of a cloud
  took the colour of whatever was behind it, the sun included).

### The storm's seam
- A storm changes from boiling tower to smooth anvil where the model's layers say it does: at one level,
  the same right across the cloud, which drew a ruled line through it. In a deep cloud the kind of cloud
  is now read through a kilometre of height about a level that wanders with the cloud's turrets, and a
  cloud that is going over to ice passes through "smooth", not through "cellular", on the way. Real model
  storms had the same line, at the height where the air reaches -30 C.

### The dashed lines beside the storm
- They were mammatus. The height of an anvil's base was stored only under the anvil, zero elsewhere, and
  the texture filter slid it from 9 km to the ground across the one cell at the anvil's edge, hanging a
  curtain of pouches down that slope all round it: seen edge-on, dotted lines. The base height is now
  carried on past the outline, and pouches hang only from solid anvil, not from the veil it frays into.
- Far beyond the back of the side view's slab, the ground now goes off into the backdrop instead of
  ending in a hard dark horizon half way up the picture (most visible at night).

### Overcast from the ground
- **You can see it.** Under cloud there is no sky to set the exposure by, and the view was setting it by
  the sky anyway: a rain deck came out near-black. The eye now adapts to the cloud base itself, worked
  out from the cloud over the point with the renderer's own optics: stratus shows light grey, a deep
  rain cloud a darker one, the belly of a storm darker still, and the ground under them is lit.
- **It has a surface.** A sheet is thicker here and thinner there, and what gets through follows:
  dark under its cells, bright along the seams, with lighter and darker reaches a few kilometres
  across (the large-scale unevenness now runs right up through a deep cloud instead of averaging out).
- **Scud.** Under a deck that is raining, ragged shreds of cloud hang and drift below the base, darker
  than the cloud above them.
- Light reaches a wide deck from its top as well as back along the sun's beam, so decks under a low
  sun are no longer several times too dark, and the ground under them gets what the deck lets through.
  The haze under cloud is lit by the cloud, grey, not by the open sky's blue.
- The 22-degree halo in cirrostratus is far easier to see for the same reason.

### Also
- Seen from above, the nearest band of cloud is drawn first (cirrus used to hide behind the cumulus
  under it).
- The step budget is a little larger (96 from 84; 60 from 52 on phones): few rays need it all now.

## 1.3.0 — 2026-11-27

### The Sky view, redrawn
- **Clouds with form.** The renderer is new from the noise up. Cumulus are heaps with flat grey bases,
  bright sunlit tops and a silver lining toward the sun; altocumulus and stratocumulus are sheets of
  lens-shaped cells; cirrus is brushed out along the wind in feathered wisps you can see the blue
  through; storms are dark underneath with white towers above. Fair-weather heaps share a base but each
  grows to its own height.
- **Light that is worked out, not suggested.** Optical depth toward the sun is swept through the weather
  into a light volume, so every sample of cloud knows how much cloud the sunlight met on its way, how
  deep it sits in its own cloud and what lies above and below it. A field of cumulus is treated as what
  it is (cloud and gaps, the sun reaching the ground between them), a deck shades the deck beneath it by
  what it lets through, and each sample marches a few steps toward the sun through the cloud's real
  shape, which is what gives it lobes that shade one another. Near sunrise and sunset the light is
  followed up from below as well: cloud bases catch fire after the ground has gone dark, the highest
  clouds last.
- **A physical sky.** Transmittance, multiple scattering and sky-view lookups of a real atmosphere
  (Rayleigh, haze and ozone) replace the old approximation: deeper blue overhead, a pale horizon, long
  twilights that go from gold through rose to indigo. The haze follows the humidity. Exposure is set
  the way an eye sets it, from how bright the sky is, and opens up through dusk and under an overcast,
  so twilight, a moonlit night and a starry one are each seen, each darker than the last.
- **No banding.** The side view's backdrop is drawn from a smooth curve through its colours (the old one
  had a flat spot at every stop, which showed as bands), colours are computed in half-float and the
  final dither is blue noise. The tone curve keeps strong colour strong instead of washing a sunset
  out to pale yellow.
- **Movement.** Each band of cloud drifts as one body with its wind, so towers are no longer sheared
  apart and the texture is never stretched; the shapes billow upward and their edges curl and evolve.
  The model's weather stays where the model put it: clouds form on one side of a field and dissolve on
  the other as they pass through.
- **The timeline is smooth.** Between two model hours the view works out how far each band of cloud
  really moved (the shift that best lines one hour's cover up with the next) and carries the clouds that
  far while one hour's cover turns into the other's. They travel, grow and thin; nothing fades out and
  back in, and a layer that exists in only one of the two hours keeps its own height while it goes.
  While the timeline plays, each step takes the whole step, the sun and moon move with it, the next
  hours are fetched ahead, and the play loop waits for the sky instead of running on without it.
- **Another place, another sky.** Moving to a new point evaporates the old clouds at once and clears
  their labels, winds, freezing level and storm cells; only "Condensing … clouds" shows until the new
  sky is there, and then it condenses in from the densest parts outward in under a second (it used to
  show the last place's cloud types until the new ones arrived, then swap).
- **Night.** The Milky Way, in its real place for the time and latitude, with its bright core and dust
  lanes; a moon with its seas; stars that twinkle near the horizon. The side view now has stars too
  (its lens is too long to show them, so they are seen through a wide one looking up the same way).
  Lightning bolts are thinner, with a violet glow.
- **The five rough edges from 1.1.** Standing inside a storm no longer shows grey straight-edged
  shapes (the weather is warped off the model's grid when it is baked, and beyond the model's box the
  sky continues as fields of cloud instead of streaks); thin ice cloud is translucent, so a
  cirrostratus halo stands against blue sky; the diagonal stripes while looking up into thick cloud
  are gone (blue-noise sampling, and noise read no finer than the steps can follow); decks in the side
  view have swelling tops, sagging bases and shaded cells instead of being flat bands, and the side
  view's front is the cloud field's own ragged edge, not a slice; and the side view has its stars.
- **Terrain and clouds together.** Cloud shadows on the land come from a shadow map at cloudlet scale
  near the point and from the light volume beyond it, so a single cumulus darkens its own patch of
  hillside and a deck dims the whole country under it; distant haze dims under cloud instead of
  glowing through rain; light shafts are measured through the same shadows.

### Faster
- **Drawing.** Only a quarter of the cloud image's pixels are marched each frame; the image is rebuilt
  from the frames before, following the camera and the wind. Long strides cross air with no weather in
  it, far clouds are read from the noise's mips (and what the mips average away is put back as an exact
  integral, so a distant field keeps its true opacity and its gaps), and the light is a lookup instead
  of a march of its own. The weather volumes are redrawn only when the hour changes and the light
  sweep is spread over a few frames. Whole frames in software rendering (SwiftShader, 1000×640):
  fair-weather cumulus from the ground 2.4 s → 0.9 s, the side view 1.05 s → 0.4 s, cirrostratus over
  altocumulus 3.6 s → 1.1 s, a stratus overcast 3.3 s → 0.8 s, a thunderstorm 3.6 s → 1.3 s, sunset
  1.85 s → 1.0 s: between 1.8 and 4 times faster than 1.2.0, with far more in every frame.
- **Opening.** The noise is generated a few slices a frame while the camera swoops in instead of in one
  go, and hovering or pressing the Sky button starts fetching the sky before the view opens.
- **"Condensing HRRR clouds…"** A sky frame used to download about 40 MB (some 220 whole-CONUS fields)
  and decode them one at a time. Now: fields the picture never used are not fetched (18 MB of 2D fields
  down to 8), temperature and wind come from one coarse copy per hour that every place shares, the
  model's terrain is fetched once per region, and decoding runs in parallel where the installed ecCodes
  is thread-safe (the PyPI wheels are; `MAMMATUS_PARALLEL_DECODE=0` turns it off). First frame at a new
  place on a cold cache, 2 cores: 4.3 s (was 6 to 10); the next hour 2.7 s; another place in the same
  region 0.2 s. The quick 2D "sketch" that was shown first is gone, and with it the swap from sketch
  to real clouds.

### Also
- A saved view or link that names a product this server doesn't have no longer breaks the legend.
- The UI fuzzer now plays and steps the timeline under the open Sky view, and feeds the sky-frame
  decoder and the cloud-motion estimate junk; new tests cover the estimate, the frame loader, the coarse
  whole-domain fields and the trimmed download list.

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
