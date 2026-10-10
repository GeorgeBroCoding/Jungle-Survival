import { Animals } from './animals.js';
import { Buildings } from './buildings.js';
import { CoinDropManager, CoinDrops } from './coins.js';
import { Canvas, Fragment, THREE, html, useEffect, useFrame, useMemo, useRef, useThree } from './core.js';
import { mulberry32, riverCenterX, riverDistance } from './data.js';
import { Caves, FlyingSpears, FxEffects, GroundWeapons, LootPickups, RemotePlayer, Resources } from './entities.js';
import { GRAPHICS_PRESETS, canopyCoverAt, fireRegistry, gfx, graphicsSettings, perfStats } from './graphics.js';
import { World } from './grass.js';
import { Kito, Workbench } from './kito.js';
import { playerTransform } from './multiplayer.js';
import { Player } from './player.js';
import { ACES_GLSL, DEPTH_GLSL, postState, skyRuntime } from './runtime.js';
import { EXPOSURE_BASE, csmStats, debugClock, envRuntime, sampleSky, shadowOverride } from './sky.js';
import { StartScreen } from './startscreen.js';
import { useGame } from './store.js';
import { RIVER, baseTerrainHeight, getTerrainHeight, shaderPatchStats, waterSurfaceAt } from './terrain.js';
import { smoothstep } from './textures.js';
import { debugWarp, touchInput } from './touch.js';
import { Hud } from './touchcontrols.js';
import { DistantRaidManager, DistantRaiders, DistantTribeCamps, EscortWarriors, FriendBase, InterTribalRaidManager, InterTribalRaiders, PlayerTribeBase, PlayerWarriors, RaidManager, Raiders, TribeCamps, TribeSpawnManager } from './tribes.js';
import { drawWater, spawnRipple, updateRipples, waterRuntime } from './water.js';
import { weather } from './weather.js';
import { applyWindOverride, windPatchStats, windUniforms } from './wind.js';

// App.js - top-level composition
// Renderer setup that can't be expressed as Canvas props. Filmic tone mapping
// is what turns the raw lighting into something that reads as photographic
// rather than washed out, and it's the single biggest "realism" switch here.
// ============================================================
// postfx.js - the post-processing chain
//
// The scene is rendered into a half-float buffer instead of straight to the
// screen, which means the renderer's own tone mapping has to come off: the
// buffer holds real radiance, where the sun disc is five orders of magnitude
// brighter than shaded ground. That is the whole point - "bloom only on bright
// sources" is a threshold on values above 1, and you cannot have values above
// 1 once something has already squashed them into 0..1.
//
// Everything here is hand-written rather than pulled from a post-processing
// library. This file has no build step and no dependencies beyond the import
// map, and the passes are merged (fog, depth of field, haze, vignette, grain
// and tone mapping are one shader) to keep the pass count down.
//
// If anything fails to set up, postState.active stays false and the game
// renders the old way. There is no half-broken mode.
// ============================================================


// A fullscreen triangle beats a quad: no diagonal seam, and the GPU shades
// each pixel once instead of twice along it.
let _fsGeo = null;
function fullscreenGeo() {
  if (!_fsGeo) {
    _fsGeo = new THREE.BufferGeometry();
    _fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    _fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  }
  return _fsGeo;
}

const FS_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Shared by several passes: turn a depth sample back into a view-space point.


// ---------- SSAO ----------
// Normals are reconstructed from the depth buffer rather than rendered into a
// second buffer. That costs a little accuracy at silhouettes and saves an
// entire geometry pass, which on a scene with a thousand draw calls is the
// right trade.
const SSAO_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uTexel;
  uniform mat4 uProj;
  uniform float uRadius;
  uniform float uBias;
  uniform float uIntensity;
  uniform float uTime;
  uniform vec3 uKernel[SSAO_SAMPLES];
${DEPTH_GLSL}

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    float d = rawDepth(vUv);
    if (isSky(d)) { gl_FragColor = vec4(1.0); return; }

    vec3 p = viewPos(vUv, d);
    // Derivatives of the reconstructed position give a usable face normal.
    vec3 n = normalize(cross(dFdx(p), dFdy(p)));

    // A per-pixel rotation turns banding into noise, which the blur can clear.
    float a = hash12(vUv / uTexel) * 6.2831853;
    vec3 rvec = vec3(cos(a), sin(a), 0.0);
    vec3 t = normalize(rvec - n * dot(rvec, n));
    vec3 b = cross(n, t);
    mat3 tbn = mat3(t, b, n);

    float occ = 0.0;
    for (int i = 0; i < SSAO_SAMPLES; i++) {
      vec3 sp = p + (tbn * uKernel[i]) * uRadius;
      vec4 off = uProj * vec4(sp, 1.0);
      vec2 suv = (off.xy / off.w) * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      float sd = rawDepth(suv);
      if (isSky(sd)) continue;
      float sceneZ = viewPos(suv, sd).z;
      // Occluded when the real surface sits in front of the sample point.
      float occluded = step(sp.z + uBias, sceneZ);
      // Ignore occluders that are far away in depth, or a foreground object
      // casts a dark halo onto the distance behind it.
      float range = smoothstep(0.0, 1.0, uRadius / max(0.0001, abs(p.z - sceneZ)));
      occ += occluded * range;
    }
    occ = occ / float(SSAO_SAMPLES);
    gl_FragColor = vec4(vec3(clamp(1.0 - occ * uIntensity, 0.0, 1.0)), 1.0);
  }
