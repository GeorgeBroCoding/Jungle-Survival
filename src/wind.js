import { THREE } from './core.js';
import { playerTransform } from './multiplayer.js';
import { entityRegistry } from './shake.js';
import { buildBarkSurface, buildBladeAlpha, buildClothSurface, buildFurSurface, buildGroundSurface, buildLeafCardSurface, buildLeafSurface, buildRockSurface, buildSkinSurface, buildSoftDisc, buildWaterNormal, makeCanvas, makeRamp, smoothstep, texFrom } from './textures.js';

// ---------- Wind, trampling, moss and foliage LOD ----------
// One uniform block shared by every material that sways, so the whole forest
// moves as one weather system rather than each tree keeping its own time.
// JK_TRAIL slots carry recent footfalls: the first eight are the player's
// trail, which ages and springs back, and the last four track nearby animals.
const JK_TRAIL_SLOTS = 12;
const JK_TRAIL_PLAYER = 8;
const windUniforms = {
  override: null,
  uWindTime: { value: 0 },
  uWindStrength: { value: 0.09 },
  uSunDirView: { value: new THREE.Vector3(0, 0, -1) },
  uSunTint: { value: new THREE.Color('#ffe9c4') },
  uLeafTrans: { value: 0 },
  uTrail: { value: Array.from({ length: JK_TRAIL_SLOTS }, () => new THREE.Vector4(0, -1000, 0, -1)) },
  uTrailLife: { value: 2.4 },
  uTrampleScale: { value: 1 },
  uGrassWind: { value: 0.16 },
  uMossAmount: { value: 0.55 },
  uMossColor: { value: new THREE.Color('#5c7a3a') },
  // Where the spray lands. Set to the foot of the waterfall once the river
  // profile exists; anything within a few metres of it is permanently soaked.
  uWetCenter: { value: new THREE.Vector2(0, 0) },
  uWetRadius: { value: 3.4 },
  uWetHeight: { value: 0 },
  uWetAmount: { value: 0.9 },
  uLodNear: { value: 45 },
  uLodFar: { value: 150 },
  uLodCull: { value: 0.7 },
};

const WIND_GLSL = `
  uniform float uWindTime;
  uniform float uWindStrength;
  uniform vec4 uTrail[${JK_TRAIL_SLOTS}];
  uniform float uTrailLife;
  uniform float uTrampleScale;
  // How far up the plant this vertex sits. Grass overwrites it per vertex so
  // the tip bends and the root does not; everything else leaves it at 1 and
  // moves as a whole.
  float jkBladeUp = 1.0;
  // How tall the plant actually is, in metres. Displacement has to be a
  // fraction of this, not a fixed distance: a fixed 0.3m push is a gentle lean
  // on a fern and lays a 20cm blade of grass flat on the ground.
  float jkPlantH = 1.0;

  // Displacement is applied in WORLD space, after the instance matrix. Doing it
  // in object space would rotate the sway with each card, and since the cards
  // are randomly oriented the forest would shimmer instead of lean.
  vec3 jkWind(vec3 wp) {
    // A broad wave rolling across the forest. Squaring it gives long calm
    // stretches broken by short gusts, which is what wind actually does and
    // what makes the ripple visible as it crosses the canopy.
    float travel = wp.x * 0.055 + wp.z * 0.042 - uWindTime * 0.55;
    float gust = sin(travel) * 0.5 + 0.5;
    gust = gust * gust;
    float amp = uWindStrength * (0.22 + 1.1 * gust);
    // Nothing moves at ground level; the top of the canopy moves most.
    amp *= clamp((wp.y - 0.5) * 0.16, 0.0, 1.0);
    // Scale to the plant: a small plant leans by a small distance. Without
    // this a gust that nudges a tree crown sends a blade of grass sideways by
    // several times its own height.
    amp *= jkBladeUp * jkPlantH;
    float ph = wp.x * 0.8 + wp.z * 0.95;
    return vec3(
      sin(uWindTime * 1.9 + ph) * amp,
      sin(uWindTime * 3.1 + ph * 1.7) * amp * 0.2,
      cos(uWindTime * 1.6 + ph * 1.2) * amp * 0.75
    );
  }

  // Push away from anything that has walked past recently. The push fades as
  // the footfall ages, which is the spring-back: the plant is never animated,
  // it just stops being pushed.
  vec3 jkTrample(vec3 wp) {
    // Direction is a weighted sum of the nearby footfalls, but the *amount* is
    // the single strongest one. Summing the amount piles up: walking leaves
    // eight overlapping footfalls, and a plant caught by four of them used to
    // be shoved four times as far as one footfall ever should.
    vec2 dirSum = vec2(0.0);
    float strongest = 0.0;
    for (int i = 0; i < ${JK_TRAIL_SLOTS}; i++) {
      vec4 t = uTrail[i];
      if (t.w < 0.0) continue;
      vec3 d = wp - t.xyz;
      // 3D distance on purpose: a canopy six metres up is not disturbed by
      // someone walking under it.
      float dist = length(d);
      if (dist > 1.3) continue;
      float fresh = 1.0 - clamp(t.w / uTrailLife, 0.0, 1.0);
      float near = 1.0 - smoothstep(0.2, 1.3, dist);
      float w = near * fresh;
      vec2 flat2 = d.xz;
      float fl = length(flat2);
      vec2 dir = fl > 0.001 ? flat2 / fl : vec2(1.0, 0.0);
      dirSum += dir * w;
      strongest = max(strongest, w);
    }
    float dl = length(dirSum);
    if (dl < 0.0001) return vec3(0.0);
    vec2 away = dirSum / dl;
    // A trampled plant leans most of the way over but never further than it is
    // tall, so the push is a fraction of its own height.
    float amt = strongest * jkBladeUp * jkPlantH * 0.55 * uTrampleScale;
    return vec3(away.x * amt, -0.3 * amt, away.y * amt);
  }

  float jkInstHash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }
`;

