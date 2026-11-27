// GLSL for the Sky view. Units: kilometres, x east, y north, z up, origin on the ground at the point.
//
// How a frame is made (render.js runs the passes):
//   bake      the two model hours being shown are blended (each carried along its own wind), warped off the
//             model's 3 km grid and written into two volumes the size of the model box: the weather
//   light     optical depth toward the sun, straight up and straight down, swept through that weather a
//             slice at a time: the light volume, so a cloud sample is lit by one lookup instead of a march
//   shadow    what the clouds leave of the sun on the ground near the point, at cloudlet scale
//   sky       transmittance, multiple scattering and sky-view lookups of a physical atmosphere
//   bg        sky, sun, moon, the Milky Way and the real terrain, at full resolution
//   clouds    ray-marched through the weather with a quarter of the pixels each frame ...
//   resolve   ... and rebuilt to full size from the last frames, following the camera and the wind
//   composite haze, light shafts, halos, rainbows, lightning, glare, tone mapping, dither

export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// ------------------------------------------------------------------ tileable noise volumes
export const NOISE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform float u_slice;     // 0..1 z of this slice
uniform float u_size;
uniform int u_kind;        // 0 = shape (perlin-worley, worley octaves), 1 = detail (worley octaves, perlin)
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
float pfbm(vec3 uvw, float fr, int oct) {
  float s = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += perlin(uvw * fr, fr) * amp; norm += amp; amp *= 0.5; fr *= 2.0; }
  return clamp(s / norm * 0.9 + 0.5, 0.0, 1.0);
}
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

