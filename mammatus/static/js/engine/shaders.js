// GLSL sources. Every layer shares one projection so the globe, the flat map and the
// morph between them line up exactly. Lat/lon are radians unless named *Deg.

export const PROJ = /* glsl */ `
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
uniform vec4 u_view;    // lon0, lat0, k (device px per radian at the equator), t (0 globe .. 1 flat)
uniform vec4 u_vp;      // width, height (device px), f (focal px), D (camera distance, unit sphere)
uniform vec2 u_merc;    // mercator y of the view center, globe scale factor

float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }

vec3 globeCam(vec2 ll) {
  float dl = ll.x - u_view.x;
  float cl = cos(ll.y);
  vec3 p = vec3(cl * sin(dl), sin(ll.y), cl * cos(dl));
  float s0 = sin(u_view.y), c0 = cos(u_view.y);
  return vec3(p.x, p.y * c0 - p.z * s0, p.y * s0 + p.z * c0);
}

// Returns pixel offset from the screen center (y up) in xy and visibility (>0 visible) in z.
vec3 projectPx(vec2 ll) {
  vec3 g = globeCam(ll);
  float s = u_vp.z / (u_vp.w - g.z);
  vec2 gpx = g.xy * s;
  float vis = g.z - 1.0 / u_vp.w;
#ifdef MESH
  float dl = ll.x - u_view.x;   // the morph mesh is centred on the view, never wraps
#else
  float dl = wrapPi(ll.x - u_view.x);
#endif
  float lat = clamp(ll.y, -1.4844222, 1.4844222);
  float my = log(tan(PI * 0.25 + lat * 0.5));
  vec2 fpx = vec2(dl, my - u_merc.x) * u_view.z;
  return vec3(mix(gpx, fpx, u_view.w), mix(vis, 1.0, u_view.w));
}
`;

// Screen pixel (from center, y up) -> lon/lat for the pure globe and pure flat modes.
export const INVERSE = /* glsl */ `
bool invGlobe(vec2 px, out vec2 ll, out vec3 nrmCam, out float edge) {
  vec3 o = vec3(0.0, 0.0, u_vp.w);
  vec3 d = normalize(vec3(px, -u_vp.z));
  float b = dot(o, d);
  float c = u_vp.w * u_vp.w - 1.0;
  float disc = b * b - c;
  edge = disc;
  if (disc < 0.0) return false;
  float t = -b - sqrt(disc);
  vec3 h = o + t * d;
  nrmCam = h;
  float s0 = sin(u_view.y), c0 = cos(u_view.y);
  float y = h.y * c0 + h.z * s0;
  float z = -h.y * s0 + h.z * c0;
  ll = vec2(u_view.x + atan(h.x, z), asin(clamp(y, -1.0, 1.0)));
  return true;
}
vec2 invFlat(vec2 px) {
  float lon = u_view.x + px.x / u_view.z;
  float my = u_merc.x + px.y / u_view.z;
  return vec2(lon, 2.0 * atan(exp(my)) - PI * 0.5);
}
`;

export const GRID = /* glsl */ `
uniform int u_gtype;     // 0 lat/lon, 1 lambert conformal
uniform vec4 u_g0;       // latlon: la1, lo1, dlat, dlon (deg) | lambert: n, R*F, rho0, lov(deg)
uniform vec4 u_g1;       // latlon: ni, nj, wrap, 0           | lambert: x1, y1, dx, dy (m)
uniform vec2 u_gsize;    // ni, nj
uniform float u_gjpos;   // lambert: +1 if j increases northward

vec2 gridIJ(vec2 ll) {
  if (u_gtype == 0) {
    float lonD = degrees(ll.x), latD = degrees(ll.y);
    float di = lonD - u_g0.y;
    float i = u_g0.w > 0.0 ? mod(di + 720.0, 360.0) / u_g0.w : -mod(720.0 - di, 360.0) / u_g0.w;
    return vec2(i, (latD - u_g0.x) / u_g0.z);
  }
  float dl = wrapPi(ll.x - radians(u_g0.w));
  float rho = u_g0.y / pow(tan(PI * 0.25 + ll.y * 0.5), u_g0.x);
  float th = u_g0.x * dl;
  float x = rho * sin(th);
  float y = u_g0.z - rho * cos(th);
  return vec2((x - u_g1.x) / u_g1.z, (y - u_g1.y) / u_g1.w * u_gjpos);
}

bool inGrid(vec2 ij) {
  if (ij.y < -0.5 || ij.y > u_gsize.y - 0.5) return false;
  if (u_g1.z > 0.5 && u_gtype == 0) return true;
  return ij.x > -0.5 && ij.x < u_gsize.x - 0.5;
}

ivec2 gidx(ivec2 p) {
  int ni = int(u_gsize.x), nj = int(u_gsize.y);
  if (u_gtype == 0 && u_g1.z > 0.5) p.x = (p.x % ni + ni) % ni;
  else p.x = clamp(p.x, 0, ni - 1);
  p.y = clamp(p.y, 0, nj - 1);
  return p;
}
`;

