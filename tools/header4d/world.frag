#version 300 es
// Otherworld vol. 1 header: a first-person flight through a four-dimensional world.
//
// The world is a signed-distance field in 4D (x, y, z, w). We see it through a 3D slice: every
// point p of our 3D space is the 4D point P = C4 + R * (p, 0). C4 is the camera's 4D position and
// flies along the z axis. R turns the slice through 4D: one whole turn in the XW plane per loop.
// The architecture is built in 4D, so its slices morph as the slice turns:
// tunnel sections change from octagon to hexagon to diamond, side tunnels that run partly along w
// swing open and shut, columns that are slices of 4D cubes grow, split and vanish, and the Ring (a Clifford
// torus) changes from two hoops facing us into hoops lying flat above and below.
//
// One loop (24 s) flies one period L of the world:
//   tunnel (z 170..25)  ->  junction (z 25..40: a tesseract room, cross tunnels that swing open and
//   shut, a lit shaft)  ->  great hall (z 45..100: hyper-columns, light wells, a tesseract frame),
//   open at its far end onto  ->  the Ring's chamber (z 95..170)  ->  a doorway into the tunnel
// The camera path, the slice rotation and the world are all periodic, so phase 1 equals phase 0.
precision highp float;
precision highp int;

uniform vec2 uRes;       // frame size in px (1280, 640)
uniform float uPhase;    // loop phase in [0, 1]
uniform int uSS;         // supersampling: uSS x uSS rays per pixel
uniform int uDebug;      // 0 normal; 1 no haze; 2 haze only; 3 surfaces without emission; 4 materials; 5 hall light
out vec4 fragColor;

#define TAU 6.283185307179586
const float L = 200.0;                       // world period along z = distance flown per loop
const float HFOV = 84.0;                     // horizontal field of view, degrees
const float FOG = 42.0;                      // haze: distance over which light falls to 1/e

// palette, linear RGB (page: --planet #e4405f, --acid #c6f03a, --fg #eef5d6)
const vec3 PLANET = vec3(0.776, 0.051, 0.115);
const vec3 ACID   = vec3(0.565, 0.871, 0.042);
const vec3 FG     = vec3(0.855, 0.913, 0.672);
const vec3 WINE   = vec3(0.070, 0.010, 0.024);
const vec3 TEAL   = vec3(0.006, 0.038, 0.044);

// materials
const float M_WALL = 1.0, M_RIB = 2.0, M_GATE = 3.0, M_COL = 4.0, M_BEAM = 5.0, M_FRAME = 6.0, M_RING = 7.0;

// zones along z (centres)
// zone walls sit at multiples of 5, midway between the rib planes (2.5 mod 5), so no rib lies flat on a wall
const float Z_JUNCTION = 32.5, Z_HALL = 72.5, Z_RING = 132.5, Z_HOOPS = 139.0;

mat4 R;                  // slice rotation
vec4 C4;                 // camera position in 4D
mat3 COLROT;             // orientation of the hyper-columns' cross-section cube

// ---------------------------------------------------------------- helpers
float wz(float z, float z0) { return mod(z - z0 + 0.5 * L, L) - 0.5 * L; }   // periodic local z

float sdBox2(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdBox3(vec3 p, vec3 b) { vec3 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0); }
float sdBox4(vec4 p, vec4 b) {
  vec4 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(max(d.x, d.y), max(d.z, d.w)), 0.0);
}