void main() {
  vec3 uvw = vec3(gl_FragCoord.xy / u_size, u_slice);
  if (u_kind == 0) {
    float pf = pfbm(uvw, 4.0, 6);
    float w1 = worley(uvw * 4.0, 4.0), w2 = worley(uvw * 8.0, 8.0), w3 = worley(uvw * 16.0, 16.0), w4 = worley(uvw * 32.0, 32.0);
    float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    float pw = clamp(remap(pf, 0.0, 1.0, wf, 1.0), 0.0, 1.0);
    o = vec4(pw, w2 * 0.625 + w3 * 0.25 + w4 * 0.125, w3, w1);
  } else {
    float a = worley(uvw * 4.0, 4.0), b = worley(uvw * 8.0, 8.0), c = worley(uvw * 16.0, 16.0), d = worley(uvw * 32.0, 32.0);
    o = vec4(a * 0.625 + b * 0.25 + c * 0.125, b * 0.625 + c * 0.25 + d * 0.125, pfbm(uvw, 8.0, 3), a);
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
uniform sampler2D u_amb;     // 2x1: mean radiance of the sky dome, and of the sky near the horizon
uniform float u_elev;        // ground height at the point, km above sea level
uniform vec2 u_lat0;         // latitude, longitude of the point (deg)
uniform float u_hazeK;       // how hazy the air is (the side view keeps distant ridges readable)
uniform float u_hazeLow;     // ... and its lowest kilometre or two in particular: damp air is hazy, dry air clear
uniform vec4 u_cut;          // side view: xy horizontal forward, z cut distance (in front of the point), w on
uniform vec2 u_slab;         // side view: clouds end this far behind the point (x), fading over y
float planeDist(vec2 xy) { return dot(xy, u_cut.xy); }
vec3 boxUVW(vec3 p) { return vec3(p.xy / BOX + 0.5, p.z / ZTOP); }

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 rayDir(vec2 ndc) {
  vec4 a = u_invVP * vec4(ndc, -1.0, 1.0), b = u_invVP * vec4(ndc, 1.0, 1.0);
  return normalize(b.xyz / b.w - a.xyz / a.w);
}
// sunlight (or moonlight) reaching height z above the point's ground, as irradiance: the noon sun is 1
vec3 lightColor(float z) { return texture(u_sunLUT, vec2(clamp(z / 20.0, 0.0, 1.0), 0.5)).rgb * u_lightI; }
vec3 skyDome() { return texelFetch(u_amb, ivec2(0, 0), 0).rgb; }
vec3 skyRim() { return texelFetch(u_amb, ivec2(1, 0), 0).rgb; }
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
  return (0.011 * airDepth(ro, rd, t, 8.0) + 0.075 * u_hazeLow * airDepth(ro, rd, t, 1.3)) * u_hazeK;
}
`;

// blue noise, moved along a low-discrepancy sequence each frame: the cleanest few-frame average there is
const BLUE = /* glsl */ `
uniform sampler2D u_blue;
uniform float u_frame;
float blue(vec2 frag, float k) {
  float b = texelFetch(u_blue, ivec2(mod(frag + k * vec2(17.0, 43.0), 64.0)), 0).r;
  return fract(b + (u_frame + k * 7.0) * 0.61803399);
}
`;

// The ground: three nested height grids around the point, finest in the middle (terrain.js), in km relative
// to the ground at the point. r = height, g = the highest ground around the texel; the mips hold the mean
// and the maximum, so a ray can step over whole blocks of country that lie below it.
const DEM = /* glsl */ `
uniform highp sampler2DArray u_dem;
uniform vec3 u_demHalf;      // half-width of each grid, km
uniform vec4 u_demInfo;      // texels per side, mip levels, relief (0 flat .. 1 full), earth curvature 1/(2R) per km
uniform vec3 u_demRange;     // lowest and highest ground, and the level plain beyond the outer grid (km)
uniform float u_demSea;      // sea level in the grids' heights (km; far below everything when not known)
uniform int u_demSteps;
// the skyline the last traced ray slipped just over on its way to the sky: where, and how much of the
// pixel it covers
float gEdgeT = -1.0, gEdgeCov = 0.0;

// which grid draws the ground here: the finest one that reaches (each ends half a texel short of its
// edge, where its rim has already become the next grid)
int demLayer(vec2 xy) {
  float m = max(abs(xy.x), abs(xy.y));
  vec3 lim = u_demHalf * (1.0 - 1.0 / u_demInfo.x);
  return m < lim.x ? 0 : (m < lim.y ? 1 : 2);
}
// ground height at xy averaged over a footprint (km); the earth's curve drops distant ground away
float demH(vec2 xy, float foot) {
  int k = demLayer(xy);
  float hw = u_demHalf[k];
  float lod = clamp(log2(max(foot * u_demInfo.x / (2.0 * hw), 1.0)), 0.0, u_demInfo.y - 1.0);
  return textureLod(u_dem, vec3(xy / (2.0 * hw) + 0.5, float(k)), lod).r * u_demInfo.z - u_demInfo.w * dot(xy, xy);
}
float demH(vec2 xy) { return demH(xy, 0.0); }

// Where a ray first meets the ground between t0 and t1 (-1.0 if it doesn't). A walk down the pyramid of
// maxima: a block the ray clears is crossed in one step, a block it might touch is opened into its four
// children, and in the finest cells (or cells smaller than a pixel) the surface itself is tested.
// When the ray reaches the sky, the crest it cleared most narrowly is left in gEdgeT / gEdgeCov (if that
// was by less than a pixel), so the skyline can be drawn smooth.
float demTrace(vec3 ro, vec3 rd, float t0, float t1, float pix) {
  gEdgeT = -1.0; gEdgeCov = 0.0;
  float nearC = 1e9, nearT = 0.0;      // the closest pass so far, in pixels, and where
  float S = u_demInfo.x, relief = u_demInfo.z, curve = u_demInfo.w;
  // nothing stands above the highest ground
  float zTop = max(u_demRange.y * relief, 0.0) + 0.02;
  if (ro.z > zTop) {
    if (rd.z > -1e-6) return -1.0;
    t0 = max(t0, (ro.z - zTop) / -rd.z);
  } else if (rd.z > 1e-6) t1 = min(t1, (zTop - ro.z) / rd.z);
  if (t1 <= t0) return -1.0;
  vec2 rdx = mix(rd.xy, vec2(1e-7), lessThan(abs(rd.xy), vec2(1e-7)));
  vec2 inv = 1.0 / rdx;
  // the stretch of the ray over the outer grid
  float H = u_demHalf.z;
  vec2 ta = (-H - ro.xy) * inv, tb = (H - ro.xy) * inv;
  float tIn = max(min(ta.x, tb.x), min(ta.y, tb.y)), tOut = min(max(ta.x, tb.x), max(ta.y, tb.y));
  float tA = max(t0, tIn), tB = min(t1, tOut);
  bool spent = false;
  if (tB > tA) {
    vec3 o = ro + rd * tA;        // distances are measured from here, so they stay small and exact
    float len = tB - tA, s = 0.0;
    // start with blocks of 8 x 8 texels (most rays begin near the ground, or dive at it) and climb to
    // bigger blocks, up to 4 x 4 to a grid, while the way is clear
    int top = int(u_demInfo.y) - 3, lod = min(3, top);
    float fLast = 0.0;                              // height above the ground where the last cell was left ...
    bool chained = false;                           // ... when this cell follows straight on from it
    spent = true;
    for (int i = 0; i < 256; i++) {
      if (i >= u_demSteps) break;
      if (s >= len) { spent = false; break; }
      vec3 p = o + rd * s;
      int k = demLayer(p.xy);
      float hw = u_demHalf[k];
      float n = float(int(S) >> lod);
      float cw = 2.0 * hw / n;
      // the cell the ray is in or just entering: a ray running along a cell wall (every ray leaving the point
      // due north, east, south or west does) must not flicker between the two sides of it
      vec2 cell = clamp(floor((p.xy + hw) / cw + 2e-4 * sign(rdx)), 0.0, n - 1.0);
      vec2 lo = cell * cw - hw, hi = lo + cw;
      // an inner grid stops where demLayer says it does, so a block never reaches past that
      if (k < 2) { float lim = hw * (1.0 - 1.0 / S); lo = max(lo, vec2(-lim)); hi = min(hi, vec2(lim)); }
      // where the ray leaves this cell
      vec2 tw = (mix(lo, hi, step(0.0, rdx)) - p.xy) * inv;
      float e = min(s + max(min(tw.x, tw.y), 0.0), len);
      // ... and whether that wall is also a wall of the parent block (worth trying the bigger block again)
      float ci = tw.x < tw.y ? cell.x : cell.y, cd = tw.x < tw.y ? rdx.x : rdx.y;
      bool outOfParent = mod(ci, 2.0) == (cd > 0.0 ? 1.0 : 0.0);
      float eps = max(cw * 2e-3, (tA + s) * 1e-6);
      // the highest the ground gets in the cell (the curve drops it at least as much as at its nearest corner)
      vec2 q = clamp(vec2(0.0), lo, hi);
      vec2 hg = texelFetch(u_dem, ivec3(ivec2(cell), k), lod).rg * relief - curve * dot(q, q);
      float zLow = min(p.z, o.z + rd.z * e);
      if (zLow > hg.y + 0.003) {
        s = e + eps;
        if (outOfParent) lod = min(lod + 1, top);
        chained = false;
        continue;
      }
      float foot = lod > 0 && cw < pix * (tA + s) ? cw : 0.0;
      if (lod > 0 && foot == 0.0) { lod--; chained = false; continue; }
      float f0 = chained ? fLast : p.z - demH(p.xy, foot);
      if (f0 < 0.0) return tA + s;
      // Inside a cell the surface is four bilinear pieces that meet along the cell's centre lines, and its
      // texel is the height at the very centre. A ray that stays above that height need only be tested where
      // it leaves; one that dips below it is tested where it crosses the centre lines too, so a crest a
      // single texel wide can't be stepped over.
      vec2 um = zLow < hg.x + 0.003 ? clamp(((cell + 0.5) * cw - hw - p.xy) * inv, 0.0, e - s) : vec2(e - s);
      float a = s, fa = f0;
      for (int j = 0; j < 3; j++) {
        float b = j == 0 ? s + min(um.x, um.y) : (j == 1 ? s + max(um.x, um.y) : e);
        if (b - a < eps * 0.25) continue;
        vec3 pb = o + rd * b;
        float fb = pb.z - demH(pb.xy, foot);
        if (fb < 0.0) {
          // the crossing lies between a (above ground) and b (below): halve the gap a few times, then one
          // straight-line step between the two heights lands on it (exactly, where the ground is flat)
          for (int m = 0; m < 3; m++) {
            float h = 0.5 * (a + b);
            vec3 ph = o + rd * h;
            float fh = ph.z - demH(ph.xy, foot);
            if (fh < 0.0) { b = h; fb = fh; } else { a = h; fa = fh; }
          }
          return tA + a + (b - a) * fa / max(fa - fb, 1e-9);
        }
        // how narrowly the ray clears the ground here, in pixels
        float c = fb / (pix * (tA + b) + 1e-6);
        if (c < nearC) { nearC = c; nearT = tA + b; }
        a = b; fa = fb;
      }
      s = e + eps;
      fLast = fa; chained = foot == 0.0;      // (cells standing in for several texels are read at their own level)
      if (outOfParent && lod < top) { lod++; chained = false; }
    }
    // Out of steps: a ray skimming rough country for kilometres. If it is within a few pixels of the ground,
    // that is the ground; otherwise the rest of the way is walked in plain strides of 3 % of the distance
    // over ground smoothed to match, so the hill it was heading for still stops it.
    if (spent) {
      float t = tA + min(s, len);
      vec3 p = ro + rd * t;
      if (p.z - demH(p.xy) < max(0.01, 4.0 * pix * t)) return t;
      for (int j = 0; j < 48; j++) {
        float tn = min(t * 1.03 + 0.02, tA + len);
        vec3 pn = ro + rd * tn;
        if (pn.z < demH(pn.xy, (tn - t) * 0.5)) {
          float a = t, b = tn;
          for (int m = 0; m < 5; m++) { float h = 0.5 * (a + b); vec3 ph = ro + rd * h; if (ph.z < demH(ph.xy, (tn - t) * 0.25)) b = h; else a = h; }
          return 0.5 * (a + b);
        }
        if (tn >= tA + len) break;
        t = tn;
      }
    }
  }
  // past the outer grid the country is a level plain (curving away with the earth)
  float tS = tB > tA ? tOut : t0;
  float b0 = u_demRange.z * relief;
  float A = curve * dot(rd.xy, rd.xy), B = rd.z + 2.0 * curve * dot(ro.xy, rd.xy), C = ro.z - b0 + curve * dot(ro.xy, ro.xy);
  float tp = -1.0;
  if (A < 1e-9) { if (B < -1e-7) tp = -C / B; }
  else { float disc = B * B - 4.0 * A * C; if (disc >= 0.0) tp = (-B - sqrt(disc)) / (2.0 * A); }
  if (tp > tS && tp < t1) return tp;
  // the ray reached the sky: the crest it cleared by less than a pixel shares that pixel with the sky
  if (nearC < 1.0) { gEdgeCov = 1.0 - nearC; gEdgeT = nearT; }
  return -1.0;
}

// How much of the sun the ground itself leaves: ridges throw long soft shadows when the light is low.
float demSunlit(vec3 p, vec3 n, vec3 L, float foot) {
  float low = 1.0 - smoothstep(0.35, 0.62, L.z);
  if (low <= 0.0 || L.z <= 0.0) return 1.0;
  float zTop = u_demRange.y * u_demInfo.z;
  float lit = 1.0, t = max(foot * 2.0, 0.06);
  vec3 o = p + n * max(foot, 0.01);
  for (int i = 0; i < 9; i++) {
    vec3 q = o + L * t;
    if (q.z > zTop) break;                    // nothing left that could stand in the light
    float d = q.z - demH(q.xy, t * 0.2);
    lit = min(lit, 0.5 + 9.0 * d / t);
    if (lit <= 0.0) break;
    t *= 1.9;
  }
  return mix(1.0, smoothstep(0.0, 1.0, lit), low);
}
`;

// ------------------------------------------------------------------ the weather and the clouds in it
//
// Weather = two volumes over the model box, baked once per change (BAKE_FS):
//   w1: coverage, precipitation (log), layer base / ZTOP, layer top / ZTOP
//   w2: cloud water (log; ice counted at its lower opacity), ice share, convectiveness, snow share
//
// The shape of the clouds comes from noise at three fixed scales (macro 12.8 km, meso 3.2 km and detail
// 0.8 km tiles: lobes of a few km, cloudlets of half a km, turrets and wisps of 50-200 m). Fixed scales,
// and one drift per layer, mean the pattern is only ever slid, never stretched: it cannot smear with time
// or shear a tower apart. Far away, where cloudlets are smaller than a pixel, the noise's mips average them
// out and the variation they lost is put back as an integral (three points of a normal distribution), so a
// distant cumulus field keeps exactly its mean opacity instead of vanishing or turning solid.
const CLOUD = /* glsl */ `
uniform highp sampler3D u_w1;
uniform highp sampler3D u_w2;
uniform highp sampler3D u_noise;
uniform highp sampler3D u_detail;
uniform sampler2D u_anvil;     // 40x40: anvil base / ZTOP, mammatus strength
uniform float u_rise;          // km the shape noise has scrolled upward: clouds billow and evolve in place
uniform float u_evo;           // ... and the detail, faster
uniform float u_fall;          // km rain has fallen
uniform float u_mammatus;
uniform float u_ext;           // extinction scale
#define T_MACRO 12.8
#define T_MESO 3.2
#define T_DET 0.8
const mat2 ROT_B = mat2(0.8508, 0.5255, -0.5255, 0.8508), ROT_C = mat2(0.7986, -0.6018, 0.6018, 0.7986);
vec4 gDrift = vec4(0.0);       // the layer's drift: xy offset (km), z distance run along its wind
vec2 gDir = vec2(1.0, 0.0);    // ... and that wind's direction (cirrus is combed along it)
float gFoot = 0.05;            // km across a pixel (or a voxel) at the sample
float gFill = 0.0;             // set by cloudDensity: the share of that footprint with any cloud in it
float gHeap = 0.0, gCir = 0.0, gCell = 0.0;     // ... and how much of a heap, how fibrous, how cellular the cloud there is

float wcDecode(float c) { return c > 0.002 ? exp2(((c * 255.0 - 1.0) * (4.5 / 253.0) - 4.0) * 3.3219281) : 0.0; }

// Weather at p. Beyond the model box there is no data: the box's own weather is carried on, mirrored at each
// edge (so cloud fields continue as fields toward the horizon, not as streaks drawn out from the edge) and
// thinning with distance.
vec2 mirrorUV(vec2 u) { return 1.0 - abs(mod(u, 2.0) - 1.0); }
vec4 weather1(vec3 p, out vec3 uvw, out float fade) {
  vec2 e = abs(p.xy) - BOX_HALF;
  float o = max(e.x, e.y);
  fade = o > 0.0 ? (1.0 - 0.45 * smoothstep(0.0, 80.0, o)) * (1.0 - smoothstep(150.0, 200.0, o)) : 1.0;
  uvw = vec3(mirrorUV(p.xy / BOX + 0.5), p.z / ZTOP);
  return texture(u_w1, uvw);
}

float lodOf(float tile) { return clamp(log2(gFoot * 128.0 / tile), 0.0, 7.0); }
// the integral of clamp(u, 0, 1)
float rampInt(float u) { float c = clamp(u, 0.0, 1.0); return 0.5 * c * c + max(u - 1.0, 0.0); }
// The noise volumes' values, stretched to fill 0..1 about evenly (measured: the raw channels sit in narrow
// ranges), so that "cover 0.4" really leaves about 40 % of the sky in cloud.
float shapeOf(vec4 n) { return sat(((n.r + 1.0 - n.g) / (2.0 - n.g) - 0.715) / 0.215); }      // billows eroded by cells
vec3 cellsOf(vec4 n) { return clamp((n.gba - vec3(0.21, 0.08, 0.13)) / vec3(0.535, 0.79, 0.74), 0.0, 1.0); }

// Cloud density 0..1 at p for coverage cov (already faded and cut), in the layer described by w1, w2.
//   fine = 1: erode the edge with the detail noise (the primary march, close up); 0: light rays and volumes.
//   h returns the height within the layer (0 base .. 1 top).
float cloudDensity(vec3 p, float cov, vec4 w1, vec4 w2, float fine, out float h) {
  h = 0.0;
  gFill = 0.0;
  if (cov < 0.01) return 0.0;
  float iceF = w2.g, cum = w2.b;
  float base = w1.b * ZTOP, top = max(w1.a * ZTOP, base + 0.12), thick = top - base;
  // what kind of cloud: fibrous ice, heaps, or a sheet (smooth, or broken into cells)
  float cir = smoothstep(0.4, 0.75, iceF) * (1.0 - smoothstep(0.3, 0.6, cum));
  float heap = smoothstep(0.52, 0.8, cum);
  float cell = smoothstep(0.12, 0.5, cum) * (1.0 - heap);
  float deep = sat((thick - 1.0) / 3.0);
  float vary = heap * (1.0 - deep);
  gHeap = heap; gCir = cir; gCell = cell;
  if (p.z < base - 0.12 || p.z > top + 0.2 + 0.3 * thick * vary) return 0.0;
  vec3 q = vec3(p.xy - gDrift.xy, p.z - u_rise);
  float lodA = lodOf(T_MACRO), lodB = lodOf(T_MESO);
  // (two readings of the large noise, at different sizes and angles: either alone would repeat every dozen
  // kilometres, which from above or toward the horizon shows as rows)
  vec4 A = textureLod(u_noise, q / T_MACRO, lodA);
  vec4 A2 = textureLod(u_noise, vec3(ROT_C * q.xy, q.z) / 19.7 + vec3(0.41, 0.77, 0.23), max(lodA - 0.6, 0.0));
  float sA = sat((shapeOf(A) * 0.55 + shapeOf(A2) * 0.45 - 0.55) * 1.35 + 0.55);
  vec3 cA = cellsOf(A);
  // Fair-weather heaps share a base (the condensation level) but not a top: each grows as far as its own
  // thermal carries it.
  vec3 cA2 = cellsOf(A2);
  if (vary > 0.0) {
    thick *= mix(1.0, 0.45 + 0.85 * cA2.z, vary);
    top = base + thick;
  }
  // a sheet's top and base are not planes either: they swell and sag gently over a few kilometres
  if (heap < 1.0) {
    float amp = min(0.3 * thick, 0.2) * (1.0 - heap);
    base += (cA.z - 0.5) * amp * 0.7;
    top += (sA - 0.5) * amp * 1.5;
    thick = max(top - base, 0.08);
  }
  if (p.z < base - 0.02 || p.z > top + 0.02) return 0.0;
  h = sat((p.z - base) / thick);

  // meso scale: cloudlets, cells and turrets ... or cirrus fibres, long along the layer's wind and hooked
  // where the crystals fall into slower air
  vec4 B = vec4(0.5);
  float sB = 0.5, fib = 0.0;
  if (cir < 0.999) {
    // (read at an angle to the larger noise, and for cells mixed with a second reading at another size and
    // angle: a small tile repeated across a whole sky would otherwise show as rows and lanes ...
    // ... and pushed about by the larger noise, differently in every part of the sky)
    B = textureLod(u_noise, vec3(ROT_B * q.xy + (vec2(cA.z, cA2.z) - 0.5) * 1.4, q.z) / T_MESO + vec3(0.37, 0.11, 0.73), lodB);
    sB = shapeOf(B);
  }
  if (cir > 0.001) {
    vec2 r = vec2(dot(p.xy, gDir), dot(p.xy, vec2(-gDir.y, gDir.x)));
    // ice falls out of the layer into slower air: the streaks trail back below
    r.x += (top - p.z) * 2.6;
    // (they wander and fan with the larger eddies instead of running ruler-straight)
    r += (vec2(cA.z, sA) - 0.5) * vec2(3.5, 0.8);
    // Smooth noise drawn out four to one, three times over at different sizes and at slightly different
    // angles to the wind: brush strokes that cross, branch and feather, never a row of stripes.
    float lodF = clamp(log2(gFoot * 64.0 / 1.6), 0.0, 6.0);
    float zf = p.z - u_rise * 0.25;
    vec2 r1 = mat2(0.9689, -0.2474, 0.2474, 0.9689) * r, r2 = mat2(0.9553, 0.2955, -0.2955, 0.9553) * r;
    float f1 = textureLod(u_detail, vec3((r.x - gDrift.z) / 25.6, r.y / 6.4, zf / 3.2) + vec3(0.19, 0.53, 0.29), max(lodF - 2.0, 0.0)).b;
    float f2 = textureLod(u_detail, vec3((r1.x - gDrift.z) / 12.8, r1.y / 3.2, zf / 1.6) + vec3(0.71, 0.13, 0.47), max(lodF - 1.0, 0.0)).b;
    float f3 = textureLod(u_detail, vec3((r2.x - gDrift.z) / 6.4, r2.y / 1.6, zf / 1.6) + vec3(0.43, 0.87, 0.61), lodF).b;
    fib = sat((f1 * 0.5 + f2 * 0.34 + f3 * 0.16 - 0.34) / 0.32);
  }

  // the shape before coverage: the part known at this scale (c0) plus the meso part (x, with weight cw)
  float c0, cw, x, sd;
  // heaps: small cumulus are meso-sized; deep ones are macro lobes carrying meso turrets
  float hc0 = mix(0.30 * sA, 0.60 * sA + 0.14 * cA.z, deep), hcw = mix(0.70, 0.30, deep);
  // sheets: smooth with large-scale unevenness, or cells (smaller the higher the layer) with gaps between
  float small = sat((base - 2.0) / 3.5);
  vec3 cB = cellsOf(B);
  float cells = mix(cB.z * 0.6 + cA.x * 0.4, cB.x * 0.7 + cB.z * 0.3, small);
  if (cell > 0.01 && cir < 0.999) {
    vec3 c2 = cellsOf(textureLod(u_noise, vec3(ROT_C * q.xy, q.z) / 5.3 + vec3(0.61, 0.27, 0.43), max(lodB - 0.7, 0.0)));
    cells = sat((cells * 0.6 + mix(c2.z, c2.x, small) * 0.4 - 0.5) * 1.3 + 0.5);
  }
  float sc0 = mix(0.62 + 0.30 * sA, 0.30, cell), scw = mix(0.08, 0.70, cell);
  float sx = mix(sB, cells, cell);
  c0 = mix(sc0, hc0, heap); cw = mix(scw, hcw, heap); x = mix(sx, sB, heap);
  sd = mix(mix(0.15, 0.17, cell), 0.15, heap);
  if (cir > 0.001) {
    // a veil where the cover is whole, fibres and hooks where it breaks
    float veil = smoothstep(0.55, 0.95, cov);
    c0 = mix(c0, mix(0.14 + 0.30 * sA, 0.62 + 0.20 * sA, veil), cir);
    cw = mix(cw, mix(0.56, 0.18, veil), cir);
    x = mix(x, fib, cir);
    sd = mix(sd, 0.16, cir);
  }

  // vertical profile: sheets fade in and out gently; heaps have flat bases and domed tops, towers stay full
  float strat = smoothstep(0.0, 0.22, h) * (1.0 - smoothstep(0.6, 1.0, h));
  // (a layer of cells is a layer of lenses: each thickest in its middle, rounding off above and below)
  strat = mix(strat, pow(4.0 * h * (1.0 - h), 0.7), cell);
  float cumu = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(mix(0.62, 0.86, deep), 1.0, h));
  float prof = mix(strat, cumu, heap);
  float covH = min(cov * mix(1.12, mix(1.2 - 0.85 * h * h, 1.12 - 0.3 * h * h, deep), heap), 1.0);
  float t = 1.0 - covH;
  // crisp heaps, softer sheets, translucent ice
  float k = mix(mix(3.4, 3.8, cell), 5.5, heap) * mix(1.0, 0.36, cir);
  // sparse heaps are separate, solid cloudlets, not a faint haze: only sheets thin out with coverage
  float thin = mix(mix(sqrt(covH), covH, cir), 1.0, heap);
  // ... and an overcast is not evenly thick: its cells and swells are denser, the seams between them thin,
  // which from underneath is the mottled grey of a real deck
  thin *= mix(1.0, 0.4 + 1.0 * x, (1.0 - heap) * (1.0 - cir) * mix(0.6, 0.9, cell));

  // fine erosion: wisps at the base, billows on top, fading out with distance on its own mips
  float er = 0.0;
  if (fine > 0.5) {
    float lodD = clamp(log2(gFoot * 64.0 / T_DET), 0.0, 6.0);
    vec3 dq = vec3(q.xy, q.z - u_evo) / T_DET;
    // the detail is pushed around by the larger noise, so its edges curl instead of lining up
    dq += (B.gba - 0.4) * 0.35 * (1.0 - cir);
    vec4 D = textureLod(u_detail, dq, lodD);
    float dr = sat((D.r - 0.23) / 0.51);
    float billow = mix(dr, 1.0 - dr, sat(h * 3.5));
    er = mix(mix(0.22, 0.30, cell), 0.42, heap) * mix(billow, sat((D.b - 0.255) / 0.48) * 0.9, cir) * mix(1.0, 0.6, cir);
  } else {
    er = mix(0.11, 0.2, heap) * mix(1.0, 0.6, cir);       // the erosion's average, so light and shade agree with the picture
  }

  // Far away (and in the light volume's big voxels) the meso noise has been averaged out by its mips. What
  // it would have been is spread evenly over a range that grows with the blur, and the density is a ramp in
  // it: so the mean density over the footprint, and the share of the footprint with any cloud in it, are
  // exact integrals. A distant cumulus field keeps its true mean opacity and its true gaps.
  // (and even where the noise is still resolved, an edge is never drawn sharper than the footprint is wide:
  // where cover is slight the edges are steep, and would otherwise break up into sparkling specks)
  float lost = clamp(mix(max(smoothstep(1.2, 4.2, lodB), gFoot / 0.6), gFoot / 0.35, cir), 0.0, 1.0);
  float gain = k / max(covH, 0.02);
  float u0 = ((c0 + cw * x) * prof - t) * gain - er * k;
  float hw = max(0.5 * lost * cw * prof * gain, 1e-3);
  float ua = u0 - hw, ub = u0 + hw;
  float d = (rampInt(ub) - rampInt(ua)) / (ub - ua);
  gFill = (max(ub, 0.0) - max(ua, 0.0)) / (ub - ua);
  return d * thin;
}

