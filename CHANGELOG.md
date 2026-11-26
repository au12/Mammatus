# Changelog

## 1.1.0 — 2026-11-26

### Added
- **Lightning layer** from the GOES-East and GOES-West Geostationary Lightning Mappers (NOAA open data).
  - Live mode replays strikes in their true rhythm about a minute behind real time. Each strike
    flickers through 1–4 return strokes, blooms and sends out a faint ring, then cools from white
    through gold and amber to crimson over the window.
  - Busy storms stay subtle: only a few visible strikes per second get the flash (fewer on phones),
    and the glow eases off when many overlap.
  - Radar and satellite loops: stepping or playing shows the lightning leading up to each frame, and
    the strikes each step reveals flash across the step. The newest frame switches to live.
  - Point card shows the nearest strike ("Lightning 6 mi away · 3 min ago").
  - Battery: frames are drawn only while an on-screen strike is flashing; animation pauses after
    3 minutes without interaction on phones (20 on desktop), follows the system's reduced-motion
    setting, and can be turned off in Settings → Display.
  - Server ingests only while someone is viewing (15 minutes after the last request), backfills
    30 minutes on demand, fetches older chunks for radar loops on request, merges the two satellites
    without double counting, and serves immutable 10-minute chunks.
  - New settings: `MAMMATUS_LIGHTNING` (`east,west` | `east` | `off`), `MAMMATUS_LIGHTNING_BACKFILL_MIN`.
- **Fronts layer** from NOAA WPC's coded surface bulletins: the 3-hourly analysis and the 12–48 hour
  forecasts, matched to the timeline, with standard symbols (cold, warm, stationary, occluded),
  troughs, drylines, and WPC highs/lows when the map doesn't already show model pressure centers.
- Legend rows for lightning (age scale, strikes in view, a bolt that flickers with real strikes) and
  fronts (which WPC analysis or forecast is showing), with "Jump to now" when lightning is out of range.

### Fixed
- A deep link was re-read after the app rewrote the address bar on startup, which could switch the
  layer back to radar.

## 1.0.0 — 2026-11-26

First release: HRRR, RRFS, GFS, ECMWF IFS and AIFS on a WebGL globe/map, MRMS radar, global
satellite, NWS alerts, meteograms, soundings, accounts with 2FA, PWA with Web Push, Unraid template.