// Fragment chunk that turns a grid location into a value or color.
export const FIELD = /* glsl */ `
uniform highp usampler2D u_data0;
uniform highp usampler2D u_data1;
uniform float u_mix;          // crossfade between frame 0 and frame 1
uniform vec2 u_qs;            // scale, offset
uniform int u_kind;           // 0 scalar, 1 vector (speed), 2 category
uniform float u_hemi;         // 1: flip sign in the southern hemisphere (cyclonic vorticity)
uniform sampler2D u_lut;      // colormap (rows = categories for kind 2)
uniform float u_stops[32];
uniform int u_nstops;
uniform float u_lutRows;
uniform float u_opacity;

vec3 bilin(highp usampler2D tex, vec2 ij, bool vec) {
  vec2 f = floor(ij);
  vec2 t = ij - f;
  ivec2 p = ivec2(f);
  uvec4 a = texelFetch(tex, gidx(p), 0);
  uvec4 b = texelFetch(tex, gidx(p + ivec2(1, 0)), 0);
  uvec4 c = texelFetch(tex, gidx(p + ivec2(0, 1)), 0);
  uvec4 d = texelFetch(tex, gidx(p + ivec2(1, 1)), 0);
  vec4 w = vec4((1.0 - t.x) * (1.0 - t.y), t.x * (1.0 - t.y), (1.0 - t.x) * t.y, t.x * t.y);
  vec4 ok = vec4(a.r > 0u, b.r > 0u, c.r > 0u, d.r > 0u);
  w *= ok;
  float ws = w.x + w.y + w.z + w.w;
  if (ws < 1e-4) return vec3(0.0);
  float x = dot(w, vec4(float(a.r), float(b.r), float(c.r), float(d.r))) / ws;
  float y = vec ? dot(w, vec4(float(a.g), float(b.g), float(c.g), float(d.g))) / ws : 0.0;
  return vec3((x - 1.0) * u_qs.x + u_qs.y, vec ? (y - 1.0) * u_qs.x + u_qs.y : 0.0, 1.0);
}

// Position of v along the colormap stops (binary search: 5 steps instead of up to 31 per pixel).
float stopT(float v) {
  int n = u_nstops;
  if (n < 2 || v <= u_stops[0]) return 0.0;
  if (v >= u_stops[n - 1]) return 1.0;
  int lo = 0, hi = n - 1;   // stops[lo] <= v < stops[hi]
  for (int k = 0; k < 6; k++) {
    if (hi - lo <= 1) break;
    int mid = (lo + hi) / 2;
    if (v < u_stops[mid]) hi = mid; else lo = mid;
  }
  float a = u_stops[lo], b = u_stops[hi];
  return (float(lo) + (v - a) / max(b - a, 1e-6)) / float(n - 1);
}

vec4 lutColor(float v, float row) {
  float t = stopT(v);
  return texture(u_lut, vec2(t, (row + 0.5) / u_lutRows));
}

float rateT(float rate) { return clamp(log(max(rate, 0.05) / 0.05) / log(1200.0), 0.0, 1.0); }

// Category from the neighbours' weighted vote; rate only from cells of that category,
// so edges taper to zero instead of blending unrelated codes.
vec4 ptypeColor(highp usampler2D tex, vec2 ij) {
  vec2 f = floor(ij);
  vec2 t = ij - f;
  ivec2 p = ivec2(f);
  uint q[4];
  q[0] = texelFetch(tex, gidx(p), 0).r;
  q[1] = texelFetch(tex, gidx(p + ivec2(1, 0)), 0).r;
  q[2] = texelFetch(tex, gidx(p + ivec2(0, 1)), 0).r;
  q[3] = texelFetch(tex, gidx(p + ivec2(1, 1)), 0).r;
  float w[4];
  w[0] = (1.0 - t.x) * (1.0 - t.y); w[1] = t.x * (1.0 - t.y); w[2] = (1.0 - t.x) * t.y; w[3] = t.x * t.y;
  float wc[6];
  for (int c = 0; c < 6; c++) wc[c] = 0.0;
  float cats[4];
  float rates[4];
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    if (q[k] == 0u) { cats[k] = -1.0; rates[k] = 0.0; continue; }
    float v = float(q[k] - 1u);
    cats[k] = floor(v / 4096.0);
    rates[k] = mod(v, 4096.0) * 0.05;
    int ci = int(cats[k]);
    if (ci >= 0 && ci < 6) wc[ci] += w[k];
    wsum += w[k];
  }
  if (wsum < 1e-4) return vec4(0.0);
  int best = 0; float bw = 0.0;
  for (int c = 1; c < 6; c++) if (wc[c] > bw) { bw = wc[c]; best = c; }
  if (best == 0) return vec4(0.0);
  float rate = 0.0;
  for (int k = 0; k < 4; k++) if (int(cats[k]) == best) rate += rates[k] * w[k];
  rate /= wsum;
  float presence = smoothstep(0.28, 0.72, bw / wsum);
  vec4 c = texture(u_lut, vec2(rateT(rate), (float(best) - 0.5) / u_lutRows));
  c.a *= presence;
  return c;
}

vec4 fieldColor(vec2 ll) {
  vec2 ij = gridIJ(ll);
  if (!inGrid(ij)) return vec4(0.0);
  if (u_kind == 2) {
    vec4 c0 = ptypeColor(u_data0, ij);
    vec4 c1 = u_mix > 0.0 ? ptypeColor(u_data1, ij) : vec4(0.0);
    return mix(c0, c1, u_mix);
  }
  bool vec = u_kind == 1;
  vec3 s0 = bilin(u_data0, ij, vec);
  if (s0.z < 0.5) return vec4(0.0);
  float v0 = vec ? length(s0.xy) : s0.x;
  float v = v0;
  if (u_mix > 0.0) {
    vec3 s1 = bilin(u_data1, ij, vec);
    if (s1.z > 0.5) v = mix(v0, vec ? length(s1.xy) : s1.x, u_mix);
  }
  if (u_hemi > 0.5 && ll.y < 0.0) v = -v;
  return lutColor(v, 0.0);
}
`;