// pouches hanging under a storm's anvil
float mammatusDensity(vec3 p) {
  if (u_mammatus < 0.01) return 0.0;
  vec2 an = texture(u_anvil, p.xy / BOX + 0.5).rg;
  float s = an.g * u_mammatus;
  if (s < 0.02) return 0.0;
  float base = an.r * ZTOP;
  float below = base - p.z;
  if (below < -0.08 || below > 1.5) return 0.0;
  vec3 q = vec3((p.xy - gDrift.xy) / 6.4, 0.31 + u_rise / 25.6);
  float c = textureLod(u_noise, q, 0.0).a;              // single-octave cells, about 1.6 km
  // round pouches: a hemisphere over each cell (the cell value falls off linearly with distance)
  float r = sat((1.0 - c) / 0.62);
  float depth = s * 1.05 * sqrt(max(0.0, 1.0 - r * r));
  float lobe = sat((depth - below) / max(depth, 0.05));
  vec2 e = abs(p.xy) - (BOX_HALF - 1.0);
  return smoothstep(0.0, 0.18, lobe) * (1.0 - smoothstep(0.0, 30.0, max(e.x, e.y)));
}

// falling rain and snow: curtains streaked downward, with ragged edges
float precipStreak(vec3 p, float snow) {
  float fall = u_fall * mix(1.0, 0.25, snow);
  vec3 q = vec3((p.xy - gDrift.xy) / mix(1.6, 3.2, snow), (p.z + fall) / mix(12.8, 3.2, snow));
  float s = sat((textureLod(u_noise, q, lodOf(1.6)).r - 0.54) / 0.35);
  float fine = sat((textureLod(u_detail, vec3((p.xy - gDrift.xy) / 0.8, (p.z + fall * 1.25) / 3.2), clamp(log2(gFoot * 64.0 / 0.8), 0.0, 6.0)).g - 0.21) / 0.54);
  return smoothstep(0.3, 0.8, s) * (0.55 + 0.45 * fine);
}

// extinction (per km) of cloud with this density and water: droplets (about 10 um) are far more opaque per
// gram than ice crystals (about 60 um), which the baked water already accounts for
// (A model's water is a mean over its grid cell, cloud and gaps together, so what it gives for a field of
// cumulus is far too little for any one of them: heaps and sheets are at least as opaque as they really are.)
float cloudSigma(float d, float water) { return d * max(150.0 * water, mix(mix(mix(10.0, 22.0, gCell), 0.3, gCir), 50.0, gHeap)) * u_ext; }
`;

// the lookups a lit sample needs
const LIGHTVOL = /* glsl */ `
uniform highp sampler3D u_lv;   // for a light above the horizon. r: optical depth a beam from it has met (it slips through
                                // the gaps in broken cloud), g: of the cloud straight overhead, b: of this cloud alone
                                // between here and where the light entered it, a: what the beam had met before that
uniform highp sampler3D u_lv2;  // r, b, a: the same for a light below the horizon (sunrise and sunset only)
uniform sampler2D u_ctot;       // g: optical depth of the whole column of cloud
uniform float u_sunAbove;       // 1 the light comes from above, 0 from below the horizon, between at sunrise and sunset
vec4 lightVol(vec3 p, out vec3 below) {
  // (beyond the box the weather is the box's, mirrored: so is its light)
  vec2 m = 1.0 - abs(mod(p.xy / BOX + 0.5, 2.0) - 1.0);
  vec3 u = vec3(m, clamp(p.z, 0.0, ZTOP) / ZTOP);
  vec4 a = texture(u_lv, u);
  below = u_sunAbove < 0.996 ? texture(u_lv2, u).rba : a.rba;
  return a;
}
float columnTau(vec2 xy) { return texture(u_ctot, 1.0 - abs(mod(xy / BOX + 0.5, 2.0) - 1.0)).g; }
`;

// ------------------------------------------------------------------ bake: the weather volumes
export const BAKE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
#define BOX 120.0
#define ZTOP 16.0
uniform highp sampler3D u_vol0;
uniform highp sampler3D u_aux0;
uniform highp sampler3D u_vol1;
uniform highp sampler3D u_aux1;
uniform highp sampler3D u_noise;
uniform float u_n;             // voxels per side
uniform float u_z;             // height of this slice, km
uniform float u_mix;           // 0 = the earlier hour, 1 = the later
uniform vec4 u_adv;            // xy: how far the earlier hour's clouds have come with the wind, zw: how far the later's still have to go (km)
uniform float u_appear;        // 0..1 condensing in (1 = all there)
layout(location = 0) out vec4 o1;
layout(location = 1) out vec4 o2;
float sat(float x) { return clamp(x, 0.0, 1.0); }
float wcDecode(float c) { return c > 0.002 ? exp2(((c * 255.0 - 1.0) * (4.5 / 253.0) - 4.0) * 3.3219281) : 0.0; }
float wcEncode(float v) { return v >= 1e-4 ? (1.0 + 253.0 * clamp((log2(v) * 0.30103 + 4.0) / 4.5, 0.0, 1.0)) / 255.0 : 0.0; }
vec3 uvwOf(vec3 p) { return vec3(p.xy / BOX + 0.5, p.z / ZTOP); }

void main() {
  vec2 xy = (gl_FragCoord.xy / u_n - 0.5) * BOX;
  vec3 p = vec3(xy, u_z);
  // A large-scale warp of where the weather is read: it hides the model's 3 km grid in organic shapes
  // (sub-grid, so heights and amounts stay where the model put them). It stays put: the weather is where
  // the model says, and the clouds drift through it, forming on one side and dissolving on the other.
  vec3 c1 = vec3(xy / 25.6, p.z / 12.8), c2 = vec3(xy / 12.8, p.z / 6.4);
  vec4 n = textureLod(u_noise, c1 + vec3(0.37, 0.11, 0.73), 0.0), n2 = textureLod(u_noise, c1 + vec3(0.83, 0.59, 0.21), 0.0);
  vec4 m = textureLod(u_noise, c2 + vec3(0.71, 0.53, 0.19), 0.0), m2 = textureLod(u_noise, c2 + vec3(0.17, 0.91, 0.67), 0.0);
  vec4 f = textureLod(u_noise, vec3(xy / 3.2, p.z / 3.2) + vec3(0.29, 0.83, 0.47), 1.0);
  // (cells of 6.4, 3.2 and 0.8 km: about 1.5, 0.9 and 0.3 km of displacement)
  vec3 warp = vec3(n.a - 0.48, n2.a - 0.48, (n.g - 0.475) * 0.14) * 4.0
            + vec3(m.a - 0.48, m2.a - 0.48, (m.g - 0.475) * 0.12) * 2.4
            + vec3(f.g - 0.475, f.a - 0.48, 0.0) * 1.2;
  vec3 q = p + warp;
  vec3 ua = uvwOf(q - vec3(u_adv.xy, 0.0));
  vec4 auxA = texture(u_aux0, ua), volA = texture(u_vol0, ua);
  float cov = auxA.r, cum = auxA.g, base = auxA.b, top = auxA.a;
  float liq = wcDecode(volA.r), ice = wcDecode(volA.g), rain = wcDecode(volA.b), snow = wcDecode(volA.a);
  if (u_mix > 0.001) {
    vec3 ub = uvwOf(q + vec3(u_adv.zw, 0.0));
    vec4 auxB = texture(u_aux1, ub), volB = texture(u_vol1, ub);
    float mx = u_mix;
    // each hour speaks for the cloud it has: a layer that exists in only one of them keeps its own height
    // and character while its cover fades, instead of sliding toward "nothing" at height zero
    float wa = (1.0 - mx) * (auxA.r + 0.02), wb = mx * (auxB.r + 0.02), ws = wa + wb;
    wa /= ws; wb /= ws;
    // where the two hours disagree, cloud lingers a little past the half-way point and arrives a little
    // before it, so the sky never thins out in the middle of a change
    cov = mix(auxA.r, auxB.r, mx) + 0.7 * mx * (1.0 - mx) * abs(auxA.r - auxB.r);
    cum = auxA.g * wa + auxB.g * wb;
    base = auxA.b * wa + auxB.b * wb;
    top = auxA.a * wa + auxB.a * wb;
    liq = liq * wa + wcDecode(volB.r) * wb;
    ice = ice * wa + wcDecode(volB.g) * wb;
    rain = mix(rain, wcDecode(volB.b), mx);
    snow = mix(snow, wcDecode(volB.a), mx);
  }
  // condensing in: every cloud grows from its densest part outward, low cloud a beat before high, and no
  // two places at quite the same moment
  if (u_appear < 0.999) {
    float ap = sat(u_appear * 1.7 - 0.38 * sat((m.r - 0.54) / 0.35) - 0.32 * (p.z / ZTOP));
    ap = ap * ap * (3.0 - 2.0 * ap);
    cov *= ap;
    rain *= ap; snow *= ap;
  }
  float water = liq + 0.1733 * ice;
  float iceF = sat((ice - liq * 0.6) / (ice + liq + 1e-5) * 1.6);
  float precip = rain + snow;
  o1 = vec4(sat(cov), wcEncode(precip), base, top);
  o2 = vec4(wcEncode(water), iceF, cum, precip > 1e-5 ? snow / precip : 0.0);
}`;

