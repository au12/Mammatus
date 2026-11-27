// GLSL for the Sky view. Units: kilometres, x east, y north, z up, origin on the ground at the point.

export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// ------------------------------------------------------------------ tileable noise volumes
export const NOISE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_slice;     // 0..1 z of this slice
uniform float u_size;
uniform int u_kind;        // 0 = shape (perlin-worley + worley octaves), 1 = detail (worley octaves)
out vec4 o;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// cellular noise, inverted (1 at the feature points), period in cells
float worley(vec3 p, float period) {
  vec3 id = floor(p), f = fract(p);
  float d = 1e9;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(x, y, z);
    vec3 c = mod(id + o, period);
    vec3 r = o + hash33(c) - f;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
vec3 grad(vec3 c) { return normalize(hash33(c) * 2.0 - 1.0 + 1e-4); }
float perlin(vec3 p, float period) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(grad(mod(i, period)), f);
  float n100 = dot(grad(mod(i + vec3(1, 0, 0), period)), f - vec3(1, 0, 0));
  float n010 = dot(grad(mod(i + vec3(0, 1, 0), period)), f - vec3(0, 1, 0));
  float n110 = dot(grad(mod(i + vec3(1, 1, 0), period)), f - vec3(1, 1, 0));
  float n001 = dot(grad(mod(i + vec3(0, 0, 1), period)), f - vec3(0, 0, 1));
  float n101 = dot(grad(mod(i + vec3(1, 0, 1), period)), f - vec3(1, 0, 1));
  float n011 = dot(grad(mod(i + vec3(0, 1, 1), period)), f - vec3(0, 1, 1));
  float n111 = dot(grad(mod(i + vec3(1, 1, 1), period)), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

void main() {
  vec3 uvw = vec3(gl_FragCoord.xy / u_size, u_slice);
  if (u_kind == 0) {
    float pf = 0.0, amp = 1.0, norm = 0.0, fr = 4.0;
    for (int i = 0; i < 6; i++) { pf += perlin(uvw * fr, fr) * amp; norm += amp; amp *= 0.5; fr *= 2.0; }
    pf = clamp(pf / norm * 0.9 + 0.5, 0.0, 1.0);
    float w1 = worley(uvw * 4.0, 4.0), w2 = worley(uvw * 8.0, 8.0), w3 = worley(uvw * 16.0, 16.0), w4 = worley(uvw * 32.0, 32.0);
    float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    float pw = clamp(remap(pf, 0.0, 1.0, wf, 1.0), 0.0, 1.0);
    o = vec4(pw, w2 * 0.625 + w3 * 0.25 + w4 * 0.125, w3, w1);
  } else {
    float a = worley(uvw * 4.0, 4.0), b = worley(uvw * 8.0, 8.0), c = worley(uvw * 16.0, 16.0), d = worley(uvw * 2.0, 2.0);
    o = vec4(a, b, c, d);
  }
}`;

// ------------------------------------------------------------------ shared scene uniforms and helpers
const COMMON = /* glsl */ `
#define PI 3.14159265
#define BOX_HALF 60.0
#define BOX 120.0
#define ZTOP 16.0
uniform vec3 u_camPos;
uniform mat4 u_invVP;
uniform vec3 u_light;        // direction to the main light (sun, or the moon at night)
uniform float u_lightI;      // its intensity relative to the noon sun
uniform sampler2D u_sunLUT;  // 64x1: light colour by height 0..20 km (sun dipping below the horizon)
uniform vec3 u_ambTop;       // skylight from above
uniform vec3 u_ambBot;       // light from the ground
uniform float u_elev;        // ground height at the point, km above sea level
uniform vec2 u_lat0;         // latitude, longitude of the point (deg)
uniform float u_hazeK;       // how hazy the air is (the side view keeps distant ridges readable)
uniform vec4 u_cut;          // side view: xy horizontal forward, z cut distance (in front of the point), w on
uniform vec2 u_slab;         // side view: clouds end this far behind the point (x), fading over y
float planeDist(vec2 xy) { return dot(xy, u_cut.xy); }

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 rayDir(vec2 ndc) {
  vec4 a = u_invVP * vec4(ndc, -1.0, 1.0), b = u_invVP * vec4(ndc, 1.0, 1.0);
  return normalize(b.xyz / b.w - a.xyz / a.w);
}
vec3 lightColor(float z) { return texture(u_sunLUT, vec2(clamp(z / 20.0, 0.0, 1.0), 0.5)).rgb * u_lightI; }
float ign(vec2 p, float f) { p += f * 5.588238; return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// air mass along a ray segment for an exponential atmosphere with scale height H (km of sea-level air)
float airDepth(vec3 ro, vec3 rd, float t, float H) {
  float h0 = max(ro.z + u_elev, 0.0), h1 = max(ro.z + rd.z * t + u_elev, 0.0);
  if (abs(rd.z) < 0.02) return t * exp(-0.5 * (h0 + h1) / H);
  return H * abs(exp(-h0 / H) - exp(-h1 / H)) / abs(rd.z);
}
// in the side view the air in front of the cut plane is not there either: haze starts at the plane
float hazeDepth(vec3 ro, vec3 rd, float t) {
  if (u_cut.w > 0.5) {
    float den = dot(rd.xy, u_cut.xy);
    if (den > 1e-6) {
      float tc = clamp((u_cut.z - dot(ro.xy, u_cut.xy)) / den, 0.0, t);
      ro += rd * tc;
      t -= tc;
    }
  }
  return (0.011 * airDepth(ro, rd, t, 8.0) + 0.075 * airDepth(ro, rd, t, 1.3)) * u_hazeK;
}
`;

// cloud volume sampling, shared by the shadow, cloud and composite passes
const CLOUD = /* glsl */ `
uniform highp sampler3D u_vol0;
uniform highp sampler3D u_aux0;
uniform highp sampler3D u_vol1;
uniform highp sampler3D u_aux1;
uniform highp sampler3D u_noise;
uniform highp sampler3D u_detail;
uniform sampler2D u_wind;      // 64x1, wind (m/s) by height
uniform sampler2D u_anvil;     // 40x40: anvil base / ZTOP, mammatus strength
uniform float u_mix;
uniform float u_time;          // drift clock, seconds (already sped up)
uniform float u_appear;        // 0..1 clouds condensing in
uniform float u_mammatus;
uniform float u_ext;           // extinction scale
uniform float u_pixAngle;      // radians per cloud-buffer pixel (for level of detail)
float gFoot = 0.05;            // km per pixel at the current sample

float wcDecode(float c) { return c > 0.002 ? exp2(((c * 255.0 - 1.0) * (4.5 / 253.0) - 4.0) * 3.3219281) : 0.0; }
vec4 wc4(vec4 c) { return vec4(wcDecode(c.r), wcDecode(c.g), wcDecode(c.b), wcDecode(c.a)); }
vec3 boxUVW(vec3 p) { return vec3((p.xy + BOX_HALF) / BOX, p.z / ZTOP); }
vec2 windAt(float z) { return texture(u_wind, vec2(clamp(z / ZTOP, 0.0, 1.0), 0.5)).rg; }
float edgeFade(vec2 xy) { vec2 e = abs(xy) - (BOX_HALF - 1.5); float o = max(e.x, e.y); return (1.0 - 0.45 * smoothstep(0.0, 60.0, o)) * (1.0 - smoothstep(150.0, 210.0, o)); }

// A slow, large-scale warp of where the weather is read: it hides the model's 3 km grid in organic
// shapes (sub-grid, so heights and amounts stay where the model put them).
vec3 warpOf(vec3 p) {
  vec2 w = windAt(p.z) * (u_time * 0.001);
  vec3 n = textureLod(u_noise, vec3((p.xy - w) / 29.0, p.z / 9.0) + vec3(0.37, 0.11, 0.73), 0.0).rgb;
  vec3 m = textureLod(u_noise, vec3((p.xy - w) / 11.0, p.z / 5.0) + vec3(0.71, 0.53, 0.19), 0.0).gba;
  vec3 f = textureLod(u_noise, vec3((p.xy - w) / 3.7, p.z / 2.2) + vec3(0.29, 0.83, 0.47), 0.0).gba;
  return (n - vec3(0.55, 0.45, 0.45)) * vec3(2.6, 2.6, 0.35) + (m - 0.4) * vec3(1.5, 1.5, 0.2) + (f - 0.4) * vec3(1.0, 1.0, 0.12);
}

void weather(vec3 p, out vec4 aux, out vec4 water) {
  vec3 uvw = boxUVW(p + warpOf(p));
  aux = texture(u_aux0, uvw);
  water = wc4(texture(u_vol0, uvw));
  if (u_mix > 0.002) {
    aux = mix(aux, texture(u_aux1, uvw), u_mix);
    water = mix(water, wc4(texture(u_vol1, uvw)), u_mix);
  }
}

// Cloud density 0..1 at p. lod 0 = full detail, 1 = no erosion (light and shadow rays).
// h returns the height within the cloud layer (0 base .. 1 top).
float cloudDensity(vec3 p, vec4 aux, vec4 water, float lod, out float h) {
  float cov = aux.r * edgeFade(p.xy);
  h = 0.0;
  if (cov < 0.01) return 0.0;
  float cum = aux.g;
  float base = aux.b * ZTOP, top = max(aux.a * ZTOP, base + 0.12);
  float thick = top - base;
  h = sat((p.z - base) / thick);
  // condensing in: low cloud first, the higher layers a beat later
  float ap = sat((u_appear * 1.45 - p.z / ZTOP * 0.45) / 1.0);
  ap = ap * ap * (3.0 - 2.0 * ap);
  cov *= ap;
  if (cov < 0.01) return 0.0;
  float iceF = sat((water.g - water.r * 0.6) / (water.g + water.r + 1e-5) * 1.6);
  // the whole layer drifts with the wind at its middle, so towers do not shear apart
  vec2 w = windAt(0.5 * (base + top)) * (u_time * 0.001);
  vec3 q = p;
  q.xy -= w;
  q.z -= u_time * 0.00045 * cum;
  vec3 nq;
  if (iceF > 0.55 && cum < 0.45) {
    // cirrus: fibres along the wind, a little hooked by height
    vec2 wd = normalize(windAt(p.z) + vec2(1e-3, 0.0));
    vec2 r = vec2(dot(q.xy, wd), dot(q.xy, vec2(-wd.y, wd.x)));
    r.x += (top - p.z) * 3.0;
    nq = vec3(r.x / 8.0, r.y / 1.1, q.z / 0.9);
  } else {
    float tile = mix(mix(5.5, 4.0, iceF), clamp(thick * 2.3, 2.2, 13.0), cum);
    nq = q / tile;
    nq.z *= mix(2.4, 1.0, cum);
  }
  vec4 n = textureLod(u_noise, nq, 0.0);
  float wf = n.g;
  float shape = remap(n.r, wf - 1.0, 1.0, 0.0, 1.0);
  // towering cumulus: cauliflower lobes a few km across (the tile's coarse cells), so a model cell's
  // edge becomes a wall of bulging turrets instead of a sheer face
  float big = cum * sat((thick - 2.0) / 3.5);
  shape = mix(shape, shape * 0.45 + (n.a * 0.62 + n.g * 0.38) * 0.68, big);
  // sheets are smooth inside but ragged where their coverage runs out
  shape = mix(0.62 + 0.38 * shape, shape, max(cum, 1.0 - smoothstep(0.5, 0.95, cov)));
  // far away the shape's own detail is below a pixel: let it settle toward its average
  shape = mix(shape, 0.55, smoothstep(0.35, 1.6, gFoot) * 0.7);
  float strat = smoothstep(0.0, 0.22, h) * (1.0 - smoothstep(0.62, 1.0, h));
  float cumu = smoothstep(0.0, 0.045, h) * (1.0 - smoothstep(0.72, 1.0, h));
  float prof = mix(strat, cumu, cum);
  // cumulus narrow to domes upward; sheets fill in
  float covH = cov * mix(1.12, 1.18 - 0.8 * h * h, cum);
  covH = min(covH, 1.0);
  // sparse cumulus are separate, solid cloudlets, not a faint haze: only sheets thin out with coverage
  float d = sat(remap(shape * prof, 1.0 - covH, 1.0, 0.0, 1.0)) * mix(covH, sqrt(covH), cum);
  if (d < 0.006) return 0.0;
  float er = mix(0.3, 0.52, cum) * mix(1.0, 0.65, iceF) * (1.0 - smoothstep(0.08, 0.4, gFoot));
  if (lod < 0.5 && er > 0.01) {
    vec3 dq = nq * 5.7 + vec3(0.0, 0.0, u_time * 0.00012);
    vec4 dn = textureLod(u_detail, dq, 0.0);
    float hf = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    hf = mix(hf, 1.0 - hf, sat(h * 4.0));      // wispy bases, billowing tops
    d = sat(remap(d, hf * er, 1.0, 0.0, 1.0));
  }
  // crisp edges: dense quickly once inside
  return sat(d * mix(1.3, 2.0, cum));
}

// pouches hanging under a storm's anvil
float mammatusDensity(vec3 p) {
  if (u_mammatus < 0.01) return 0.0;
  vec2 an = texture(u_anvil, (p.xy + BOX_HALF) / BOX).rg;
  float s = an.g * u_mammatus;
  if (s < 0.02) return 0.0;
  float base = an.r * ZTOP;
  float below = base - p.z;
  if (below < -0.08 || below > 1.5) return 0.0;
  vec2 w = windAt(base) * (u_time * 0.001);
  vec3 q = vec3((p.xy - w) / 7.0, 0.31 + u_time * 0.000015);
  float c = textureLod(u_noise, q, 0.0).a;              // single-octave cells, about 1.7 km
  // round pouches: a hemisphere over each cell (the cell value falls off linearly with distance)
  float r = sat((1.0 - c) / 0.62);
  float depth = s * 1.05 * sqrt(max(0.0, 1.0 - r * r));
  float lobe = sat((depth - below) / max(depth, 0.05));
  return smoothstep(0.0, 0.18, lobe) * edgeFade(p.xy);
}

// falling rain and snow: curtains streaked downward
float precipStreak(vec3 p, float snow) {
  vec2 w = windAt(p.z) * (u_time * 0.001);
  float fall = mix(0.0065, 0.0012, snow) * u_time;
  vec3 q = vec3((p.xy - w) / mix(1.6, 3.0, snow), (p.z + fall) / mix(10.0, 4.0, snow));
  float s = textureLod(u_noise, q, 0.0).r;
  // curtains: broad sheets with fine streaks inside
  float fine = textureLod(u_detail, vec3((p.xy - w) / 0.9, (p.z + fall * 1.3) / 3.5), 0.0).g;
  return smoothstep(0.3, 0.8, s) * (0.55 + 0.45 * fine);
}

// extinction (per km) of cloud water with this density: optical properties of droplets vs crystals
// droplets (about 10 um) are far more opaque per gram than ice crystals and snow aloft (about 60 um)
float cloudSigma(float d, vec4 water) {
  return d * max(150.0 * water.r + 26.0 * water.g, 1.2) * u_ext;
}
`;

// ------------------------------------------------------------------ physically based sky (lookup texture)
export const SKYLUT_FS = /* glsl */ `#version 300 es
precision highp float;
#define PI 3.14159265
uniform vec2 u_size;
uniform vec3 u_sunDir;       // direction to the sun
uniform float u_h0;          // observer height above sea level (km)
out vec4 o;
const float RP = 6360.0, RA = 6460.0;
const vec3 BR = vec3(5.802, 13.558, 33.1) * 1e-3;
const float BMS = 3.996e-3, BME = 4.40e-3;
const vec3 BO = vec3(0.650, 1.881, 0.085) * 1e-3;
vec2 sphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
vec3 extinctionAt(float h) {
  float r = exp(-h / 8.0), m = exp(-h / 1.2), oz = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  return BR * r + BME * m + BO * oz;
}
vec3 transmittanceToSun(vec3 p, vec3 sd) {
  vec2 hit = sphere(p, sd, RP);
  if (hit.x > 0.0) return vec3(0.0);
  float len = sphere(p, sd, RA).y;
  vec3 tau = vec3(0.0);
  float ds = len / 8.0;
  for (int i = 0; i < 8; i++) {
    vec3 q = p + sd * ds * (float(i) + 0.5);
    tau += extinctionAt(length(q) - RP) * ds;
  }
  return exp(-tau);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float az = uv.x * PI;
  float v = uv.y * 2.0 - 1.0;
  float el = sign(v) * v * v * PI * 0.5;
  // frame where the sun lies at azimuth 0
  float sunEl = asin(clamp(u_sunDir.z, -1.0, 1.0));
  vec3 sd = vec3(0.0, cos(sunEl), sin(sunEl));
  vec3 rd = vec3(sin(az) * cos(el), cos(az) * cos(el), sin(el));
  vec3 ro = vec3(0.0, 0.0, RP + max(u_h0, 0.01));
  vec2 atm = sphere(ro, rd, RA), gnd = sphere(ro, rd, RP);
  float len = gnd.x > 0.0 ? gnd.x : atm.y;
  float mu = dot(rd, sd);
  float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.8;
  float pm = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 L = vec3(0.0), T = vec3(1.0);
  const int N = 28;
  float ds = len / float(N);
  // planet frame: the observer on the z axis, the sun at azimuth 0 (it is at infinity, so every
  // sample sees it in the same direction; the local horizon tilts with the curvature on its own)
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * ds * (float(i) + 0.5);
    float h = length(p) - RP;
    float r = exp(-h / 8.0), m = exp(-h / 1.2);
    vec3 ext = extinctionAt(h);
    vec3 Ts = transmittanceToSun(p, sd);
    // a crude multiple-scattering floor keeps twilight from going pitch black
    vec3 ms = (BR * r + BMS * m) * (0.06 + 0.25 * max(sd.z + 0.1, 0.0));
    vec3 S = (BR * r * pr + BMS * m * pm) * Ts + ms * smoothstep(-0.2, 0.05, sd.z);
    vec3 Tr = exp(-ext * ds);
    L += T * (S - S * Tr) / ext;
    T *= Tr;
  }
  o = vec4(L * 5.0, 1.0);
}`;

// ------------------------------------------------------------------ cloud shadows on the ground (sun's eye view, top-down)
export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
${COMMON}
${CLOUD}
uniform sampler2D u_terrain;
uniform vec2 u_size;
uniform float u_span;
out vec4 o;
float terrainH(vec2 xy) { return texture(u_terrain, (xy + BOX_HALF) / BOX).r; }
void main() {
  vec2 xy = (gl_FragCoord.xy / u_size - 0.5) * u_span;
  vec3 L = u_light;
  if (L.z < 0.02) { o = vec4(1.0); return; }
  vec3 p = vec3(xy, max(terrainH(xy), 0.0));
  float tau = 0.0;
  float len = min((ZTOP - p.z) / L.z, 70.0);
  const int N = 30;
  float dt = len / float(N);
  float j = ign(gl_FragCoord.xy, 0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + L * dt * (float(i) + j);
    if (abs(q.x) > BOX_HALF + 200.0 || abs(q.y) > BOX_HALF + 200.0) break;
    vec4 aux, water; float h;
    weather(q, aux, water);
    float d = cloudDensity(q, aux, water, 1.0, h);
    tau += cloudSigma(d, water) * dt * 0.6 + (1.5 * water.b + 15.0 * water.a) * dt * 0.5;
    if (tau > 8.0) break;
  }
  o = vec4(exp(-tau), 0.0, 0.0, 1.0);
}`;

// ------------------------------------------------------------------ background: sky, sun, moon, terrain
export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
${COMMON}
uniform vec2 u_res;
uniform sampler2D u_skyLUT;
uniform sampler2D u_terrain;     // relative heights (km) in the box
uniform sampler2D u_day;
uniform sampler2D u_nightTex;
uniform sampler2D u_shadow;
uniform float u_shadowSpan;
uniform vec3 u_sunDir;           // the sun itself (u_light may be the moon)
uniform vec3 u_sunCol;           // sun colour at the camera
uniform vec3 u_moonDir;
uniform vec3 u_moonCol;
uniform float u_moonIllum;
uniform float u_night;           // 0 day .. 1 night
uniform float u_stylize;         // side view: the sky darkens to space by altitude
uniform float u_refDist;         // distance to the point's vertical plane
uniform float u_refZ;            // camera height (for the altitude of a background pixel)
uniform float u_snow;            // ground whitening
uniform float u_cityGlow;        // light pollution 0..1
uniform float u_far;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oDepth;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p, int oct) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

float boxTerrain(vec2 xy) { return texture(u_terrain, (xy + BOX_HALF) / BOX).r; }
// the box's terrain, carried past its edge with rolling hills, plus fine ridges
float terrainH(vec2 xy, int oct) {
  float inside = 1.0 - smoothstep(0.0, 30.0, max(abs(xy.x), abs(xy.y)) - BOX_HALF);
  float relief = 0.12 + 0.6 * smoothstep(0.0, 1.2, abs(boxTerrain(xy)) + 0.15);
  float hills = (fbm2(xy * 0.045 + 3.0, 3) - 0.5) * 0.8 * relief;
  // fine ridges everywhere but right at the point, where the ground view stands
  float fine = (fbm2(xy * 0.6, oct) - 0.5) * 0.18 * relief * smoothstep(0.05, 1.5, length(xy));
  return mix(hills, boxTerrain(xy), inside) + fine;
}

vec2 lonlat(vec2 xy) {
  float lat = u_lat0.x + xy.y / 111.195;
  float lon = u_lat0.y + xy.x / (111.195 * max(cos(radians(u_lat0.x)), 0.05));
  return vec2(lon, lat);
}

vec3 skyLUT(vec3 rd, vec3 s) {
  float el = asin(clamp(rd.z, -1.0, 1.0));
  vec2 a = normalize(rd.xy + 1e-6), b = normalize(s.xy + 1e-6);
  float az = acos(clamp(dot(a, b), -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (PI * 0.5));
  return texture(u_skyLUT, vec2(az / PI, v)).rgb;
}

// The side view's backdrop: the colours of the atmosphere by altitude, pale blue near the ground through deep
// blue and violet to black at the top, warming toward the sun at golden hour and going to blue and indigo at
// twilight (with the Belt of Venus over the earth's shadow opposite the sun) and navy at night.
vec3 ramp7(float z, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4, vec3 c5, vec3 c6) {
  vec3 c = mix(c0, c1, smoothstep(0.0, 3.0, z));
  c = mix(c, c2, smoothstep(3.0, 7.0, z));
  c = mix(c, c3, smoothstep(7.0, 10.0, z));
  c = mix(c, c4, smoothstep(10.0, 13.0, z));
  c = mix(c, c5, smoothstep(13.0, 15.2, z));
  return mix(c, c6, smoothstep(15.2, 17.6, z));
}
vec3 atmosphereRamp(vec3 rd, float z) {
  float el = degrees(asin(clamp(u_sunDir.z, -1.0, 1.0)));
  float wd = smoothstep(3.0, 14.0, el);
  float wg = smoothstep(-3.0, 2.0, el) * (1.0 - wd);
  float wt = smoothstep(-11.0, -3.0, el) * (1.0 - smoothstep(-3.0, 2.0, el));
  float wn = max(0.0, 1.0 - wd - wg - wt);
  vec3 day = ramp7(z, vec3(0.44, 0.62, 0.80), vec3(0.30, 0.53, 0.82), vec3(0.10, 0.31, 0.72), vec3(0.026, 0.12, 0.54),
                   vec3(0.021, 0.027, 0.27), vec3(0.02, 0.006, 0.12), vec3(0.0012, 0.0006, 0.003));
  vec3 gold = ramp7(z, vec3(0.78, 0.42, 0.22), vec3(0.62, 0.27, 0.28), vec3(0.28, 0.18, 0.47), vec3(0.09, 0.10, 0.45),
                    vec3(0.024, 0.022, 0.23), vec3(0.009, 0.004, 0.08), vec3(0.001, 0.0005, 0.003));
  vec3 twi = ramp7(z, vec3(0.13, 0.10, 0.21), vec3(0.11, 0.09, 0.24), vec3(0.06, 0.06, 0.20), vec3(0.03, 0.035, 0.14),
                   vec3(0.012, 0.012, 0.07), vec3(0.006, 0.004, 0.035), vec3(0.001, 0.0008, 0.004));
  vec3 nite = 0.32 * ramp7(z, vec3(0.013, 0.017, 0.032), vec3(0.010, 0.013, 0.028), vec3(0.008, 0.010, 0.024), vec3(0.006, 0.007, 0.018),
                    vec3(0.004, 0.004, 0.012), vec3(0.002, 0.002, 0.007), vec3(0.0005, 0.0005, 0.0018));
  nite *= 1.0 + 1.1 * u_moonIllum * smoothstep(-2.0, 15.0, degrees(asin(clamp(u_moonDir.z, -1.0, 1.0))));
  // toward the sun warmer and brighter, away cooler
  vec2 a = normalize(rd.xy + 1e-6), b = normalize(u_sunDir.xy + 1e-6);
  float toward = 0.5 + 0.5 * dot(a, b);
  vec3 side = mix(vec3(0.82, 0.92, 1.12), vec3(1.2, 1.02, 0.84), toward);
  gold *= side * mix(0.75, 1.25, toward);
  twi *= mix(vec3(0.9, 0.95, 1.1), vec3(1.25, 1.0, 0.9), toward);
  // Belt of Venus: a pink band over the bluish earth shadow, opposite a sun just below the horizon
  float belt = smoothstep(-6.0, -1.5, el) * (1.0 - smoothstep(-1.5, 3.0, el)) * (1.0 - toward);
  twi += vec3(0.16, 0.07, 0.10) * belt * smoothstep(1.0, 2.6, z) * (1.0 - smoothstep(3.6, 6.0, z));
  vec3 c = day * wd + gold * wg + twi * wt + nite * wn;
  // city glow on the haze at night
  c += vec3(0.030, 0.017, 0.008) * u_cityGlow * u_night * (1.0 - smoothstep(0.0, 4.0, z));
  return c;
}

vec3 skyColor(vec3 rd) {
  vec3 c = skyLUT(rd, u_sunDir);
  // moonlight: the same sky lit a few hundred thousand times dimmer, then airglow and city glow
  c += skyLUT(rd, u_moonDir) * 0.055 * u_moonIllum * u_night;
  float horizon = exp(-max(rd.z, 0.0) * 14.0);
  c += u_night * (vec3(0.0025, 0.0032, 0.0055) + vec3(0.030, 0.017, 0.008) * u_cityGlow * horizon);
  if (u_stylize > 0.0) {
    // the altitude this pixel sits at on the point's plane
    float zEq = u_refZ + u_refDist * max(rd.z, -0.01) / max(length(rd.xy), 1e-3);
    vec3 g = atmosphereRamp(rd, zEq);
    // the sun's aureole still shows through
    float cs = max(dot(rd, u_sunDir), 0.0);
    g += u_sunCol * (0.05 * pow(cs, 14.0) + 0.3 * pow(cs, 260.0));
    c = mix(c, g, u_stylize);
  }
  return c;
}

// sun and moon discs
vec3 discs(vec3 rd) {
  vec3 col = vec3(0.0);
  float cs = dot(rd, u_sunDir);
  float r = acos(clamp(cs, -1.0, 1.0)) / 0.00465;   // in solar radii
  if (r < 1.0) {
    float mu = sqrt(1.0 - r * r);
    vec3 limb = vec3(0.397, 0.503, 0.652);
    vec3 dark = 1.0 - (1.0 - limb) * (1.0 - pow(vec3(mu), vec3(0.65, 0.75, 0.85)));
    col += u_sunCol * 1600.0 * dark;
  }
  float cm = dot(rd, u_moonDir);
  float rm = acos(clamp(cm, -1.0, 1.0)) / 0.0045;
  if (rm < 1.0 && u_moonDir.z > -0.02) {
    // the moon as a sphere lit by the sun: phase and orientation come out right on their own
    vec3 m = u_moonDir;
    vec3 ex = normalize(cross(m, vec3(0.0, 0.0, 1.0) + 1e-4));
    vec3 ey = cross(ex, m);
    vec2 uv = vec2(dot(rd - m * cm, ex), dot(rd - m * cm, ey)) / 0.0045;
    float zz = sqrt(max(0.0, 1.0 - dot(uv, uv)));
    vec3 n = normalize(uv.x * ex + uv.y * ey - m * zz);
    float lit = max(dot(n, u_sunDir), 0.0);
    float maria = 0.75 + 0.25 * smoothstep(0.35, 0.65, fbm2(uv * 2.2 + 4.0, 4));
    float edge = smoothstep(1.0, 0.94, rm);
    col += u_moonCol * (lit * maria * 9.0 + 0.012) * edge;
  }
  // the moon's aureole in the air around it
  if (u_moonDir.z > -0.05) {
    float rr = max(rm - 1.0, 0.0);
    col += u_moonCol * u_moonIllum * u_night * (0.05 * exp(-rr / 2.5) + 0.012 * exp(-rr / 18.0) + 0.003 * exp(-rr / 70.0));
  }
  return col;
}

void main() {
  vec2 ndc = gl_FragCoord.xy / u_res * 2.0 - 1.0;
  vec3 rd = rayDir(ndc);
  vec3 ro = u_camPos;
  float tHit = -1.0;
  bool face = false;
  // side view: everything in front of the cut plane is removed; looking at the plane below the
  // ground shows the earth's cut face
  float tCut = 0.0;
  if (u_cut.w > 0.5) {
    float den = dot(rd.xy, u_cut.xy);
    if (den > 1e-6) {
      tCut = (u_cut.z - planeDist(ro.xy)) / den;
      vec3 pc = ro + rd * tCut;
      if (tCut > 0.0 && pc.z < terrainH(pc.xy, 4)) { tHit = tCut; face = true; }
    }
  }
  // terrain: only rays heading down far enough can reach it
  float maxH = 2.6;
  if (!face && (rd.z < 0.0 || ro.z < maxH)) {
    float t = rd.z < 0.0 ? max(tCut, (ro.z - maxH) / -rd.z) : tCut;
    float tEnd = min(u_far, rd.z < -1e-4 ? (ro.z + 1.0) / -rd.z : u_far);
    float prevD = 1.0, prevT = t;
    for (int i = 0; i < 96; i++) {
      if (t > tEnd) break;
      vec3 p = ro + rd * t;
      float d = p.z - terrainH(p.xy, 3);
      if (d < 0.0) {
        float a = prevT, b = t;
        for (int k = 0; k < 5; k++) { float m = 0.5 * (a + b); vec3 q = ro + rd * m; if (q.z - terrainH(q.xy, 3) < 0.0) b = m; else a = m; }
        tHit = 0.5 * (a + b);
        break;
      }
      prevD = d; prevT = t;
      t += max(d * 0.55, 0.004 + t * 0.0025);
    }
  }
  vec3 col;
  float depth;
  if (face) {
    vec3 p = ro + rd * tHit;
    float below = terrainH(p.xy, 4) - p.z;
    // soil over rock, with faint strata; a lit rim of ground along the top
    vec3 soil = vec3(0.060, 0.042, 0.030), rock = vec3(0.026, 0.022, 0.021);
    vec3 earth = mix(soil, rock, smoothstep(0.02, 0.35, below));
    float strata = 0.85 + 0.15 * sin((p.z + fbm2(p.xy * 0.4, 2) * 0.06) * 140.0);
    vec3 lit = lightColor(u_elev) * max(u_light.z, 0.0) * 0.35 + u_ambTop * 0.6 + u_ambBot * 0.5;
    col = earth * strata * lit;
    vec2 ll = lonlat(p.xy);
    vec3 grass = pow(texture(u_day, vec2((ll.x + 180.0) / 360.0, (90.0 - ll.y) / 180.0)).rgb, vec3(2.2));
    col = mix(col, grass * (lightColor(u_elev) * max(u_light.z, 0.0) + u_ambTop), smoothstep(0.012, 0.0, below));
    depth = tHit;
  } else if (tHit > 0.0) {
    vec3 p = ro + rd * tHit;
    float e = 0.02 + tHit * 0.0015;
    vec3 n = normalize(vec3(terrainH(p.xy - vec2(e, 0), 5) - terrainH(p.xy + vec2(e, 0), 5),
                            terrainH(p.xy - vec2(0, e), 5) - terrainH(p.xy + vec2(0, e), 5), 2.0 * e));
    vec2 ll = lonlat(p.xy);
    vec2 tuv = vec2((ll.x + 180.0) / 360.0, (90.0 - ll.y) / 180.0);
    vec3 alb = pow(texture(u_day, tuv).rgb, vec3(2.2));
    alb *= 0.75 + 0.5 * fbm2(p.xy * 1.7, 4);
    alb = mix(alb, vec3(0.8, 0.83, 0.87), u_snow * smoothstep(0.35, 0.75, n.z));
    float sh = texture(u_shadow, p.xy / u_shadowSpan + 0.5).r;
    vec3 Ls = lightColor(p.z + u_elev) * max(dot(n, u_light), 0.0) * sh;
    vec3 amb = mix(u_ambBot, u_ambTop, 0.5 + 0.5 * n.z) * 0.9;
    col = alb * (Ls + amb);
    // city lights at night
    // city lights at night: warm points scattered through the lit area, not a glowing sheet
    float lit = pow(texture(u_nightTex, tuv).r, 2.2);
    float pts = smoothstep(0.58, 0.82, fbm2(p.xy * 9.0, 3)) * (0.4 + 0.6 * smoothstep(0.3, 0.7, fbm2(p.xy * 1.3 + 7.0, 2)));
    col += vec3(1.0, 0.62, 0.32) * lit * (0.004 + 0.12 * pts) * u_night;
    depth = tHit;
  } else {
    col = skyColor(rd) + discs(rd);
    depth = u_far;
  }
  // aerial perspective: boundary-layer haze and air between the camera and the hit
  if (tHit > 0.0) {
    float f = 1.0 - exp(-hazeDepth(ro, rd, tHit));
    vec3 haze = skyColor(normalize(vec3(rd.xy, max(rd.z, 0.02))));
    col = mix(col, haze, f);
  }
  o = vec4(col, 1.0);
  oDepth = vec4(depth, 0.0, 0.0, 1.0);
}`;

// stars, drawn as points over the sky
export const STAR_VS = /* glsl */ `#version 300 es
in vec3 a_dir;   // equatorial unit vector
in vec2 a_mt;    // magnitude, colour temperature (K)
uniform mat4 u_vp;
uniform mat3 u_eq;   // equatorial -> local (x east, y north, z up) for this place and time
uniform vec3 u_camPos;
uniform float u_dpr;
uniform float u_vis;
out vec3 v_col;
out float v_a;
vec3 starColor(float t) {
  t = clamp(t, 2500.0, 25000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.293 * pow(t - 60.0, -0.1332), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.390 * log(t) - 0.6318, 0.0, 1.0) : clamp(1.1298 * pow(t - 60.0, -0.0755), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432 * log(t - 10.0) - 1.1962, 0.0, 1.0));
  return mix(vec3(1.0), c, 0.6);
}
void main() {
  vec3 d = u_eq * a_dir;
  gl_Position = u_vp * vec4(u_camPos + d * 3000.0, 1.0);
  gl_Position.z = gl_Position.w * 0.99999;   // on the far plane, never clipped by it
  float m = a_mt.x;
  // twinkle-free, but fainter stars drown in haze near the horizon
  float ext = exp(-0.25 / max(d.z + 0.03, 0.03));
  v_a = clamp(pow(10.0, -0.4 * (m - 2.0)) * 0.9 + 0.08, 0.05, 2.5) * u_vis * ext * step(0.0, d.z);
  v_col = starColor(a_mt.y);
  gl_PointSize = clamp(3.6 - 0.45 * m, 1.3, 4.5) * u_dpr;
}`;

export const STAR_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_depth;
uniform vec2 u_res;
uniform float u_far;
in vec3 v_col;
in float v_a;
out vec4 o;
void main() {
  if (texture(u_depth, gl_FragCoord.xy / u_res).r < u_far * 0.99) discard;
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(d, d) * 3.5) * v_a;
  o = vec4(v_col * a, 0.0);
}`;

// ------------------------------------------------------------------ volumetric clouds (low resolution, jittered)
export const CLOUD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
${COMMON}
${CLOUD}
uniform vec2 u_res;
uniform vec2 u_jitter;
uniform float u_frame;
uniform sampler2D u_sceneDepth;
uniform sampler2D u_shadow;
uniform float u_shadowSpan;
uniform vec2 u_bands[6];
uniform int u_nbands;
uniform int u_maxSteps;
uniform float u_far;
uniform vec3 u_cityCol;          // light from below at night (city lights on cloud bases)
uniform vec4 u_flash[2];         // lightning inside the cloud: xyz (km), w intensity
uniform vec3 u_flashCol;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oEx;

float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
float phase2(float c, float k) { return mix(hg(c, 0.82 * k), hg(c, -0.28 * k), 0.24) * 0.9 + 0.1 / (4.0 * PI); }

// optical depth toward the light, a few growing steps (their spacing jittered per pixel and frame, so the
// discrete steps can't print bands where they cross a layer's edge)
float gLJit = 0.5;
float lightTau(vec3 p) {
  float tau = 0.0, t = 0.0;
  float steps[6] = float[6](0.05, 0.12, 0.25, 0.5, 1.0, 2.2);
  float js = 0.7 + 0.6 * gLJit;
  for (int i = 0; i < 6; i++) {
    float dt = steps[i] * js;
    t += dt;
    vec3 q = p + u_light * (t - dt * (0.25 + 0.5 * gLJit));
    if (q.z > ZTOP) break;
    vec4 aux, water; float h;
    weather(q, aux, water);
    float d = cloudDensity(q, aux, water, i < 2 ? 0.0 : 1.0, h) + mammatusDensity(q);
    tau += (cloudSigma(d, water) + 1.5 * water.b + 12.0 * water.a) * dt;
  }
  return tau;
}

void main() {
  vec2 frag = gl_FragCoord.xy + u_jitter - 0.5;
  vec2 uv = frag / u_res;
  vec3 rd = rayDir(uv * 2.0 - 1.0);
  vec3 ro = u_camPos;
  float tScene = texture(u_sceneDepth, gl_FragCoord.xy / u_res).r;
  float tFar = min(tScene, u_far);
  float tNear = 0.0;
  if (u_cut.w > 0.5) {
    float den = dot(rd.xy, u_cut.xy);
    float num = u_cut.z - dot(ro.xy, u_cut.xy);
    if (abs(den) > 1e-5) {
      float tc = num / den;
      if (den > 0.0) tNear = max(tNear, tc); else tFar = min(tFar, tc);
      float ts = (u_slab.x - dot(ro.xy, u_cut.xy)) / den;
      if (den > 0.0) tFar = min(tFar, ts);
    }
    else if (num > 0.0) tFar = -1.0;
  }
  // the cloud box (and the edge values carried on toward the horizon)
  float M = BOX_HALF + 200.0;
  vec3 inv = 1.0 / (rd + vec3(1e-7));
  vec3 t0 = (vec3(-M, -M, 0.0) - ro) * inv, t1 = (vec3(M, M, ZTOP) - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  tNear = max(tNear, max(max(tmin.x, tmin.y), tmin.z));
  tFar = min(tFar, min(min(tmax.x, tmax.y), tmax.z));
  vec3 L = vec3(0.0);
  float T = 1.0, dAcc = 0.0, wAcc = 0.0, halo = 0.0, bow = 0.0;
  float cosT = dot(rd, u_light);
  float ph[4];
  ph[0] = phase2(cosT, 1.0); ph[1] = phase2(cosT, 0.5); ph[2] = phase2(cosT, 0.25); ph[3] = phase2(cosT, 0.08);
  float jit = ign(gl_FragCoord.xy, u_frame);
  gLJit = ign(gl_FragCoord.yx + 17.0, u_frame + 11.0);
  int budget = u_maxSteps;
  float t0m = tNear;          // steps grow with distance from where the march starts, not from the camera
  if (tFar > tNear) {
    for (int b = 0; b < 6; b++) {
      if (b >= u_nbands || budget <= 0 || T < 0.01) break;
      vec2 band = u_bands[b];
      float a, c;
      if (abs(rd.z) < 1e-5) { if (ro.z < band.x || ro.z > band.y) continue; a = tNear; c = tFar; }
      else { float ta = (band.x - ro.z) / rd.z, tb = (band.y - ro.z) / rd.z; a = max(tNear, min(ta, tb)); c = min(tFar, max(ta, tb)); }
      if (c <= a) continue;
      float len = c - a;
      // steps grow geometrically with distance from where the march starts (0.06 km + 1.2% of the
      // distance): near cloud gets fine steps however long the ray is, and when the step budget runs
      // short every step stretches by the same factor instead of the near ones going coarse
      float A = 0.06 / 0.012 + (a - t0m);
      float Nf = log((A + len) / A) / 0.012;
      int n = int(clamp(ceil(Nf), 3.0, float(budget)));
      budget -= n;
      float km = 0.012 * Nf / float(n);
      for (int i = 0; i < 200; i++) {
        if (i >= n || T < 0.01) break;
        float e0 = exp(km * float(i));
        float dt = A * e0 * (exp(km) - 1.0);
        float t = a + A * (e0 * exp(km * jit) - 1.0);
        vec3 p = ro + rd * t;
        gFoot = max(t * u_pixAngle, 0.01);
        vec4 aux, water; float h;
        weather(p, aux, water);
        float pd = planeDist(p.xy);
        float cutF = u_cut.w > 0.5 ? smoothstep(0.0, 2.0, pd - u_cut.z) * (1.0 - smoothstep(u_slab.x - u_slab.y, u_slab.x, pd)) : 1.0;
        float d = cloudDensity(p, aux, water, 0.0, h);
        float dm = mammatusDensity(p);
        float sc = cloudSigma(d, water) + dm * 16.0 * u_ext;
        // precipitation edges: the model's amounts fade over a 3 km cell, which would leave a shaft with
        // straight walls; noise in the (logarithmic) amount makes the curtains' edges ragged
        float pe = 1.0;
        if (water.b + water.a > 1e-4) {
          vec2 pw = windAt(p.z) * (u_time * 0.001);
          float rn = textureLod(u_noise, vec3((p.xy - pw) / 7.0, p.z / 9.0) + vec3(0.13, 0.57, 0.91), 0.0).r;
          pe = exp2(min((rn - 0.5) * 8.0, 0.7));
        }
        float sr = water.b * pe * 0.9 * (0.25 + 1.5 * precipStreak(p, 0.0));
        float ss = water.a * pe * 9.0 * (0.3 + 1.1 * precipStreak(p, 1.0));
        float se = (sc + sr + ss) * cutF;
        if (se < 1e-4) continue;
        gFoot = max(t * u_pixAngle, 0.01);
        float tau = min(lightTau(p), 80.0);
        vec3 Lc = lightColor(p.z + u_elev);
        // multiple scattering: octaves with weaker extinction and a flatter phase (light that has bounced
        // around inside the cloud), so shadowed sides stay luminous the way real cumulus do
        float sun = ph[0] * exp(-tau) + 0.6 * ph[1] * exp(-tau * 0.25) + 0.42 * ph[2] * exp(-tau * 0.07) + 0.3 * ph[3] * exp(-tau * 0.018);
        // deep inside thick cloud the light is fully diffused: a glow that brightens toward the sunlit top
        sun += 0.055 * (0.3 + 0.7 * h) * exp(-tau * 0.02) * (1.0 - 0.6 * sat(water.b));
        // the light march only looks a few km toward the light; under a towering storm the rest of the
        // column above still has to be crossed, so its base and shadowed flanks go dark and ominous
        float column = max(aux.a * ZTOP - p.z, 0.0) / max(u_light.z, 0.3);
        sun *= mix(1.0, exp(-max(column - 3.0, 0.0) * 0.16), smoothstep(6.0, 40.0, tau));
        float powder = 1.0 - 0.45 * exp(-se * 0.3);
        float hh = dm > d ? 0.12 : max(h, sat(p.z / 3.0) * step(d, 0.0));
        vec3 amb = mix(u_ambBot, u_ambTop, smoothstep(0.0, 1.0, hh)) * (0.6 + 0.4 * hh);
        // under and inside a deep, wide cloud the sky dome is hidden by the cloud itself
        float above = max(aux.a * ZTOP - max(p.z, aux.b * ZTOP), 0.0);
        amb *= 1.0 - 0.85 * smoothstep(0.2, 0.8, aux.r) * (1.0 - exp(-above * 0.35));
        amb += u_cityCol * exp(-max(p.z - aux.b * ZTOP, 0.0) * 2.2) * (1.0 - hh);
        // lightning: a point of light deep in the cloud, diffused by the droplets around it, so the flash
        // blooms through the cloud's own structure
        float fl = 0.0;
        for (int k = 0; k < 2; k++) {
          if (u_flash[k].w < 0.001) continue;
          float fd = length(p - u_flash[k].xyz);
          fl += u_flash[k].w * exp(-fd * 0.12) / (1.0 + fd * fd * 0.012);
        }
        vec3 S = (sc * 0.995 + sr * 0.55 + ss * 0.85) * cutF * (Lc * sun * powder * 10.0 + amb * 0.62 + u_flashCol * fl * 0.1);
        float Tr = exp(-se * dt);
        L += T * (S - S * Tr) / se;
        // what the halo and the rainbow need: thin, sunlit ice and rain on this ray
        float sunT = exp(-tau);
        halo += T * cutF * cloudSigma(d, water) * dt * sat((water.g - 2.0 * water.r) * 40.0) * sunT;
        bow += T * sr * cutF * dt * sunT;
        float w = T * (1.0 - Tr);
        dAcc += t * w; wAcc += w;
        T *= Tr;
      }
    }
  }
  // aerial perspective over the clouds
  float dc = wAcc > 1e-4 ? dAcc / wAcc : u_far;
  o = vec4(L, T);
  oEx = vec4(dc, halo, bow, 1.0);
}`;

// ------------------------------------------------------------------ temporal accumulation
export const RESOLVE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_cur;
uniform sampler2D u_curEx;
uniform sampler2D u_hist;
uniform sampler2D u_histEx;
uniform mat4 u_invVP;
uniform mat4 u_prevVP;
uniform vec3 u_camPos;
uniform vec2 u_res;
uniform float u_alpha;
uniform float u_reset;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oEx;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec4 c = texture(u_cur, uv), ce = texture(u_curEx, uv);
  if (u_reset > 0.5) { o = c; oEx = ce; return; }
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 a = u_invVP * vec4(ndc, -1.0, 1.0), b = u_invVP * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize(b.xyz / b.w - a.xyz / a.w);
  vec3 p = u_camPos + rd * min(ce.r, 400.0);
  vec4 pc = u_prevVP * vec4(p, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float alpha = u_alpha;
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0))) || pc.w <= 0.0) alpha = 1.0;
  vec4 h = texture(u_hist, puv), he = texture(u_histEx, puv);
  // keep the history within what the neighbourhood allows, so moving cloud edges don't smear
  vec4 mn = c, mx = c;
  vec2 px = 1.0 / u_res;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 s = texture(u_cur, uv + vec2(x, y) * px);
    mn = min(mn, s); mx = max(mx, s);
  }
  vec4 ext = (mx - mn) * 0.6 + vec4(0.02);
  h = clamp(h, mn - ext, mx + ext);
  o = mix(h, c, alpha);
  oEx = vec4(mix(he.r, ce.r, max(alpha, 0.3)), mix(he.gb, ce.gb, alpha), 1.0);
}`;

// ------------------------------------------------------------------ final image
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
${COMMON}
uniform vec2 u_res;
uniform vec2 u_cloudRes;
uniform sampler2D u_bg;
uniform sampler2D u_bgDepth;
uniform sampler2D u_cloud;
uniform sampler2D u_cloudEx;
uniform sampler2D u_shadow;
uniform float u_shadowSpan;
uniform vec3 u_sunDir;
uniform vec3 u_sunCol;
uniform vec3 u_moonDir;
uniform vec3 u_moonCol;
uniform float u_exposure;
uniform float u_frame;
uniform vec4 u_flash[2];       // xyz position (km), w intensity
uniform vec3 u_flashCol;
uniform float u_rays;          // crepuscular ray strength
uniform float u_far;
out vec4 o;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// a ring of light at radius r0 (deg) with width w, coloured by wavelength
vec3 ring(float ang, vec3 r0, float w) {
  vec3 d = (vec3(ang) - r0) / w;
  return exp(-d * d);
}

// clouds upsampled with a little smarts: 4 taps weighted by depth agreement
vec4 cloudAt(vec2 uv, out vec4 ex) {
  vec4 c = texture(u_cloud, uv);
  ex = texture(u_cloudEx, uv);
  return c;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 rd = rayDir(uv * 2.0 - 1.0);
  vec3 bg = texture(u_bg, uv).rgb;
  float sceneT = texture(u_bgDepth, uv).r;
  vec4 ex;
  vec4 cl = cloudAt(uv, ex);
  float T = cl.a;
  // distant cloud fades into the haze like the ground does
  vec3 hazeCol = sceneT >= u_far * 0.99 ? bg : u_ambTop * 1.25 + lightColor(1.0) * 0.06;
  float fh = 1.0 - exp(-hazeDepth(u_camPos, rd, min(ex.r, u_far)));
  vec3 col = bg * T + mix(cl.rgb, hazeCol * (1.0 - T), fh);

  // light shafts through gaps in the cloud: sunlit haze along the ray below the cloud base
  if (u_rays > 0.001) {
    float tEnd = min(min(sceneT, ex.r), 90.0);
    float cs = dot(rd, u_light);
    float mie = 0.0716 * (1.0 - 0.76 * 0.76) / pow(1.0 + 0.5776 - 1.52 * cs, 1.5) + 0.06;
    float acc = 0.0, wsum = 0.0;
    float j = ign(gl_FragCoord.xy, u_frame);
    for (int i = 0; i < 14; i++) {
      float t = tEnd * (float(i) + j) / 14.0;
      vec3 p = u_camPos + rd * t;
      if (p.z > 6.0) break;
      // trace down the sun's direction to the ground and read the shadow there
      vec2 g = p.xy - u_light.xy / max(u_light.z, 0.05) * p.z;
      float sh = texture(u_shadow, g / u_shadowSpan + 0.5).r;
      float dens = exp(-max(p.z + u_elev, 0.0) / 1.4);
      acc += sh * dens; wsum += dens;
    }
    float lit = wsum > 0.0 ? acc / wsum : 1.0;
    float amount = (1.0 - exp(-tEnd * 0.03)) * u_rays;
    col += lightColor(1.0) * mie * (lit - 0.6) * amount * T * 0.35;
  }

  // 22-degree halo and sun dogs in thin ice cloud, primary and secondary rainbows in sunlit rain
  float halo = min(ex.g, 1.5);
  if (halo > 0.003) {
    vec3 hl = u_light;
    float ang = degrees(acos(clamp(dot(rd, hl), -1.0, 1.0)));
    vec3 h = ring(ang, vec3(21.65, 22.0, 22.4), 0.55) * vec3(1.0, 0.92, 0.82);
    float inner = smoothstep(21.0, 17.0, ang) * 0.12;
    // parhelia at the halo's distance either side, at the light's elevation
    float el = asin(clamp(hl.z, -1.0, 1.0)), re = asin(clamp(rd.z, -1.0, 1.0));
    float daz = acos(clamp(dot(normalize(rd.xy + 1e-6), normalize(hl.xy + 1e-6)), -1.0, 1.0));
    float dogAz = radians(22.0) / max(cos(el), 0.3);
    float dE = degrees(re - el), dA = degrees(daz - dogAz);
    vec3 dogs = exp(-vec3(dA - 0.35, dA, dA + 0.35) * vec3(dA - 0.35, dA, dA + 0.35) / 0.35 - dE * dE / 1.2) * smoothstep(45.0, 20.0, degrees(el)) * 1.6;
    col += lightColor(10.0) * (h + dogs - inner) * halo * 1.6;
  }
  float bow = min(ex.b, 1.0);
  if (bow > 0.002 && u_light.z > -0.02) {
    float ang = degrees(acos(clamp(dot(rd, -u_light), -1.0, 1.0)));
    vec3 p1 = ring(ang, vec3(42.3, 41.6, 40.7), 0.7);
    vec3 p2 = ring(ang, vec3(50.6, 51.6, 53.0), 1.1) * 0.42;
    float alex = smoothstep(42.6, 43.5, ang) * (1.0 - smoothstep(49.5, 50.4, ang));
    col += lightColor(1.0) * ((p1 + p2) * 0.55 - alex * 0.06) * bow;
  }

  // lightning lights the cloud around it
  for (int i = 0; i < 2; i++) {
    vec4 f = u_flash[i];
    if (f.w < 0.001) continue;
    // (the cloud itself is lit in the cloud pass) the ray passing close by, through air and rain, and the
    // whole sky brightening a touch
    vec3 toF = f.xyz - u_camPos;
    float tc = max(dot(toF, rd), 0.0);
    float miss = length(toF - rd * tc);
    float air = (exp(-miss * miss / 4.0) * 0.010 + exp(-miss / 6.0) * 0.0015) * T;
    col += u_flashCol * f.w * air;
  }

  col *= u_exposure;
  col = aces(col);
  col = pow(col, vec3(1.0 / 2.2));
  // dither (triangular, one 8-bit step): no banding in the long smooth gradients
  float n1 = ign(gl_FragCoord.xy, u_frame), n2 = ign(gl_FragCoord.xy + 37.0, u_frame + 3.0);
  col += (n1 + n2 - 1.0) / 255.0;
  o = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ lightning bolts
export const BOLT_VS = /* glsl */ `#version 300 es
in vec3 a_a;
in vec3 a_b;
in vec2 a_corner;    // x along 0..1, y side -1..1
in float a_w;        // width scale
uniform mat4 u_vp;
uniform vec2 u_res;
uniform float u_width;
out vec2 v_q;
out float v_w;
void main() {
  vec4 ca = u_vp * vec4(a_a, 1.0), cb = u_vp * vec4(a_b, 1.0);
  vec2 sa = ca.xy / ca.w * u_res * 0.5, sb = cb.xy / cb.w * u_res * 0.5;
  vec2 dir = normalize(sb - sa + 1e-5);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = u_width * a_w;
  vec4 c = mix(ca, cb, a_corner.x);
  vec2 off = nrm * a_corner.y * w + dir * (a_corner.x * 2.0 - 1.0) * w * 0.5;
  c.xy += off / (u_res * 0.5) * c.w;
  gl_Position = c;
  v_q = vec2(a_corner.y, 0.0);
  v_w = a_w;
}`;

export const BOLT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_col;
uniform float u_i;
in vec2 v_q;
in float v_w;
out vec4 o;
void main() {
  float d = abs(v_q.x);
  float core = smoothstep(0.22, 0.0, d);
  float glow = exp(-d * d * 7.0) * 0.5;
  vec3 c = mix(u_col, vec3(1.0), core) * (core + glow) * u_i;
  o = vec4(c, 0.0);
}`;