// the 2-faces (2-skeleton) of a tesseract of half-size b, thickened by e. A 3D slice cuts the
// 2-faces in segments, so the slice shows the wireframe of the cross-section polyhedron.
float sdTess2Skeleton(vec4 p, float b, float e) {
  vec4 a = abs(p) - b;
  vec4 o = max(a, 0.0);
  float d = 1e9;
  d = min(d, length(vec4(a.x, a.y, o.z, o.w)));
  d = min(d, length(vec4(a.x, o.y, a.z, o.w)));
  d = min(d, length(vec4(a.x, o.y, o.z, a.w)));
  d = min(d, length(vec4(o.x, a.y, a.z, o.w)));
  d = min(d, length(vec4(o.x, a.y, o.z, a.w)));
  d = min(d, length(vec4(o.x, o.y, a.z, a.w)));
  return d - e;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// value noise whose lattice wraps every `per` cells along z, so textures repeat with the world
float vnoise(vec3 x, float per) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float z0 = mod(i.z, per), z1 = mod(i.z + 1.0, per);
  vec3 a = vec3(i.xy, z0), b = vec3(i.xy, z1);
  return mix(mix(mix(hash13(a), hash13(a + vec3(1, 0, 0)), f.x),
                 mix(hash13(a + vec3(0, 1, 0)), hash13(a + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(b), hash13(b + vec3(1, 0, 0)), f.x),
                 mix(hash13(b + vec3(0, 1, 0)), hash13(b + vec3(1, 1, 0)), f.x), f.y), f.z);
}

mat4 rotXW(float a) { float c = cos(a), s = sin(a); return mat4(c, 0, 0, s,  0, 1, 0, 0,  0, 0, 1, 0,  -s, 0, 0, c); }
mat3 rotAxis(vec3 k, float a) {
  float c = cos(a), s = sin(a);
  mat3 K = mat3(0.0, k.z, -k.y,  -k.z, 0.0, k.x,  k.y, -k.x, 0.0);
  return mat3(1.0) + s * K + (1.0 - c) * K * K;
}

// the flight path bends gently (periodic in z); the architecture follows it
float bendX(float z) { return 2.6 * sin(TAU * z / L) + 1.1 * sin(2.0 * TAU * z / L + 1.3); }
float bendY(float z) { return 0.9 * sin(TAU * z / L + 2.1); }
float dbendX(float z) { return (TAU / L) * (2.6 * cos(TAU * z / L) + 2.2 * cos(2.0 * TAU * z / L + 1.3)); }
float dbendY(float z) { return (TAU / L) * 0.9 * cos(TAU * z / L + 2.1); }
float ddbendX(float z) { float k = TAU / L; return -k * k * (2.6 * sin(TAU * z / L) + 4.4 * sin(2.0 * TAU * z / L + 1.3)); }

vec4 arch(vec4 P) { return vec4(P.x - bendX(P.z), P.y - bendY(P.z), P.z, P.w); }

// ---------------------------------------------------------------- the 4D architecture
// free space is negative inside; walls are everything else
float tunnelSect(vec3 c) {                  // the tunnels' 3D cross-section, in (x, y, w)
  float box = sdBox3(c, vec3(3.3)) - 0.4;
  float oct = (abs(c.x) + abs(c.y) + abs(c.z) - 5.3) * 0.57735;
  return max(box, oct);
}
float hallBox(vec4 q) { return sdBox4(vec4(q.x, q.y - 11.0, wz(q.z, Z_HALL), q.w), vec4(38.0, 18.0, 26.5, 38.0)) - 1.0; }    // z 45..100, open into the chamber
float chamberBox(vec4 q) { return sdBox4(vec4(q.x, q.y - 2.0, wz(q.z, Z_RING), q.w), vec4(40.0, 30.0, 29.5, 40.0)) - 8.0; } // z 95..170

float freeSpace(vec4 q) {
  float d = tunnelSect(vec3(q.x, q.y, q.w));
  float zj = wz(q.z, Z_JUNCTION);
  d = min(d, sdBox4(vec4(q.x, q.y - 1.5, zj, q.w), vec4(6.5, 5.5, 6.9, 6.5)) - 0.6);     // junction room: a tesseract, z 25..40
  // two cross tunnels running along directions in the XW plane (11 and 35 degrees from x): each
  // swings open into a long corridor as the slice turns past its direction, then closes again
  vec2 xw = vec2(q.x, q.w);
  d = min(d, sdBox3(vec3(dot(xw, vec2(-0.199, 0.980)), q.y, zj + 4.0), vec3(2.8, 2.6, 2.4)) - 0.2);
  d = min(d, sdBox3(vec3(dot(xw, vec2(-0.581, 0.814)), q.y, zj - 4.0), vec3(2.8, 2.6, 2.4)) - 0.2);
  d = min(d, sdBox3(vec3(q.x, zj, q.w), vec3(2.6)) - 0.2);                             // a shaft along world y
  d = min(d, hallBox(q));
  // light wells: square shafts in the hall's ceiling, long along the hall, open far up
  float zh = wz(q.z, Z_HALL);
  vec2 cw = abs(mod(vec2(q.x, q.w) + 3.0, 6.0) - 3.0) - 1.3;          // square wells on a 6-unit lattice
  float wells = max(sdBox4(vec4(q.x, q.y - 110.0, zh, q.w), vec4(34.0, 82.0, 21.0, 34.0)), max(cw.x, cw.y));
  d = min(d, wells);
  d = min(d, chamberBox(q));
  return d;
}

vec3 colLocal(vec4 q) {                     // position relative to the nearest hyper-column
  vec2 xw = vec2(q.x, q.w);
  vec2 id = floor(xw / 9.0 + 0.5);
  if (id == vec2(0.0)) id = abs(q.x) > abs(q.w) ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.w));   // the aisle
  vec2 l = xw - id * 9.0;
  float zh = wz(q.z, Z_HALL);
  float lz = zh - 10.0 * clamp(floor(zh / 10.0 + 0.5), -2.0, 2.0);
  return COLROT * vec3(l.x, lz, l.y);
}
float columns(vec4 q) {
  float d = sdBox3(colLocal(q), vec3(1.25)) - 0.2;
  d -= 0.7 * (smoothstep(-3.0, -7.5, q.y) + smoothstep(25.0, 29.5, q.y));    // base and capital
  return max(d, hallBox(q));
}
float beams(vec4 q) {
  float zh = wz(q.z, Z_HALL);
  return max(sdBox2(vec2(q.y - 27.5, mod(zh, 5.0) - 2.5), vec2(2.5, 0.45)), hallBox(q));
}
vec4 frameLocal(vec4 q) { return vec4(q.x, q.y - 4.0, wz(q.z, Z_HALL), q.w); }
vec4 ringLocal(vec4 q) { return vec4(q.x, q.y, wz(q.z, Z_HOOPS), q.w); }
const float RING_R1 = 13.5, RING_R2 = 15.0;
float ring(vec4 q) {                        // the Ring: a Clifford torus with a rectangular section
  vec4 r = ringLocal(q);
  vec2 t = vec2(length(r.xy) - RING_R1, length(r.zw) - RING_R2);
  return sdBox2(t, vec2(1.1, 2.4)) - 0.3;
}