// ------------------------------------------------------------------ light: optical depth swept through the weather
//
// One slice per draw, from the top down (or, for a light below the horizon, from the ground up). The path of
// light through a slice ends at (xy) and began on the slice's far face at (xy + u_shift); what it had met by
// then comes from the previous slice's result (u_run). So the whole sweep costs one pass over the volume,
// and shadows soften with distance as they should.
//
// A voxel here is the better part of a kilometre: a field of cumulus is inside it, not resolved by it. So
// what is carried is not "the mean cloud" (which would put every cloudlet in its neighbours' shade, the sun
// never reaching the ground through a broken sky) but three things:
//   r  what a beam of light has met: through a voxel that is 40 % cloud, 60 % of it carries on untouched
//   g  the optical depth of cloud overhead, for something that is inside the cloud
//   b  the optical depth of the cloud a sample stands in, back to where the light entered that cloud
//   a  what the beam had met before it entered that cloud (the shade of other clouds on this one)
export const LIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
${COMMON}
${CLOUD}
uniform sampler2D u_run;
uniform float u_n;
uniform float u_z0;            // bottom of the slice, km
uniform float u_dz;
uniform vec2 u_shift;          // km the light path travels sideways across the slice, toward the light
uniform float u_path;          // path length per km of height
uniform float u_up;            // 0 sweeping down from the top, 1 up from the ground
uniform int u_sub;             // samples along the path
uniform float u_first;
uniform float u_empty;         // nothing in this slice: just carry the result through
uniform vec4 u_sDrift;
uniform vec2 u_sDir;
layout(location = 0) out vec4 oRun;
layout(location = 1) out vec4 oVol;

// what is here. x: extinction of the cloud, averaged over the voxel, y: the share of the voxel in cloud,
// z: of rain, snow and mammatus (spread evenly)
vec3 mediaAt(vec3 q) {
  vec3 uvw; float fade;
  vec4 w1 = weather1(q, uvw, fade);
  float pr = wcDecode(w1.g);
  float mam = mammatusDensity(q) * 16.0 * u_ext;
  if (w1.r < 0.01 && pr < 1e-4) return vec3(0.0, 0.0, mam);
  vec4 w2 = texture(u_w2, uvw);
  float h;
  float d = cloudDensity(q, w1.r, w1, w2, 0.0, h);
  // rain and snow dim the light too (snow, flake for flake, far more)
  return vec3(cloudSigma(d, wcDecode(w2.r)), gFill, pr * mix(1.2, 10.0, w2.a) * u_ext * 1.4 + mam);
}
// The optical depth a beam meets over a length s of that. Cloudlets (about LC across) either stand in the
// beam's way or don't: a stretch of several is that many independent chances of slipping through.
const float LC = 0.7;
float beamTau(vec3 m, float s) {
  float f = clamp(m.y, 0.0, 1.0);
  float t = f > 0.01 ? -(s / LC) * log(max(1.0 - f + f * exp(-m.x / f * LC), 1e-6)) : 0.0;
  return t + m.z * s;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_n;
  vec2 xy = (uv - 0.5) * BOX;
  gDrift = u_sDrift; gDir = u_sDir;
  gFoot = BOX / u_n;
  float zMid = u_z0 + 0.5 * u_dz;
  float zIn = u_up > 0.5 ? u_z0 : u_z0 + u_dz, zOut = u_up > 0.5 ? u_z0 + u_dz : u_z0;
  float sLen = u_dz * u_path;
  vec3 mC = vec3(0.0);
  float tb = 0.0;
  if (u_empty < 0.5) {
    mC = mediaAt(vec3(xy, zMid));
    if (u_sub <= 1) tb = beamTau(mC, sLen);
    else {
      for (int i = 0; i < 4; i++) {
        if (i >= u_sub) break;
        float s = (float(i) + 0.5) / float(u_sub);
        tb += beamTau(mediaAt(vec3(xy + u_shift * s, mix(zOut, zIn, s))), sLen / float(u_sub));
      }
    }
  }
  float f = clamp(mC.y, 0.0, 1.0);
  float sIn = (f > 0.01 ? mC.x / max(f, 0.08) : 0.0) + mC.z;        // extinction inside the cloud itself
  vec4 r0 = vec4(0.0), rH = vec4(0.0), rV = vec4(0.0);
  if (u_first < 0.5) {
    r0 = texture(u_run, uv + u_shift / BOX);
    rH = texture(u_run, uv + 0.5 * u_shift / BOX);
    rV = texture(u_run, uv);
  }
  // The cloud a sample stands in reaches back toward the light as far as cloud is continuous: straight up a
  // cloud's own column it nearly always is; along a slanting path across a broken field, only by chance.
  float coh = exp(-length(u_shift) / LC);
  float keep = mix(f, 1.0, coh) * step(0.01, f);
  float k0 = keep * sat(r0.b * 4.0), kH = keep * sat(rH.b * 4.0);
  oRun = vec4(r0.r + tb, rV.g + sIn * u_dz, r0.b * keep + sIn * sLen, mix(r0.r, r0.a, k0));
  oVol = vec4(rH.r + 0.5 * tb, rV.g + 0.5 * sIn * u_dz, rH.b * keep + 0.5 * sIn * sLen, mix(rH.r, rH.a, kH));
}`;

// ------------------------------------------------------------------ cloud shadows on the ground near the point
//
// The light volume knows the clouds at the scale of its voxels (about a kilometre): right for light inside
// cloud, too soft for the shadow of one cumulus on a field. This is the sun's-eye view at cloudlet scale,
// stored as the optical depth between each spot of ground and the sun.
export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DArray;
${COMMON}
${DEM}
${CLOUD}
${BLUE}
uniform vec2 u_size;
uniform float u_span;
uniform vec4 u_bDrift[6];
uniform vec2 u_bDir[6];
uniform vec2 u_bands[6];
uniform int u_nbands;
out vec4 o;
void main() {
  vec2 xy = (gl_FragCoord.xy / u_size - 0.5) * u_span;
  vec3 L = u_light;
  float lz = max(L.z, 0.07);
  vec3 p = vec3(xy, max(demH(xy, u_span / u_size.x), 0.0));
  gFoot = u_span / u_size.x;
  float tau = 0.0;
  float j = texelFetch(u_blue, ivec2(mod(gl_FragCoord.xy, 64.0)), 0).r;       // (the same every time: shadows that don't shimmer)
  for (int b = 0; b < 6; b++) {
    if (b >= u_nbands || tau > 12.0) break;
    vec2 band = u_bands[b];
    float z0 = max(band.x, p.z), z1 = band.y;
    if (z1 <= z0) continue;
    gDrift = u_bDrift[b]; gDir = u_bDir[b];
    int n = int(clamp(ceil((z1 - z0) / 0.3), 2.0, 10.0));
    float dz = (z1 - z0) / float(n);
    for (int i = 0; i < 10; i++) {
      if (i >= n) break;
      float z = z0 + dz * (float(i) + j);
      vec3 q = vec3(p.xy + L.xy / lz * (z - p.z), z);
      if (abs(q.x) > BOX_HALF + 200.0 || abs(q.y) > BOX_HALF + 200.0) break;
      vec3 uvw; float fade;
      vec4 w1 = weather1(q, uvw, fade);
      float pr = wcDecode(w1.g);
      if (w1.r * fade < 0.01 && pr < 1e-4) continue;
      vec4 w2 = texture(u_w2, uvw);
      float h;
      float d = cloudDensity(q, w1.r * fade, w1, w2, 0.0, h);
      tau += (cloudSigma(d, wcDecode(w2.r)) + pr * mix(1.2, 10.0, w2.a) * u_ext * 1.4) * dz / lz;
    }
  }
  o = vec4(tau, 0.0, 0.0, 1.0);
}`;

// ------------------------------------------------------------------ the atmosphere (after Hillaire 2020)
//
// Three small lookups: the transmittance of the air between any height and space, the light that has been
// scattered more than once (which is what keeps twilight and the shadowed sky bright), and from those the
// radiance of the whole sky as seen from the camera's height. Rayleigh air, Mie haze and the ozone layer,
// in km and per-km units; radiance is per unit of the sun's irradiance.
const ATMOS = /* glsl */ `
const float RG = 6360.0, RT = 6460.0;
const vec3 BR = vec3(5.802, 13.558, 33.1) * 1e-3;
const float BMS = 3.996e-3, BME = 4.40e-3;
const vec3 BO = vec3(0.650, 1.881, 0.085) * 1e-3;
uniform float u_mie;            // haze amount (1 = a clear day)
float rayOut(vec3 ro, vec3 rd, float r) {      // distance to where the ray leaves a sphere it is inside (or crosses), -1 if it misses
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}
float rayIn(vec3 ro, vec3 rd, float r) {       // distance to where the ray first meets a sphere it is outside of, -1 if it doesn't
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0 || b > 0.0) return -1.0;
  return -b - sqrt(d);
}
void media(float h, out vec3 sR, out float sM, out vec3 ext) {
  float r = exp(-h / 8.0), m = exp(-h / 1.2) * u_mie, oz = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  sR = BR * r; sM = BMS * m;
  ext = sR + BME * m + BO * oz;
}
vec2 lutUV(float h, float mu) { return vec2(0.5 + 0.5 * mu, clamp(h / (RT - RG), 0.0, 1.0)); }
`;

export const TRANS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
#define PI 3.14159265
${ATMOS}
uniform vec2 u_size;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float mu = uv.x * 2.0 - 1.0, h = uv.y * (RT - RG);
  vec3 ro = vec3(0.0, 0.0, RG + h), rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), 0.0, mu);
  if (rayIn(ro, rd, RG) > 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float len = rayOut(ro, rd, RT);
  vec3 tau = vec3(0.0);
  const int N = 40;
  float t = 0.0;
  for (int i = 0; i < N; i++) {
    float nt = (float(i) + 0.3) / float(N) * len, dt = nt - t;
    t = nt;
    vec3 sR, ext; float sM;
    media(length(ro + rd * t) - RG, sR, sM, ext);
    tau += ext * dt;
  }
  o = vec4(exp(-tau), 1.0);
}`;

export const MSCAT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
#define PI 3.14159265
${ATMOS}
uniform vec2 u_size;
uniform sampler2D u_trans;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float mus = uv.x * 2.0 - 1.0, h = clamp(uv.y, 0.002, 0.998) * (RT - RG);
  vec3 pos = vec3(0.0, 0.0, RG + h), sun = vec3(sqrt(max(0.0, 1.0 - mus * mus)), 0.0, mus);
  vec3 lum = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8, STEPS = 20;
  for (int i = 0; i < SQ; i++) for (int j = 0; j < SQ; j++) {
    float th = PI * (float(i) + 0.5) / float(SQ) * 2.0, ph = acos(clamp(1.0 - 2.0 * (float(j) + 0.5) / float(SQ), -1.0, 1.0));
    vec3 rd = vec3(sin(ph) * cos(th), sin(ph) * sin(th), cos(ph));
    float tg = rayIn(pos, rd, RG), ta = rayOut(pos, rd, RT);
    float tMax = tg > 0.0 ? tg : ta;
    vec3 L = vec3(0.0), F = vec3(0.0), T = vec3(1.0);
    float t = 0.0;
    for (int s = 0; s < STEPS; s++) {
      float nt = (float(s) + 0.3) / float(STEPS) * tMax, dt = nt - t;
      t = nt;
      vec3 p = pos + rd * t;
      float r = length(p);
      vec3 sR, ext; float sM;
      media(r - RG, sR, sM, ext);
      vec3 Ts = exp(-ext * dt);
      vec3 sc = sR + sM;
      F += T * (sc - sc * Ts) / ext;
      vec3 sunT = texture(u_trans, lutUV(r - RG, dot(p, sun) / r)).rgb;
      vec3 ins = sc * sunT / (4.0 * PI);
      L += T * (ins - ins * Ts) / ext;
      T *= Ts;
    }
    if (tg > 0.0) {
      vec3 hit = normalize(pos + rd * tg);
      L += T * 0.3 / PI * max(dot(hit, sun), 0.0) * texture(u_trans, lutUV(0.0, dot(hit, sun))).rgb;
    }
    lum += L / float(SQ * SQ);
    fms += F / float(SQ * SQ);
  }
  o = vec4(lum / (1.0 - fms), 1.0);
}`;