`;

// Depth-aware separable blur: averages the AO term but refuses to bleed across
// an edge, which is what keeps objects from smearing their occlusion onto the
// background behind them.
const SSAO_BLUR_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tAO;
  uniform vec2 uDir;
${DEPTH_GLSL}

  void main() {
    float centre = linearDepth(rawDepth(vUv));
    float sum = 0.0;
    float wsum = 0.0;
    for (int i = -3; i <= 3; i++) {
      vec2 uv = vUv + uDir * float(i);
      float w = exp(-float(i * i) * 0.18);
      float dz = abs(linearDepth(rawDepth(uv)) - centre);
      w *= exp(-dz * dz * 2.0);
      sum += texture2D(tAO, uv).r * w;
      wsum += w;
    }
    gl_FragColor = vec4(vec3(sum / max(0.0001, wsum)), 1.0);
  }
`;

// ---------- Bloom ----------
// Only what is genuinely brighter than white blooms. In an HDR buffer that is
// the sun, the fires and the sky seen through a gap in the canopy - never a
// pale rock, which is what happens when you threshold a tone-mapped image.
const BRIGHT_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform float uThreshold;
  uniform float uKnee;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Soft knee so things do not pop into bloom as they cross the threshold.
    float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 0.0001);
    float contrib = max(soft, l - uThreshold) / max(l, 0.0001);
    gl_FragColor = vec4(c * contrib, 1.0);
  }
`;

// The scene's depth, in metres from the eye, written to a colour target. The
// water pass needs to read depth while the depth attachment it came from is
// bound for testing, and sampling an attachment of the framebuffer you are
// drawing into is a feedback loop. Linear metres also condition far better in
// half float than raw window-space depth does.
const LINEAR_DEPTH_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDepth;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float ndc = texture2D(tDepth, vUv).x * 2.0 - 1.0;
    gl_FragColor = vec4((2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear)), 0.0, 0.0, 1.0);
  }
`;

const DOWN_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  void main() {
    // Four bilinear taps on the diagonals = a 2x2 box of the source level.
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    gl_FragColor = vec4(c * 0.25, 1.0);
  }
`;

const UP_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform sampler2D tPrev;
  uniform vec2 uTexel;
  uniform float uRadius;
  void main() {
    // 3x3 tent filter. Cheap, and it is what stops the bloom looking like a
    // stack of boxes when the levels are added back together.
    vec2 o = uTexel * uRadius;
    vec3 c = texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb
           + texture2D(tSrc, vUv + vec2( 0.0,  o.y)).rgb * 2.0
           + texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb
           + texture2D(tSrc, vUv + vec2(-o.x,  0.0)).rgb * 2.0
           + texture2D(tSrc, vUv).rgb * 4.0
           + texture2D(tSrc, vUv + vec2( o.x,  0.0)).rgb * 2.0
           + texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb
           + texture2D(tSrc, vUv + vec2( 0.0, -o.y)).rgb * 2.0
           + texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb;
    gl_FragColor = vec4(c / 16.0 + texture2D(tPrev, vUv).rgb, 1.0);
  }
`;

// ---------- God rays ----------
// Radial blur of the sky toward the sun. Only pixels where the depth buffer
// says "nothing here" contribute, so the shafts are literally light coming
// through the gaps in the canopy, and the canopy itself blocks them.
const GODRAY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform vec2 uSunUv;
  uniform float uDensity;
  uniform float uDecay;
  uniform float uWeight;
${DEPTH_GLSL}

  void main() {
    vec2 uv = vUv;
    vec2 delta = (uv - uSunUv) * (uDensity / float(GODRAY_STEPS));
    float illum = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < GODRAY_STEPS; i++) {
      uv -= delta;
      vec3 s = isSky(rawDepth(uv)) ? texture2D(tScene, uv).rgb : vec3(0.0);
      acc += s * illum * uWeight;
      illum *= uDecay;
    }
    gl_FragColor = vec4(acc / float(GODRAY_STEPS), 1.0);
  }