export const SURFACE_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec2 a_pos;      // full-screen: NDC corners; mesh: lon/lat degrees
uniform float u_meshLon;
out vec2 v_px;
out vec2 v_ll;
out float v_vis;
void main() {
#ifdef MESH
  vec2 ll = radians(a_pos + vec2(u_meshLon, 0.0));
  vec3 p = projectPx(ll);
  v_ll = ll;
  v_vis = p.z;
  v_px = p.xy;
  gl_Position = vec4(p.xy / (0.5 * u_vp.xy), 0.0, 1.0);
#else
  v_px = a_pos * 0.5 * u_vp.xy;
  v_ll = vec2(0.0);
  v_vis = 1.0;
  gl_Position = vec4(a_pos, 0.0, 1.0);
#endif
}`;

export const SURFACE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PROJ}
${INVERSE}
#ifdef FIELD_ON
${GRID}
${FIELD}
#endif
in vec2 v_px;
in vec2 v_ll;
in float v_vis;
out vec4 o_color;
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_terrain;
uniform sampler2D u_clouds;
uniform vec3 u_sun;        // sun direction, earth-fixed (x: lon 0, y: lon 90E, z: north)
uniform vec4 u_look;       // dim, stylized mix, clouds strength, realism (atmosphere/specular)
uniform vec3 u_land;       // stylized land color
uniform vec3 u_water;      // stylized water color

vec3 toLinear(vec3 c) { return c * c; }

void main() {
  vec2 ll;
  vec3 nrmCam = vec3(0.0, 0.0, 1.0);
  float edge = 1.0;
  float alpha = 1.0;
#ifdef MESH
  if (v_vis < 0.0) discard;
  ll = v_ll;
  nrmCam = globeCam(ll);
#elif defined(FLAT)
  ll = invFlat(v_px);
  if (abs(ll.y) > 1.4844) discard;
#else
  if (!invGlobe(v_px, ll, nrmCam, edge)) {
    // atmosphere halo beyond the limb
    vec3 d = normalize(vec3(v_px, -u_vp.z));
    vec3 o = vec3(0.0, 0.0, u_vp.w);
    float bmin = length(cross(o, d));
    float h = bmin - 1.0;
    float glow = exp(-h * 38.0) * smoothstep(0.0, 0.004, h + 0.004);
    vec3 dirCam = normalize(o + d * (-dot(o, d)));
    float s0 = sin(u_view.y), c0 = cos(u_view.y);
    vec3 dirE = vec3(dirCam.x, dirCam.y * c0 + dirCam.z * s0, -dirCam.y * s0 + dirCam.z * c0);
    float lonc = u_view.x + atan(dirE.x, dirE.z);
    float latc = asin(clamp(dirE.y, -1.0, 1.0));
    vec3 n = vec3(cos(latc) * cos(lonc), cos(latc) * sin(lonc), sin(latc));
    float sunUp = smoothstep(-0.35, 0.35, dot(n, u_sun));
    vec3 col = mix(vec3(0.10, 0.16, 0.35), vec3(0.38, 0.62, 1.0), sunUp);
    float a = glow * (0.25 + 0.75 * sunUp) * u_look.w;
    if (a < 0.003) discard;
    o_color = vec4(col * a, a);
    return;
  }
  alpha = smoothstep(0.0, 0.0009 * u_vp.w, edge);
#endif
  float lon = ll.x, lat = ll.y;
  vec3 nE = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  vec2 uv = vec2(fract(lon / TAU + 0.5), 0.5 - lat / PI);
  vec3 day = toLinear(texture(u_day, uv).rgb);
  float lights = texture(u_night, uv).r;
  vec3 ter = texture(u_terrain, uv).rgb;
  float water = ter.r;

  float mu = dot(nE, u_sun);
  float dayAmt = smoothstep(-0.1, 0.12, mu);
  vec3 lit = day * (0.12 + 1.05 * pow(max(mu, 0.0), 0.55));
  vec3 night = vec3(1.0, 0.72, 0.38) * lights * lights * 1.3 + day * 0.0035;
  vec3 col = mix(night, lit, dayAmt);
  col += vec3(1.0, 0.42, 0.16) * exp(-abs(mu) * 30.0) * 0.018 * (1.0 - water * 0.5);
#ifndef FLAT
  // ocean glint and limb haze on the globe
  vec3 viewCam = normalize(vec3(0.0, 0.0, u_vp.w) - nrmCam);
  float s0 = sin(u_view.y), c0 = cos(u_view.y);
  vec3 vE0 = vec3(viewCam.x, viewCam.y * c0 + viewCam.z * s0, -viewCam.y * s0 + viewCam.z * c0);
  float lv = u_view.x;
  vec3 vE = vec3(vE0.z * cos(lv) - vE0.x * sin(lv), vE0.z * sin(lv) + vE0.x * cos(lv), vE0.y);
  vec3 hv = normalize(vE + u_sun);
  float spec = pow(max(dot(nE, hv), 0.0), 90.0) * water * dayAmt;
  col += vec3(1.0, 0.92, 0.8) * spec * 0.55 * u_look.w;
  float fres = pow(1.0 - max(dot(normalize(nrmCam), viewCam), 0.0), 3.0);
  col = mix(col, vec3(0.32, 0.55, 1.0) * (0.15 + 0.85 * dayAmt), fres * 0.55 * u_look.w);
#endif
  // stylized basemap for regional zooms (and as data backdrop)
  float elev = ter.g;
  vec3 land = u_land * (0.85 + elev * 0.9);
  vec3 sty = mix(land, u_water, smoothstep(0.35, 0.65, water));
  col = mix(col, sty * mix(0.75, 1.0, dayAmt), u_look.y);

#ifdef CLOUDS
  vec4 cl = texture(u_clouds, uv);
  float cov = smoothstep(0.30, 0.86, cl.r) * cl.a * min(u_look.z, 1.0);
  float nightLift = clamp(u_look.z - 1.0, 0.0, 1.0);
  vec3 cloudNight = mix(vec3(0.055, 0.07, 0.11), vec3(0.30, 0.34, 0.42) * (0.6 + 0.4 * cl.r), nightLift);
  vec3 cloudCol = mix(cloudNight, vec3(0.95), dayAmt * 0.92 + 0.04);
  col = mix(col, cloudCol, cov * 0.88);
#endif
  col *= u_look.x;

#ifdef FIELD_ON
  vec4 fc = fieldColor(ll);
  fc.a *= u_opacity;
  // on the 3D globe, let the night side gently darken the data too (flat maps stay fully readable)
  vec3 fl = toLinear(fc.rgb) * mix(1.0, 0.42 + 0.58 * dayAmt, 0.85 * u_look.w);
  col = mix(col, fl, fc.a);
#endif
  o_color = vec4(sqrt(max(col, 0.0)) * alpha, alpha);
}`;