export const SKYVIEW_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
#define PI 3.14159265
${ATMOS}
uniform vec2 u_size;
uniform sampler2D u_trans;
uniform sampler2D u_ms;
uniform vec3 u_sunDir;       // direction to the light (only its elevation matters: azimuth 0 is toward it)
uniform float u_h0;          // observer height above sea level (km)
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float az = uv.x * PI;
  float v = uv.y * 2.0 - 1.0;
  float el = sign(v) * v * v * PI * 0.5;
  float sunEl = asin(clamp(u_sunDir.z, -1.0, 1.0));
  vec3 sd = vec3(0.0, cos(sunEl), sin(sunEl));
  vec3 rd = vec3(sin(az) * cos(el), cos(az) * cos(el), sin(el));
  vec3 ro = vec3(0.0, 0.0, RG + max(u_h0, 0.005));
  float tg = rayIn(ro, rd, RG), ta = rayOut(ro, rd, RT);
  float tMax = tg > 0.0 ? tg : ta;
  float mu = dot(rd, sd);
  float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.8;
  float pm = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 L = vec3(0.0), T = vec3(1.0);
  const int N = 32;
  float t = 0.0;
  for (int i = 0; i < N; i++) {
    // more of the steps near the eye, where the air is thick
    float f = (float(i) + 0.4) / float(N);
    float nt = tMax * f * f, dt = nt - t;
    t = nt;
    vec3 p = ro + rd * t;
    float r = length(p), h = r - RG;
    vec3 sR, ext; float sM;
    media(h, sR, sM, ext);
    float mus = dot(p, sd) / r;
    vec3 sunT = texture(u_trans, lutUV(h, mus)).rgb;
    vec3 ms = texture(u_ms, lutUV(h, mus)).rgb;
    vec3 S = (sR * pr + sM * pm) * sunT + (sR + sM) * ms;
    vec3 Ts = exp(-ext * dt);
    L += T * (S - S * Ts) / ext;
    T *= Ts;
  }
  o = vec4(max(L, vec3(0.0)), 1.0);
}`;

// the light the sky gives a cloud: the mean radiance of the dome (sun's and moon's sky together), and of
// the ring just above the horizon
export const AMBIENT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
#define PI 3.14159265
uniform sampler2D u_skyLUT;
uniform sampler2D u_moonLUT;
uniform float u_moonK;
uniform vec3 u_night;        // airglow and what the city lights put into the air
uniform vec4 u_stDome;       // side view: the backdrop's own light (rgb) and how much of the picture it is (a)
uniform vec3 u_stRim;
out vec4 o;
vec3 lut(sampler2D s, float az, float el) { return texture(s, vec2(az / PI, 0.5 + 0.5 * sqrt(clamp(el / (PI * 0.5), 0.0, 1.0)))).rgb; }
void main() {
  vec3 c = vec3(0.0);
  float w = 0.0;
  bool rim = gl_FragCoord.x > 1.0;
  for (int i = 0; i < 8; i++) for (int j = 0; j < 5; j++) {
    float az = PI * (float(i) + 0.5) / 8.0;
    float el = rim ? radians(1.0 + 2.5 * float(j)) : asin((float(j) + 0.5) / 5.0);
    float k = rim ? 1.0 : sin(el);          // the dome is weighed by how squarely each part shines down
    c += (lut(u_skyLUT, az, el) + lut(u_moonLUT, az, el) * u_moonK) * k;
    w += k;
  }
  // in the side view the sky behind the clouds is the drawn backdrop: the clouds stand in its light
  o = vec4(mix(c / w + u_night, rim ? u_stRim : u_stDome.rgb, u_stDome.a), 1.0);
}`;

// The Milky Way and the night's faintest light, drawn once into an all-sky map (equatorial coordinates):
// a band along the galactic plane, bright and broad toward Sagittarius, split by dust lanes.
export const MILKY_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
#define PI 3.14159265
uniform vec2 u_size;
uniform highp sampler3D u_noise;
out vec4 o;
// equatorial (J2000) -> galactic
const mat3 GAL = mat3(-0.0548755604, 0.4941094279, -0.8676661490,
                      -0.8734370902, -0.4448296300, -0.1980763734,
                      -0.4838350155, 0.7469822445, 0.4559837762);
float n3(vec3 p, float lod) { return textureLod(u_noise, p, lod).r; }
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float ra = uv.x * 2.0 * PI, dec = (uv.y - 0.5) * PI;
  vec3 e = vec3(cos(dec) * cos(ra), cos(dec) * sin(ra), sin(dec));
  vec3 g = GAL * e;                                    // x toward the galactic centre, z toward the pole
  float b = asin(clamp(g.z, -1.0, 1.0)), l = atan(g.y, g.x);
  float core = exp(-l * l / 0.9);                      // brighter and thicker toward the centre
  float width = mix(0.085, 0.22, core);
  float band = exp(-b * b / (2.0 * width * width));
  // clouds of stars and lanes of dust (noise read on the sphere itself, so there is no seam)
  float clouds = n3(g * 1.7 + 0.31, 0.0) * 0.6 + n3(g * 4.3 + 0.7, 0.0) * 0.4;
  float dust = n3(g * vec3(2.6, 2.6, 7.0) + 0.13, 0.0);
  float rift = smoothstep(0.52, 0.72, dust) * exp(-b * b / (2.0 * 0.06 * 0.06)) * (0.55 + 0.45 * core);
  float glow = band * (0.35 + 0.9 * core) * (0.45 + 1.1 * clouds * clouds) * (1.0 - 0.8 * rift);
  glow += 0.05 * exp(-abs(b) / 0.6);                   // the galaxy's faint outer glow
  vec3 col = mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.82, 0.60), core * (0.4 + 0.6 * band)) * glow;
  col = mix(col, col * vec3(1.0, 0.72, 0.5), rift * 0.6);     // light through dust is reddened
  o = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ background: sky, sun, moon, terrain
export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DArray;
${COMMON}
${DEM}
${BLUE}
${LIGHTVOL}
uniform vec2 u_res;
uniform float u_pix;             // radians per pixel
uniform sampler2D u_skyLUT;
uniform sampler2D u_moonLUT;
uniform sampler2D u_ramp;        // side view backdrop: colour by altitude (x) away from / toward the sun (y), as shown on screen
uniform float u_rampK;           // ... over the exposure
uniform sampler2D u_milky;
uniform sampler2D u_day;
uniform sampler2D u_nightTex;
uniform sampler2D u_shadow;      // optical depth of cloud between the ground and the sun, near the point
uniform float u_shadowSpan;
uniform vec3 u_sunDir;           // the sun itself (u_light may be the moon)
uniform vec3 u_sunCol;           // sun colour at the camera
uniform vec3 u_moonDir;
uniform vec3 u_moonCol;
uniform float u_moonIllum;
uniform float u_moonK;           // moonlit sky relative to the sunlit one
uniform float u_night;           // 0 day .. 1 night
uniform float u_stylize;         // side view: the sky is drawn by altitude
uniform float u_refDist;         // distance to the point's vertical plane
uniform float u_refZ;            // camera height (for the altitude of a background pixel)
uniform float u_snow;            // ground whitening
uniform float u_cityGlow;        // light pollution 0..1
uniform float u_far;
uniform mat3 u_eqInv;            // local sky -> equatorial (for the Milky Way)
uniform mat3 u_starCam;          // side view: the frame the night sky is seen in (the diorama's lens is too long to show it)
uniform float u_starVis;
uniform float u_milkyK;
uniform vec3 u_nightAir;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oDepth;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p, int oct) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

vec2 lonlat(vec2 xy) {
  float lat = u_lat0.x + xy.y / 111.195;
  float lon = u_lat0.y + xy.x / (111.195 * max(cos(radians(u_lat0.x)), 0.05));
  return vec2(lon, lat);
}