`;

// ---------- Composite ----------
// One pass for everything that can be done per-pixel at full resolution:
// ambient occlusion, bloom, shafts, height fog, the distance blur, heat haze,
// tone mapping, vignette and grain. Merging them means one dependent texture
// read chain instead of six round trips through memory.
const COMPOSITE_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tAO;
  uniform sampler2D tRays;
  uniform vec2 uTexel;
  uniform float uExposure;
  uniform float uToneMapper;   // 0 = ACES, 1 = AgX
  uniform float uFlash;        // lightning, decaying
  uniform float uUnderwater;   // 0 above the surface, 1 below it
  uniform vec3 uUnderwaterTint;
  uniform float uUnderwaterDensity;
  uniform float uUnderwaterDepth;   // how far below the surface the eye is
  uniform float uBloom;
  uniform float uAOAmount;
  uniform float uRays;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;
  uniform float uDofStart;
  uniform float uDofRange;
  uniform float uDofAmount;
  uniform mat4 uViewInv;
  uniform vec3 uCamPos;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uFogHeight;
  uniform float uFogFalloff;
  uniform vec4 uHaze[3];     // xy = screen position, z = radius, w = strength
  uniform float uHazeTime;
${DEPTH_GLSL}
${ACES_GLSL}

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec2 uv = vUv;

    // --- heat haze: shift the lookup, not the geometry ---
    for (int i = 0; i < 3; i++) {
      vec4 h = uHaze[i];
      if (h.w <= 0.0) continue;
      vec2 d = (uv - h.xy) / max(0.0001, h.z);
      // Aspect is already baked into h.z by the caller; keep it round.
      float m = 1.0 - smoothstep(0.35, 1.0, length(d));
      if (m <= 0.0) continue;
      // Rises, so the wobble scrolls upward and is stronger higher up.
      float rise = (uv.y - h.y) / max(0.0001, h.z);
      float w = sin(uv.y * 90.0 - uHazeTime * 5.0) * cos(uv.x * 70.0 + uHazeTime * 3.1);
      uv += vec2(w, w * 0.4) * 0.0022 * m * h.w * clamp(rise + 0.4, 0.0, 1.4);
    }

    // Underwater the whole frame is sampled through a slow ripple. Doing it on
    // the fetch rather than as a tint afterwards is what makes it read as being
    // IN the water rather than looking at a blue picture of it.
    if (uUnderwater > 0.0) {
      uv += vec2(sin(uv.y * 26.0 + uTime * 1.3), cos(uv.x * 21.0 + uTime * 1.1))
          * 0.0045 * uUnderwater;
    }

    float d = rawDepth(uv);
    vec3 colour = texture2D(tScene, uv).rgb;

    // --- depth of field: only the far distance, and only a little ---
    // Six taps on a small disc, at most a few pixels across. This is the
    // "very slight" kind of defocus that stops the far treeline fizzing, not
    // a photographic bokeh.
    if (uDofAmount > 0.0 && !isSky(d)) {
      float dist = linearDepth(d);
      float blur = clamp((dist - uDofStart) / max(1.0, uDofRange), 0.0, 1.0) * uDofAmount;
      if (blur > 0.01) {
        vec2 r = uTexel * (1.0 + blur * 3.5);
        vec3 acc = colour
          + texture2D(tScene, uv + r * vec2( 1.0,  0.3)).rgb
          + texture2D(tScene, uv + r * vec2(-0.9,  0.5)).rgb
          + texture2D(tScene, uv + r * vec2( 0.2, -1.0)).rgb
          + texture2D(tScene, uv + r * vec2(-0.4, -0.9)).rgb
          + texture2D(tScene, uv + r * vec2( 0.8, -0.6)).rgb
          + texture2D(tScene, uv + r * vec2(-0.7,  0.9)).rgb;
        colour = mix(colour, acc / 7.0, blur);
      }
    }

    // --- ambient occlusion, on the shaded result ---
    if (uAOAmount > 0.0) {
      float ao = texture2D(tAO, uv).r;
      colour *= mix(1.0, ao, uAOAmount);
    }

    // --- height fog, integrated along the view ray ---
    if (uFogDensity > 0.0) {
      float dist = isSky(d) ? uFar : linearDepth(d);
      vec3 vp = viewPos(uv, d);
      vec3 world = (uViewInv * vec4(vp, 1.0)).xyz;
      vec3 ray = world - uCamPos;
      float len = min(length(ray), uFar);
      vec3 dir = len > 0.0001 ? ray / len : vec3(0.0, 1.0, 0.0);
      // Analytic integral of an exponential height falloff along the ray.
      float h0 = uCamPos.y - uFogHeight;
      float dy = dir.y;
      float fog;
      if (abs(dy) < 0.0001) {
        fog = uFogDensity * len * exp(-uFogFalloff * h0);
      } else {
        fog = uFogDensity * exp(-uFogFalloff * h0) * (1.0 - exp(-uFogFalloff * dy * len)) / (uFogFalloff * dy);
      }
      colour = mix(colour, uFogColor, clamp(1.0 - exp(-max(0.0, fog)), 0.0, 1.0));
    }

    // --- light added on top: shafts, then bloom ---
    if (uRays > 0.0) colour += texture2D(tRays, uv).rgb * uRays;
    if (uBloom > 0.0) colour += texture2D(tBloom, uv).rgb * uBloom;

    // --- exposure, tone map, encode ---
    // uToneMapper picks the transform so the two can be compared on the same
    // frame rather than argued about: 0 = ACES, 1 = AgX.
    vec3 exposed = colour * uExposure;
    vec3 mapped = lin2srgb(mix(aces(exposed), agx(exposed), uToneMapper));

    // Lightning is blue-white and flat: it washes colour out of everything for
    // the fraction of a second it lasts.
    if (uFlash > 0.0) {
      float lum = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
      mapped = mix(mapped, mix(vec3(lum), vec3(0.78, 0.86, 1.0) * lum, 0.55), uFlash * 0.8);
    }

    // --- under the surface ---
    // Water is not a blue filter over the picture: it absorbs red within a
    // couple of metres, scatters everything, and is seen through a surface
    // that will not hold still. All three are here; only the first is usually
    // bothered with, and it is the one that reads least on its own.
    if (uUnderwater > 0.0) {
      float eyeDist = isSky(d) ? uFar : linearDepth(d);
      float ext = 1.0 - exp(-eyeDist * uUnderwaterDensity);
      // How much light is left depends on how deep the eye is, not only on how
      // far it is looking.
      float gloom = exp(-uUnderwaterDepth * 0.30);
      vec3 water = uUnderwaterTint * (0.18 + 0.82 * gloom);
      mapped = mix(mapped, water, clamp(ext, 0.0, 0.96) * uUnderwater);

      // Shafts coming down through the surface.
      float shaft = sin(vUv.x * 34.0 + uTime * 0.7) * 0.5 + 0.5;
      shaft *= sin(vUv.x * 11.0 - uTime * 0.4 + vUv.y * 3.0) * 0.5 + 0.5;
      shaft = pow(shaft, 3.0) * smoothstep(0.1, 0.9, 1.0 - vUv.y) * gloom;
      mapped += uUnderwaterTint * shaft * 0.18 * uUnderwater;
      mapped *= 1.0 - 0.10 * uUnderwater;
    }

    // --- vignette, in display space so it reads the same at any exposure ---
    if (uVignette > 0.0) {
      vec2 q = (vUv - 0.5) * vec2(1.0, 0.92);
      float v = smoothstep(0.78, 0.26, length(q));
      mapped *= mix(1.0 - uVignette, 1.0, v);
    }

    // --- grain, scaled down in the highlights the way real film behaves ---
    if (uGrain > 0.0) {
      float n = hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5;
      float l = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
      mapped += n * uGrain * (1.0 - l * 0.7);
    }

    gl_FragColor = vec4(mapped, 1.0);
  }
`;