// panels: shallow grooves cut into the walls, laid out in 4D so they morph with the slice
float grooves(vec4 q) {
  float g1 = abs(mod(q.z, 2.5) - 1.25);
  float g2 = abs(mod(q.y + 0.875, 1.75) - 0.875);
  float g3 = abs(mod(q.x + 0.5 * q.w + 0.875, 1.75) - 0.875);
  return 0.045 * (1.0 - smoothstep(0.03, 0.16, min(g1, min(g2, g3))));
}

vec2 scene(vec4 q) {
  float fs = freeSpace(q);
  vec2 res = vec2(-fs + grooves(q), M_WALL);
  float rib = max(abs(mod(q.z, 5.0) - 2.5) - 0.3, -fs - 0.65);       // ribs every 5 units on every wall
  if (rib < res.x) res = vec2(rib, M_RIB);
  float gate = max(abs(mod(q.z, 25.0) - 12.5) - 0.65, -fs - 1.1);    // a heavier gate every 25 (tunnels only)
  gate = max(gate, max(1.5 - hallBox(q), 1.5 - chamberBox(q)));
  if (gate < res.x) res = vec2(gate, M_GATE);
  float c = columns(q);
  if (c < res.x) res = vec2(c, M_COL);
  float b = beams(q);
  if (b < res.x) res = vec2(b, M_BEAM);
  float f = sdTess2Skeleton(frameLocal(q), 9.0, 0.14);
  if (f < res.x) res = vec2(f, M_FRAME);
  float r = ring(q);
  if (r < res.x) res = vec2(r, M_RING);
  return res;
}

vec4 toWorld(vec3 p) { return arch(C4 + R * vec4(p, 0.0)); }
vec2 map(vec3 p) { return scene(toWorld(p)); }

// ---------------------------------------------------------------- shading
vec3 calcNormal(vec3 p, float t) {
  float e = 0.001 + 0.0006 * t;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * map(p + k.xyy * e).x + k.yyx * map(p + k.yyx * e).x +
                   k.yxy * map(p + k.yxy * e).x + k.xxx * map(p + k.xxx * e).x);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 6; i++) {
    float h = 0.06 + 0.5 * float(i) * float(i) * 0.25;
    occ += (h - map(p + h * n).x) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - 0.9 * occ, 0.0, 1.0);
}