export const SKY_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_px;
uniform vec4 u_vp;
void main() { v_px = a_pos * 0.5 * u_vp.xy; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Bakes the Milky Way into an equirectangular texture in celestial coordinates (once).
// Values are stored x8 so the darkest glows survive 8-bit storage.
export const SKYBAKE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_px;
out vec4 o_color;
uniform vec4 u_vp;
const float PI = 3.141592653589793;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }

void main() {
  vec2 uv = v_px / u_vp.xy + 0.5;
  float ra = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 eq = vec3(cos(lat) * cos(ra), cos(lat) * sin(ra), sin(lat));
  // equatorial -> galactic (J2000)
  mat3 G = mat3(-0.0548756, 0.4941094, -0.8676661,
                -0.8734371, -0.4448296, -0.1980764,
                -0.4838350, 0.7469823, 0.4559838);
  vec3 g = G * eq;
  float b = asin(clamp(g.z, -1.0, 1.0));
  float l = atan(g.y, g.x);
  float band = exp(-b * b * 38.0);
  float bulge = exp(-(l * l * 2.2 + b * b * 30.0));
  float dust = fbm(g * 9.0 + vec3(3.1));
  float glowN = fbm(g * 4.0);
  float mw = (band * (0.55 + 0.75 * glowN) + bulge * 1.4) * smoothstep(0.25, 0.75, dust + 0.15);
  vec3 col = vec3(0.006, 0.008, 0.016) + vec3(0.55, 0.56, 0.66) * mw * 0.06 + vec3(0.30, 0.20, 0.12) * bulge * 0.03;
  o_color = vec4(min(col * 8.0, 1.0), 1.0);
}`;

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec2 v_px;
out vec4 o_color;
uniform float u_gmst;
uniform float u_fade;
uniform sampler2D u_sky;
void main() {
  vec3 d = normalize(vec3(v_px, -u_vp.z));
  // camera frame -> earth-fixed (x: lon0 meridian, y: north) -> celestial
  float s0 = sin(u_view.y), c0 = cos(u_view.y);
  vec3 e = vec3(d.x, d.y * c0 + d.z * s0, -d.y * s0 + d.z * c0);
  float lon = u_view.x + atan(e.x, e.z);
  float lat = asin(clamp(e.y, -1.0, 1.0));
  float ra = lon + u_gmst;
  vec2 uv = vec2(fract(ra / TAU + 0.5), lat / PI + 0.5);
  vec3 col = texture(u_sky, uv).rgb / 8.0;
  o_color = vec4(col * u_fade, 1.0);
}`;

export const STAR_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec3 a_dir;
in vec2 a_mt;  // magnitude, temperature
uniform float u_gmst;
uniform float u_dpr;
uniform float u_fade;
out vec3 v_col;
out float v_a;
vec3 starColor(float t) {
  t = clamp(t, 2500.0, 25000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.293 * pow(t - 60.0, -0.1332), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.390 * log(t) - 0.6318, 0.0, 1.0) : clamp(1.1298 * pow(t - 60.0, -0.0755), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432 * log(t - 10.0) - 1.1962, 0.0, 1.0));
  return mix(vec3(1.0), c, 0.55);
}
void main() {
  float ra = atan(a_dir.y, a_dir.x);
  float dec = asin(clamp(a_dir.z, -1.0, 1.0));
  vec3 d = globeCam(vec2(ra - u_gmst, dec));
  if (d.z > -0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec2 px = d.xy * u_vp.z / -d.z;
  gl_Position = vec4(px / (0.5 * u_vp.xy), 0.0, 1.0);
  float m = a_mt.x;
  gl_PointSize = clamp(4.2 - 0.5 * m, 1.5, 5.0) * u_dpr;
  v_a = clamp(pow(10.0, -0.4 * (m - 3.2)) * 0.75 + 0.2, 0.18, 1.0) * u_fade;
  v_col = starColor(a_mt.y);
}`;

export const STAR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_col;
in float v_a;
out vec4 o_color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  float a = exp(-r * 3.2) * v_a;
  if (a < 0.004) discard;
  o_color = vec4(v_col * a, a);
}`;

export const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec3 a_a;       // lon, lat (deg), cumulative distance (km); lon 999 = polyline break
in vec3 a_b;
in vec2 a_corner;  // x: 0/1 along the segment, y: -1/1 across
uniform float u_width;
out float v_side;
out float v_dist;
out float v_hw;
void main() {
  if (a_a.x > 500.0 || a_b.x > 500.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }  // polyline break
  vec3 pa = projectPx(radians(a_a.xy));
  vec3 pb = projectPx(radians(a_b.xy));
  vec2 d = pb.xy - pa.xy;
  float len = length(d);
  if (pa.z < 0.0 || pb.z < 0.0 || len > 0.6 * max(u_vp.x, u_vp.y) || len < 1e-4) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
  }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = u_width * 0.5 + 1.0;
  vec2 p = mix(pa.xy, pb.xy, a_corner.x) + nrm * a_corner.y * hw;
  v_side = a_corner.y * hw;
  v_hw = u_width * 0.5;
  v_dist = mix(a_a.z, a_b.z, a_corner.x);
  gl_Position = vec4(p / (0.5 * u_vp.xy), 0.0, 1.0);
}`;

export const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in float v_side;
in float v_dist;
in float v_hw;
out vec4 o_color;
uniform vec4 u_color;
uniform vec3 u_dash;   // on, period, phase in the polyline's distance units (period 0 = solid)
void main() {
  float a = clamp(v_hw + 0.5 - abs(v_side), 0.0, 1.0);
  if (u_dash.y > 0.0 && mod(v_dist + u_dash.z, u_dash.y) > u_dash.x) discard;
  a *= u_color.a;
  if (a < 0.01) discard;
  o_color = vec4(u_color.rgb * a, a);
}`;

