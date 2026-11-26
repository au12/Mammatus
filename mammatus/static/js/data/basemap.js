// Decoders for the varint-delta basemap assets built by tools/build_assets.mjs.

function header(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "MMB2") throw new Error("bad basemap asset");
  const hlen = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  return { h, base: 8 + hlen };
}

class Reader {
  constructor(bytes, q) { this.b = bytes; this.i = 0; this.q = q; this.x = 0; this.y = 0; }
  uint() {
    let v = 0, mul = 1, byte;
    do { byte = this.b[this.i++]; v += (byte & 127) * mul; mul *= 128; } while (byte & 128);
    return v;
  }
  sint() { const u = this.uint(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  point() { this.x += this.sint(); this.y += this.sint(); return [this.x / this.q, this.y / this.q]; }
}

const R = 6371;
const DEG = Math.PI / 180;

// Returns {layerName: Float32Array [lon, lat, cumulativeKm, ...]} with lon=999 breaks.
export function decodeBoundaries(buf) {
  const { h, base } = header(buf);
  const out = {};
  for (const [name, idx] of Object.entries(h.index)) {
    const bytes = new Uint8Array(buf, base + idx.offset, idx.bytes);
    const meta = h.meta[name];
    const arr = new Float32Array((meta.vertices + meta.polylines) * 3);
    const rd = new Reader(bytes, h.q);
    const n = rd.uint();
    let o = 0;
    for (let p = 0; p < n; p++) {
      const count = rd.uint();
      let dist = 0, plon = 0, plat = 0;
      for (let k = 0; k < count; k++) {
        const [lon, lat] = rd.point();
        if (k > 0) dist += haversine(plon, plat, lon, lat);
        arr[o++] = lon; arr[o++] = lat; arr[o++] = dist;
        plon = lon; plat = lat;
      }
      arr[o++] = 999; arr[o++] = 0; arr[o++] = 0;
    }
    out[name] = arr.subarray(0, o);
  }
  return out;
}

export function decodeCounties(buf) {
  const { h, base } = header(buf);
  const idx = h.index.data;
  const rd = new Reader(new Uint8Array(buf, base + idx.offset, idx.bytes), 1000);
  const verts = new Float32Array(h.vertices * 2);
  const owner = new Float32Array(h.vertices);
  const indices = new Uint32Array(h.indices);
  let vo = 0, io = 0;
  const nCounties = rd.uint();
  for (let c = 0; c < nCounties; c++) {
    const polys = rd.uint();
    for (let p = 0; p < polys; p++) {
      const nv = rd.uint(), ni = rd.uint();
      const base0 = vo;
      for (let k = 0; k < nv; k++) {
        const [lon, lat] = rd.point();
        verts[vo * 2] = lon; verts[vo * 2 + 1] = lat; owner[vo] = c; vo++;
      }
      for (let k = 0; k < ni; k++) indices[io++] = base0 + rd.uint();
    }
  }
  const fipsIndex = new Map(h.fips.map((f, i) => [f, i]));
  return { verts, owner, indices, fips: h.fips, fipsIndex };
}

export function haversine(lon1, lat1, lon2, lat2) {
  const dlat = (lat2 - lat1) * DEG, dlon = (lon2 - lon1) * DEG;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Stars: Int16 x,y,z (equatorial unit vector), uint8 magnitude, uint8 temperature.
export function decodeStars(buf) {
  const dv = new DataView(buf);
  const n = Math.floor(buf.byteLength / 8);
  const dir = new Float32Array(n * 3), mt = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    dir[i * 3] = dv.getInt16(i * 8, true) / 32767;
    dir[i * 3 + 1] = dv.getInt16(i * 8 + 2, true) / 32767;
    dir[i * 3 + 2] = dv.getInt16(i * 8 + 4, true) / 32767;
    mt[i * 2] = dv.getUint8(i * 8 + 6) / 25 - 2;
    mt[i * 2 + 1] = dv.getUint8(i * 8 + 7) * 100 + 2000;
  }
  return { dir, mt, count: n };
}