vec3 lutAt(sampler2D s, vec3 rd, vec3 l) {
  float el = asin(clamp(rd.z, -1.0, 1.0));
  vec2 a = normalize(rd.xy + 1e-6), b = normalize(l.xy + 1e-6);
  float az = acos(clamp(dot(a, b), -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (PI * 0.5));
  return texture(s, vec2(az / PI, v)).rgb;
}

// the physical sky: the sun's, the moon's (the same air lit a few hundred thousand times dimmer), airglow
// and the glow of a city on the haze
vec3 physicalSky(vec3 rd) {
  vec3 c = (lutAt(u_skyLUT, rd, u_sunDir) + lutAt(u_moonLUT, rd, u_moonDir) * u_moonK) * 1.25;
  // airglow, and a town's light on the haze (brightest low down)
  c += u_nightAir * (0.6 + 2.4 * exp(-max(rd.z, 0.0) * 9.0));
  return c;
}

// The side view's backdrop: the colours of the atmosphere by altitude, from the air near the ground through
// deep blue and violet to the black of space, warm toward a low sun and cool away from it.
vec3 backdrop(vec3 rd) {
  // the altitude this pixel sits at on the point's plane
  float z = u_refZ + u_refDist * max(rd.z, -0.01) / max(length(rd.xy), 1e-3);
  vec2 a = normalize(rd.xy + 1e-6), b = normalize(u_sunDir.xy + 1e-6);
  float toward = 0.5 + 0.5 * dot(a, b);
  vec3 g = texture(u_ramp, vec2(clamp(z / 18.0, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.25 + 0.5 * toward)).rgb * u_rampK;
  // the sun's aureole still shows through
  float cs = max(dot(rd, u_sunDir), 0.0);
  g += u_sunCol * (0.012 * pow(cs, 14.0) + 0.08 * pow(cs, 260.0));
  return g;
}

vec3 skyColor(vec3 rd) {
  vec3 c = physicalSky(rd);
  if (u_stylize > 0.0) c = mix(c, backdrop(rd), u_stylize);
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
    // (through the side view's long lens the sun is a great disc: there it is drawn as bright as the screen can
    // show and no brighter, so it keeps its colour and its darker limb)
    col += u_sunCol * mix(420.0, 2.6 * u_rampK, u_stylize) * dark * smoothstep(1.0, 0.92, r);
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
    // the seas: dark basalt plains on the near side, roughly where the real ones lie
    float mare = 0.0;
    mare = max(mare, 1.0 - length((uv - vec2(-0.28, 0.42)) / vec2(0.30, 0.26)));    // Imbrium
    mare = max(mare, 1.0 - length((uv - vec2(0.18, 0.36)) / vec2(0.17, 0.19)));     // Serenitatis
    mare = max(mare, 1.0 - length((uv - vec2(0.36, 0.10)) / vec2(0.24, 0.19)));     // Tranquillitatis
    mare = max(mare, 1.0 - length((uv - vec2(0.69, 0.25)) / vec2(0.10, 0.13)));     // Crisium
    mare = max(mare, 1.0 - length((uv - vec2(0.58, -0.10)) / vec2(0.13, 0.19)));    // Fecunditatis
    mare = max(mare, 1.0 - length((uv - vec2(0.38, -0.25)) / vec2(0.10, 0.10)));    // Nectaris
    mare = max(mare, 1.0 - length((uv - vec2(-0.20, -0.35)) / vec2(0.22, 0.15)));   // Nubium
    mare = max(mare, 1.0 - length((uv - vec2(-0.50, -0.38)) / vec2(0.10, 0.11)));   // Humorum
    mare = max(mare, 1.0 - length((uv - vec2(-0.62, 0.10)) / vec2(0.26, 0.48)));    // Procellarum
    mare = max(mare, 1.0 - length((uv - vec2(-0.02, 0.72)) / vec2(0.46, 0.07)));    // Frigoris
    float rough = fbm2(uv * 7.0 + 4.0, 4);
    float alb = mix(1.0, 0.52, smoothstep(0.0, 0.35, mare + (rough - 0.5) * 0.5));
    // bright young craters and their rays
    float tycho = exp(-dot(uv - vec2(-0.10, -0.68), uv - vec2(-0.10, -0.68)) / 0.003);
    float cop = exp(-dot(uv - vec2(-0.33, 0.16), uv - vec2(-0.33, 0.16)) / 0.002);
    alb += 0.35 * tycho + 0.22 * cop + 0.10 * (rough - 0.5);
    float edge = smoothstep(1.0, 0.94, rm);
    // (no limb darkening to speak of: the dusty surface throws light back the way it came)
    col += u_moonCol * (pow(lit, 0.75) * alb + 0.0015 * alb) * edge;
  }
  // the moon's aureole in the air around it
  if (u_moonDir.z > -0.05) {
    float rr = max(rm - 1.0, 0.0);
    col += u_moonCol * u_moonIllum * u_night * (0.05 * exp(-rr / 2.5) + 0.012 * exp(-rr / 18.0) + 0.003 * exp(-rr / 70.0));
  }
  return col;
}

// What cloud leaves of the direct sun at a point on or near the ground, and of the light that comes down
// through the cloud diffusely (the first vanishes under a cumulus, the second never quite does).
vec2 cloudLight(vec3 p) {
  vec2 suv = p.xy / u_shadowSpan + 0.5;
  vec3 lw;
  vec4 lv = lightVol(p, lw);
  float tauCoarse = mix(lw.x, lv.x, u_sunAbove);
  float tau = tauCoarse;
  if (all(greaterThan(suv, vec2(0.01))) && all(lessThan(suv, vec2(0.99)))) {
    // (near the point the fine map; it fades into the light volume toward its rim)
    vec2 e = abs(suv - 0.5) * 2.0;
    tau = mix(texture(u_shadow, suv).r, tauCoarse, smoothstep(0.75, 0.97, max(e.x, e.y)));
  }
  return vec2(exp(-tau), 1.0 / (1.0 + 0.11 * tau));
}

// aerial perspective: boundary-layer haze and air between the camera and something t away. The haze glows
// with the light that reaches it, so under a storm or a solid deck the far country goes dull instead of
// shining through the rain like a clear day's horizon.
vec3 hazed(vec3 col, vec3 ro, vec3 rd, float t) {
  float f = 1.0 - exp(-hazeDepth(ro, rd, t));
  float t0 = 0.0;
  if (u_cut.w > 0.5) { float den = dot(rd.xy, u_cut.xy); if (den > 1e-6) t0 = clamp((u_cut.z - dot(ro.xy, u_cut.xy)) / den, 0.0, t); }
  vec3 pa = ro + rd * mix(t0, t, 0.35), pb = ro + rd * t;
  float lit = 0.5 * (cloudLight(pa).y + cloudLight(pb).y);
  return mix(col, skyColor(normalize(vec3(rd.xy, max(rd.z, 0.02)))) * mix(0.25, 1.0, lit), f);
}

// The Blue Marble's colour for a place. (Read at an explicit level: implicit derivatives are undefined
// after the trace's loops and early returns, and show up as stray pixels along the screen's diagonal. The
// texture's texels are kilometres wide.)
vec3 imagery(vec2 tuv) { return textureLod(u_day, tuv, 0.0).rgb; }
// what the ground reflects: those colours (which run dark), lifted to plausible albedos
vec3 albedoOf(vec3 tex) { return 1.0 - exp(-2.0 * pow(tex, vec3(1.05))); }

// the ground where the ray meets it, t along the ray
vec3 groundColor(vec3 ro, vec3 rd, float t) {
  vec3 p = ro + rd * t;
  // the slope, measured over a texel (or a pixel, when that is larger) each way: smooth, not faceted
  float foot = t * u_pix;
  float e = max(2.0 * u_demHalf[demLayer(p.xy)] / u_demInfo.x, foot);
  vec3 n = normalize(vec3(demH(p.xy - vec2(e, 0), foot) - demH(p.xy + vec2(e, 0), foot),
                          demH(p.xy - vec2(0, e), foot) - demH(p.xy + vec2(0, e), foot), 2.0 * e));
  float steep = smoothstep(0.16, 0.42, 1.0 - n.z);          // from about 33 degrees
  // texture finer than the grid, close up: in the shading only, the outline stays the measured ground
  float close = 1.0 - smoothstep(0.004, 0.03, foot);
  if (close > 0.0) {
    float g0 = fbm2(p.xy * 9.0, 3);
    vec2 g = vec2(fbm2(p.xy * 9.0 + vec2(0.35, 0.0), 3), fbm2(p.xy * 9.0 + vec2(0.0, 0.35), 3)) - g0;
    n = normalize(n + vec3(-g, 0.0) * close * (0.35 + 1.4 * steep));
  }
  vec2 ll = lonlat(p.xy);
  vec2 tuv = vec2((ll.x + 180.0) / 360.0, (90.0 - ll.y) / 180.0);
  vec3 tex = imagery(tuv);
  vec2 cl = cloudLight(p);
  vec3 sun = lightColor(p.z + u_elev);
  vec3 dome = skyDome();
  // The sea: ground at sea level that the imagery doesn't show as land (basins below sea level are land).
  // Dark from above, a mirror of the sky toward the horizon, with the sun's glitter on it.
  float asl = (demH(p.xy) + u_demInfo.w * dot(p.xy, p.xy)) / max(u_demInfo.z, 1e-3) - u_demSea;
  bool land = max(tex.r, tex.g) > tex.b + 0.06 && tex.r + tex.g + tex.b > 0.54;
  if (asl < 0.0008 && !land) {
    float fres = 0.02 + 0.6 * pow(1.0 - clamp(-rd.z, 0.0, 1.0), 5.0);       // (waves keep it short of a perfect mirror)
    vec3 mirror = skyColor(normalize(vec3(rd.xy, max(-rd.z, 0.03)))) * mix(0.35, 1.0, cl.y);
    vec3 sea = vec3(0.008, 0.026, 0.05) * (sun * max(u_light.z, 0.0) * (cl.x + 0.5 * (cl.y - cl.x)) / PI + dome * cl.y) * 4.0 + mirror * fres * 0.8;
    sea += sun * cl.x * 0.6 * pow(max(dot(reflect(rd, vec3(0.0, 0.0, 1.0)), u_light), 0.0), 260.0);
    return hazed(sea, ro, rd, t);
  }
  vec3 alb = albedoOf(tex);
  float grain = fbm2(p.xy * 1.7, 3);
  // land the imagery paints as sea (its texels are 10 km wide: small islands, the shore) takes an earth tone
  alb = mix(alb, vec3(0.085, 0.095, 0.055), clamp((tex.b - max(tex.r, tex.g)) * 6.0, 0.0, 1.0));
  alb *= 0.75 + 0.5 * grain;
  if (close > 0.0) alb *= mix(1.0, 0.8 + 0.4 * fbm2(p.xy * 37.0, 3), close);     // fields and woods underfoot
  // steep ground is bare rock
  alb = mix(alb, vec3(0.2, 0.185, 0.165) * (0.7 + 0.7 * grain), steep * 0.7);
  alb = mix(alb, vec3(0.8, 0.83, 0.87), u_snow * smoothstep(0.35, 0.75, n.z));
  float sh = cl.x * demSunlit(p, n, u_light, max(e, foot));
  // direct sun on the slope, the sun's light diffused down through cloud, and the sky (less of it seen from a
  // valley floor than from a ridge, and less again under a deck)
  float open = clamp(1.0 + 2.2 * (p.z - demH(p.xy, max(8.0 * e, 1.5))), 0.6, 1.12);
  vec3 E = sun * (max(dot(n, u_light), 0.0) * sh + max(u_light.z, 0.0) * max(cl.y - cl.x, 0.0) * 0.8)
         + dome * PI * (0.5 + 0.5 * n.z) * open * mix(0.3, 1.0, cl.y);
  vec3 col = alb * E / PI;
  // city lights at night: warm points scattered through the lit area, not a glowing sheet
  if (u_night > 0.005) {
    float lit = pow(textureLod(u_nightTex, tuv, 0.0).r, 2.2);
    float pts = smoothstep(0.58, 0.82, fbm2(p.xy * 9.0, 3)) * (0.4 + 0.6 * smoothstep(0.3, 0.7, fbm2(p.xy * 1.3 + 7.0, 2)));
    col += vec3(1.0, 0.62, 0.32) * lit * (0.004 + 0.11 * pts) * u_night * u_rampK;      // (as bright on screen whatever the exposure)
  }
  return hazed(col, ro, rd, t);
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
      if (tCut > 0.0 && pc.z < demH(pc.xy)) { tHit = tCut; face = true; }
    }
  }
  vec3 col;
  float depth;
  if (face) {
    vec3 p = ro + rd * tHit;
    float below = demH(p.xy) - p.z;
    // soil over rock, with faint strata; a lit rim of ground along the top
    vec3 soil = vec3(0.060, 0.042, 0.030), rock = vec3(0.026, 0.022, 0.021);
    vec3 earth = mix(soil, rock, smoothstep(0.02, 0.35, below));
    float strata = 0.85 + 0.15 * sin((p.z + fbm2(p.xy * 0.4, 2) * 0.06) * 140.0);
    vec3 sun = lightColor(u_elev), dome = skyDome();
    vec3 lit = sun * max(u_light.z, 0.0) * 0.12 + dome * 4.5 + vec3(0.004);
    col = earth * strata * lit;
    vec2 ll = lonlat(p.xy);
    vec3 grass = albedoOf(imagery(vec2((ll.x + 180.0) / 360.0, (90.0 - ll.y) / 180.0)));
    vec2 cl = cloudLight(vec3(p.xy, demH(p.xy)));
    col = mix(col, grass * (sun * max(u_light.z, 0.0) * (cl.x + 0.8 * max(cl.y - cl.x, 0.0)) + dome * PI * cl.y) / PI, smoothstep(0.012, 0.0, below));
    col = hazed(col, ro, rd, tHit);
    depth = tHit;
  } else {
    tHit = demTrace(ro, rd, max(tCut, 0.0), u_far, u_pix);
    if (tHit > 0.0) { col = groundColor(ro, rd, tHit); depth = tHit; }
    else {
      col = skyColor(rd) + discs(rd);
      // the Milky Way and the unresolved starlight of the night sky (the stars themselves are drawn as points)
      if (u_starVis > 0.003) {
        vec3 sd = u_stylize > 0.5 ? normalize(u_starCam * vec3(ndc * vec2(u_res.x / u_res.y, 1.0) * 0.55, 1.0)) : rd;
        if (sd.z > -0.02) {
          vec3 eq = u_eqInv * sd;
          vec2 muv = vec2(atan(eq.y, eq.x) / (2.0 * PI), asin(clamp(eq.z, -1.0, 1.0)) / PI + 0.5);
          muv.x = fract(muv.x);
          float ext = exp(-0.25 / max(sd.z + 0.04, 0.03));
          // (explicit level: the wrap of right ascension would otherwise pick the smallest mip along a seam)
          col += textureLod(u_milky, muv, 0.0).rgb * u_milkyK * u_starVis * ext;
        }
      }
      depth = u_far;
      // a skyline this ray cleared by less than a pixel covers part of the pixel: no stair-steps against the
      // sky. Its colour is the slope facing the camera, a texel and a half short of the crest.
      if (gEdgeCov > 0.0) {
        float tEdge = gEdgeT, cov = gEdgeCov;
        vec3 pc = ro + rd * tEdge;
        float back = 3.0 * u_demHalf[demLayer(pc.xy)] / u_demInfo.x;
        col = mix(col, groundColor(ro, rd, max(tEdge - back, tEdge * 0.5)), cov);
        if (cov > 0.5) depth = tEdge;
      }
    }
  }
  o = vec4(max(col, vec3(0.0)), 1.0);
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
uniform float u_twinkle;     // seconds
out vec3 v_col;
out float v_a;
vec3 starColor(float t) {
  t = clamp(t, 2500.0, 25000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.293 * pow(t - 60.0, -0.1332), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.390 * log(t) - 0.6318, 0.0, 1.0) : clamp(1.1298 * pow(t - 60.0, -0.0755), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432 * log(t - 10.0) - 1.1962, 0.0, 1.0));
  return mix(vec3(1.0), c, 0.7);
}
void main() {
  vec3 d = u_eq * a_dir;
  gl_Position = u_vp * vec4(u_camPos + d * 3000.0, 1.0);
  gl_Position.z = gl_Position.w * 0.99999;   // on the far plane, never clipped by it
  float m = a_mt.x;
  // fainter stars drown in haze near the horizon, where the air also makes them twinkle
  float ext = exp(-0.25 / max(d.z + 0.03, 0.03));
  float tw = 1.0 + 0.22 * (1.0 - smoothstep(0.1, 0.7, d.z)) * sin(u_twinkle * (3.0 + fract(a_dir.x * 91.7) * 5.0) + a_dir.y * 311.0);
  v_a = clamp(pow(10.0, -0.4 * (m - 2.0)) * 0.9 + 0.08, 0.05, 2.5) * u_vis * ext * step(0.0, d.z) * tw;
  v_col = starColor(a_mt.y);
  gl_PointSize = clamp(3.6 - 0.45 * m, 1.3, 4.5) * u_dpr;
}`;

export const STAR_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_depth;
uniform sampler2D u_bgCol;
uniform vec2 u_res;
uniform float u_far;
in vec3 v_col;
in float v_a;
out vec4 o;
void main() {
  if (texture(u_depth, gl_FragCoord.xy / u_res).r < u_far * 0.99) discard;
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(d, d) * 3.5) * v_a;
  o = vec4(v_col * a * 0.16, 0.0);
}`;

// ------------------------------------------------------------------ volumetric clouds
//
// A quarter of the pixels each frame (RESOLVE_FS rebuilds the rest), each ray stepped through the height
// bands that hold anything: long strides through clear air, short ones in cloud, growing with distance.
// A sample is lit by the light volume (optical depth to the sun through everything in the way, and how much
// cloud lies above and below) plus a short march of its own for the shading of its nearest lobes:
//   - sunlight that has scattered once (the phase function: the silver lining toward the sun)
//   - sunlight that has diffused through the cloud: bright where the sun enters, falling off only slowly
//     with depth (two-stream), which is what gives real cumulus their white tops, grey bodies and dark bases
//   - the sky from above and the ground's light from below, each dimmed by the cloud in between
export const CLOUD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
${COMMON}
${CLOUD}
${LIGHTVOL}
${BLUE}
uniform vec2 u_res;
uniform vec2 u_jitter;           // which of the 2x2 full-size pixels this frame's rays go through, and sub-pixel jitter
uniform float u_pixAngle;        // radians per cloud pixel
uniform sampler2D u_sceneDepth;
uniform vec2 u_bands[6];
uniform vec4 u_bDrift[6];
uniform vec2 u_bDir[6];
uniform int u_nbands;
uniform int u_maxSteps;
uniform int u_lightSteps;
uniform float u_fill;             // how much open sky there is around (0 under an overcast)
uniform float u_far;
uniform vec3 u_cityCol;          // light from below at night (city lights on cloud bases)
uniform vec4 u_flash[2];         // lightning inside the cloud: xyz (km), w intensity
uniform vec3 u_flashCol;
uniform float u_groundAlb;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oEx;

float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
// droplets: a sharp forward lobe (the glare around the sun through thin cloud), a broad one, a little back
float phaseWater(float c) { return 0.42 * min(hg(c, 0.90), 6.0) + 0.46 * hg(c, 0.55) + 0.12 * hg(c, -0.25); }
// ice: smoother crystals' lobe (the halo is added where it belongs, in the composite)
float phaseIce(float c) { return 0.55 * hg(c, 0.75) + 0.35 * hg(c, 0.35) + 0.10 * hg(c, -0.2); }

const float GAM = 0.11;          // 0.75 (1 - g): how fast diffuse light is turned back by cloud