export const FILL_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec2 a_ll;
in float a_owner;
uniform sampler2D u_colors;
uniform float u_ncolors;
out vec4 v_col;
out float v_vis;
void main() {
  vec3 p = projectPx(radians(a_ll));
  float idx = a_owner;
  vec2 uv = vec2((mod(idx, 1024.0) + 0.5) / 1024.0, (floor(idx / 1024.0) + 0.5) / u_ncolors);
  v_col = texture(u_colors, uv);
  v_vis = p.z;
  // keep far-side vertices in place (moving them would smear triangles across the screen); the FS discards them
  gl_Position = vec4(p.xy / (0.5 * u_vp.xy), 0.0, 1.0);
}`;

export const FILL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_col;
in float v_vis;
out vec4 o_color;
void main() {
  if (v_vis < 0.0 || v_col.a < 0.01) discard;
  o_color = vec4(v_col.rgb * v_col.a, v_col.a);
}`;

export const PARTICLE_UPDATE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PROJ}
${INVERSE}
${GRID}
uniform highp usampler2D u_wind;
uniform vec2 u_qs;
uniform float u_step;     // radians of travel per (m/s) this frame
uniform float u_maxAge;
uniform float u_dt;
uniform float u_seed;
in vec4 a_state;           // lon, lat (rad), age, rnd
out vec4 v_state;

float rnd(float n) { return fract(sin(n * 12.9898 + u_seed * 78.233) * 43758.5453); }

vec3 windAt(vec2 ll) {
  vec2 ij = gridIJ(ll);
  if (!inGrid(ij)) return vec3(0.0);
  vec2 f = floor(ij); vec2 t = ij - f; ivec2 p = ivec2(f);
  uvec4 a = texelFetch(u_wind, gidx(p), 0), b = texelFetch(u_wind, gidx(p + ivec2(1, 0)), 0);
  uvec4 c = texelFetch(u_wind, gidx(p + ivec2(0, 1)), 0), d = texelFetch(u_wind, gidx(p + ivec2(1, 1)), 0);
  if (a.r == 0u || b.r == 0u || c.r == 0u || d.r == 0u) return vec3(0.0);
  vec2 q = mix(mix(vec2(a.rg), vec2(b.rg), t.x), mix(vec2(c.rg), vec2(d.rg), t.x), t.y);
  return vec3((q - 1.0) * u_qs.x + u_qs.y, 1.0);
}

vec4 spawn(float id) {
  for (int k = 0; k < 4; k++) {
    vec2 px = (vec2(rnd(id + float(k) * 7.1), rnd(id * 1.37 + float(k) * 3.3)) - 0.5) * u_vp.xy;
    vec2 ll; vec3 nc; float e;
    bool ok = true;
    if (u_view.w > 0.999) ll = invFlat(px);
    else ok = invGlobe(px, ll, nc, e);
    if (ok && inGrid(gridIJ(ll))) return vec4(ll, 0.0, rnd(id * 3.7));
  }
  return vec4(0.0, 0.0, u_maxAge * 2.0, rnd(id));
}

