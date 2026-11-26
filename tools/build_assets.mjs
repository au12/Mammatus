// Builds compact binary basemap assets for the web client from public-domain sources.
// Run: ./fetch_sources.sh && node build_assets.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as topojson from "topojson-client";
import earcut, { flatten } from "earcut";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => path.join(here, "sources", f);
const out = path.join(here, "..", "mammatus", "static", "data");
fs.mkdirSync(out, { recursive: true });

const worldLand = require("world-atlas/land-50m.json");
const worldCountries = require("world-atlas/countries-50m.json");
const usStates = require("us-atlas/states-10m.json");
const usCounties = require("us-atlas/counties-10m.json");

// ---------------------------------------------------------------- polylines
function linesFromGeometry(geom, outLines) {
  if (!geom) return;
  const push = (coords) => outLines.push(coords);
  switch (geom.type) {
    case "LineString": push(geom.coordinates); break;
    case "MultiLineString": geom.coordinates.forEach(push); break;
    case "Polygon": geom.coordinates.forEach(push); break;
    case "MultiPolygon": geom.coordinates.forEach((p) => p.forEach(push)); break;
    case "GeometryCollection": geom.geometries.forEach((g) => linesFromGeometry(g, outLines)); break;
  }
}

function splitDateline(line) {
  const parts = [[]];
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    const cur = parts[parts.length - 1];
    if (cur.length && Math.abs(p[0] - cur[cur.length - 1][0]) > 180) parts.push([]);
    parts[parts.length - 1].push(p);
  }
  return parts.filter((p) => p.length > 1);
}

function simplify(line, tol) {
  // Radial-distance simplification (cheap, keeps shape for already-generalized data)
  if (tol <= 0 || line.length < 3) return line;
  const outL = [line[0]];
  let last = line[0];
  for (let i = 1; i < line.length - 1; i++) {
    const p = line[i];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) >= tol) { outL.push(p); last = p; }
  }
  outL.push(line[line.length - 1]);
  return outL;
}

// Varint-delta encoding: coordinates in 1e-3 degree units, zigzag deltas chained across
// polylines. Roughly 2 bytes per vertex instead of 8 for float32.
const Q = 1000;
class VarintWriter {
  constructor() { this.bytes = []; this.lx = 0; this.ly = 0; }
  uint(v) { while (v > 127) { this.bytes.push((v & 127) | 128); v = Math.floor(v / 128); } this.bytes.push(v); }
  sint(v) { this.uint(v >= 0 ? v * 2 : -v * 2 - 1); }
  point(lon, lat) {
    const x = Math.round(lon * Q), y = Math.round(lat * Q);
    this.sint(x - this.lx); this.sint(y - this.ly); this.lx = x; this.ly = y;
  }
  buffer() { return Uint8Array.from(this.bytes); }
}

function packLayer(lines, tol = 0) {
  const kept = [];
  let verts = 0;
  for (const raw of lines) {
    for (const line of splitDateline(raw)) {
      const s = simplify(line, tol);
      if (s.length >= 2) { kept.push(s); verts += s.length; }
    }
  }
  const w = new VarintWriter();
  w.uint(kept.length);
  for (const line of kept) {
    w.uint(line.length);
    for (const [lon, lat] of line) w.point(lon, lat);
  }
  const buf = w.buffer();
  buf.meta = { polylines: kept.length, vertices: verts };
  return buf;
}

const layers = {};
{
  const coast = [];
  linesFromGeometry(topojson.mesh(worldLand, worldLand.objects.land), coast);
  layers.coast = packLayer(coast, 0.02);

  const borders = [];
  linesFromGeometry(topojson.mesh(worldCountries, worldCountries.objects.countries, (a, b) => a !== b), borders);
  layers.countries = packLayer(borders, 0.02);

  const prov = JSON.parse(fs.readFileSync(src("ne_50m_admin_1_states_provinces_lines.geojson"), "utf8"));
  const provLines = [];
  for (const f of prov.features) {
    if ((f.properties.adm0_a3 || f.properties.ADM0_A3) === "USA") continue;
    linesFromGeometry(f.geometry, provLines);
  }
  layers.provinces = packLayer(provLines, 0.02);

  const lakes = JSON.parse(fs.readFileSync(src("ne_50m_lakes.geojson"), "utf8"));
  const lakeLines = [];
  for (const f of lakes.features) linesFromGeometry(f.geometry, lakeLines);
  layers.lakes = packLayer(lakeLines, 0.02);

  const st = [];
  linesFromGeometry(topojson.mesh(usStates, usStates.objects.states, (a, b) => a !== b), st);
  layers.states = packLayer(st);

  const co = [];
  linesFromGeometry(
    topojson.mesh(usCounties, usCounties.objects.counties,
      (a, b) => a !== b && Math.floor(+a.id / 1000) === Math.floor(+b.id / 1000)),
    co,
  );
  layers.counties = packLayer(co);
}

