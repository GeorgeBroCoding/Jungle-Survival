import { THREE, html, useEffect, useFrame, useMemo, useRef } from './core.js';
import { POND_CENTER, POND_OVERRUN, POND_RADIUS, POND_SURFACE_Y, RIVER_HALF, RIVER_Z0, RIVER_Z1, mulberry32, riverCenterSlope, riverCenterX } from './data.js';
import { GRAPHICS_PRESETS, gfx } from './graphics.js';
import { skyRuntime } from './runtime.js';
import { ATMO, ATMO_GLSL } from './sky.js';
import { useGame } from './store.js';
import { RIVER, getTerrainHeight, riverStation, riverSurfaceY } from './terrain.js';
import { fbm, greyCanvasFromField, smoothstep, texFrom } from './textures.js';
import { vegGeo, vegMat } from './vegetation.js';
import { waterNormals, windUniforms } from './wind.js';

// ---------- Water ----------
// Water is drawn in a pass of its own, after the opaque scene, out of its own
// little scene graph. That is what buys refraction: by the time the water runs,
// the colour and depth of everything behind it has already been written, so the
// shader can bend the view through the surface and tint it by how much water
// the sightline crosses. It also means the surface can be opaque and write
// depth, so fog, depth of field and the god rays treat it as a real surface
// instead of something they have to guess about.
//
// On Low there is no post chain and therefore no colour buffer to refract, so
// the same shader falls back to a plain transparent surface whose colour and
// alpha still come from the depth of water underneath. Scaled down, not
// dropped.
const JK_RIPPLE_SLOTS = 16;
const JK_RIPPLE_LIFE = 2.6;
const waterRuntime = {
  scene: null,
  uniforms: null,
  ripples: [],
  rippleIdx: 0,
  override: null,
  // Filled in by PostFX once per frame, just before the water pass.
  refractTex: null,
  depthTex: null,
  // Live counts, for the debug handle.
  // Driven by the weather system when there is one; until then the rain
  // ripple source is simply switched off.
  rain: 0,
  // 0 above the surface, 1 with the eye under it. Eased, so breaking the
  // surface is a transition rather than a switch.
  submerged: 0,
  stats: { ripples: 0, surfaces: 0, spray: 0 },
};

// A ripple is (x, z, age, strength). Strength <= 0 means the slot is free.
function resetRipples() {
  waterRuntime.ripples = [];
  for (let i = 0; i < JK_RIPPLE_SLOTS; i++) {
    waterRuntime.ripples.push(new THREE.Vector4(0, 0, 0, 0));
  }
  waterRuntime.rippleIdx = 0;
}
resetRipples();

// Oldest-first replacement: the ring always gives up the slot that has the
// least life left, so a burst of splashes never wipes out a ripple that is
// still clearly visible.
function spawnRipple(x, z, strength) {
  const r = waterRuntime.ripples;
  let slot = -1, worst = -1;
  for (let i = 0; i < r.length; i++) {
    if (r[i].w <= 0) { slot = i; break; }
    if (r[i].z > worst) { worst = r[i].z; slot = i; }
  }
  if (slot < 0) return;
  r[slot].set(x, z, 0, strength);
}

function updateRipples(delta) {
  const r = waterRuntime.ripples;
  let live = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i].w <= 0) continue;
    r[i].z += delta;
    if (r[i].z > JK_RIPPLE_LIFE) r[i].w = 0;
    else live++;
  }
  waterRuntime.stats.ripples = live;
}

// Seamless froth. Two scales of fbm, contrast-stretched so it breaks into
// clumps rather than reading as grey cloud.
let _foamNoise = null;
function foamNoise() {
  if (!_foamNoise) {
    const size = 256;
    const a = fbm(size, 5, 5, 4, 7717);
    const b = fbm(size, 13, 13, 3, 2281);
    const h = new Float32Array(size * size);
    for (let i = 0; i < h.length; i++) {
      const v = a[i] * 0.65 + b[i] * 0.35;
      h[i] = Math.max(0, Math.min(1, (v - 0.42) * 2.6));
    }
    _foamNoise = texFrom(greyCanvasFromField(h, size, 0, 1), [1, 1], false);
  }
  return _foamNoise;
}