void main() {
  vec4 s = a_state;
  float id = float(gl_VertexID) + s.w * 977.0;
  vec3 w = windAt(s.xy);
  vec3 scr = projectPx(s.xy);
  bool off = abs(scr.x) > 0.55 * u_vp.x || abs(scr.y) > 0.55 * u_vp.y || scr.z < 0.0;
  if (s.z > u_maxAge * (0.55 + 0.45 * s.w) || w.z < 0.5 || off) {
    v_state = spawn(id);
    return;
  }
  float lat = s.y + w.y * u_step;
  float lon = s.x + w.x * u_step / max(cos(s.y), 0.05);
  v_state = vec4(wrapPi(lon), clamp(lat, -1.55, 1.55), s.z + u_dt, s.w);
}`;

export const PARTICLE_UPDATE_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

export const PARTICLE_DRAW_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PROJ}
${GRID}
uniform highp usampler2D u_wind;
uniform vec2 u_qs;
uniform float u_trail;      // radians of trail per (m/s)
uniform float u_maxAge;
uniform float u_width;
in vec4 a_state;
in vec2 a_corner;
out float v_a;
out float v_side;
out float v_hw;

vec2 windAt(vec2 ll) {
  vec2 ij = gridIJ(ll);
  if (!inGrid(ij)) return vec2(0.0);
  uvec4 q = texelFetch(u_wind, gidx(ivec2(floor(ij + 0.5))), 0);
  if (q.r == 0u) return vec2(0.0);
  return (vec2(q.rg) - 1.0) * u_qs.x + u_qs.y;
}

void main() {
  vec2 ll = a_state.xy;
  vec2 w = windAt(ll);
  float sp = length(w);
  vec2 tail = vec2(ll.x - w.x * u_trail / max(cos(ll.y), 0.05), ll.y - w.y * u_trail);
  vec3 pa = projectPx(tail), pb = projectPx(ll);
  vec2 d = pb.xy - pa.xy; float len = length(d);
  float age = a_state.z;
  float life = u_maxAge * (0.55 + 0.45 * a_state.w);
  float fade = smoothstep(0.0, 0.35, age) * (1.0 - smoothstep(life * 0.75, life, age));
  if (pa.z < 0.0 || pb.z < 0.0 || len < 0.2 || len > 200.0 || sp < 0.3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = d / len, nrm = vec2(-dir.y, dir.x);
  float hw = u_width * 0.5 + 0.8;
  vec2 p = mix(pa.xy, pb.xy, a_corner.x) + nrm * a_corner.y * hw;
  v_side = a_corner.y * hw; v_hw = u_width * 0.5;
  v_a = fade * clamp(0.35 + sp / 18.0, 0.35, 1.0) * mix(0.0, 1.0, a_corner.x);
  gl_Position = vec4(p / (0.5 * u_vp.xy), 0.0, 1.0);
}`;

export const PARTICLE_DRAW_FS = /* glsl */ `#version 300 es
precision highp float;
in float v_a; in float v_side; in float v_hw;
uniform vec4 u_color;
out vec4 o_color;
void main() {
  float a = clamp(v_hw + 0.6 - abs(v_side), 0.0, 1.0) * v_a * u_color.a;
  if (a < 0.01) discard;
  o_color = vec4(u_color.rgb * a, a);
}`;

// Lightning: every strike is drawn as a bolt glyph (a signed-distance sprite), biggest for the newest
// strikes and shrinking with age, colored white -> gold -> amber -> crimson across the window.
// A bolt flashes when it happens live, when a stepped radar frame reveals it, or when a replay
// sequence reaches it: replays run through the strikes in the order they happened, either revealing
// them one by one (reveal) or re-flashing ones already on screen (pulse).
// Glow terms are emitted with alpha 0 so they add light under the premultiplied blend.
export const BOLT_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec2 a_corner;          // -1..1
in vec4 a_s;               // lon, lat (deg), time (s, relative to the layer base), energy 0..1
in float a_r;              // per-strike random 0..1: flash selection, tilt, flicker pattern
uniform float u_tEnd;      // end of the visible window (same base as a_s.z)
uniform float u_window;    // window length (s)
uniform float u_mode;      // 0 live (a strike flashes as its time passes), 1 stepped
uniform float u_prevT;     // stepped: start of the interval the step revealed
uniform float u_wall;      // wall clock (s)
uniform float u_stepWall;  // stepped: wall time of the step
uniform float u_spread;    // stepped: seconds the revealed strikes are spread over
uniform float u_flash;     // flash length (s); 0 = no animation
uniform float u_animFrac;  // share of live/stepped strikes that flash
uniform vec4 u_seq;        // replay: wall start, t0, t1, duration (s); duration 0 = none
uniform vec3 u_seqOpt;     // replay: mode (1 reveal, 2 pulse), flash length per bolt, share that flash
uniform float u_knots[17]; // replay: strike times at 0, 1/16 ... 1 of the replayed strikes (even pacing)
uniform float u_size;      // height of the newest bolt (device px)
uniform float u_minSize;   // height of the oldest bolt (device px)
out vec2 v_uv;             // glyph space, -1..1 over the glyph box (rotated with the bolt)
out vec2 v_px;             // device px from the bolt center
out float v_age;           // 0..1 across the window
out float v_fa;            // flash phase (s), -1 when not flashing
out float v_fdur;
out float v_seed;
out float v_half;          // glyph box half size (device px)
out float v_e;
out float v_ageS;          // age in seconds

float seqFrac(float t) {
  if (t <= u_knots[0]) return 0.0;
  for (int k = 1; k < 17; k++) {
    if (t <= u_knots[k]) {
      float a = u_knots[k - 1], b = u_knots[k];
      return (float(k - 1) + (t - a) / max(b - a, 1e-4)) / 16.0;
    }
  }
  return 1.0;
}