// ---------- Plumbing ----------

// Written every frame by DayNightSystem, read by the post chain. The two run
// in the same frame (lighting at priority 0, post at priority 1) so this is
// always the current frame's values, never last frame's.

function makeRT(w, h, opts) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), Object.assign({
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  }, opts || {}));
  rt.texture.colorSpace = THREE.NoColorSpace; // these hold linear radiance
  return rt;
}

// A hemisphere of sample points, denser near the origin so nearby geometry
// matters more than distant geometry.
function ssaoKernel(n) {
  const out = [];
  const rand = mulberry32(90210);
  for (let i = 0; i < n; i++) {
    let x = rand() * 2 - 1, y = rand() * 2 - 1, z = rand();
    const len = Math.hypot(x, y, z) || 1;
    let scale = i / n;
    scale = 0.1 + 0.9 * scale * scale;
    out.push(new THREE.Vector3((x / len) * scale, (y / len) * scale, (z / len) * scale));
  }
  return out;
}

function postMat(frag, uniforms, defines) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: frag,
    uniforms,
    defines: defines || {},
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function PostFX() {
  const { gl, scene, camera, size } = useThree();
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();

  // Rebuilt only when something structural changes - sample counts and mip
  // counts are #defines, so they need a new shader, but resizing does not.
  const rig = useMemo(() => {
    if (!q.post) {
      postState.active = false;
      postState.reason = 'disabled by quality preset';
      return null;
    }
    try {
      const isWebGL2 = gl.capabilities.isWebGL2 !== false;
      if (!isWebGL2) throw new Error('needs WebGL2');

      // Multisampled. Until now the canvas asked for antialiasing and never got
      // any, because the scene goes into an offscreen target and the canvas
      // setting does not reach it - every leaf cut-out and blade of grass had a
      // hard stair-stepped edge. It also unlocks alpha-to-coverage on the
      // foliage, which is the only way to get a soft edge on an alpha-tested
      // cut-out. three resolves the depth buffer along with the colour, so SSAO,
      // the god rays, the fog and the water all still read what they expect.
      const scene1 = makeRT(2, 2, { depthBuffer: true, samples: q.msaa | 0 });
      scene1.depthTexture = new THREE.DepthTexture(2, 2);
      scene1.depthTexture.format = THREE.DepthFormat;
      scene1.depthTexture.type = THREE.UnsignedIntType;

      // Water needs the colour behind it (half res is plenty - it is about to be
      // smeared by a normal map) and the scene depth as linear metres.
      const refract = makeRT(2, 2);
      const wdepth = makeRT(2, 2);

      const ao1 = makeRT(2, 2, { type: THREE.UnsignedByteType });
      const ao2 = makeRT(2, 2, { type: THREE.UnsignedByteType });
      const rays = makeRT(2, 2);
      const bright = makeRT(2, 2);
      const levels = Math.max(1, q.bloomLevels | 0);
      const down = []; const up = [];
      for (let i = 0; i < levels; i++) { down.push(makeRT(2, 2)); up.push(makeRT(2, 2)); }

      const kernel = ssaoKernel(Math.max(1, q.ssaoSamples | 0));
      const depthUniforms = () => ({
        tDepth: { value: scene1.depthTexture },
        uProjInv: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 },
        uFar: { value: 500 },
      });

      const mats = {
        ssao: postMat(SSAO_FRAG, Object.assign(depthUniforms(), {
          uTexel: { value: new THREE.Vector2() },
          uProj: { value: new THREE.Matrix4() },
          uRadius: { value: 0.7 },
          uBias: { value: 0.035 },
          uIntensity: { value: 1.25 },
          uTime: { value: 0 },
          uKernel: { value: kernel },
        }), { SSAO_SAMPLES: kernel.length }),
        blur: postMat(SSAO_BLUR_FRAG, Object.assign(depthUniforms(), {
          tAO: { value: null },
          uDir: { value: new THREE.Vector2() },
        })),
        bright: postMat(BRIGHT_FRAG, {
          tScene: { value: null },
          uThreshold: { value: 1.0 },
          uKnee: { value: 0.6 },
        }),
        down: postMat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }),
        lindepth: postMat(LINEAR_DEPTH_FRAG, {
          tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 500 },
        }),
        up: postMat(UP_FRAG, {
          tSrc: { value: null }, tPrev: { value: null },
          uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
        }),
        rays: postMat(GODRAY_FRAG, Object.assign(depthUniforms(), {
          tScene: { value: null },
          uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
          uDensity: { value: 0.9 },
          uDecay: { value: 0.96 },
          uWeight: { value: 0.9 },
        }), { GODRAY_STEPS: q.godRays ? 28 : 1 }),
        composite: postMat(COMPOSITE_FRAG, Object.assign(depthUniforms(), {
          tScene: { value: null }, tBloom: { value: null },
          tAO: { value: null }, tRays: { value: null },
          uTexel: { value: new THREE.Vector2() },
          uExposure: { value: 0.52 },
          // ACES for now. AgX has the better highlight path, but it also
          // desaturates hard, and in a frame that is almost entirely mid-green
          // that reads as colourless fog - compared side by side at noon it was
          // not close. Revisit once the grading LUT exists to put the
          // saturation back; the transform is already here behind this switch.
          uToneMapper: { value: 0 },
          uFlash: { value: 0 },
          uUnderwater: { value: 0 },
          uUnderwaterTint: { value: new THREE.Color('#123f44') },
          uUnderwaterDensity: { value: 0.085 },
          uUnderwaterDepth: { value: 0 },
          uBloom: { value: 0.0 }, uAOAmount: { value: 0.0 }, uRays: { value: 0.0 },
          uVignette: { value: 0.3 }, uGrain: { value: 0.0 }, uTime: { value: 0 },
          uDofStart: { value: 60 }, uDofRange: { value: 140 }, uDofAmount: { value: 0 },
          uViewInv: { value: new THREE.Matrix4() },
          uCamPos: { value: new THREE.Vector3() },
          uFogColor: { value: new THREE.Color() },
          uFogDensity: { value: 0 }, uFogHeight: { value: 0 }, uFogFalloff: { value: 0.22 },
          uHaze: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
          uHazeTime: { value: 0 },
        })),
      };

      const quadScene = new THREE.Scene();
      const quadCam = new THREE.Camera();
      const quadMesh = new THREE.Mesh(fullscreenGeo(), mats.composite);
      quadMesh.frustumCulled = false;
      quadScene.add(quadMesh);

      postState.active = true;
      postState.reason = 'ok';
      return { scene1, refract, wdepth, ao1, ao2, rays, bright, down, up, mats,
               quadScene, quadCam, quadMesh, levels, size: [0, 0], fog: null };
    } catch (e) {
      postState.active = false;
      postState.reason = String(e && e.message || e);
      // eslint-disable-next-line no-console
      console.warn('[jungle-king] post-processing unavailable, rendering direct:', postState.reason);
      return null;
    }
  }, [gl, q.post, q.ssaoSamples, q.bloomLevels, q.godRays, q.msaa]);

  // Materials have to output linear radiance into the HDR buffer; the chain
  // tone maps at the end. Without this the renderer would squash everything
  // into 0..1 before bloom ever saw it.
  useEffect(() => {
    if (!rig) {
      gl.toneMapping = THREE.ACESFilmicToneMapping;
      return undefined;
    }
    gl.toneMapping = THREE.NoToneMapping;
    gl.toneMappingExposure = 1;
    return () => {
      gl.toneMapping = THREE.ACESFilmicToneMapping;
      gl.setRenderTarget(null);
    };
  }, [gl, rig]);

  useEffect(() => () => {
    if (!rig) return;
    const all = [rig.scene1, rig.refract, rig.wdepth, rig.ao1, rig.ao2, rig.rays, rig.bright]
      .concat(rig.down, rig.up);
    for (const rt of all) rt.dispose();
    for (const k in rig.mats) rig.mats[k].dispose();
  }, [rig]);

  useFrame((state, delta) => {
    // Console overrides are applied here, at priority 1, because this runs
    // after every priority-0 callback. Applying them inside any one of those
    // would just let the next one overwrite them again - which it did.
    applyWindOverride();
    updateRipples(delta);
    // Taking a priority above 0 switches off react-three-fiber's own render
    // call - for the whole component, not just for the frames where we do
    // something. So when the chain is off we still have to draw the scene
    // ourselves, or the screen stays black. (It did.)
    if (!rig) {
      gl.setRenderTarget(null);
      gl.render(scene, camera);
      perfStats.draws = gl.info.render.calls;
      perfStats.tris = gl.info.render.triangles;
      // No colour buffer to refract and no depth to read, so the water falls
      // back to a transparent surface tinted by the depth it carries in its
      // own vertices. Still a second pass - it is a second scene.
      const dpr0 = gl.getPixelRatio();
      perfStats.draws += drawWater(gl, scene, camera, state.clock.elapsedTime,
        Math.max(2, Math.floor(size.width * dpr0)), Math.max(2, Math.floor(size.height * dpr0)));
      return;
    }
    const dpr = gl.getPixelRatio();
    const w = Math.max(2, Math.floor(size.width * dpr));
    const h = Math.max(2, Math.floor(size.height * dpr));
    if (rig.size[0] !== w || rig.size[1] !== h) {
      rig.size[0] = w; rig.size[1] = h;
      rig.scene1.setSize(w, h);
      rig.wdepth.setSize(w, h);
      const aw = Math.max(2, w >> 1), ah = Math.max(2, h >> 1);
      rig.refract.setSize(aw, ah);
      rig.ao1.setSize(aw, ah);
      rig.ao2.setSize(aw, ah);
      rig.rays.setSize(aw, ah);
      rig.bright.setSize(aw, ah);
      for (let i = 0; i < rig.levels; i++) {
        const s = 2 << i; // half, quarter, eighth...
        rig.down[i].setSize(Math.max(2, w / s | 0), Math.max(2, h / s | 0));
        rig.up[i].setSize(Math.max(2, w / s | 0), Math.max(2, h / s | 0));
      }
    }

    const qq = gfx();
    const m = rig.mats;
    const t = state.clock.elapsedTime;

    // --- 1. the scene itself, into HDR ---
    gl.setRenderTarget(rig.scene1);
    gl.clear();
    gl.render(scene, camera);
    // gl.info resets at the start of every render() call, so the scene's own
    // cost has to be read right here - after the chain has run it only
    // describes the last fullscreen triangle.
    perfStats.draws = gl.info.render.calls;
    perfStats.tris = gl.info.render.triangles;

    // Shared camera-dependent uniforms.
    const setDepth = (mat) => {
      mat.uniforms.tDepth.value = rig.scene1.depthTexture;
      mat.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
      mat.uniforms.uNear.value = camera.near;
      mat.uniforms.uFar.value = camera.far;
    };

    const draw = (mat, target) => {
      rig.quadMesh.material = mat;
      gl.setRenderTarget(target || null);
      gl.render(rig.quadScene, rig.quadCam);
    };

    // --- 1b. the water, in a pass of its own ---
    // Everything behind it is already drawn, so the surface can bend the view
    // through itself. The colour copy is half res - a normal map is about to
    // smear it anyway - but the depth copy is full res, because a soft
    // shoreline is a sub-pixel feature and softening it is the entire point.
    if (waterRuntime.scene && waterRuntime.uniforms) {
      const wu = waterRuntime.uniforms;
      const wantRefract = !!qq.waterRefract;
      if (wantRefract) {
        m.down.uniforms.tSrc.value = rig.scene1.texture;
        m.down.uniforms.uTexel.value.set(1 / w, 1 / h);
        draw(m.down, rig.refract);
      }
      m.lindepth.uniforms.tDepth.value = rig.scene1.depthTexture;
      m.lindepth.uniforms.uNear.value = camera.near;
      m.lindepth.uniforms.uFar.value = camera.far;
      draw(m.lindepth, rig.wdepth);
      wu.tRefract.value = wantRefract ? rig.refract.texture : null;
      wu.tSceneDepth.value = rig.wdepth.texture;
      wu.uNear.value = camera.near;
      wu.uFar.value = camera.far;
      gl.setRenderTarget(rig.scene1);
      perfStats.draws += drawWater(gl, scene, camera, t, w, h);
    }

    // --- 2. ambient occlusion at half res, then a depth-aware blur ---
    const wantAO = qq.ssaoSamples > 0;
    if (wantAO) {
      setDepth(m.ssao);
      m.ssao.uniforms.uProj.value.copy(camera.projectionMatrix);
      m.ssao.uniforms.uTexel.value.set(1 / rig.ao1.width, 1 / rig.ao1.height);
      m.ssao.uniforms.uTime.value = t;
      draw(m.ssao, rig.ao1);
      setDepth(m.blur);
      m.blur.uniforms.tAO.value = rig.ao1.texture;
      m.blur.uniforms.uDir.value.set(1 / rig.ao1.width, 0);
      draw(m.blur, rig.ao2);
      m.blur.uniforms.tAO.value = rig.ao2.texture;
      m.blur.uniforms.uDir.value.set(0, 1 / rig.ao1.height);
      draw(m.blur, rig.ao1);
    }

    // --- 3. bloom: bright pass, down the chain, then back up ---
    m.bright.uniforms.tScene.value = rig.scene1.texture;
    // The threshold has to track exposure. "Brighter than white" is a
    // statement about the final image, and a fixed threshold on linear
    // radiance would mean the whole sky blooms whenever the eye stops down.
    m.bright.uniforms.uThreshold.value = 1.0 / Math.max(0.05, skyRuntime.exposure);
    m.bright.uniforms.uKnee.value = 0.6 / Math.max(0.05, skyRuntime.exposure);
    draw(m.bright, rig.bright);
    let src = rig.bright;
    for (let i = 0; i < rig.levels; i++) {
      m.down.uniforms.tSrc.value = src.texture;
      m.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      draw(m.down, rig.down[i]);
      src = rig.down[i];
    }
    // Walk back up, adding each level onto the one below it.
    let prev = rig.down[rig.levels - 1];
    for (let i = rig.levels - 2; i >= 0; i--) {
      m.up.uniforms.tSrc.value = prev.texture;
      m.up.uniforms.tPrev.value = rig.down[i].texture;
      m.up.uniforms.uTexel.value.set(1 / prev.width, 1 / prev.height);
      draw(m.up, rig.up[i]);
      prev = rig.up[i];
    }

    // --- 4. god rays, if the sun is actually on screen ---
    let rayAmount = 0;
    if (qq.godRays && skyRuntime.sunI > 0.05) {
      _sunWorld.copy(skyRuntime.sunDir).multiplyScalar(300).add(camera.position);
      _sunProj.copy(_sunWorld).project(camera);
      // Whether the sun is in front has to be a dot product, not a test on the
      // projected z. The sun is effectively at infinity, so the point stands in
      // for it lands within rounding distance of the far plane and can tip past
      // it - which silently switched the shafts off altogether. It also matters
      // that this is checked first: project() mirrors x and y for anything
      // behind the camera, so the screen position is only meaningful once the
      // sun is known to be in front.
      camera.getWorldDirection(_camFwd);
      const inFront = _camFwd.dot(skyRuntime.sunDir) > 0.05;
      const onScreen = inFront
        && _sunProj.x > -1.6 && _sunProj.x < 1.6
        && _sunProj.y > -1.6 && _sunProj.y < 1.6;
      if (onScreen) {
        // Fade out as the sun leaves the frame, or the shafts snap off.
        const edge = Math.max(Math.abs(_sunProj.x), Math.abs(_sunProj.y));
        const fade = 1 - smoothstep(Math.max(0, Math.min(1, (edge - 0.8) / 0.8)));
        setDepth(m.rays);
        m.rays.uniforms.tScene.value = rig.scene1.texture;
        m.rays.uniforms.uSunUv.value.set(_sunProj.x * 0.5 + 0.5, _sunProj.y * 0.5 + 0.5);
        draw(m.rays, rig.rays);
        // Strongest with a low sun: that is when the light is raking through
        // the trunks rather than coming straight down through the canopy.
        const lowSun = 1 - Math.max(0, Math.min(1, skyRuntime.sunDir.y / 0.55));
        rayAmount = 0.55 * fade * (0.25 + 0.75 * lowSun);
      }
    }

    // --- 5. composite ---
    setDepth(m.composite);
    const c = m.composite.uniforms;
    c.tScene.value = rig.scene1.texture;
    c.tBloom.value = (rig.levels > 1 ? rig.up[0] : rig.down[0]).texture;
    c.tAO.value = rig.ao1.texture;
    c.tRays.value = rig.rays.texture;
    c.uTexel.value.set(1 / w, 1 / h);
    // A lightning strike as a brief exposure and cold-tint push rather than a
    // real light: a directional light bright enough to read would also have to
    // re-render every shadow cascade for the one frame it is up.
    const flash = skyRuntime.flash || 0;
    c.uExposure.value = skyRuntime.exposure * (1 + flash * 2.6);
    c.uFlash.value = flash;

    // Is the eye under water? Asked of the same function the spray and the
    // wading check use, so the three cannot disagree about where the surface
    // is. Eased rather than switched, or breaking the surface flickers.
    const eyeSurface = waterSurfaceAt(camera.position.x, camera.position.z);
    const submerged = eyeSurface === -Infinity ? 0
      : Math.max(0, Math.min(1, (eyeSurface - camera.position.y) / 0.22));
    waterRuntime.submerged += (submerged - waterRuntime.submerged)
      * Math.min(1, delta * 9);
    if (waterRuntime.submerged < 0.002) waterRuntime.submerged = 0;
    c.uUnderwater.value = waterRuntime.submerged;
    c.uUnderwaterDepth.value = eyeSurface === -Infinity ? 0
      : Math.max(0, eyeSurface - camera.position.y);
    c.uTime.value = t;
    c.uBloom.value = qq.bloom;
    c.uAOAmount.value = wantAO ? qq.aoStrength : 0;
    c.uRays.value = rayAmount;
    c.uVignette.value = qq.vignette;
    c.uGrain.value = qq.grain;
    c.uTime.value = t;
    c.uDofAmount.value = qq.dof ? 1 : 0;
    c.uDofStart.value = 55;
    c.uDofRange.value = 160;
    c.uViewInv.value.copy(camera.matrixWorld);
    c.uCamPos.value.copy(camera.position);
    c.uFogColor.value.copy(skyRuntime.fogColor);
    c.uFogDensity.value = groundFogDensity(useGame.getState().timeOfDay) * qq.heightFog;
    c.uFogHeight.value = 0.4;
    c.uFogFalloff.value = 0.30;
    c.uHazeTime.value = t;
    updateHazeUniforms(c.uHaze.value, camera, qq);
    if (postState.override) {
      for (const k in postState.override) {
        if (c[k]) c[k].value = postState.override[k];
      }
    }
    draw(m.composite, null);
  }, 1);

  return null;
}

