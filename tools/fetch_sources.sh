#!/usr/bin/env bash
# Downloads the public-domain source data used by build_assets.mjs and build_textures.py.
# Natural Earth (public domain), Yale Bright Star Catalog (public domain, JSON conversion by
# Bretton Wade), NASA Blue Marble / Black Marble imagery (public domain, via three-globe).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p sources
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_50m_admin_1_states_provinces_lines.geojson ne_50m_lakes.geojson ne_10m_populated_places_simple.geojson; do
  [ -s "sources/$f" ] || curl -fsSL -o "sources/$f" "$NE/$f"
done
[ -s sources/bsc5-short.json ] || curl -fsSL -o sources/bsc5-short.json \
  https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-short.json
if [ ! -s sources/earth-blue-marble.jpg ]; then
  tmp=$(mktemp -d)
  (cd "$tmp" && npm pack --silent three-globe@2.45.6 >/dev/null && tar -xzf three-globe-*.tgz)
  cp "$tmp"/package/example/img/{earth-blue-marble.jpg,earth-night.jpg,earth-topology.png,earth-water.png} sources/
  rm -rf "$tmp"
fi
echo "sources ready"