void main() {
  float age = u_tEnd - a_s.z;
  vec3 p = projectPx(radians(a_s.xy));
  bool pick = a_r < u_animFrac;
  float fa = -1.0, fdur = u_flash;
  bool hidden = false;
  if (u_flash > 0.0 && pick) {
    if (u_mode < 0.5) { if (age >= 0.0 && age < u_flash) fa = age; }
    else if (a_s.z > u_prevT) {
      fa = (u_wall - u_stepWall) - (a_s.z - u_prevT) / max(u_tEnd - u_prevT, 1e-3) * u_spread;
      if (fa < 0.0) hidden = true;
    }
  }
  if (u_seq.w > 0.0 && a_s.z >= u_seq.y && a_s.z <= u_seq.z) {
    float lin = (a_s.z - u_seq.y) / max(u_seq.z - u_seq.y, 1e-3);
    float ph = (u_wall - u_seq.x) - mix(lin, seqFrac(a_s.z), 0.75) * u_seq.w;
    if (ph < 0.0) { if (u_seqOpt.x < 1.5) hidden = true; }
    else if (ph < u_seqOpt.y && a_r < u_seqOpt.z && (fa < 0.0 || ph < fa)) { fa = ph; fdur = u_seqOpt.y; }
  }
  if (age < 0.0 || age > u_window || p.z < 0.0 || hidden) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float rec = exp(-age / (u_window * 0.22));
  float h = mix(u_minSize, u_size, rec) * (0.9 + 0.2 * a_s.w);
  bool flashing = fa >= 0.0 && fa < fdur;
  float pop = flashing ? 1.0 + 0.45 * exp(-fa / max(fdur * 0.35, 0.02)) : 1.0;
  h *= pop;
  float halfG = h * 0.76;                          // glyph box: the bolt spans +-0.66 of it vertically
  float young = exp(-clamp(age / u_window, 0.0, 1.0) * 14.0);
  // the quad must contain every glow term, or its edges show as a square
  float halfQ = flashing ? halfG * 3.4 + 6.0 : halfG * (1.0 + 0.35 * young) + 3.0;
  float tilt = (fract(a_r * 13.7) - 0.5) * 0.5;
  float mirror = fract(a_r * 7.31) > 0.5 ? -1.0 : 1.0;
  vec2 q = a_corner * halfQ;                       // quad corner, device px, y up
  float c = cos(tilt), s = sin(tilt);
  vec2 g = vec2(c * q.x + s * q.y, -s * q.x + c * q.y) / halfG;
  v_uv = vec2(g.x * mirror, g.y);
  v_px = q;
  v_half = halfG;
  v_age = clamp(age / u_window, 0.0, 1.0);
  v_fa = flashing ? fa : -1.0;
  v_fdur = fdur;
  v_seed = fract(a_r * 7.13 + a_s.z * 0.618);
  v_e = a_s.w;
  v_ageS = max(age, 0.0);
  gl_Position = vec4((p.xy + q) / (0.5 * u_vp.xy), 0.0, 1.0);
}`;

export const BOLT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_px;
in float v_age;
in float v_fa;
in float v_fdur;
in float v_seed;
in float v_half;
in float v_e;
in float v_ageS;
out vec4 o_color;
uniform sampler2D u_sdf;
uniform float u_sdfRange;  // largest distance the SDF stores, in glyph-box units (1 = half the box)
uniform float u_gain;      // dims flashes when many go off at once
uniform float u_dpr;

vec3 ageColor(float a) {
  vec3 c0 = vec3(1.0, 1.0, 0.96), c1 = vec3(1.0, 0.93, 0.55), c2 = vec3(1.0, 0.72, 0.2), c3 = vec3(1.0, 0.45, 0.14), c4 = vec3(0.9, 0.18, 0.3);
  if (a < 0.04) return mix(c0, c1, a / 0.04);
  if (a < 0.18) return mix(c1, c2, (a - 0.04) / 0.14);
  if (a < 0.5) return mix(c2, c3, (a - 0.18) / 0.32);
  return mix(c3, c4, (a - 0.5) / 0.5);
}

float h1(float s, float k) { return fract(sin((s + k) * 91.345) * 47453.5453); }

// A first return stroke and up to three more: sharp spikes with fast decays, plus an afterglow.
float flicker(float t, float seed, float dur) {
  float sc = clamp(dur / 0.75, 0.35, 1.0);
  float env = 0.0, start = 0.0;
  int strokes = 1 + int(floor(h1(seed, 1.0) * 3.99));
  for (int k = 0; k < 4; k++) {
    if (k >= strokes) break;
    float amp = k == 0 ? 1.0 : 0.45 + 0.5 * h1(seed, float(k) + 2.0);
    float dt = t - start;
    if (dt >= 0.0) env = max(env, amp * exp(-dt / (0.045 * sc)));
    start += (0.05 + 0.11 * h1(seed, float(k) + 7.0)) * sc;
  }
  return env + 0.22 * exp(-t / (0.3 * sc));
}

void main() {
  // signed distance to the bolt outline in device px (positive outside); past the glyph box the
  // texture is clamped, so take the distance to the box as a lower bound
  float sd = texture(u_sdf, vec2(v_uv.x * 0.5 + 0.5, 0.5 - v_uv.y * 0.5)).r;
  float rangePx = u_sdfRange * v_half;
  float d = max((0.5 - sd) * 2.0 * rangePx, length(max(abs(v_uv) - 1.0, 0.0)) * v_half);
  float r = length(v_px);
  float aa = 0.6 * u_dpr;
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float ow = min(1.7 * u_dpr, 0.4 * rangePx);       // outline stays inside what the SDF can encode
  float outline = (1.0 - smoothstep(ow * 0.45, ow, d)) * (1.0 - fill);
  // older bolts recede a little so the newest stand out in a busy cell
  float fade = (1.0 - smoothstep(0.88, 1.0, v_age)) * mix(1.0, 0.7, smoothstep(0.25, 1.0, v_age));
  vec3 col = ageColor(v_age);
  float young = exp(-v_age * 14.0);
  vec3 core = mix(col, vec3(1.0), 0.55 * young);
  vec3 rgb = core * fill * fade;
  float a = (fill + outline * 0.8 * (1.0 - fill)) * fade;
  // a strike glows softly for a few seconds after it lands; a busy cell lands several per second, so
  // the glow is short and dims with u_gain or the glows pile up into a white blob that hides the bolts
  rgb += col * exp(-pow(r / (v_half * 0.5), 2.0)) * 0.28 * exp(-v_ageS / 6.0) * u_gain * (1.0 - fill) * fade;
  if (v_fa >= 0.0) {
    float u = clamp(v_fa / v_fdur, 0.0, 1.0);
    float env = flicker(v_fa, v_seed, v_fdur) * u_gain * (0.75 + 0.45 * v_e);
    float bloom = env * mix(0.3, 1.0, exp(-v_age * 8.0));
    vec3 bolt = vec3(0.86, 0.92, 1.0);
    rgb = mix(rgb, vec3(1.0) * fill, clamp(env * 1.4, 0.0, 1.0));
    rgb += bolt * (exp(-pow(r / (v_half * 0.55), 2.0)) * 0.9 + exp(-pow(r / (v_half * 1.25), 2.0)) * 0.24) * bloom;
    float rr = mix(v_half * 0.4, v_half * 2.6, 1.0 - pow(1.0 - u, 3.0));
    rgb += bolt * exp(-pow((r - rr) / (1.3 * u_dpr), 2.0)) * 0.45 * (1.0 - u) * (1.0 - u) * u_gain;
    a = max(a, fill);
  }
  if (a < 0.003 && max(rgb.r, max(rgb.g, rgb.b)) < 0.003) discard;
  o_color = vec4(rgb, a);
}`;