// Scratch for the sun projection, so the frame loop allocates nothing.
const _sunWorld = new THREE.Vector3();
const _sunProj = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _hazePos = new THREE.Vector3();

// Valley mist: thickest just before dawn, gone by mid-morning, creeping back
// after sunset. Purely a function of the clock.
function groundFogDensity(t) {
  const night = t < 4.5 ? 1 : t < 7.2 ? (7.2 - t) / 2.7 : t < 17.5 ? 0 : t < 20.5 ? (t - 17.5) / 3 : 1;
  // Ungated: a window around the gaussian put a visible step in the density
  // at its edge, which made the mist pop on rather than gather. It decays to
  // nothing well inside the day on its own.
  const dawnPeak = Math.exp(-Math.pow((t - 5.8) / 1.1, 2));
  return 0.055 * night + 0.085 * dawnPeak;
}

// Project each live fire into screen space so the composite can wobble the
// pixels just above it.
function updateHazeUniforms(slots, camera, q) {
  let n = 0;
  if (q.heatHaze) {
    for (const id in fireRegistry) {
      if (n >= slots.length) break;
      const p = fireRegistry[id];
      if (!p) continue;
      _hazePos.set(p[0], p[1] + 0.9, p[2]);
      const dist = _hazePos.distanceTo(camera.position);
      if (dist > 26) continue;
      _hazePos.project(camera);
      if (_hazePos.z > 1) continue;
      const radius = Math.min(0.5, 2.6 / Math.max(1.5, dist));
      slots[n].set(_hazePos.x * 0.5 + 0.5, _hazePos.y * 0.5 + 0.5, radius,
        Math.max(0, 1 - dist / 26));
      n++;
    }
  }
  for (; n < slots.length; n++) slots[n].set(0, 0, 0, 0);
}