function writeBinary(file, header, buffers) {
  let offset = 0;
  const index = {};
  for (const [name, buf] of Object.entries(buffers)) {
    const pad = (4 - (offset % 4)) % 4;
    offset += pad;
    index[name] = { offset, bytes: buf.byteLength, type: buf.constructor.name, length: buf.length };
    offset += buf.byteLength;
  }
  const hjson = Buffer.from(JSON.stringify({ ...header, index }));
  const hpad = Buffer.alloc((4 - (hjson.length % 4)) % 4, 32);
  const headerBuf = Buffer.concat([hjson, hpad]);
  const total = 8 + headerBuf.length + offset;
  const outBuf = Buffer.alloc(total);
  outBuf.write("MMB2", 0, "ascii");
  outBuf.writeUInt32LE(headerBuf.length, 4);
  headerBuf.copy(outBuf, 8);
  for (const [name, buf] of Object.entries(buffers)) {
    Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).copy(outBuf, 8 + headerBuf.length + index[name].offset);
  }
  fs.writeFileSync(path.join(out, file), outBuf);
  return total;
}

const bsize = writeBinary("boundaries.bin", {
  v: 2, q: Q, meta: Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.meta])),
}, layers);
console.log("boundaries.bin", (bsize / 1024).toFixed(0), "KB",
  Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.meta.vertices])));

// ---------------------------------------------------------------- county polygons
{
  const geo = topojson.feature(usCounties, usCounties.objects.counties);
  const fips = [];
  const w = new VarintWriter();
  let nv = 0, ni = 0;
  w.uint(geo.features.length);
  for (const f of geo.features) {
    fips.push(String(f.id).padStart(5, "0"));
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    w.uint(polys.length);
    for (const poly of polys) {
      const flat = flatten(poly);
      const tri = earcut(flat.vertices, flat.holes, 2);
      const count = flat.vertices.length / 2;
      w.uint(count); w.uint(tri.length);
      for (let i = 0; i < flat.vertices.length; i += 2) w.point(flat.vertices[i], flat.vertices[i + 1]);
      for (const t of tri) w.uint(t);
      nv += count; ni += tri.length;
    }
  }
  const size = writeBinary("counties.bin", { v: 2, fips, vertices: nv, indices: ni }, { data: w.buffer() });
  console.log("counties.bin", (size / 1024).toFixed(0), "KB", fips.length, "counties", nv, "verts", ni, "indices");
}

// ---------------------------------------------------------------- cities
{
  const pp = JSON.parse(fs.readFileSync(src("ne_10m_populated_places_simple.geojson"), "utf8"));
  const rows = [];
  for (const f of pp.features) {
    const p = f.properties;
    const pop = p.pop_max || p.pop_min || 0;
    const rank = p.scalerank ?? 10;
    const us = p.adm0_a3 === "USA";
    if (!us && rank > 6 && pop < 400000) continue;
    if (us && rank > 9 && pop < 25000) continue;
    rows.push([p.name, p.adm1name || "", p.iso_a2 || p.adm0_a3 || "", +p.latitude.toFixed(4), +p.longitude.toFixed(4), pop, rank]);
  }
  rows.sort((a, b) => a[6] - b[6] || b[5] - a[5]);
  fs.writeFileSync(path.join(out, "cities.json"), JSON.stringify(rows));
  console.log("cities.json", rows.length, "places");
}

// ---------------------------------------------------------------- stars
{
  const bsc = JSON.parse(fs.readFileSync(src("bsc5-short.json"), "utf8"));
  const parseRA = (s) => {
    const m = s.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/);
    return m ? (+m[1] + +m[2] / 60 + +m[3] / 3600) * 15 : null;
  };
  const parseDec = (s) => {
    const m = s.match(/([+-])(\d+)°\s*(\d+)′\s*([\d.]+)″/);
    if (!m) return null;
    const v = +m[2] + +m[3] / 60 + +m[4] / 3600;
    return m[1] === "-" ? -v : v;
  };
  const stars = [];
  for (const s of bsc) {
    const ra = parseRA(s.RA || ""), dec = parseDec(s.Dec || "");
    const mag = parseFloat(s.V);
    if (ra == null || dec == null || !Number.isFinite(mag)) continue;
    const temp = parseFloat(s.K) || 6000;
    const r = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
    stars.push([Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d), mag, temp]);
  }
  stars.sort((a, b) => a[3] - b[3]);
  const buf = Buffer.alloc(stars.length * 8);
  stars.forEach(([x, y, z, mag, temp], i) => {
    buf.writeInt16LE(Math.round(x * 32767), i * 8);
    buf.writeInt16LE(Math.round(y * 32767), i * 8 + 2);
    buf.writeInt16LE(Math.round(z * 32767), i * 8 + 4);
    buf.writeUInt8(Math.max(0, Math.min(255, Math.round((mag + 2) * 25))), i * 8 + 6);
    buf.writeUInt8(Math.max(0, Math.min(255, Math.round((temp - 2000) / 100))), i * 8 + 7);
  });
  fs.writeFileSync(path.join(out, "stars.bin"), buf);
  console.log("stars.bin", stars.length, "stars");
}