// The swell, and the rings that spread from anything that disturbs the water.
// Both the height and its slope are closed form, so the fragment shader can ask
// for the normal directly instead of sampling the height three times.
const WATER_WAVE_GLSL = `
  uniform float uTime;
  uniform vec4 uRipples[${JK_RIPPLE_SLOTS}];
  uniform float uRippleLife;
  uniform float uSwell;
  uniform float uWindWave;   // how hard it is blowing, from the shared wind

  // Three long waves plus a short chop. The chop is what the wind actually
  // raises: a lake in a dead calm still has swell rolling across it, but the
  // small steep stuff only appears when there is weather, so its amplitude
  // comes from the same wind system the trees and grass move on.
  //
  // Crests are sharpened by pushing the sine through a power rather than by a
  // full Gerstner displacement, which would want its own normal derivation.
  // Both halves below are the same function and its exact derivative - if one
  // is edited the other has to be, or the lighting stops matching the shape.
  float jkWaveH(vec2 p, float t) {
    float chop = sin(p.x * 1.55 - p.y * 0.92 + t * 3.4) * 0.012 * uWindWave;
    chop += sin(p.x * 0.78 + p.y * 1.71 - t * 2.9) * 0.009 * uWindWave;
    return ( sin(p.x * 0.42 + t * 1.25) * 0.035
           + sin(p.y * 0.33 - t * 0.95) * 0.030
           + sin((p.x + p.y) * 0.60 + t * 1.90) * 0.015 ) * uSwell
           + chop;
  }

  vec2 jkWaveSlope(vec2 p, float t) {
    float c = cos((p.x + p.y) * 0.60 + t * 1.90) * 0.015 * 0.60;
    vec2 swell = vec2(
      cos(p.x * 0.42 + t * 1.25) * 0.035 * 0.42 + c,
      cos(p.y * 0.33 - t * 0.95) * 0.030 * 0.33 + c
    ) * uSwell;
    float c1 = cos(p.x * 1.55 - p.y * 0.92 + t * 3.4) * 0.012 * uWindWave;
    float c2 = cos(p.x * 0.78 + p.y * 1.71 - t * 2.9) * 0.009 * uWindWave;
    return swell + vec2(c1 * 1.55 + c2 * 0.78, c1 * -0.92 + c2 * 1.71);
  }

  // One expanding ring per live ripple. The ring travels outward at
  // JK_RIPPLE_SPEED and fades with age; the gaussian band is what keeps it a
  // ring instead of filling in the middle.
  float jkRippleH(vec2 p, float t) {
    float h = 0.0;
    for (int i = 0; i < ${JK_RIPPLE_SLOTS}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      float rad = r.z * 1.7;
      float e = (distance(p, r.xy) - rad) * 2.2;
      float fade = max(0.0, 1.0 - r.z / uRippleLife);
      h += sin(e * 4.0) * exp(-e * e) * fade * r.w;
    }
    return h;
  }

  vec2 jkRippleSlope(vec2 p, float t) {
    vec2 g = vec2(0.0);
    for (int i = 0; i < ${JK_RIPPLE_SLOTS}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      vec2 dv = p - r.xy;
      float d = length(dv) + 1e-4;
      float e = (d - r.z * 1.7) * 2.2;
      float band = exp(-e * e);
      float fade = max(0.0, 1.0 - r.z / uRippleLife);
      // d/dd of sin(4e) * exp(-e*e), with de/dd = 2.2
      float dh = (8.8 * cos(e * 4.0) - 4.4 * e * sin(e * 4.0)) * band * fade * r.w;
      g += (dv / d) * dh;
    }
    return g;
  }
`;