const PROJECT_WITH_WIND = [
  'vec4 mvPosition = vec4( transformed, 1.0 );',
  '#ifdef USE_BATCHING',
  '  mvPosition = batchingMatrix * mvPosition;',
  '#endif',
  '#ifdef USE_INSTANCING',
  '  mvPosition = instanceMatrix * mvPosition;',
  '#endif',
  'vec4 jkWorld = modelMatrix * mvPosition;',
  '#if defined( JK_LEAFLOD ) && defined( USE_INSTANCING )',
  // Stochastic level of detail: past uLodNear a growing random fraction of the
  // sprigs are dropped. Overdraw is what foliage actually costs, and thinning
  // the far crowns is invisible while they are a few pixels across. Dropped
  // cards are folded far below the world rather than skipped, so no chunk
  // further down the shader is left reading something that was never set.
  '  vec3 jkInstOrigin = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );',
  '  float jkDist = distance( jkWorld.xyz, cameraPosition );',
  '  float jkKeep = 1.0 - smoothstep( uLodNear, uLodFar, jkDist ) * uLodCull;',
  '  if ( jkInstHash( jkInstOrigin ) > jkKeep ) jkWorld.xyz = vec3( 0.0, -9999.0, 0.0 );',
  '#endif',
  // Rock does not move at all, and bark sways but is not trampled - walking
  // past a trunk used to bend its base a half metre out of the ground, because
  // the trample radius is 1.3m and a trunk base is well inside it.
  '#ifndef JK_STILL',
  '  #ifdef JK_NOTRAMPLE',
  '    jkWorld.xyz += jkWind( jkWorld.xyz );',
  '  #else',
  '    jkWorld.xyz += jkWind( jkWorld.xyz ) + jkTrample( jkWorld.xyz );',
  '  #endif',
  '#endif',
  '#ifdef JK_MOSS',
  '  vJkWorldPos = jkWorld.xyz;',
  '  #ifdef USE_INSTANCING',
  '    vJkWorldNormal = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );',
  '  #else',
  '    vJkWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );',
  '  #endif',
  '#endif',
  'mvPosition = viewMatrix * jkWorld;',
  'gl_Position = projectionMatrix * mvPosition;',
].join('\n');