// an anti-aliased line of width w around d = 0; px is the pixel footprint. Widened lines dim.
float line(float d, float w, float px) {
  float ww = max(w, 1.5 * px);
  return (1.0 - smoothstep(0.35 * ww, ww, abs(d))) * (w / ww);
}

vec3 fogColour(vec3 rd) {
  return mix(vec3(0.0060, 0.0016, 0.0036), vec3(0.0022, 0.0052, 0.0062), 0.5 + 0.5 * rd.y);
}

float wGrad;             // |gradient of the 4D w coordinate| across the slice, for the w = 0 line

vec3 SUN;                // the great hall's high light, as a direction in the slice

float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.3;
  for (int i = 0; i < 48; i++) {
    vec3 p = ro + rd * t;
    if (toWorld(p).y > 34.0) break;               // up in the light wells: open sky
    float h = map(p).x;
    res = min(res, 14.0 * h / t);
    t += clamp(h, 0.2, 3.0);
    if (res < 0.02 || t > 70.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

vec3 shade(vec3 rd, float t, vec3 p, float mat) {
  vec3 n = calcNormal(p, t);
  vec4 q = toWorld(p);
  float fs = freeSpace(q);
  float ao = calcAO(p, n);
  float px = 1.15 * t / (0.5 * uRes.x / tan(radians(HFOV * 0.5)));        // pixel footprint

  // dark matte stone: panels of slightly different tone, a little grime
  vec3 cell = floor(vec3(mod(q.z, L) / 2.5, (q.x + 0.5 * q.w + 0.875) / 1.75, (q.y + 0.875) / 1.75));
  float var = 0.7 + 0.6 * hash13(cell + mat * 17.0);
  float grime = 0.65 + 0.7 * vnoise(vec3(q.x + 0.7 * q.w, q.y - 0.4 * q.w, q.z) * 0.9, 0.9 * L);
  vec3 alb = mix(vec3(0.060, 0.034, 0.046), vec3(0.032, 0.048, 0.054), hash13(cell.zyx + 3.0)) * var * grime;

  float facing = max(dot(n, -rd), 0.0);
  float endWall = smoothstep(0.6, 0.9, abs(n.z));                         // walls facing along the flight
  float nearWall = smoothstep(-2.0, 0.0, fs);
  float inHall = smoothstep(2.0, -2.0, hallBox(q));
  float inChamber = smoothstep(4.0, -4.0, chamberBox(q));

  // light: a dim lamp at the camera; pink light pooled round the gates and ribs; the hall's high
  // light with soft shadows; the Ring's glow in its chamber; wine and teal ambience
  vec3 lamp = vec3(1.0, 0.86, 0.80) * 1.0 / (1.0 + 0.05 * t * t) * (0.15 + 0.85 * facing);
  float dzr = abs(mod(q.z, 5.0) - 2.5), dzg = abs(mod(q.z, 25.0) - 12.5);
  float tunnelish = smoothstep(0.0, 2.5, hallBox(q)) * smoothstep(0.0, 2.5, chamberBox(q));
  vec3 pool = PLANET * (0.3 * exp(-dzr * 2.5) + 4.0 * exp(-dzg * 0.42) * tunnelish) * nearWall * (1.0 - 0.8 * endWall);
  vec3 sky = vec3(0.0);
  if (inHall > 0.0) {
    float dif = max(dot(n, SUN), 0.0);
    if (dif > 0.0) dif *= softShadow(p + n * 0.05, SUN);
    sky = (FG * 1.1 + WINE * 3.0) * dif * inHall;
  }
  float rd4 = ring(q);
  vec3 ringLight = PLANET * 0.35 * exp(-max(rd4, 0.0) / 6.0) * inChamber * (mat == M_RING ? 0.15 : 1.0);
  vec3 amb = (WINE * 0.9 + TEAL * 1.0) * (0.55 + 0.45 * n.y) * (1.0 - 0.75 * endWall) * (1.0 - 0.6 * inChamber);
  vec3 col = alb * (lamp + pool + sky + ringLight + amb) * ao;
  col += FG * 0.008 * pow(1.0 - facing, 6.0) * ao;                         // warm rim highlight

  // seams of light, sparse
  vec3 em = vec3(0.0);
  if (mat == M_RIB) {
    float inner = 1.0 - smoothstep(0.03, 0.10 + px, abs(fs + 0.65));
    em += PLANET * 0.6 * inner * line(mod(q.z, 5.0) - 2.5, 0.04, px);
  } else if (mat == M_GATE) {
    float inner = 1.0 - smoothstep(0.03, 0.12 + px, abs(fs + 1.1));
    float zg = mod(q.z, 25.0) - 12.5;
    em += PLANET * 3.5 * inner * (line(zg - 0.4, 0.05, px) + line(zg + 0.4, 0.05, px));
    float dots = line(mod(q.x + q.w + 0.6, 1.2) - 0.6, 0.14, px) * line(zg, 0.14, px) * inner;
    em += (q.y > 2.5 ? ACID * 3.0 : (q.y < -2.5 ? FG * 3.0 : vec3(0.0))) * dots;   // guide lights
  } else if (mat == M_WALL) {
    float floorish = smoothstep(0.6, 0.9, n.y);
    em += PLANET * 0.30 * line(mod(q.x, 5.0) - 2.5, 0.04, px) * floorish;   // rails, floor grid
    em += PLANET * 0.18 * line(mod(q.z, 5.0), 0.04, px) * floorish * inHall;
    em += PLANET * 2.0 * line(tunnelSect(vec3(q.x, q.y, q.w)), 0.06, px) * endWall;  // doorways
  } else if (mat == M_COL) {
    float flare = 0.7 * (smoothstep(-3.0, -7.5, q.y) + smoothstep(25.0, 29.5, q.y));
    vec3 a = abs(colLocal(q)) - 1.25 - flare;
    float mx = max(a.x, max(a.y, a.z)), mn = min(a.x, min(a.y, a.z));
    float mid = a.x + a.y + a.z - mx - mn;
    em += PLANET * 0.9 * line(mid - 0.1, 0.05, px);                        // the 4D cube's edges
  } else if (mat == M_BEAM) {
    float zh = wz(q.z, Z_HALL);
    em += FG * 1.2 * line(mod(zh, 5.0) - 2.5, 0.08, px) * step(n.y, -0.6);  // strip lights below
  } else if (mat == M_FRAME) {
    em += PLANET * (0.25 + 0.6 * pow(1.0 - facing, 2.0));                  // brighter where seen edge-on
  } else if (mat == M_RING) {
    vec4 r = ringLocal(q);
    vec2 tt = vec2(length(r.xy) - RING_R1, length(r.zw) - RING_R2);
    float s = atan(r.y, r.x) * length(r.xy);                                 // arc length round the ring
    float pxs = px / max(facing, 0.15);                                      // footprint along the surface
    em += PLANET * 0.30 * line(mod(s, 3.0) - 1.5, 0.05, pxs);
    em += PLANET * 3.0 * line(abs(tt.y) - 2.6, 0.07, pxs) * step(abs(tt.x), 1.5);
  }
  if (mat == M_RING || mat == M_FRAME || mat == M_COL)                     // acid where they pierce w = 0
    em += ACID * 1.8 * line(q.w / max(wGrad, 1e-3), 0.04, px);
  if (uDebug == 5) return sky * 0.3;
  return uDebug == 3 ? col : col + em;
}

// light scattered by the haze: brighter in the great hall and around the Ring and the gates
vec3 inscatter(vec3 rd, float tEnd, float jit) {
  const int N = 24;
  float tMax = min(tEnd, 130.0), dt = tMax / float(N);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + jit) * dt;
    vec4 q = toWorld(rd * t);
    float zh = wz(q.z, Z_HALL);
    vec2 cw = abs(mod(vec2(q.x, q.w) + 3.0, 6.0) - 3.0);
    float shaft = 0.12 + 0.88 * smoothstep(1.7, 1.0, max(cw.x, cw.y)) * smoothstep(-10.0, 30.0, q.y) * smoothstep(23.0, 19.0, abs(zh));
    float hall = smoothstep(1.0, -3.0, hallBox(q)) * shaft;
    float rg = exp(-max(ring(q), 0.0) / 2.2) * smoothstep(4.0, -4.0, chamberBox(q));
    float gate = exp(-abs(mod(q.z, 25.0) - 12.5) * 0.7) * smoothstep(-4.0, 0.0, freeSpace(q)) * smoothstep(0.0, 2.5, hallBox(q));
    float zj = wz(q.z, Z_JUNCTION);
    float shaftJ = exp(-length(vec3(q.x, zj, q.w)) * 0.6) * smoothstep(-6.0, 20.0, q.y);   // light down the junction shaft
    vec3 e = (WINE * 0.35 + TEAL * 0.2 + FG * 0.03) * 0.06 * hall + PLANET * 0.004 * rg + PLANET * 0.0016 * gate
           + (FG * 0.02 + PLANET * 0.02) * shaftJ;
    acc += e * exp(-t / FOG) * dt;
  }
  return acc;
}