const WATER_VERT = `
  attribute float aDepth;   // metres of water under this vertex, from the terrain
  attribute vec2 aFlow;     // world-space flow direction; length is speed in m/s

  varying vec3 vWorld;
  varying float vGeoDepth;
  varying vec2 vFlow;

  ${WATER_WAVE_GLSL}

  #include <fog_pars_vertex>

  void main() {
    vGeoDepth = aDepth;
    vFlow = aFlow;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // Swell fades out in the shallows. A wave cannot be taller than the water
    // it is in, and without this the surface saws up through the shoreline.
    float room = clamp(aDepth * 2.5, 0.0, 1.0);
    wp.y += jkWaveH(wp.xz, uTime) * room + jkRippleH(wp.xz, uTime) * room;
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Built lazily: it splices in DEPTH_GLSL and ATMO_GLSL, which are declared
// further down the file, so evaluating this at module scope would hit the
// temporal dead zone.
function waterFrag(ssrSteps) {
  return `
  uniform vec2 uResolution;
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform float uSkyGain;
  uniform float uTurbidity;
  uniform float uRayleigh;
  uniform float uMieC;
  uniform float uMieG;
  uniform sampler2D tNormal;
  uniform sampler2D tFoam;
  uniform vec3 uAbsorb;      // per-channel extinction, 1/metre
  uniform vec3 uScatter;     // what the water itself glows back at you
  uniform float uNormalScale;
  uniform float uRefract;
  #ifdef JK_SSR
    uniform mat4 uViewProj;
    uniform mat4 uViewMatrix;
    uniform float uSsrThickness;
  #endif
  uniform float uFoamWidth;
  uniform float uFoamAmount;
  uniform float uMaxDepth;
  uniform float uOpacity;
  uniform vec3 uSunColor;
  uniform float uCaustic;

  #ifdef JK_REFRACT
    uniform sampler2D tRefract;
  #endif

  varying vec3 vWorld;
  varying float vGeoDepth;
  varying vec2 vFlow;

  ${WATER_WAVE_GLSL}
  ${ATMO_GLSL}

  #ifdef JK_DEPTHTEX
    // Linear metres from the eye, written out by a copy pass. It cannot be the
    // scene's own depth attachment: that is bound for depth testing while the
    // water draws, and sampling it at the same time is a feedback loop.
    uniform sampler2D tSceneDepth;
    uniform float uNear;
    uniform float uFar;
    float jkEyeDist(float d) {
      float ndc = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }
  #endif

  #include <fog_pars_fragment>

  #ifdef JK_CAUSTICS
  // The bright web on the bottom of a pool: sunlight focused by the lens the
  // rippling surface makes. Three rounds of domain warping fold a pair of sine
  // waves into a cellular net, and the sharp power turns its zero crossings
  // into the thin bright lines.
  float jkCaustic(vec2 p, float t) {
    vec2 q = p * 3.4;
    float v = 0.0;
    for (int i = 0; i < 3; i++) {
      q += vec2(sin(q.y * 1.7 + t * 0.6), cos(q.x * 1.5 - t * 0.5)) * 0.35;
      v += sin(q.x * 2.1 + t * 0.9) * sin(q.y * 1.9 - t * 0.7);
    }
    return pow(max(0.0, 1.0 - abs(v / 3.0)), 9.0);
  }
  #endif

  // Flow-mapped detail. Scrolling one sample along the flow stretches the
  // texture without bound, so two copies run half a cycle apart and cross-fade;
  // neither ever travels more than half a period before it is replaced.
  vec2 jkDetailSlope(vec2 p, float speed) {
    vec2 dir = speed > 0.001 ? vFlow / speed : vec2(0.0, 0.0);
    float p0 = fract(uTime * max(speed, 0.35) * 0.35);
    float p1 = fract(p0 + 0.5);
    vec2 base = p * 0.85;
    vec3 n0 = texture2D(tNormal, base - dir * p0 * 0.6 + vec2(uTime * 0.012, uTime * 0.008)).xyz;
    vec3 n1 = texture2D(tNormal, base * 2.3 - dir * p1 * 0.6 - vec2(uTime * 0.009, uTime * 0.015)).xyz;
    vec2 s0 = n0.xy * 2.0 - 1.0;
    vec2 s1 = n1.xy * 2.0 - 1.0;
    float w = abs(0.5 - p0) * 2.0;
    return mix(s0, s1, w) * uNormalScale;
  }

  void main() {
    vec2 suv = gl_FragCoord.xy / uResolution;
    vec3 V = normalize(uCamPos - vWorld);
    float speed = length(vFlow);

    vec2 slope = jkWaveSlope(vWorld.xz, uTime)
               + jkRippleSlope(vWorld.xz, uTime)
               + jkDetailSlope(vWorld.xz, speed);
    vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
    // Seen from underneath - the camera is in the pond - the surface faces the
    // other way, or the Fresnel term reads inside out.
    if (!gl_FrontFacing) N = -N;

    // How much water the sightline crosses before it hits anything. The
    // vertical distance to the terrain is the fallback; where the depth buffer
    // is available it is exact, and it also picks up rocks, legs and anything
    // else standing in the water.
    float thick = vGeoDepth;
    #ifdef JK_DEPTHTEX
      float surfZ = jkEyeDist(gl_FragCoord.z);
      float sceneZ = texture2D(tSceneDepth, suv).r;
      thick = max(0.0, sceneZ - surfZ);
    #endif
    // The water column this sightline would cross if nothing were standing in
    // it: the vertical depth, stretched by how flat the view is.
    float column = min(vGeoDepth / max(0.18, abs(V.y)), uMaxDepth);
    // Colour comes from the body of water, which is there whether or not a rock
    // or a pair of legs happens to be in the way. The measured thickness is
    // only used to soften where things poke through - taking the colour from it
    // as well means anything in the shallows bleaches the river around it.
    float tClamped = min(uMaxDepth, max(thick, column * 0.6));

    // What is behind the surface, bent by the slope of it.
    vec3 behind = uScatter;
    #ifdef JK_REFRACT
      vec2 off = N.xz * uRefract * min(1.0, thick * 0.8);
      vec2 ruv = clamp(suv + off, vec2(0.002), vec2(0.998));
      // If the bent sightline lands on something in FRONT of the water, that
      // pixel is not behind the surface at all - bleeding it in smears the
      // shoreline and anything wading. Fall back to the straight line.
      if (texture2D(tSceneDepth, ruv).r < surfZ) ruv = suv;
      behind = texture2D(tRefract, ruv).rgb;
    #endif

    #ifdef JK_CAUSTICS
      // Where this sightline lands is where the web is painted, so the pattern
      // sits on the bottom rather than on the surface.
      vec3 floorPos = vWorld - V * tClamped;
      float sunUp = clamp(uSunDir.y * 2.5, 0.0, 1.0);
      // Extra light landing on the bottom, so it is modulated by what the
      // bottom is. Added as white it paints a glowing maze over everything
      // instead of lighting the silt.
      // They need some water to be focused by, and they are gone again by the
      // time there is enough of it to scatter the light on the way down.
      float caus = jkCaustic(floorPos.xz, uTime) * uCaustic * sunUp
                 * smoothstep(0.03, 0.4, tClamped) * (1.0 - smoothstep(1.0, 3.5, tClamped));
      behind += behind * uSunColor * caus;
    #endif

    // Beer-Lambert. Red goes first, which is the whole reason deep water is
    // blue-green and a hand held just under the surface is not.
    vec3 absorb = exp(-uAbsorb * tClamped);
    vec3 through = behind * absorb + uScatter * (1.0 - absorb);

    // Reflection off the same analytic sky the dome is drawn from, so the water
    // and the sky can never disagree. The sun disc is left in: broken up by the
    // ripples it becomes the glitter path.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.001;
    vec3 sky = atmoSky(R, uSunDir, uTurbidity, uRayleigh, uMieC, uMieG, 1.0) * uSkyGain;

    #ifdef JK_SSR
      // Trees in the water. Reflecting only the sky is what makes game water
      // read as a blue sheet: at a grazing angle a real lake is a mirror, and
      // what it mirrors is the bank.
      //
      // The reflected ray is walked in world space and projected each step,
      // rather than marched in screen space, because the step then stays a
      // fixed size in metres and does not stretch out toward the horizon. The
      // scene's depth is already on hand as metres from the eye for the
      // refraction, so the hit test is a comparison, not a reconstruction.
      vec3 ssrColour = sky;
      float ssrHit = 0.0;
      {
        float stride = 0.42;
        vec3 p = vWorld + R * 0.25;
        for (int i = 0; i < ${ssrSteps}; i++) {
          p += R * stride;
          stride *= 1.18;            // coarser the further it travels
          vec4 clip = uViewProj * vec4(p, 1.0);
          if (clip.w <= 0.0) break;
          vec2 suv2 = clip.xy / clip.w * 0.5 + 0.5;
          if (suv2.x < 0.0 || suv2.x > 1.0 || suv2.y < 0.0 || suv2.y > 1.0) break;
          float rayZ = -(uViewMatrix * vec4(p, 1.0)).z;
          float sceneZ2 = texture2D(tSceneDepth, suv2).r;
          // A hit is the ray passing behind something, but only just behind:
          // further than uSsrThickness and the ray went past the back of it and
          // the "reflection" would be of a surface it never touched.
          if (rayZ > sceneZ2 && rayZ - sceneZ2 < uSsrThickness) {
            ssrColour = texture2D(tRefract, suv2).rgb;
            // Fade out at the edge of the screen, where there is simply no
            // information, and with distance, where the stride is too coarse.
            vec2 edge = abs(suv2 - 0.5) * 2.0;
            ssrHit = (1.0 - smoothstep(0.72, 1.0, max(edge.x, edge.y)))
                   * (1.0 - smoothstep(0.55, 0.95, float(i) / float(${ssrSteps})));
            break;
          }
        }
      }
      sky = mix(sky, ssrColour, ssrHit);
    #endif

    // Schlick, F0 = 0.02 for water. At a grazing angle the surface is a mirror;
    // looking straight down it is a window.
    float fres = 0.02 + 0.98 * pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 5.0);
    vec3 col = mix(through, sky, fres);

    // Froth: at the waterline, over anything shallow, and wherever the flow is
    // fast enough to break.
    // Froth is sampled in the river's own frame - stretched four to one along
    // the current and travelling with it - so broken water reads as streaks
    // being carried downstream rather than as blobs sitting on the surface.
    vec2 fdir = speed > 0.001 ? vFlow / speed : vec2(0.8, 0.6);
    vec2 fperp = vec2(-fdir.y, fdir.x);
    float froth = texture2D(tFoam, vec2(
      dot(vWorld.xz, fdir) * 0.10 - uTime * max(speed, 0.25) * 0.24,
      dot(vWorld.xz, fperp) * 0.40 + uTime * 0.012)).r;
    // The band is measured straight down, not along the sightline: a waterline
    // is a fixed width of ground, and measuring it along the view ray smeared
    // it across half the pond as soon as you looked across the water.
    // A band just inside the waterline, not a disc centred on it: at zero depth
    // the surface has already faded out, so foam painted there fades with it.
    float shore = smoothstep(0.0, 0.05, vGeoDepth)
                * (1.0 - smoothstep(uFoamWidth * 0.2, uFoamWidth, vGeoDepth));
    float white = smoothstep(0.45, 0.95, shore * (0.45 + froth * 0.95));
    // Broken water wherever the current is quick enough to tear - which on a
    // shallow stony river is most of it, not just the fastest chute.
    white += smoothstep(0.35, 1.5, speed) * smoothstep(0.3, 0.8, froth) * 0.85;
    col = mix(col, vec3(1.0, 1.02, 1.04), clamp(white, 0.0, 1.0) * uFoamAmount);

    float alpha = uOpacity;
    #ifdef JK_REFRACT
      // The surface runs past the shoreline on purpose. Where the ground is
      // above it the depth test throws it away; over the last shallow margin
      // this fades it out, so the waterline follows the actual bank instead of
      // being the rim of a drawn disc.
      if (thick < 0.004 || vGeoDepth < 0.002) discard;
      // Opaque, with the edge handled by fading back to exactly what is behind
      // it - the same thing an alpha fade would do, without giving up the depth
      // write that fog and depth of field need. Both measures matter: the
      // sightline one softens where the water meets anything standing in it,
      // the vertical one softens the waterline itself, which is otherwise a
      // geometric clip and reads as a cut.
      col = mix(behind, col, smoothstep(0.0, 0.22, thick) * smoothstep(0.0, 0.07, vGeoDepth));
      alpha = 1.0;
    #else
      alpha = mix(0.35, uOpacity, smoothstep(0.0, 1.1, thick))
            * smoothstep(0.0, 0.22, thick) * smoothstep(0.0, 0.07, vGeoDepth);
      alpha = max(alpha, clamp(white, 0.0, 1.0) * uFoamAmount * smoothstep(0.02, 0.2, vGeoDepth));
    #endif

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;
}