// A handle for driving the game from a headless browser. The only browser on
// this machine is Chrome over the DevTools protocol, so anything not reachable
// from JS simply cannot be checked - including what the renderer is actually
// doing. Read-only in practice; nothing in the game reads it back.
if (typeof window !== 'undefined') {
  window.__jk = {
    store: useGame,
    graphics: graphicsSettings,
    perf: perfStats,
    preset: gfx,
    player: playerTransform,
    canopyCoverAt,
    shaderPatchStats,
    csm: csmStats,
    windPatchStats,
    wind: windUniforms,
    water: waterRuntime,
    ripple: (x, z, a) => spawnRipple(x, z, a === undefined ? 0.05 : a),
    teleport: (x, z) => { debugWarp.x = x; debugWarp.z = z; },
    // The sky owns the clock; setting the store's timeOfDay does not move it.
    setTime: (t) => { debugClock.t = t; },
    envScale: (v) => { envRuntime.scale = v; },
    shadows: shadowOverride,
    weather,
    river: RIVER,
    riverX: riverCenterX,
    waterAt: waterSurfaceAt,
    terrain: getTerrainHeight,
    terrainBase: baseTerrainHeight,
    riverDist: riverDistance,
    // Exposed so a headless run can aim the camera. It is the same channel the
    // touch look-drag writes to, and it accumulates, so driving it from outside
    // cannot fight a real input - it just adds to it.
    look: touchInput,
    sunDir: () => ({ x: skyRuntime.sunDir.x, y: skyRuntime.sunDir.y, z: skyRuntime.sunDir.z }),
    sunOnScreen: () => {
      const v = new THREE.Vector3().copy(skyRuntime.sunDir).multiplyScalar(300).add(window.__jk.camera.position);
      v.project(window.__jk.camera);
      const f = new THREE.Vector3();
      window.__jk.camera.getWorldDirection(f);
      const inFront = f.dot(skyRuntime.sunDir) > 0.05;
      return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3), inFront,
               inFrame: inFront && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
    },
    post: postState,
    gl: null,
    scene: null,
    // The composite applies exposure now, so the renderer's own value is 1.
    exposure: () => skyRuntime.exposure,
    sky: (t) => {
      const s = sampleSky(t);
      return { sunI: s.sunI, ambI: s.ambI, hemiI: s.hemiI, star: s.star, fogN: s.fogN, fogF: s.fogF };
    },
  };
}