vec3 render(vec3 rd, float jit) {
  float t = 0.05, mat = 0.0;
  bool hit = false;
  for (int i = 0; i < 240; i++) {
    vec2 h = map(rd * t);
    if (h.x < 0.0006 * t + 0.0008) { hit = true; mat = h.y; break; }
    t += h.x * 0.8;
    if (t > 180.0) break;
  }
  vec3 fog = fogColour(rd);
  if (uDebug == 4) {                        // material ids
    vec3 ids[8] = vec3[8](vec3(0), vec3(0.3), vec3(0, 0, 1), vec3(0, 1, 1), vec3(1, 0, 0), vec3(1, 1, 0), vec3(0, 1, 0), vec3(1, 0, 1));
    return hit ? ids[int(mat)] * (0.3 + 0.7 * exp(-t / 40.0)) : vec3(0.0);
  }
  vec3 col = hit ? mix(fog, shade(rd, t, rd * t, mat), exp(-t / FOG)) : fog;
  vec3 ins = inscatter(rd, hit ? t : 180.0, jit);
  if (uDebug == 1) return col;
  if (uDebug == 2) return ins;
  return col + ins;
}

void main() {
  float ph = uPhase;
  float zc = L * ph;
  C4 = vec4(bendX(zc) + 0.45 * sin(TAU * 2.0 * ph + 0.7), bendY(zc) + 0.3 * sin(TAU * 3.0 * ph + 1.1),
            zc, 0.7 * sin(TAU * ph + 0.4));
  // the slice turns once per loop in XW, offset so the Ring faces us as we fly through it
  R = rotXW(TAU * (ph - 0.0972));
  wGrad = length(vec3(R[0][3], R[1][3], R[2][3]));
  SUN = normalize((transpose(R) * normalize(vec4(0.3, 1.0, 0.0, 0.2))).xyz);
  COLROT = rotAxis(normalize(vec3(0.3, 1.0, 0.5)), 0.6);

  // look along the path's 4D tangent a little ahead, as seen in the slice; bank into the bends
  float za = zc + 6.0;
  vec3 f = normalize((transpose(R) * vec4(dbendX(za), dbendY(za), 1.0, 0.0)).xyz);
  float roll = -11.0 * ddbendX(zc + 3.0);
  // lift the gaze in the great hall to take in its height
  float lift = 0.13 * smoothstep(50.0, 62.0, wz(zc, 0.0) + 0.0) * smoothstep(92.0, 78.0, wz(zc, 0.0));
  f = normalize(f + vec3(0.0, lift, 0.0));
  vec3 up = vec3(sin(roll), cos(roll), 0.0);
  vec3 cr = normalize(cross(up, f));
  vec3 cu = cross(f, cr);
  float focal = 0.5 * uRes.x / tan(radians(HFOV * 0.5));

  vec3 acc = vec3(0.0);
  for (int j = 0; j < uSS; j++)
    for (int i = 0; i < uSS; i++) {
      vec2 sub = (vec2(i, j) + 0.5) / float(uSS);
      vec2 pix = gl_FragCoord.xy + sub - 0.5;
      vec2 uv = (pix - 0.5 * uRes) / focal;
      float jit = fract(sin(dot(gl_FragCoord.xy + sub, vec2(12.9898, 78.233))) * 43758.5453);
      acc += render(normalize(uv.x * cr + uv.y * cu + f), jit);
    }
  fragColor = vec4(acc / float(uSS * uSS), 1.0);
}