// A water surface knows how deep it is everywhere, because the terrain under it
// is a function we can just evaluate. That depth rides along as a vertex
// attribute, which is what lets Low - with no depth buffer to read - still
// colour the shallows differently from the middle.
function attachWaterDepth(geo, originX, originZ, surfaceY, flowFn) {
  const pos = geo.attributes.position;
  const depth = new Float32Array(pos.count);
  const flow = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = originX + pos.getX(i);
    const z = originZ + pos.getZ(i);
    depth[i] = Math.max(0, surfaceY - getTerrainHeight(x, z));
    if (flowFn) {
      const f = flowFn(x, z);
      flow[i * 2] = f[0];
      flow[i * 2 + 1] = f[1];
    }
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
  return geo;
}

function makeWaterMaterial(q) {
  const [nA] = waterNormals();
  const refracting = !!(q.waterRefract && q.post);
  const defines = {};
  if (q.post) defines.JK_DEPTHTEX = '';
  if (refracting) defines.JK_REFRACT = '';
  // Caustics need to know where the sightline hits the bottom, which is the
  // depth buffer's job. Without it there is nowhere to paint them.
  if (q.waterCaustics && q.post) defines.JK_CAUSTICS = '';
  // Screen-space reflections need both the colour of the scene before the
  // water and its depth, so they ride on the same pass refraction does.
  const ssr = refracting && (q.waterSSR | 0) > 0;
  if (ssr) defines.JK_SSR = '';
  const u = {
    uTime: { value: 0 },
    uRipples: { value: waterRuntime.ripples },
    uRippleLife: { value: JK_RIPPLE_LIFE },
    uSwell: { value: 1 },
    uWindWave: { value: 1 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSkyGain: { value: ATMO.gain },
    uTurbidity: { value: ATMO.turbidity },
    uRayleigh: { value: ATMO.rayleigh },
    uMieC: { value: ATMO.mieCoefficient },
    uMieG: { value: ATMO.mieDirectionalG },
    tNormal: { value: nA },
    tFoam: { value: foamNoise() },
    // Roughly the extinction of clear fresh water over a few metres, pushed
    // green because a jungle pool is full of algae.
    uAbsorb: { value: new THREE.Vector3(0.62, 0.21, 0.26) },
    uScatter: { value: new THREE.Color('#1d4a4a') },
    uNormalScale: { value: 0.5 },
    uRefract: { value: 0.06 },
    uFoamWidth: { value: 0.30 },
    uFoamAmount: { value: 0.8 },
    uMaxDepth: { value: 6 },
    uOpacity: { value: 0.92 },
    uSunColor: { value: new THREE.Color('#ffffff') },
    uCaustic: { value: 0.38 },
    uViewProj: { value: new THREE.Matrix4() },
    uViewMatrix: { value: new THREE.Matrix4() },
    uSsrThickness: { value: 1.6 },
    tRefract: { value: null },
    tSceneDepth: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 500 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    vertexShader: WATER_VERT,
    fragmentShader: waterFrag(Math.max(1, q.waterSSR | 0)),
    defines: defines,
    fog: true,
    // Refracting water does its own blending in the shader, so it can be
    // opaque and write depth - which is what lets fog, depth of field and the
    // god rays treat it as the surface it is.
    transparent: !refracting,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  // Added alongside the cloned fog uniforms, not in place of them: the renderer
  // refreshes fogColor/fogNear/fogFar through those exact objects.
  for (const k in u) m.uniforms[k] = u[k];
  waterRuntime.uniforms = m.uniforms;
  return m;
}

// The river's surface: a ribbon swept along the centreline, one row of vertices
// per station. Like the pond it is built wider than its channel, so the bank
// cuts the waterline rather than the geometry doing it.
const RIVER_OVERRUN = 2.4;
const RIVER_CROSS = 7;

function buildRiverSurface() {
  const n = RIVER.n;
  const cols = RIVER_CROSS;
  const half = RIVER_HALF + RIVER_OVERRUN;
  const pos = [], depth = [], flow = [], uv = [], idx = [];
  for (let i = 0; i < n; i++) {
    const z = RIVER.zs[i];
    const cx = riverCenterX(z);
    const m = riverCenterSlope(z);
    const norm = 1 / Math.sqrt(1 + m * m);
    // Downstream is +z, so the tangent in world xz is (slope, 1) normalised.
    const tx = m * norm, tz = norm;
    // Grade drives how fast it looks: a slack stretch barely moves, the run up
    // to the ledge races.
    const j = Math.min(n - 1, i + 1);
    const dz = Math.max(0.01, RIVER.zs[j] - RIVER.zs[i]);
    const grade = i === RIVER.fallI ? 0.2 : Math.max(0, (RIVER.surf[i] - RIVER.surf[j]) / dz);
    const speed = Math.min(2.6, 0.75 + grade * 16);
    const y = RIVER.surf[i];
    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1) * 2 - 1;        // -1..1 across
      const off = t * half;
      const x = cx + off / norm;
      pos.push(x, y, z);
      depth.push(Math.max(0, y - getTerrainHeight(x, z)));
      flow.push(tx * speed, tz * speed);
      uv.push((t + 1) * 0.5, i / (n - 1));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    // No quad across the ledge: that span is the waterfall, and stretching the
    // surface over it would turn the drop into a ramp.
    if (i === RIVER.fallI) continue;
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
  g.computeVertexNormals();
  return g;
}

// The sheet itself. Hung from the lip, leaning out a little, and widening as it
// falls - water thrown off a ledge spreads.
function buildWaterfallSheet() {
  const i = RIVER.fallI;
  const zTop = RIVER.zs[i];
  const zBot = RIVER.zs[Math.min(RIVER.n - 1, i + 1)];
  const yTop = RIVER.surf[i];
  const yBot = RIVER.surf[Math.min(RIVER.n - 1, i + 1)] - 0.1;
  const rows = 8, cols = 5;
  const pos = [], uv = [], idx = [];
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);              // 0 at the lip, 1 at the base
    // Falling water accelerates, so it covers the last of the drop in much less
    // horizontal distance than the first.
    const fall = v * v * 0.75 + v * 0.25;
    const y = yTop + (yBot - yTop) * fall;
    const z = zTop + (zBot - zTop) * (0.25 + v * 0.75);
    const cx = riverCenterX(z);
    const m = riverCenterSlope(z);
    const norm = 1 / Math.sqrt(1 + m * m);
    const half = RIVER_HALF * (0.86 + v * 0.3);
    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1) * 2 - 1;
      pos.push(cx + t * half / norm, y, z);
      uv.push((t + 1) * 0.5, v);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

const WATERFALL_VERT = `
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 mvPosition = viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Falling water is mostly air. There is no point refracting through it or
// reflecting a sky off it: what you actually see is streaks of aeration, solid
// at the lip and shredding into spray by the time they reach the bottom.
const WATERFALL_FRAG = `
  uniform float uTime;
  uniform sampler2D tFoam;
  uniform vec3 uTint;
  uniform float uOpacity;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main() {
    float a = texture2D(tFoam, vec2(vUv.x * 2.0, vUv.y * 0.55 - uTime * 0.85)).r;
    float b = texture2D(tFoam, vec2(vUv.x * 3.7 + 0.37, vUv.y * 0.95 - uTime * 1.4)).r;
    float f = a * 0.65 + b * 0.6;
    // Solid sheet at the lip, broken spray at the foot.
    float shred = smoothstep(0.15, 1.0, vUv.y);
    float m = mix(0.62 + f * 0.75, f * 1.5 - 0.1, shred);
    // Thinner at the edges, where the sheet is tearing off the rock.
    float edge = smoothstep(0.0, 0.14, vUv.x) * smoothstep(0.0, 0.14, 1.0 - vUv.x);
    // Thin out into the spray at the foot instead of ending on a straight line.
    edge *= 1.0 - smoothstep(0.78, 1.0, vUv.y) * (0.55 + f * 0.45);
    float alpha = clamp(m, 0.0, 1.0) * edge * uOpacity;
    gl_FragColor = vec4(uTint * (0.7 + f * 0.7), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// A rainbow is sunlight refracted back out of the mist at 42 degrees from the
// line opposite the sun, so it only exists when the sun is behind you and low
// enough to put that cone above the ground. Drawn as a billboard arc that fades
// out the moment either stops being true.
const RAINBOW_FRAG = `
  uniform float uStrength;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  vec3 jkSpectrum(float t) {
    // Rough but recognisable: red outside, violet inside.
    return clamp(vec3(
      1.6 - abs(t - 0.88) * 5.0,
      1.5 - abs(t - 0.58) * 4.6,
      1.5 - abs(t - 0.30) * 4.4
    ), 0.0, 1.0);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.y = p.y * 0.5 + 0.45;
    float r = length(p);
    float band = smoothstep(0.70, 0.78, r) * (1.0 - smoothstep(0.90, 0.99, r));
    float t = clamp((r - 0.78) / 0.14, 0.0, 1.0);
    float arc = step(0.0, p.y);
    gl_FragColor = vec4(jkSpectrum(t) * band * arc * uStrength, 0.0);
    gl_FragColor.a = band * arc * uStrength * 0.9;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------- What the river is carrying ----------
// A current you cannot see anything moving in does not read as a current. These
// are leaves and bits of bark riding the flow: they travel downstream at the
// local speed, drift across the channel, spin, and are put back at the source
// when they reach the pond. Cheap - one instanced mesh, a few dozen of them -
// and the single clearest signal that the river is going somewhere.
function RiverDebris() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const count = Math.max(0, (q.waterDebris | 0));
  const ref = useRef();

  const data = useMemo(() => {
    const rand = mulberry32(5512);
    const bits = [];
    for (let i = 0; i < count; i++) {
      bits.push({
        z: RIVER_Z0 + rand() * (RIVER_Z1 - RIVER_Z0),
        across: (rand() * 2 - 1) * 0.78,
        spin: (rand() - 0.5) * 2.2,
        phase: rand() * 100,
        size: 0.10 + rand() * 0.16,
        drift: (rand() - 0.5) * 0.22,
      });
    }
    return {
      bits,
      m: new THREE.Matrix4(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      e: new THREE.Euler(), s: new THREE.Vector3(), c: new THREE.Color(),
    };
  }, [count]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    const d = Math.min(0.1, delta);
    const t = state.clock.elapsedTime;
    for (let i = 0; i < data.bits.length; i++) {
      const b = data.bits[i];
      // Downstream is +z. Speed from the local grade, same number the surface
      // shader uses for its flow, so debris and water move together.
      const st = riverStation(b.z);
      const j = Math.min(RIVER.n - 1, st.i + 1);
      const dz = Math.max(0.01, RIVER.zs[j] - RIVER.zs[st.i]);
      const grade = Math.max(0, (RIVER.surf[st.i] - RIVER.surf[j]) / dz);
      const speed = Math.min(2.6, 0.75 + grade * 16);
      b.z += speed * d;
      b.across += b.drift * d;
      if (b.across > 0.92 || b.across < -0.92) b.drift = -b.drift;
      if (b.z >= RIVER_Z1) b.z = RIVER_Z0 + (b.z - RIVER_Z1);

      const cx = riverCenterX(b.z);
      const m = riverCenterSlope(b.z);
      const norm = 1 / Math.sqrt(1 + m * m);
      const x = cx + (b.across * RIVER_HALF) / norm;
      const y = riverSurfaceY(b.z) + 0.03;
      // Lying on the surface, turning slowly as it goes.
      data.e.set(-Math.PI / 2 + Math.sin(t * 1.4 + b.phase) * 0.35,
        t * b.spin * 0.5 + b.phase, Math.cos(t * 1.1 + b.phase) * 0.3);
      data.q.setFromEuler(data.e);
      data.v.set(x, y, b.z);
      data.s.set(b.size, b.size, b.size);
      data.m.compose(data.v, data.q, data.s);
      mesh.setMatrixAt(i, data.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (count === 0) return null;
  return html`<instancedMesh ref=${ref}
    args=${[vegGeo('leafCard'), vegMat('leafCard'), count]}
    castShadow=${false} receiveShadow=${false} frustumCulled=${false} />`;
}

// Console overrides, same channel as the wind: anything PostFX writes every
// frame cannot be held from outside without one.
function applyWaterOverride() {
  const o = waterRuntime.override;
  const u = waterRuntime.uniforms;
  if (!o || !u) return;
  for (const k in o) {
    if (u[k] && typeof o[k] === 'number') u[k].value = o[k];
  }
}

// The second pass. Everything behind the water has already been drawn, which is
// the whole reason this is a separate pass, and the depth buffer is still live,
// so the surface depth-tests against the world without being cleared first.
const _bowFwd = new THREE.Vector3();
function drawWater(gl, scene, camera, t, w, h) {
  const ws = waterRuntime.scene;
  const u = waterRuntime.uniforms;
  if (!ws || !u) return 0;
  // USE_FOG is a compile-time define, so the first frame where the scene's fog
  // exists has to recompile, or the water never fogs at all.
  if (ws.fog !== scene.fog) {
    ws.fog = scene.fog;
    ws.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  }
  u.uTime.value = t;
  // The chop follows the weather, not a constant. uWindStrength is the same
  // number the trees and the grass lean to, so a gust crosses the water and
  // the forest together instead of each keeping its own weather.
  if (u.uWindWave) {
    u.uWindWave.value = Math.max(0.15, windUniforms.uWindStrength.value / 0.09);
  }
  u.uResolution.value.set(w, h);
  u.uCamPos.value.copy(camera.position);
  if (u.uViewProj) {
    u.uViewMatrix.value.copy(camera.matrixWorldInverse);
    u.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }
  u.uSunDir.value.copy(skyRuntime.sunDir);
  const sunLit = Math.max(0, skyRuntime.sunI);
  if (u.uSunColor) u.uSunColor.value.copy(skyRuntime.sunColor).multiplyScalar(sunLit);
  applyWaterOverride();

  const fm = waterRuntime.fallMat;
  if (fm) {
    fm.uniforms.uTime.value = t;
    // Aerated water is white, but it is still only as bright as the light on
    // it, so the fall goes grey at dusk with everything else.
    fm.uniforms.uTint.value.copy(skyRuntime.sunColor)
      .multiplyScalar(0.22 + sunLit * 0.55).addScalar(0.1);
  }

  const bow = waterRuntime.bow;
  if (bow) {
    // A rainbow is sunlight turned back out of the mist at 42 degrees, so it
    // exists only when the sun is behind the viewer and low enough to throw
    // that cone above the ground. Both conditions, or it is not drawn.
    bow.quaternion.copy(camera.quaternion);
    camera.getWorldDirection(_bowFwd);
    const behind = -_bowFwd.dot(skyRuntime.sunDir);
    // A bow in the sky sits 42 degrees off the anti-solar point and needs a low
    // sun to clear the horizon - but this one is in spray at the foot of a
    // waterfall, which you look down into, so a high sun only dims it rather
    // than putting it out. Gating hard on sun height meant it never appeared at
    // all: this sky keeps the sun above 0.75 all day.
    const sy = skyRuntime.sunDir.y;
    const low = 1 - 0.45 * Math.max(0, Math.min(1, (sy - 0.6) / 0.3));
    const near = 1 - Math.max(0, Math.min(1, (camera.position.distanceTo(bow.position) - 14) / 42));
    bow.material.uniforms.uStrength.value =
      Math.max(0, Math.min(1, behind * 1.8 - 0.5)) * low * Math.min(1, sunLit) * near * 1.2;
  }
  // The shadow maps were rendered during the opaque pass and nothing has moved
  // since. Without this every frame renders the whole cascade twice.
  const autoShadow = gl.shadowMap.autoUpdate;
  const autoClear = gl.autoClear;
  gl.shadowMap.autoUpdate = false;
  gl.autoClear = false;
  gl.render(ws, camera);
  gl.autoClear = autoClear;
  gl.shadowMap.autoUpdate = autoShadow;
  return gl.info.render.calls;
}

function Water() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();

  // The water lives in a scene of its own so the second pass costs one tiny
  // traversal instead of walking the whole world again.
  const rig = useMemo(() => {
    const scene = new THREE.Scene();
    const seg = q.waterSegments;
    const geos = [];
    const mats = [];

    // One material for every still-or-flowing surface in the world: the only
    // difference between the pond and the river is the flow attribute.
    const mat = makeWaterMaterial(q);
    mats.push(mat);

    const pondGeo = new THREE.RingGeometry(0.02, POND_RADIUS + POND_OVERRUN, seg,
      Math.max(8, Math.round(seg / 1.6)));
    pondGeo.rotateX(-Math.PI / 2);
    attachWaterDepth(pondGeo, POND_CENTER[0], POND_CENTER[1], POND_SURFACE_Y, null);
    const pond = new THREE.Mesh(pondGeo, mat);
    pond.position.set(POND_CENTER[0], POND_SURFACE_Y, POND_CENTER[1]);
    pond.frustumCulled = false;
    scene.add(pond);
    geos.push(pondGeo);

    // The river is built in world coordinates, so its model matrix is identity
    // and the depth already baked into each vertex stays correct.
    const riverGeo = buildRiverSurface();
    const river = new THREE.Mesh(riverGeo, mat);
    river.frustumCulled = false;
    scene.add(river);
    geos.push(riverGeo);

    const fallGeo = buildWaterfallSheet();
    const fallMat = new THREE.ShaderMaterial({
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
        uTime: { value: 0 },
        tFoam: { value: foamNoise() },
        uTint: { value: new THREE.Color('#ffffff') },
        uOpacity: { value: 0.95 },
      }),
      vertexShader: WATERFALL_VERT,
      fragmentShader: WATERFALL_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const fall = new THREE.Mesh(fallGeo, fallMat);
    fall.frustumCulled = false;
    fall.renderOrder = 2;
    scene.add(fall);
    geos.push(fallGeo);
    mats.push(fallMat);

    // The rainbow lives in the mist at the foot of the fall.
    const bowZ = RIVER.zs[Math.min(RIVER.n - 1, RIVER.fallI + 1)];
    const bowGeo = new THREE.PlaneGeometry(14, 10);
    const bowMat = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 } },
      vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv;'
        + ' gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }',
      fragmentShader: RAINBOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const bow = new THREE.Mesh(bowGeo, bowMat);
    bow.position.set(riverCenterX(bowZ), RIVER.surf[RIVER.fallI + 1] + 0.6, bowZ + 3.5);
    bow.frustumCulled = false;
    bow.renderOrder = 3;
    scene.add(bow);
    geos.push(bowGeo);
    mats.push(bowMat);

    waterRuntime.scene = scene;
    waterRuntime.fallMat = fallMat;
    waterRuntime.bow = bow;
    waterRuntime.stats.surfaces = 3;
    // Tell the rock shader where the spray lands.
    windUniforms.uWetCenter.value.set(riverCenterX(bowZ), bowZ);
    windUniforms.uWetHeight.value = RIVER.surf[RIVER.fallI + 1];
    return { scene, geos, mats, mat };
  }, [q.waterSegments, q.waterRefract, q.waterCaustics, q.waterSSR, q.post]);

  useEffect(() => () => {
    for (const g of rig.geos) g.dispose();
    for (const m of rig.mats) m.dispose();
    if (waterRuntime.scene === rig.scene) {
      waterRuntime.scene = null;
      waterRuntime.uniforms = null;
      waterRuntime.fallMat = null;
      waterRuntime.bow = null;
    }
  }, [rig]);

  return null;
}

// ============================================================

export {
  JK_RIPPLE_SLOTS,
  JK_RIPPLE_LIFE,
  waterRuntime,
  resetRipples,
  spawnRipple,
  updateRipples,
  _foamNoise,
  foamNoise,
  WATER_WAVE_GLSL,
  WATER_VERT,
  waterFrag,
  attachWaterDepth,
  makeWaterMaterial,
  RIVER_OVERRUN,
  RIVER_CROSS,
  buildRiverSurface,
  buildWaterfallSheet,
  WATERFALL_VERT,
  WATERFALL_FRAG,
  RAINBOW_FRAG,
  RiverDebris,
  applyWaterOverride,
  _bowFwd,
  drawWater,
  Water,
};