// Map labels: sprites from the label atlas, anchored at lon/lat and snapped to whole device pixels
// so the atlas texels land 1:1 on screen pixels (crisp text, no shimmer while panning).
export const LABEL_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec2 a_corner;   // 0..1
in vec2 a_ll;       // lon, lat (deg)
in vec2 a_off;      // sprite top-left relative to the anchor (device px, y down)
in vec2 a_size;     // sprite size (device px)
in vec2 a_uv;       // sprite top-left in the atlas (px)
in float a_alpha;
uniform vec2 u_buf;        // drawing buffer size (px)
uniform vec2 u_atlasSize;
out vec2 v_uv;
out float v_a;
void main() {
  vec3 p = projectPx(radians(a_ll));
  float a = a_alpha * smoothstep(0.035, 0.09, p.z);
  if (a <= 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 ndc = p.xy / (0.5 * u_vp.xy);
  vec2 px = vec2((ndc.x * 0.5 + 0.5) * u_buf.x, (0.5 - ndc.y * 0.5) * u_buf.y);
  vec2 tl = floor(px + a_off + 0.5);
  vec2 q = tl + a_corner * a_size;
  gl_Position = vec4(q.x / u_buf.x * 2.0 - 1.0, 1.0 - q.y / u_buf.y * 2.0, 0.0, 1.0);
  v_uv = (a_uv + a_corner * a_size) / u_atlasSize;
  v_a = a;
}`;

export const LABEL_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
in float v_a;
uniform sampler2D u_atlas;
out vec4 o_color;
void main() {
  vec4 c = texture(u_atlas, v_uv);
  if (c.a < 0.004) discard;
  o_color = c * v_a;
}`;

// WPC front symbols (cold triangles, warm half-discs, dryline open half-discs), oriented along the
// front on screen. Shapes are signed distance fields, so they stay crisp at any angle and size.
export const FRONTSYM_VS = /* glsl */ `#version 300 es
precision highp float;
${PROJ}
in vec2 a_corner;    // -1..1
in vec4 a_ll;        // symbol lon, lat, and a point just ahead along the front (deg)
in vec2 a_kind;      // kind (0 triangle, 1 half-disc, 2 open half-disc), side (+1 left of travel, -1 right)
in vec3 a_color;
uniform float u_size;   // device px
out vec2 v_local;       // device px: x along the front, y toward the symbol side
out vec3 v_color;
flat out float v_kind;
void main() {
  vec3 pa = projectPx(radians(a_ll.xy));
  vec3 pb = projectPx(radians(a_ll.zw));
  vec2 d = pb.xy - pa.xy;
  float len = length(d);
  if (pa.z < 0.02 || pb.z < 0.0 || len < 1e-3 || len > 0.5 * max(u_vp.x, u_vp.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x) * a_kind.y;
  vec2 local = vec2(a_corner.x * 1.25, mix(-0.35, 1.35, a_corner.y * 0.5 + 0.5)) * u_size;
  vec2 p = pa.xy + dir * local.x + nrm * local.y;
  v_local = local;
  v_color = a_color;
  v_kind = a_kind.x;
  gl_Position = vec4(p / (0.5 * u_vp.xy), 0.0, 1.0);
}`;

export const FRONTSYM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
in vec3 v_color;
flat in float v_kind;
uniform float u_size;
uniform float u_dpr;
out vec4 o_color;
float sdTri(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 e0 = b - a, e1 = c - b, e2 = a - c;
  vec2 v0 = p - a, v1 = p - b, v2 = p - c;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
               vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
void main() {
  float s = u_size;
  float d;
  if (v_kind < 0.5) d = sdTri(v_local, vec2(-0.82 * s, 0.0), vec2(0.82 * s, 0.0), vec2(0.0, 1.05 * s));
  else {
    float r = 0.72 * s;
    float disc = length(v_local) - r;
    d = max(disc, -v_local.y);
    if (v_kind > 1.5) d = max(abs(disc) - u_dpr, -v_local.y);
  }
  float aa = 0.75;
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float edge = 1.0 - smoothstep(-aa, aa, d - 1.4 * u_dpr);
  if (edge < 0.004) discard;
  vec3 col = v_color * fill;
  float a = fill + (edge - fill) * 0.6;
  o_color = vec4(col, a);
}`;

// Copies the cached surface pass to the screen, pixel for pixel.
export const BLIT_FS = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
out vec4 o_color;
void main() { o_color = texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0); }`;