function onCanvasCreated(state) {
  const gl = state.gl;
  if (typeof window !== 'undefined' && window.__jk) {
    window.__jk.gl = gl;
    window.__jk.scene = state.scene;
    window.__jk.camera = state.camera;
  }
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  // DayNightSystem drives this every frame from here on (eye adaptation); this
  // is just so the very first frame isn't blown out.
  gl.toneMappingExposure = EXPOSURE_BASE * graphicsSettings.brightness;
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;
  // Shadow maps are reallocated when the quality preset changes; without this
  // the old map lingers and self-shadowing artefacts creep back in.
  gl.shadowMap.autoUpdate = true;
}

// Render resolution follows the quality preset. Changing it live (rather than
// remounting the Canvas) matters because a remount would reset the scene and
// teleport the player back to spawn.
// Samples the renderer's own counters half a second at a time. Reading
// gl.info is free; the averaging is what makes the number readable.
function PerfProbe() {
  const { gl } = useThree();
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, delta) => {
    const a = acc.current;
    a.t += delta;
    a.n += 1;
    if (a.t >= 0.5) {
      perfStats.fps = a.n / a.t;
      perfStats.ms = (a.t / a.n) * 1000;
      // With the post chain running, PostFX records these itself straight after
      // the scene pass; reading them here would catch the composite instead.
      if (!postState.active) {
        perfStats.draws = gl.info.render.calls;
        perfStats.tris = gl.info.render.triangles;
      }
      a.t = 0;
      a.n = 0;
    }
  });
  return null;
}