// Light coming through a leaf rather than off it. Cheap approximation: look for
// the camera being roughly opposite the sun, and let thin edges pass more.
const LEAF_TRANSLUCENCY = [
  '#include <lights_fragment_end>',
  '#ifdef JK_TRANSLUCENT',
  '  vec3 jkView = normalize( vViewPosition );',
  '  float jkBack = max( 0.0, dot( jkView, -uSunDirView ) );',
  '  float jkThin = 1.0 - abs( dot( normalize( normal ), jkView ) );',
  '  reflectedLight.directDiffuse += uSunTint * pow( jkBack, 3.0 )',
  '    * ( 0.3 + 0.7 * jkThin ) * uLeafTrans * diffuseColor.rgb;',
  '#endif',
].join('\n');

// Moss grows on what faces the sky and stays damp, so it is keyed off the
// world normal and broken up with noise rather than painted into the texture -
// a mossy bark map would put moss on every trunk, evenly, including the
// underside of branches.
const MOSS_GLSL = `
  varying vec3 vJkWorldPos;
  varying vec3 vJkWorldNormal;
  uniform float uMossAmount;
  uniform vec2 uWetCenter;
  uniform float uWetRadius;
  uniform float uWetHeight;
  uniform float uWetAmount;
  uniform vec3 uMossColor;
  float jkHash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float jkNoise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(jkHash3(i + vec3(0,0,0)), jkHash3(i + vec3(1,0,0)), f.x),
          mix(jkHash3(i + vec3(0,1,0)), jkHash3(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(jkHash3(i + vec3(0,0,1)), jkHash3(i + vec3(1,0,1)), f.x),
          mix(jkHash3(i + vec3(0,1,1)), jkHash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

const MOSS_APPLY = [
  '#include <map_fragment>',
  '#ifdef JK_MOSS',
  '  float jkUp = clamp( vJkWorldNormal.y, 0.0, 1.0 );',
  '  float jkPatch = jkNoise3( vJkWorldPos * 0.7 );',
  '  float jkFine = jkNoise3( vJkWorldPos * 3.1 );',
  '  float jkMoss = smoothstep( 0.15, 0.8, jkUp ) * smoothstep( 0.42, 0.78, jkPatch ) * uMossAmount;',
  '  diffuseColor.rgb = mix( diffuseColor.rgb, uMossColor * ( 0.65 + 0.7 * jkFine ), jkMoss );',
  // Rock at the foot of a waterfall is permanently soaked, and wet rock is
  // darker and far glossier than dry rock. The terrain already does this for
  // the ground; without it here the boulders in the spray look like they were
  // dropped in from a different, drier scene.
  '  float jkWetD = distance( vJkWorldPos.xz, uWetCenter ) - uWetRadius;',
  '  float jkWet = clamp( 1.0 - jkWetD / 4.5, 0.0, 1.0 ) * uWetAmount;',
  '  jkWet *= smoothstep( 3.2, 0.2, vJkWorldPos.y - uWetHeight );',
  '  diffuseColor.rgb *= mix( 1.0, 0.42, jkWet );',
  '#endif',
].join('\n');

// Wet is darker AND glossier. The darkening goes in with the moss above; the
// gloss has to go in at the roughness chunk, which runs later.
const WET_ROUGHNESS = [
  '#include <roughnessmap_fragment>',
  '#ifdef JK_MOSS',
  '  float jkWetR = clamp( 1.0 - ( distance( vJkWorldPos.xz, uWetCenter ) - uWetRadius ) / 4.5, 0.0, 1.0 )',
  '    * uWetAmount * smoothstep( 3.2, 0.2, vJkWorldPos.y - uWetHeight );',
  '  roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.28 + 0.05, jkWetR );',
  '#endif',
].join('\n');

const windPatchStats = { wind: 0, windFailed: 0, trans: 0, transFailed: 0, moss: 0, mossFailed: 0,
  wet: 0, wetFailed: 0 };

// Adds the shared uniforms and whichever of the extras this material wants.
// Guarded on the chunks it rewrites, verified against three r160.
function makeWindy(mat, opts) {
  const o = opts || {};
  mat.onBeforeCompile = (shader) => {
    try {
      shader.uniforms.uWindTime = windUniforms.uWindTime;
      shader.uniforms.uWindStrength = windUniforms.uWindStrength;
      shader.uniforms.uTrail = windUniforms.uTrail;
      shader.uniforms.uTrailLife = windUniforms.uTrailLife;
      shader.uniforms.uTrampleScale = windUniforms.uTrampleScale;
      let prelude = WIND_GLSL;
      let defines = '';
      if (o.still) defines += '#define JK_STILL\n';
      if (o.noTrample) defines += '#define JK_NOTRAMPLE\n';
      if (o.leafLod) {
        shader.uniforms.uLodNear = windUniforms.uLodNear;
        shader.uniforms.uLodFar = windUniforms.uLodFar;
        shader.uniforms.uLodCull = windUniforms.uLodCull;
        prelude = 'uniform float uLodNear;\nuniform float uLodFar;\nuniform float uLodCull;\n' + prelude;
        defines += '#define JK_LEAFLOD\n';
      }
      if (o.mossy) {
        shader.uniforms.uMossAmount = windUniforms.uMossAmount;
        shader.uniforms.uMossColor = windUniforms.uMossColor;
        shader.uniforms.uWetCenter = windUniforms.uWetCenter;
        shader.uniforms.uWetRadius = windUniforms.uWetRadius;
        shader.uniforms.uWetHeight = windUniforms.uWetHeight;
        shader.uniforms.uWetAmount = windUniforms.uWetAmount;
        prelude = 'varying vec3 vJkWorldPos;\nvarying vec3 vJkWorldNormal;\n' + prelude;
        defines += '#define JK_MOSS\n';
      }
      if (shader.vertexShader.indexOf('#include <project_vertex>') !== -1) {
        shader.vertexShader = defines + prelude + '\n'
          + shader.vertexShader.replace('#include <project_vertex>', PROJECT_WITH_WIND);
        windPatchStats.wind++;
      } else {
        windPatchStats.windFailed++;
      }
      if (o.mossy) {
        if (shader.fragmentShader.indexOf('#include <map_fragment>') !== -1) {
          shader.fragmentShader = '#define JK_MOSS\n' + MOSS_GLSL + '\n'
            + shader.fragmentShader.replace('#include <map_fragment>', MOSS_APPLY);
          windPatchStats.moss++;
          if (shader.fragmentShader.indexOf('#include <roughnessmap_fragment>') !== -1) {
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <roughnessmap_fragment>', WET_ROUGHNESS);
            windPatchStats.wet++;
          } else {
            windPatchStats.wetFailed++;
          }
        } else {
          windPatchStats.mossFailed++;
        }
      }
      if (o.translucent) {
        shader.uniforms.uSunDirView = windUniforms.uSunDirView;
        shader.uniforms.uSunTint = windUniforms.uSunTint;
        shader.uniforms.uLeafTrans = windUniforms.uLeafTrans;
        if (shader.fragmentShader.indexOf('#include <lights_fragment_end>') !== -1) {
          shader.fragmentShader = '#define JK_TRANSLUCENT\nuniform vec3 uSunDirView;\n'
            + 'uniform vec3 uSunTint;\nuniform float uLeafTrans;\n'
            + shader.fragmentShader.replace('#include <lights_fragment_end>', LEAF_TRANSLUCENCY);
          windPatchStats.trans++;
        } else {
          windPatchStats.transFailed++;
        }
      }
    } catch (e) { /* plain material rather than a broken one */ }
  };
  mat.customProgramCacheKey = () => 'jk-veg-'
    + (o.translucent ? 't' : '') + (o.mossy ? 'm' : '') + (o.leafLod ? 'l' : '')
    + (o.still ? 's' : '') + (o.noTrample ? 'n' : '');
  return mat;
}

// ---------- The trample trail ----------
// Footfalls are dropped into a ring buffer as the player moves and age out;
// animals write into reserved slots every frame. Plants read the whole buffer.
function applyWindOverride() {
  if (!windUniforms.override) return;
  for (const k in windUniforms.override) {
    const u = windUniforms[k];
    if (u && typeof windUniforms.override[k] === 'number') u.value = windUniforms.override[k];
  }
}

const trailState = { idx: 0, lastX: 1e9, lastZ: 1e9 };
function updateTrampleTrail(delta) {
  const slots = windUniforms.uTrail.value;
  const life = windUniforms.uTrailLife.value;
  for (let i = 0; i < JK_TRAIL_PLAYER; i++) {
    if (slots[i].w >= 0) {
      slots[i].w += delta;
      if (slots[i].w > life) slots[i].w = -1;
    }
  }
  const px = playerTransform.position[0];
  const py = playerTransform.position[1];
  const pz = playerTransform.position[2];
  if (Math.hypot(px - trailState.lastX, pz - trailState.lastZ) > 0.3) {
    trailState.lastX = px;
    trailState.lastZ = pz;
    slots[trailState.idx % JK_TRAIL_PLAYER].set(px, py + 0.15, pz, 0);
    trailState.idx++;
  }
  // Animals get live slots rather than a trail - they are always somewhere, and
  // a boar standing in a fern should hold it open.
  let n = JK_TRAIL_PLAYER;
  for (const id in entityRegistry.animals) {
    if (n >= JK_TRAIL_SLOTS) break;
    const a = entityRegistry.animals[id];
    if (!a) continue;
    if (Math.hypot(a[0] - px, a[2] - pz) > 26) continue;
    slots[n].set(a[0], a[1] + 0.2, a[2], 0);
    n++;
  }
  for (; n < JK_TRAIL_SLOTS; n++) slots[n].w = -1;
}

// Lazily built, shared across every material that wants them. Building all of
// these up front would stall the first frame, so each is made on first access.
const SURFACES = {};
function surface(name) {
  if (SURFACES[name]) return SURFACES[name];
  let s;
  if (name === 'ground') s = buildGroundSurface(256);
  else if (name === 'bark') s = buildBarkSurface(256);
  else if (name === 'leaf') s = buildLeafSurface(256);
  else if (name === 'leafCard') s = buildLeafCardSurface(256);
  else if (name === 'rock') s = buildRockSurface(256);
  else if (name === 'skin') s = buildSkinSurface(128, makeRamp([[0, '#8a5c38'], [0.5, '#a9764e'], [1, '#c89468']]));
  else if (name === 'skinPale') s = buildSkinSurface(128, makeRamp([[0, '#b07d52'], [0.5, '#d8a878'], [1, '#efc49a']]));
  else if (name === 'cloth') s = buildClothSurface(128, makeRamp([[0, '#3d3222'], [0.5, '#5a4632'], [1, '#776046']]), 404);
  else if (name === 'hide') s = buildClothSurface(128, makeRamp([[0, '#4a3722'], [0.5, '#6b5133'], [1, '#8a6a46']]), 909);
  else if (name === 'boarFur') s = buildFurSurface(128, makeRamp([[0, '#241a12'], [0.5, '#3f2f20'], [1, '#5c4730']]), 1212);
  else if (name === 'monkeyFur') s = buildFurSurface(128, makeRamp([[0, '#3b2516'], [0.5, '#6b4a2e'], [1, '#8e6a44']]), 1313);
  else throw new Error('unknown surface ' + name);
  SURFACES[name] = s;
  return s;
}

// Building every surface costs a couple of hundred milliseconds all told. Left
// to happen lazily it lands as a stutter the moment you spawn, because that's
// when the first tree, the first person and the ground all ask for theirs at
// once. So the start screen builds them ahead of time, one per tick, which keeps
// the menu responsive and means the world is fully dressed before you see it.
const WARM_ORDER = [
  'ground', 'bark', 'leaf', 'leafCard', 'rock',
  'skin', 'skinPale', 'cloth', 'hide', 'boarFur', 'monkeyFur',
];
let warmStarted = false;
function warmSurfaces(onDone) {
  if (warmStarted) {
    if (onDone) onDone();
    return () => {};
  }
  warmStarted = true;
  let i = 0;
  let timer = null;
  const step = () => {
    if (i >= WARM_ORDER.length) {
      // The derived maps are cheap next to the surfaces they come from.
      try {
        waterNormals();
        for (const name of ['ground', 'bark', 'leaf', 'rock', 'cloth']) grainTiled(name, [1, 1]);
      } catch (e) {}
      if (onDone) onDone();
      return;
    }
    try { surface(WARM_ORDER[i]); } catch (e) {}
    i++;
    timer = setTimeout(step, 0);
  };
  timer = setTimeout(step, 0);
  return () => { if (timer) clearTimeout(timer); };
}

// Same bundle, but the tiling is per-use: a tree trunk wants bark repeating
// differently from a wooden wall. Clones share the underlying canvas upload.
function surfaceTiled(name, repeat) {
  const key = name + '@' + repeat[0] + 'x' + repeat[1];
  if (SURFACES[key]) return SURFACES[key];
  const base = surface(name);
  const out = {};
  for (const slot in base) {
    const t = base[slot].clone();
    t.needsUpdate = true;
    t.repeat.set(repeat[0], repeat[1]);
    out[slot] = t;
  }
  SURFACES[key] = out;
  return out;
}

// Tinting a full-colour albedo with a `color` just multiplies two colours and
// everything turns to mud. This strips a surface down to its light/dark grain,
// normalised around its own average, so `color` survives and only the texture's
// relief and variation come through.
const GRAIN = {};
function grainCanvasFor(name) {
  const cached = GRAIN['canvas:' + name];
  if (cached) return cached;
  const src = surface(name).map.image;
  const size = src.width;
  const d = src.getContext('2d').getImageData(0, 0, size, size).data;
  const lum = new Float32Array(size * size);
  let sum = 0;
  for (let i = 0; i < lum.length; i++) {
    const o = i * 4;
    lum[i] = (d[o] + d[o + 1] + d[o + 2]) / 765;
    sum += lum[i];
  }
  const mean = sum / lum.length || 0.5;
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < lum.length; i++) {
    const v = Math.max(0.35, Math.min(1, 0.82 + ((lum[i] - mean) / mean) * 0.3));
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(v * 255);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  GRAIN['canvas:' + name] = cv;
  return cv;
}

function grainTiled(name, repeat) {
  const key = 'grain:' + name + '@' + repeat[0] + 'x' + repeat[1];
  if (GRAIN[key]) return GRAIN[key];
  const base = surface(name);
  const out = { map: texFrom(grainCanvasFor(name), repeat, true) };
  for (const slot of ['normalMap', 'roughnessMap']) {
    const t = base[slot].clone();
    t.needsUpdate = true;
    t.repeat.set(repeat[0], repeat[1]);
    out[slot] = t;
  }
  GRAIN[key] = out;
  return out;
}

let _waterNormalA = null, _waterNormalB = null;
function waterNormals() {
  if (!_waterNormalA) {
    const cv = buildWaterNormal(256);
    _waterNormalA = texFrom(cv, [5, 5], false);
    _waterNormalB = texFrom(cv, [9, 9], false);
  }
  return [_waterNormalA, _waterNormalB];
}

let _softDisc = null;
function softDiscTexture() {
  if (!_softDisc) _softDisc = texFrom(buildSoftDisc(64), [1, 1], false);
  return _softDisc;
}

let _bladeAlpha = null;
function bladeAlphaTexture() {
  if (!_bladeAlpha) _bladeAlpha = texFrom(buildBladeAlpha(64), [1, 1], false);
  return _bladeAlpha;
}


export {
  JK_TRAIL_SLOTS,
  JK_TRAIL_PLAYER,
  windUniforms,
  WIND_GLSL,
  PROJECT_WITH_WIND,
  LEAF_TRANSLUCENCY,
  MOSS_GLSL,
  MOSS_APPLY,
  WET_ROUGHNESS,
  windPatchStats,
  makeWindy,
  applyWindOverride,
  trailState,
  updateTrampleTrail,
  SURFACES,
  surface,
  WARM_ORDER,
  warmStarted,
  warmSurfaces,
  surfaceTiled,
  GRAIN,
  grainCanvasFor,
  grainTiled,
  _waterNormalA,
  waterNormals,
  _softDisc,
  softDiscTexture,
  _bladeAlpha,
  bladeAlphaTexture,
};