void main() {
  vec2 frag = (floor(gl_FragCoord.xy) * 2.0 + u_jitter + 0.5);       // in full-size cloud pixels
  vec2 uv = frag / u_res;
  vec3 rd = rayDir(uv * 2.0 - 1.0);
  vec3 ro = u_camPos;
  float tScene = texture(u_sceneDepth, uv).r;
  float tFar = min(tScene, u_far);
  float tNear = 0.0;
  if (u_cut.w > 0.5) {
    float den = dot(rd.xy, u_cut.xy);
    float num = u_cut.z - dot(ro.xy, u_cut.xy);
    if (abs(den) > 1e-5) {
      float tc = num / den;
      if (den > 0.0) tNear = max(tNear, tc - 3.0 / den); else tFar = min(tFar, tc);
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

  vec3 Lsum = vec3(0.0);
  float T = 1.0, dAcc = 0.0, wAcc = 0.0, halo = 0.0, bow = 0.0;
  float cosT = dot(rd, u_light);
  float phW = phaseWater(cosT), phI = phaseIce(cosT);
  float phM = 0.6 * hg(cosT, 0.35) + 0.4 / (4.0 * PI);        // light that has scattered a few times: nearly even
  float jit = blue(gl_FragCoord.xy, 0.0);
  float jl = blue(gl_FragCoord.xy, 1.0);
  vec3 dome = skyDome(), rim = skyRim();
  float mu0 = max(u_light.z, 0.0);
  // the light the ground sends back up: sunlit and skylit earth (snow far more)
  vec3 ground0 = u_groundAlb * (lightColor(0.0) * mu0 / PI + dome);
  int budget = u_maxSteps;
  float t0m = max(tNear, 0.0);          // steps grow with distance from where the march starts, not from the camera
  if (tFar > tNear) {
    for (int b = 0; b < 6; b++) {
      if (b >= u_nbands || budget <= 0 || T < 0.01) break;
      vec2 band = u_bands[b];
      float a, c;
      if (abs(rd.z) < 1e-5) { if (ro.z < band.x || ro.z > band.y) continue; a = tNear; c = tFar; }
      else { float ta = (band.x - ro.z) / rd.z, tb = (band.y - ro.z) / rd.z; a = max(tNear, min(ta, tb)); c = min(tFar, max(ta, tb)); }
      if (c <= a) continue;
      gDrift = u_bDrift[b]; gDir = u_bDir[b];
      // step length: 45 m plus 1.1 % of the distance from the start of the march; 2.6 times that through
      // clear air, falling back half a stride when cloud is met so its edge is found with short steps
      float t = a, empty = 0.0, cap = 1e3, skin = 0.0, rainy = 0.0;
      bool first = true;
      for (int i = 0; i < 160; i++) {
        if (budget <= 0 || T < 0.01 || t >= c) break;
        budget--;
        // steps: 45 m plus 1.1 % of the distance marched, and never much finer than a pixel is wide there;
        // through air with no weather in it, strides as long as the weather's own grain allows
        float base = max(0.045 + 0.011 * (t - t0m), 1.2 * t * u_pixAngle);
        float stride = empty > 1.5 ? max(2.6, min(0.6, 0.2 / max(abs(rd.z), 0.05)) / base) : 1.0;
        // (inside cloudy air, until the ray is well into a cloud, steps are short: the lit skin of a cloud is
        // where its look is decided)
        float dt = min(min(base * (skin > 0.0 ? mix(1.0, 0.45 + 0.55 * (1.0 - T), skin) : max(stride, 1.0 + rainy)), cap), c - t + 1e-4);
        float ts = t + dt * jit;
        vec3 p = ro + rd * ts;
        // (the noise is read no finer than the steps can follow: a sample stands for its whole step)
        gFoot = max(max(ts * u_pixAngle, 0.35 * dt), 0.008);
        vec3 uvw; float fade;
        vec4 w1 = weather1(p, uvw, fade);
        float precip = wcDecode(w1.g);
        float cov = w1.r * fade;
        // side view: the slab's front and back are not planes but wander by a kilometre or two, and clouds
        // there are cut clean through, whole: what faces the viewer is a cloud's own inside, lit as cloud,
        // along a surface no straighter than the cloud's
        float cutF = 1.0;
        if (u_cut.w > 0.5) {
          float pd = planeDist(p.xy) + (textureLod(u_noise, vec3(p.xy / 25.6, 0.5), 1.0).a - 0.48) * 4.5;
          cutF = smoothstep(-0.3, 0.3, pd - u_cut.z) * (1.0 - smoothstep(u_slab.x - min(u_slab.y, 1.5), u_slab.x, pd));
          if (cutF < 0.01) { cov = 0.0; precip = 0.0; }
        }
        float dm = u_mammatus > 0.01 ? mammatusDensity(p) * cutF : 0.0;
        if (cov < 0.01 && precip < 1e-4 && dm <= 0.0) { empty += 1.0; cap = 1e3; skin = 0.0; rainy = 0.0; t += dt; first = false; continue; }
        // a thin layer is not stepped over: at least three samples through it (it would sparkle otherwise)
        cap = cov >= 0.01 ? max(0.3 * (w1.a - w1.b) * ZTOP, 0.5 * base) : 1e3;
        rainy = cov < 0.01 ? 1.0 : 0.0;          // (falling rain alone is smooth: twice the stride)
        vec4 w2 = texture(u_w2, uvw);
        float h;
        float d = cloudDensity(p, cov, w1, w2, 1.0, h) * cutF;
        skin = cov >= 0.01 ? gHeap : 0.0;
        float water = wcDecode(w2.r);
        float sc = cloudSigma(d, water) + dm * 16.0 * u_ext;
        float sr = 0.0, ss = 0.0;
        if (precip > 1e-4) {
          // curtains with ragged edges: the model's amounts fade over a 3 km cell, noise in the (logarithmic)
          // amount keeps a shaft from having straight walls
          float rn = sat((textureLod(u_noise, vec3((p.xy - gDrift.xy) / 6.4, p.z / 12.8) + vec3(0.13, 0.57, 0.91), lodOf(6.4)).r - 0.54) / 0.35);
          float pe = exp2(min((rn - 0.5) * 8.0, 0.7)) * cutF * fade;
          if (w2.a < 0.92) sr = precip * (1.0 - w2.a) * pe * 0.9 * (0.25 + 1.5 * precipStreak(p, 0.0));
          if (w2.a > 0.08) ss = precip * w2.a * pe * 9.0 * (0.3 + 1.1 * precipStreak(p, 1.0));
        }
        float se = sc + (sr + ss) * u_ext * 2.5;
        if (se < 2e-3) { empty = 0.0; t += dt; first = false; continue; }      // (cloudy air, a gap in it: keep to short steps)
        if (empty > 1.5 && !first) {
          // strode into cloud: go back and take it in short steps
          t = max(t, ts - base);
          empty = 0.0;
          continue;
        }
        empty = 0.0;
        first = false;

        // ---- light
        // The cloud between here and the light, at its real shape: a few steps, each three times the last
        // (50 m to a couple of km), seen ever more coarsely. This is what gives a cloud its form: lobes that
        // shade one another, a lit flank and a dark one. Beyond their reach the light volume takes over.
        float tauL = 0.0, reach = 0.25;
        // (Thin cloud casts no shade on itself worth marching for, and a sheet has less form than a heap.)
        int nl = sc < 2.5 || gFoot > 0.6 ? 0 : (gHeap > 0.4 ? u_lightSteps : 2);
        if (nl > 0) {
          float f0 = gFoot, s0 = 0.0, s1 = (0.06 + 0.02 * jl) * (nl == 2 ? 2.5 : 1.0);
          for (int k = 0; k < 4; k++) {
            if (k >= nl) break;
            float sm = 0.5 * (s0 + s1), h2;
            gFoot = max(f0, 0.12 * sm);
            tauL += cloudSigma(cloudDensity(p + u_light * sm, cov, w1, w2, k == 0 ? 1.0 : 0.0, h2), water) * (s1 - s0);
            s0 = s1; s1 *= 3.0;
          }
          gFoot = f0;
          reach = s0;
        }
        vec3 lw, lw0;
        vec4 lv = lightVol(p + u_light * reach, lw);
        // (the cloud overhead and underfoot are read here, not out where the light comes from)
        float ctot = columnTau(p.xy);
        float tauUp = min(lightVol(p, lw0).y, ctot), tauDn = max(ctot - tauUp, 0.0);
        vec3 Fs = lightColor(p.z + u_elev);
        float ice = w2.g;
        float ph1 = mix(phW, phI, ice);
        // how much light has been scattered more than once here: none in a thin veil, all of it in a cumulus
        float thick = 1.0 - exp(-0.5 * (tauUp + tauDn + tauL));
        vec3 sunTerm = vec3(0.0);
        for (int k = 0; k < 2; k++) {
          float wgt = k == 0 ? u_sunAbove : 1.0 - u_sunAbove;
          if (wgt < 0.004) continue;
          // what the beam has met on its way here, and how deep in its own cloud the sample is
          float beam = (k == 0 ? lv.x : lw.x) + tauL;
          float depth = (k == 0 ? lv.z : lw.y) + tauL;
          // a light below the horizon enters through the cloud's base, so "beyond" is the cloud above
          float beyond = k == 0 ? tauDn : tauUp;
          float direct = exp(-beam);
          // two-stream: 1 where the light enters, 1 / (1 + GAM tau) on the far side of the whole cloud
          // (other clouds' shade falls on the whole of this one)
          float shade = 1.0 / (1.0 + GAM * (k == 0 ? lv.a : lw.z));      // (what a deck above lets through, diffused)
          float diffuse = (1.0 + GAM * beyond) / (1.0 + GAM * (depth + beyond)) * shade;
          float few = exp(-0.28 * depth) * shade;
          float slant = mix(0.42, 1.0, mu0);            // towers and flanks catch a low sun that flat tops don't
          sunTerm += wgt * (ph1 * direct + thick * (phM * 0.55 * few + slant * diffuse * mix(0.22, 0.30, few)));
        }
        // sky from above, the ground's light from below; each crosses the cloud between diffusely
        float den = 1.0 + GAM * (tauUp + tauDn);
        vec3 amb = (dome * (1.0 + GAM * tauDn) + ground0 / (1.0 + GAM * 0.6 * ctot) * (1.0 + GAM * tauUp)) / den;
        // the horizon's glow on the flanks of anything thin enough to see sideways through
        amb += rim * 0.25 * (1.0 - thick);
        // The face of a cloud that we see is turned toward us, and so toward the sky behind us: its fill light.
        amb += mix(rim, dome, 0.5) * (0.55 * u_fill / (1.0 + GAM * 2.0 * -log(max(T, 1e-3))));
        // city lights on the cloud base at night
        amb += u_cityCol * (1.0 + GAM * tauUp) / den;
        // lightning: a point of light deep in the cloud, diffused by the droplets around it, so the flash
        // blooms through the cloud's own structure
        float fl = 0.0;
        for (int k = 0; k < 2; k++) {
          if (u_flash[k].w < 0.001) continue;
          float fd = length(p - u_flash[k].xyz);
          fl += u_flash[k].w * exp(-fd * 0.12) / (1.0 + fd * fd * 0.012);
        }
        vec3 inScatter = Fs * sunTerm + amb + u_flashCol * fl * 0.012;
        // droplets and crystals scatter nearly all the light that meets them; rain and snow a little less
        vec3 S = (sc * 0.999 + (sr * 0.62 + ss * 0.9) * u_ext * 2.5) * inScatter;
        float Tr = exp(-se * dt);
        Lsum += T * (S - S * Tr) / se;
        // what the halo and the rainbow need: thin, sunlit ice and rain on this ray
        float sunT = exp(-(mix(lw.x, lv.x, u_sunAbove) + tauL));
        halo += T * cloudSigma(d, water) * dt * smoothstep(0.55, 0.95, ice) * sunT;
        bow += T * sr * u_ext * 2.5 * dt * sunT;
        float w = T * (1.0 - Tr);
        dAcc += ts * w; wAcc += w;
        T *= Tr;
        t += dt;
      }
    }
  }
  // aerial perspective over the clouds. (Where there is none the distance is the ground's behind it, not
  // "infinitely far": scaled up next to real cloud, that would haze the cloud's edge to sky brightness and
  // draw a bright rim along every ridge standing in front of a storm.)
  float dc = wAcc > 1e-4 ? dAcc / wAcc : min(tScene, u_far);
  o = vec4(Lsum, T);
  oEx = vec4(dc, halo, bow, 1.0);
}`;

// ------------------------------------------------------------------ temporal reconstruction
//
// The cloud pass fills one pixel of every 2x2 block each frame. Here the full-size image is rebuilt: a
// pixel that was just marched takes (most of) its new value; the others are carried over from the last
// frame, found where they were then (the camera may have moved, and the cloud has drifted with its wind),
// and kept within what the new low-resolution picture allows so nothing can smear or ghost.
export const RESOLVE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_cur;       // this frame: half size in each direction
uniform sampler2D u_curEx;
uniform sampler2D u_hist;
uniform sampler2D u_histEx;
uniform mat4 u_invVP;
uniform mat4 u_prevVP;
uniform vec3 u_camPos;
uniform vec2 u_res;            // full-size cloud image
uniform vec2 u_jitter;         // this frame's pixel within each 2x2 block
uniform float u_alpha;         // how much of a fresh sample to take
uniform float u_keep;          // how firmly to hold on to the other pixels' history
uniform float u_clamp;         // how tightly history is held to what the new samples allow (1 while things move)
uniform float u_reset;
uniform vec2 u_bands[6];
uniform vec3 u_bVel[6];        // how far each layer moved since the last frame (km)
uniform int u_nbands;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oEx;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / u_res;
  ivec2 lo = px / 2;
  ivec2 lim = textureSize(u_cur, 0) - 1;
  bool fresh = all(equal(px - lo * 2, ivec2(u_jitter)));
  // this frame's value here: its own ray, or its neighbours' (their rays pass half a pixel away)
  vec2 luv = (gl_FragCoord.xy - u_jitter - 0.5 + 1.0) / (u_res);
  vec4 c = fresh ? texelFetch(u_cur, min(lo, lim), 0) : texture(u_cur, luv);
  vec4 ce = fresh ? texelFetch(u_curEx, min(lo, lim), 0) : texture(u_curEx, luv);
  if (u_reset > 0.5) { o = c; oEx = ce; return; }
  // where this bit of cloud was a frame ago
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 a = u_invVP * vec4(ndc, -1.0, 1.0), b = u_invVP * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize(b.xyz / b.w - a.xyz / a.w);
  vec3 p = u_camPos + rd * min(ce.r, 400.0);
  for (int i = 0; i < 6; i++) { if (i >= u_nbands) break; if (p.z >= u_bands[i].x - 0.1 && p.z <= u_bands[i].y + 0.1) { p -= u_bVel[i]; break; } }
  vec4 pc = u_prevVP * vec4(p, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool lost = any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0))) || pc.w <= 0.0;
  if (lost) { o = c; oEx = ce; return; }
  vec4 h = texture(u_hist, puv), he = texture(u_histEx, puv);
  // the range the neighbourhood allows
  vec4 mn = c, mx = c;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 s = texelFetch(u_cur, clamp(lo + ivec2(x, y), ivec2(0), lim), 0);
    mn = min(mn, s); mx = max(mx, s);
  }
  // (with nothing moving the history is right and is left alone: held to the coarse new picture it would
  // lose the detail it has gathered, in blocks)
  vec4 ext = (mx - mn) * mix(3.0, 0.5, u_clamp) + vec4(mix(0.08, 0.012, u_clamp));
  vec4 hc = clamp(h, mn - ext, mx + ext);
  float alpha = fresh ? u_alpha : (1.0 - u_keep);
  // history that had to be pulled far back into range was wrong: trust the new picture more there
  float off = length(h - hc) / (length(ext) + 1e-4);
  alpha = max(alpha, clamp(off * 0.5, 0.0, 0.6));
  o = mix(hc, c, alpha);
  oEx = vec4(mix(he.r, ce.r, max(alpha, 0.3)), mix(he.gb, ce.gb, max(alpha, 0.12)), 1.0);
}`;

// ------------------------------------------------------------------ final image
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
${COMMON}
${BLUE}
${LIGHTVOL}
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
uniform vec4 u_flash[2];       // xyz position (km), w intensity
uniform vec3 u_flashCol;
uniform float u_rays;          // crepuscular ray strength
uniform float u_far;
uniform vec3 u_glare;          // the sun's place on screen (uv), and whether it is in front of the camera
uniform float u_aspect;
uniform float u_grade;         // how much of the look (contrast, saturation) to apply
out vec4 o;

// Filmic tone curve. Applied to the brightness and to each channel, and blended: the per-channel curve
// alone washes strong colour out toward white (a sunset goes pale yellow), the brightness curve alone
// keeps hue and saturation; between them highlights roll off without losing the sky's colour.
vec3 curve(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float curve1(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 tonemap(vec3 c) {
  float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
  vec3 byLum = c * (curve1(l) / l);
  vec3 byCh = curve(c);
  // bright things still go to white (the sun, a lit cloud top), strong colours in the mid tones stay strong
  return mix(byCh, min(byLum, vec3(1.0)), 0.55 * (1.0 - smoothstep(0.55, 1.6, l)));
}

// a ring of light at radius r0 (deg) with width w, coloured by wavelength
vec3 ring(float ang, vec3 r0, float w) {
  vec3 d = (vec3(ang) - r0) / w;
  return exp(-d * d);
}

// The clouds are drawn smaller than the screen, each of their texels marched as far as the ground at its
// centre. Where the ground's outline crosses a texel (a ridge against a cloud deck) plain filtering would
// smear cloud over the ridge and leave a blocky gap around it, so there the four nearest texels are weighed
// by how well the ground they saw agrees with the ground at this pixel.
vec4 cloudAt(vec2 uv, float sceneT, out vec4 ex) {
  vec2 f = uv * u_cloudRes - 0.5;
  vec2 i0 = floor(f), w = f - i0;
  vec2 c00 = (i0 + 0.5) / u_cloudRes, c11 = (i0 + 1.5) / u_cloudRes;
  vec4 d = vec4(texture(u_bgDepth, c00).r, texture(u_bgDepth, vec2(c11.x, c00.y)).r,
                texture(u_bgDepth, vec2(c00.x, c11.y)).r, texture(u_bgDepth, c11).r);
  vec4 r = abs(d - sceneT) / max(min(d, vec4(sceneT)), 0.1);
  if (all(lessThan(r, vec4(0.03)))) { ex = texture(u_cloudEx, uv); return texture(u_cloud, uv); }
  vec4 k = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y) / (1.0 + 900.0 * r * r) + 1e-6;
  k /= k.x + k.y + k.z + k.w;
  ivec2 lim = ivec2(u_cloudRes) - 1, a = clamp(ivec2(i0), ivec2(0), lim), b = clamp(ivec2(i0) + 1, ivec2(0), lim);
  ex = k.x * texelFetch(u_cloudEx, a, 0) + k.y * texelFetch(u_cloudEx, ivec2(b.x, a.y), 0)
     + k.z * texelFetch(u_cloudEx, ivec2(a.x, b.y), 0) + k.w * texelFetch(u_cloudEx, b, 0);
  return k.x * texelFetch(u_cloud, a, 0) + k.y * texelFetch(u_cloud, ivec2(b.x, a.y), 0)
       + k.z * texelFetch(u_cloud, ivec2(a.x, b.y), 0) + k.w * texelFetch(u_cloud, b, 0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 rd = rayDir(uv * 2.0 - 1.0);
  vec3 bg = texture(u_bg, uv).rgb;
  float sceneT = texture(u_bgDepth, uv).r;
  vec4 ex;
  vec4 cl = cloudAt(uv, sceneT, ex);
  float T = clamp(cl.a, 0.0, 1.0);
  vec3 dome = skyDome(), rim = skyRim();
  // distant cloud fades into the haze like the ground does
  vec3 hazeCol = sceneT >= u_far * 0.99 ? bg : rim * 0.9 + lightColor(1.0) * 0.004;
  float fh = 1.0 - exp(-hazeDepth(u_camPos, rd, min(ex.r, u_far)));
  vec3 col = bg * T + mix(max(cl.rgb, vec3(0.0)), hazeCol * (1.0 - T), fh);

  // light shafts through gaps in the cloud: the haze of the lowest few kilometres, sunlit or in shadow, along
  // the part of the ray that is in it and over the ground the shadow map covers
  if (u_rays > 0.001) {
    float tEnd = min(min(sceneT, ex.r), 60.0);
    if (rd.z > 1e-3) tEnd = min(tEnd, max(4.0 - u_camPos.z, 0.0) / rd.z);
    float t0 = rd.z < -1e-3 && u_camPos.z > 4.0 ? (u_camPos.z - 4.0) / -rd.z : 0.0;
    if (tEnd > t0 + 0.2) {
      float cs = dot(rd, u_light);
      float mie = 0.0716 * (1.0 - 0.76 * 0.76) / pow(1.0 + 0.5776 - 1.52 * cs, 1.5) + 0.06;
      float acc = 0.0, wsum = 0.0;
      float j = texelFetch(u_blue, ivec2(mod(gl_FragCoord.xy, 64.0)), 0).r;
      for (int i = 0; i < 8; i++) {
        float t = mix(t0, tEnd, (float(i) + j) / 8.0);
        vec3 p = u_camPos + rd * t;
        // trace down the sun's direction to the ground and read the shadow there
        vec2 g = p.xy - u_light.xy / max(u_light.z, 0.07) * max(p.z, 0.0);
        vec2 suv = g / u_shadowSpan + 0.5;
        float dens = exp(-max(p.z + u_elev, 0.0) / 1.4);
        // (beyond the shadow map, the light volume's broader idea of the shade)
        vec2 e = abs(suv - 0.5) * 2.0;
        float in_ = 1.0 - smoothstep(0.8, 1.0, max(e.x, e.y));
        float lit1 = 0.0;
        if (in_ < 1.0) { vec3 lw; vec4 lv = lightVol(vec3(g, 0.1), lw); lit1 = exp(-mix(lw.x, lv.x, u_sunAbove)); }
        if (in_ > 0.0) lit1 = mix(lit1, exp(-texture(u_shadow, suv).r), in_);
        acc += lit1 * dens; wsum += dens;
      }
      float lit = wsum > 0.0 ? acc / wsum : 0.6;
      float amount = (1.0 - exp(-(tEnd - t0) * 0.03)) * u_rays;
      col = max(col + lightColor(1.0) * mie * (lit - 0.6) * amount * T * 0.08, col * 0.6);
    }
  }

  // 22-degree halo and sun dogs in thin ice cloud, primary and secondary rainbows in sunlit rain
  float halo = 1.0 - exp(-ex.g * 1.6);
  if (halo > 0.002) {
    vec3 hl = u_light;
    float ang = degrees(acos(clamp(dot(rd, hl), -1.0, 1.0)));
    // red on the inside (it is bent least), a sharp inner edge and a long bluish-white fade outward
    vec3 r0 = vec3(21.75, 21.95, 22.2);
    vec3 in1 = smoothstep(r0 - 0.5, r0 + 0.15, vec3(ang));
    vec3 h = in1 * exp(-max(vec3(ang) - r0, 0.0) / vec3(1.7, 1.95, 2.3)) * vec3(1.0, 0.96, 0.92);
    // the sky inside the ring is a little darker than outside it
    float inner = smoothstep(21.6, 12.0, ang) * 0.10;
    // parhelia at the halo's distance either side, at the light's elevation
    float el = asin(clamp(hl.z, -1.0, 1.0)), re = asin(clamp(rd.z, -1.0, 1.0));
    float daz = acos(clamp(dot(normalize(rd.xy + 1e-6), normalize(hl.xy + 1e-6)), -1.0, 1.0));
    float dogAz = radians(22.0) / max(cos(el), 0.3);
    float dE = degrees(re - el);
    vec3 dA = degrees(daz - dogAz) - vec3(-0.5, 0.0, 0.6);
    vec3 dogs = exp(-dA * dA / 0.5 - dE * dE / 1.6) * smoothstep(45.0, 20.0, degrees(el)) * 2.2;
    dogs += exp(-max(dA, 0.0) / 3.5 - dE * dE / 1.2) * step(0.0, dA.g) * 0.5 * smoothstep(45.0, 20.0, degrees(el));    // their tails, pointing away
    col += lightColor(10.0) * (h + dogs - inner) * halo * 0.2;
  }
  float bow = min(ex.b, 1.0);
  if (bow > 0.002 && u_light.z > -0.02) {
    float ang = degrees(acos(clamp(dot(rd, -u_light), -1.0, 1.0)));
    vec3 p1 = ring(ang, vec3(42.3, 41.6, 40.7), 0.7);
    vec3 p2 = ring(ang, vec3(50.6, 51.6, 53.0), 1.1) * 0.42;
    float alex = smoothstep(42.6, 43.5, ang) * (1.0 - smoothstep(49.5, 50.4, ang));
    col += lightColor(1.0) * ((p1 + p2) * 0.12 - alex * 0.012) * bow;
  }

  // lightning lights the air around it
  for (int i = 0; i < 2; i++) {
    vec4 f = u_flash[i];
    if (f.w < 0.001) continue;
    // (the cloud itself is lit in the cloud pass) the ray passing close by, through air and rain
    vec3 toF = f.xyz - u_camPos;
    float tc = max(dot(toF, rd), 0.0);
    float miss = length(toF - rd * tc);
    float air = (exp(-miss * miss / 4.0) * 0.010 + exp(-miss / 6.0) * 0.0015) * T;
    col += u_flashCol * f.w * air * 0.22;
  }

  // the sun's glare in the eye (or the lens): what is left of the disc after the cloud in front of it
  if (u_glare.z > 0.5) {
    vec2 d = (uv - u_glare.xy) * vec2(u_aspect, 1.0);
    float r2 = dot(d, d);
    float vis = clamp(texture(u_cloud, u_glare.xy).a, 0.0, 1.0);
    vis *= texture(u_bgDepth, u_glare.xy).r >= u_far * 0.99 ? 1.0 : 0.0;
    col += u_sunCol * vis * (0.0020 / (r2 + 0.0016) + 0.018 * exp(-r2 * 22.0));
  }

  col = max(col, vec3(0.0)) * u_exposure;
  col = tonemap(col);
  // the look: a touch of contrast and saturation in the mid tones
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 1.0 + 0.16 * u_grade);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.22 * u_grade);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  // dither (triangular, one 8-bit step, blue noise): no banding in the long smooth gradients
  float n1 = blue(gl_FragCoord.xy, 4.0), n2 = blue(gl_FragCoord.xy + 31.0, 5.0);
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
precision highp sampler2D;
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