// A deliberately plain readout. It re-renders twice a second and only while
// it is switched on, so it can't itself be the reason the frame rate drops.

function RendererTuning() {
  const { gl } = useThree();
  const quality = useGame((s) => s.graphicsQuality);
  useEffect(() => {
    const q = GRAPHICS_PRESETS[quality] || gfx();
    const cap = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    gl.setPixelRatio(Math.min(q.dpr, cap));
  }, [gl, quality]);
  return null;
}

// ============================================================
function App() {
  const started = useGame((s) => s.started);

  if (!started) return html`<${StartScreen} />`;

  return html`
    <${Fragment}>
      <${Canvas}
        shadows=${{ type: THREE.PCFSoftShadowMap }}
        gl=${{ antialias: true, powerPreference: 'high-performance', alpha: false }}
        camera=${{ fov: 70, near: 0.1, far: 500, position: [0, 2, 14] }}
        onCreated=${onCanvasCreated}
      >
        <${RendererTuning} />
      <${PerfProbe} />
      <${PostFX} />
        <${World} />
        <${Player} />
        <${RemotePlayer} />
        <${Resources} />
        <${Caves} />
        <${LootPickups} />
        <${GroundWeapons} />
        <${FlyingSpears} />
        <${FxEffects} />
        <${Animals} />
        <${Kito} />
        <${Workbench} />
        <${PlayerTribeBase} />
        <${FriendBase} />
        <${PlayerWarriors} />
        <${EscortWarriors} />
        <${TribeCamps} />
        <${TribeSpawnManager} />
        <${DistantTribeCamps} />
        <${DistantRaiders} />
        <${DistantRaidManager} />
        <${Buildings} />
        <${Raiders} />
        <${RaidManager} />
        <${InterTribalRaiders} />
        <${InterTribalRaidManager} />
        <${CoinDrops} />
        <${CoinDropManager} />
      <//>
      <${Hud} />
    <//>
  `;
}

export {
  _fsGeo,
  fullscreenGeo,
  FS_VERT,
  SSAO_FRAG,
  SSAO_BLUR_FRAG,
  BRIGHT_FRAG,
  LINEAR_DEPTH_FRAG,
  DOWN_FRAG,
  UP_FRAG,
  GODRAY_FRAG,
  COMPOSITE_FRAG,
  makeRT,
  ssaoKernel,
  postMat,
  PostFX,
  _sunWorld,
  _sunProj,
  _camFwd,
  _hazePos,
  groundFogDensity,
  updateHazeUniforms,
  onCanvasCreated,
  PerfProbe,
  RendererTuning,
  App,
};
