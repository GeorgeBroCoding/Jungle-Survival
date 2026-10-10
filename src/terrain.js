import { THREE, html, useEffect, useMemo, useState } from './core.js';
import { POND_BLEND_R, POND_CENTER, POND_DEPTH, POND_OVERRUN, POND_RADIUS, POND_SHORE_Y, POND_SILT_R, POND_SURFACE_Y, RIVER_BANK, RIVER_DEPTH, RIVER_FALL_H, RIVER_FALL_Z, RIVER_HALF, RIVER_STATIONS, RIVER_Z0, RIVER_Z1, riverCenterSlope, riverCenterX, riverDistance } from './data.js';
import { GRAPHICS_PRESETS, gfx } from './graphics.js';
import { useGame } from './store.js';
import { SPLAT_BODY, SPLAT_PARS, TERRAIN_LAYER_SCALE, TERRAIN_LAYER_TINT, loadTerrainSplat, terrainSplatState } from './terrainsplat.js';
import { smoothstep } from './textures.js';
import { RIVER_OVERRUN } from './water.js';
import { grainTiled, surface, surfaceTiled } from './wind.js';

// ---------- Terrain: rolling hills + a ring of distant mountains ----------
// Each entry is a smooth "bump" added to the terrain height field. Bumps are placed
// in the gaps between rival tribe camps and well clear of the base/resources/animals,
// so the core play area stays flat while the wider jungle gets real hills and mountains.
const TERRAIN_HILLS = [
  // mid-range hills
  { x: 86.1, z: 40.1, amp: 5, r: 13 },
  { x: 27.8, z: 90.9, amp: 6, r: 14 },
  { x: -43.1, z: 84.6, amp: 5, r: 13 },
  { x: -95, z: -2, amp: 6, r: 14 },
  { x: 3, z: -95, amp: 5, r: 13 },
  { x: 90.3, z: -29.4, amp: 5, r: 13 },
  // distant mountains
  { x: 172.2, z: 80.3, amp: 20, r: 40 },
  { x: 55.5, z: 181.7, amp: 22, r: 42 },
  { x: -86.3, z: 169.3, amp: 24, r: 45 },
  { x: -190, z: -3.3, amp: 20, r: 40 },
  { x: 6.6, z: -189.9, amp: 22, r: 42 },
  { x: 180.7, z: -58.7, amp: 24, r: 45 },
];

// How strongly the pond overrides the natural hills: fully inside the waterline,
// easing back to untouched terrain by POND_BLEND_R so the bank has no seam.
function pondShoreWeight(d) {
  if (d >= POND_BLEND_R) return 0;
  if (d <= POND_RADIUS) return 1;
  return smoothstep(1 - (d - POND_RADIUS) / (POND_BLEND_R - POND_RADIUS));
}

// Depth of the bowl below the shore level. Smoothstepped to exactly zero at the
// waterline, so the shore meets the water instead of the basin continuing outward
// and leaving a dry pit ringing the pond.
function pondDepth(d) {
  if (d >= POND_RADIUS) return 0;
  return POND_DEPTH * smoothstep(1 - d / POND_RADIUS);
}

// The land before the river cut it. Split out because the river's own profile
// has to be measured against the ground it is carving, and a function cannot
// ask itself what it would have been.
function baseTerrainHeight(x, z) {
  let h = 0;
  for (const hill of TERRAIN_HILLS) {
    const dx = x - hill.x;
    const dz = z - hill.z;
    const d2 = dx * dx + dz * dz;
    h += hill.amp * Math.exp(-d2 / (2 * hill.r * hill.r));
  }
  const pd = Math.hypot(x - POND_CENTER[0], z - POND_CENTER[1]);
  if (pd < POND_BLEND_R) {
    const w = pondShoreWeight(pd);
    h = h * (1 - w) + POND_SHORE_Y * w;
    h -= pondDepth(pd);
  }
  return h;
}

// Water does not run uphill, and a cut must never raise the ground it cuts. The
// profile is therefore built once, against the untouched land, and checked
// against both of those rules - see test_world.
function buildRiverProfile() {
  const n = RIVER_STATIONS;
  const nat = new Float32Array(n);
  const surf = new Float32Array(n);
  const bed = new Float32Array(n);
  const zs = new Float32Array(n);
  const rim = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = RIVER_Z0 + (RIVER_Z1 - RIVER_Z0) * (i / (n - 1));
    zs[i] = z;
    const cx = riverCenterX(z);
    nat[i] = baseTerrainHeight(cx, z);
    // What actually has to hold the water in is the rim of the cut, not the
    // ground on the centreline. A river crossing a hillside has one bank a
    // metre lower than the other, and sitting the surface at centreline height
    // pours it straight down the slope.
    const norm = 1 / Math.sqrt(1 + riverCenterSlope(z) * riverCenterSlope(z));
    let lowest = Infinity;
    for (let k = 0; k < 6; k++) {
      const off = (RIVER_BANK + (k % 3) * 1.5) * (k < 3 ? 1 : -1);
      lowest = Math.min(lowest, baseTerrainHeight(cx + off / norm, z));
    }
    rim[i] = lowest;
  }
  const fallI = Math.max(1, Math.min(n - 2, Math.round(
    ((RIVER_FALL_Z - RIVER_Z0) / (RIVER_Z1 - RIVER_Z0)) * (n - 1))));
  // Above the ledge the river hugs the hillside it is running down. Below it,
  // everything the drop bought is spent on a long gentle run into the pond.
  // The surface hugs the lip of its own banks all the way down, except at the
  // ledge, where it is pushed a whole drop lower in one station. Below the fall
  // it carries on descending, so the ravine the fall cuts fills itself back in
  // as the hillside catches up - which is how a river below a waterfall looks.
  for (let i = 0; i < n; i++) {
    let y = rim[i] - 0.12;
    if (i > 0) y = Math.min(y, surf[i - 1] - (i === fallI + 1 ? RIVER_FALL_H : 0));
    // Never below the pond it is running into.
    surf[i] = Math.max(POND_SURFACE_Y, y);
  }
  for (let i = 0; i < n; i++) {
    // A plunge pool under the fall, filling back in downstream.
    const below = i - fallI;
    const plunge = below > 0 ? 0.95 * Math.exp(-below * 0.22) : 0;
    bed[i] = Math.min(surf[i] - RIVER_DEPTH - plunge, nat[i] - 0.05);
  }
  return { n, zs, nat, rim, surf, bed, fallI, fallZ: zs[fallI], fallTop: surf[fallI],
           fallBottom: surf[Math.min(n - 1, fallI + 1)] };
}
const RIVER = buildRiverProfile();

// Station lookup. Linear in z, so it is an index and a lerp.
function riverStation(z) {
  const t = (z - RIVER_Z0) / (RIVER_Z1 - RIVER_Z0) * (RIVER.n - 1);
  const i = Math.max(0, Math.min(RIVER.n - 2, Math.floor(t)));
  return { i: i, f: Math.max(0, Math.min(1, t - i)) };
}
function riverSurfaceY(z) {
  if (z <= RIVER_Z0) return RIVER.surf[0];
  if (z >= RIVER_Z1) return RIVER.surf[RIVER.n - 1];
  const st = riverStation(z);
  // The ledge is a step, so the two stations either side of it must not be
  // blended - that would turn the waterfall into a ramp.
  if (st.i === RIVER.fallI) return st.f < 0.5 ? RIVER.surf[st.i] : RIVER.surf[st.i + 1];
  return RIVER.surf[st.i] + (RIVER.surf[st.i + 1] - RIVER.surf[st.i]) * st.f;
}
function riverBedY(z) {
  if (z <= RIVER_Z0) return RIVER.bed[0];
  if (z >= RIVER_Z1) return RIVER.bed[RIVER.n - 1];
  const st = riverStation(z);
  return RIVER.bed[st.i] + (RIVER.bed[st.i + 1] - RIVER.bed[st.i]) * st.f;
}

// Perpendicular distance to the centreline, in metres. The division by the
// slope is what turns "how far across in x" into a real distance where the
// river is running diagonally.

// The height of whatever water covers this point, or -Infinity where there is
// none. One place for "is there water here", so the spray, the ripples and the
// wading check cannot drift apart.
function waterSurfaceAt(x, z) {
  const pd = Math.hypot(x - POND_CENTER[0], z - POND_CENTER[1]);
  if (pd < POND_RADIUS + POND_OVERRUN) return POND_SURFACE_Y;
  if (z >= RIVER_Z0 && z <= RIVER_Z1 && riverDistance(x, z) < RIVER_HALF + RIVER_OVERRUN) {
    return riverSurfaceY(z);
  }
  return -Infinity;
}

function getTerrainHeight(x, z) {
  const h = baseTerrainHeight(x, z);
  const d = riverDistance(x, z);
  if (d >= RIVER_BANK) return h;
  // Flat floor out to RIVER_HALF, then banks easing back into the hillside.
  const t = Math.max(0, (d - RIVER_HALF) / (RIVER_BANK - RIVER_HALF));
  const w = smoothstep(1 - t);
  // Only ever downward: the channel is cut out of the land, never built on it.
  return Math.min(h, h * (1 - w) + riverBedY(z) * w);
}

// ---------- Biomes ----------
const BIOME_ZONES = [
  { cx: 0,    cz: 0,    r: 65,  color: [0.15, 0.35, 0.10] }, // woodland (center)
  { cx: 155,  cz: -50,  r: 115, color: [0.83, 0.73, 0.42] }, // sandy desert (NE)
  { cx: -45,  cz: -175, r: 115, color: [0.82, 0.88, 0.92] }, // snowy (N)
  { cx: -155, cz: -100, r: 110, color: [0.50, 0.46, 0.42] }, // rocky (W)
  { cx: 30,   cz: 175,  r: 110, color: [0.18, 0.34, 0.16] }, // swamp (S)
];
function getBiomeColor(x, z) {
  let tw = 0, r = 0, g = 0, b = 0;
  for (const zone of BIOME_ZONES) {
    const dx = x - zone.cx, dz = z - zone.cz;
    const w = Math.exp(-(dx * dx + dz * dz) / (2 * zone.r * zone.r));
    tw += w; r += zone.color[0] * w; g += zone.color[1] * w; b += zone.color[2] * w;
  }
  if (tw > 0) { r /= tw; g /= tw; b /= tw; }
  const n = Math.sin(x * 3.73 + z * 2.31) * Math.sin(z * 4.17 - x * 1.91) * 0.04;
  return [Math.min(1, Math.max(0, r + n)), Math.min(1, Math.max(0, g + n * 1.1)), Math.min(1, Math.max(0, b + n * 0.9))];
}
function getDominantBiome(x, z) {
  let bestW = -1, best = 0;
  for (let i = 0; i < BIOME_ZONES.length; i++) {
    const zone = BIOME_ZONES[i];
    const dx = x - zone.cx, dz = z - zone.cz;
    const w = Math.exp(-(dx * dx + dz * dz) / (2 * zone.r * zone.r));
    if (w > bestW) { bestW = w; best = i; }
  }
  return best; // 0=woodland, 1=sandy, 2=snow, 3=rocky, 4=swamp
}

// ---------- Shared materials ----------
// One material per surface, shared by every mesh that uses it, so the renderer
// can batch and the textures upload once.
const MATS = {};
function stdMat(name, build) {
  if (!MATS[name]) MATS[name] = build();
  return MATS[name];
}
function surfaceMat(name, surfKey, repeat, opts) {
  return stdMat(name, () => {
    // A `color` means this material is tinted, so it needs the grain variant
    // rather than the full-colour albedo.
    const s = (opts && opts.color) ? grainTiled(surfKey, repeat) : surfaceTiled(surfKey, repeat);
    return new THREE.MeshStandardMaterial(Object.assign({
      map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap,
    }, opts || {}));
  });
}

// Mean luminance of a surface's albedo, needed by the detail-blend patch below
// so the second texture layer modulates around its own average instead of
// darkening everything it touches.
const _meanCache = {};
function surfaceMeanLuma(name) {
  if (_meanCache[name] !== undefined) return _meanCache[name];
  let mean = 0.3;
  try {
    const tex = surface(name).map;
    const cv = tex.image;
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 765;
    mean = sum / (d.length / 4);
  } catch (e) {}
  _meanCache[name] = mean;
  return mean;
}

// ---------- Detail-texture shader patches ----------
// A single tiled texture either looks blurry up close or obviously repeating far
// away. These patch meshStandardMaterial to sample the same texture at two
// scales: a macro layer for the broad colour and a fine layer for the grit under
// your feet. Both patches no-op if the shader chunks aren't where we expect, so
// a three.js upgrade degrades to plain tiling rather than breaking.
// onBeforeCompile hands us the shader with its #include directives still
// unresolved, so the only thing we can test for is the directive itself. An
// earlier version also checked that the varying (`vMapUv`) was present, which
// sounded safer and was in fact the bug: the varying is declared inside
// <uv_pars_fragment> and does not exist as literal text at this point, so the
// guard failed every time and the detail blend never once ran. Verified
// against three r160: map_fragment reads vMapUv, normal_fragment_maps reads
// vNormalMapUv, and both varyings exist whenever their map is bound.
const shaderPatchStats = { map: 0, normal: 0, mapFailed: 0, normalFailed: 0 };

function patchMapDetail(shader, macro, detail, mean, strength) {
  const chunk = '#include <map_fragment>';
  if (shader.fragmentShader.indexOf(chunk) === -1) {
    shaderPatchStats.mapFailed++;
    return false;
  }
  shaderPatchStats.map++;
  shader.uniforms.uMapMacro = { value: macro };
  shader.uniforms.uMapDetail = { value: detail };
  shader.uniforms.uMapMean = { value: mean };
  shader.uniforms.uMapStrength = { value: strength };
  shader.fragmentShader = 'uniform float uMapMacro;\nuniform float uMapDetail;\nuniform float uMapMean;\nuniform float uMapStrength;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(chunk, [
    '#ifdef USE_MAP',
    '  vec4 macroTex = texture2D( map, vMapUv * uMapMacro );',
    '  float detailLuma = dot( texture2D( map, vMapUv * uMapDetail ).rgb, vec3( 0.3333 ) );',
    '  float detailMod = 1.0 + ( detailLuma - uMapMean ) * uMapStrength;',
    '  diffuseColor *= vec4( macroTex.rgb * detailMod, macroTex.a );',
    '#endif',
  ].join('\n'));
  return true;
}

function patchNormalDetail(shader, macro, detail, blend) {
  const chunk = '#include <normal_fragment_maps>';
  if (shader.fragmentShader.indexOf(chunk) === -1) {
    shaderPatchStats.normalFailed++;
    return false;
  }
  shaderPatchStats.normal++;
  shader.uniforms.uNrmMacro = { value: macro };
  shader.uniforms.uNrmDetail = { value: detail };
  shader.uniforms.uNrmBlend = { value: blend };
  shader.fragmentShader = 'uniform float uNrmMacro;\nuniform float uNrmDetail;\nuniform float uNrmBlend;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(chunk, [
    '#ifdef USE_NORMALMAP_TANGENTSPACE',
    '  vec3 nA = texture2D( normalMap, vNormalMapUv * uNrmMacro ).xyz * 2.0 - 1.0;',
    '  vec3 nB = texture2D( normalMap, vNormalMapUv * uNrmDetail ).xyz * 2.0 - 1.0;',
    // Whiteout blend: add the tangents, keep the z product. Cheap and it never
    // flattens the macro shape the way a plain mix() does.
    '  vec3 mapN = normalize( vec3( nA.xy + nB.xy * uNrmBlend, nA.z * nB.z ) );',
    '  mapN.xy *= normalScale;',
    '  normal = normalize( tbn * mapN );',
    '#endif',
  ].join('\n'));
  return true;
}

// ---------- Ground ----------
const TERRAIN_SIZE = 600;
// 200 segments over 600 units is a 3-unit grid, enough for the 18-unit pond basin
// to read as round. At 100 the basin spanned only three quads and looked faceted.
const TERRAIN_SEGMENTS = 200;

function createTerrainGeometry() {
  const geo = new THREE.BufferGeometry();
  const half = TERRAIN_SIZE / 2;
  const seg = TERRAIN_SEGMENTS;
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const silt = [0.40, 0.345, 0.25];
  for (let iz = 0; iz <= seg; iz++) {
    for (let ix = 0; ix <= seg; ix++) {
      const x = -half + (ix / seg) * TERRAIN_SIZE;
      const z = -half + (iz / seg) * TERRAIN_SIZE;
      positions.push(x, getTerrainHeight(x, z), z);
      uvs.push(ix / seg, iz / seg);
      let [cr, cg, cb] = getBiomeColor(x, z);
      // Wet silt around and under the pond. Only the 3D mesh is tinted - the map
      // raster keeps using getBiomeColor so the overhead view stays readable.
      const pd = Math.hypot(x - POND_CENTER[0], z - POND_CENTER[1]);
      if (pd < POND_SILT_R) {
        const w = smoothstep(1 - pd / POND_SILT_R);
        cr += (silt[0] - cr) * w;
        cg += (silt[1] - cg) * w;
        cb += (silt[2] - cb) * w;
      }
      colors.push(cr, cg, cb);
    }
  }
  for (let iz = 0; iz < seg; iz++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iz * (seg + 1) + ix;
      const b = a + 1;
      const c = a + (seg + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// Patch the splat shader into a standard material. It replaces the albedo,
// normal and roughness lookups and leaves everything else - lighting, the
// cascaded shadows, fog - to three, which is the whole reason this is an
// injection rather than a ShaderMaterial.
function applySplatPatch(shader, maps) {
  shader.uniforms.tSplatAlbedo = { value: maps.albedo };
  shader.uniforms.tSplatNormal = { value: maps.normal };
  shader.uniforms.tSplatOrm = { value: maps.orm };
  shader.uniforms.uLayerScale = { value: TERRAIN_LAYER_SCALE.slice() };
  shader.uniforms.uLayerTint = {
    value: TERRAIN_LAYER_TINT.reduce((acc, _, i, a) => (i % 3 ? acc
      : acc.concat([new THREE.Vector3(a[i], a[i + 1], a[i + 2])])), []),
  };
  shader.uniforms.uSplatHeightBlend = { value: 0.22 };
  shader.uniforms.uSplatMacro = { value: 0.17 };
  shader.uniforms.uPondCenter = { value: new THREE.Vector2(POND_CENTER[0], POND_CENTER[1]) };
  shader.uniforms.uPondRadius = { value: POND_RADIUS };
  shader.uniforms.uWaterLine = { value: POND_SURFACE_Y };
  shader.uniforms.uRiverZ = { value: new THREE.Vector2(RIVER_Z0, RIVER_Z1) };
  shader.uniforms.uRiverHalf = { value: RIVER_HALF };
  // The same zones getBiomeColor uses, so the ground material and the biome
  // tint cannot disagree about where the desert is.
  const zone = (i) => new THREE.Vector4(BIOME_ZONES[i].cx, BIOME_ZONES[i].cz, BIOME_ZONES[i].r, 0);
  shader.uniforms.uBiomeSand = { value: zone(1) };
  shader.uniforms.uBiomeSnow = { value: zone(2) };
  shader.uniforms.uBiomeRock = { value: zone(3) };
  shader.uniforms.uBiomeSwamp = { value: zone(4) };

  // World position and world normal, which the splat needs and the standard
  // material does not otherwise carry.
  shader.vertexShader = 'varying vec3 vSplatWorld;\nvarying vec3 vSplatNormalW;\n'
    + shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n'
      + '  vSplatWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
      + '  vSplatNormalW = normalize(mat3(modelMatrix) * objectNormal);');

  shader.fragmentShader = SPLAT_PARS + '\n' + shader.fragmentShader
    .replace('#include <map_fragment>',
      SPLAT_BODY + '\n  diffuseColor.rgb *= splatAlbedo.rgb;')
    .replace('#include <roughnessmap_fragment>',
      'float roughnessFactor = roughness * splatOrm.g;')
    .replace('#include <normal_fragment_maps>',
      // Tangent-space normal applied against the terrain's own basis. The
      // ground is close enough to horizontal that deriving the tangent from
      // world X is stable, and it avoids needing a tangent attribute.
      'vec3 splatN = splatSample(tSplatNormal, vSplatWorld, normalize(vSplatNormalW),'
      + ' float(i0), s0).xyz * m0 + splatSample(tSplatNormal, vSplatWorld,'
      + ' normalize(vSplatNormalW), float(i1), s1).xyz * m1;\n'
      + '  splatN = splatN * 2.0 - 1.0;\n'
      + '  vec3 splatT = normalize(cross(vec3(0.0, 1.0, 0.0), normal) + vec3(1e-5, 0.0, 0.0));\n'
      + '  vec3 splatB = normalize(cross(normal, splatT));\n'
      + '  normal = normalize(normal + (splatT * splatN.x + splatB * splatN.y) * 1.25);')
    .replace('#include <aomap_fragment>',
      '#include <aomap_fragment>\n'
      + '  reflectedLight.indirectDiffuse *= mix(1.0, splatOrm.r, 0.85);');
  return shader;
}

function Ground() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const geo = useMemo(() => createTerrainGeometry(), []);
  // Re-created when the textures finish loading, so the world is walkable on
  // the procedural ground from the first frame and upgrades in place.
  const [splatReady, setSplatReady] = useState(terrainSplatState.ready);
  useEffect(() => {
    if (!q.terrainSplat) return undefined;
    loadTerrainSplat(THREE);
    if (terrainSplatState.ready) { setSplatReady(true); return undefined; }
    const timer = setInterval(() => {
      if (terrainSplatState.ready) { setSplatReady(true); clearInterval(timer); }
      else if (terrainSplatState.failed) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [q.terrainSplat]);

  const useSplat = !!(q.terrainSplat && splatReady && terrainSplatState.maps);
  const mat = useMemo(() => {
    const s = surfaceTiled('ground', [1, 1]);
    const m = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.roughnessMap,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      normalScale: new THREE.Vector2(1.1, 1.1),
      envMapIntensity: 1.0,
    });
    const mean = surfaceMeanLuma('ground');
    if (useSplat) {
      const maps = terrainSplatState.maps;
      // The biome tint stays, but gently: the photographed layers carry their
      // own colour and a strong tint on top of them looks painted.
      m.onBeforeCompile = (shader) => {
        try { applySplatPatch(shader, maps); } catch (e) {}
      };
      m.customProgramCacheKey = () => 'jk-ground-splat';
    } else {
      // UVs run 0..1 across all 600 units, so these numbers are tiles per
      // world: 90 gives a ~6.7m macro tile, 520 a ~1.15m detail tile.
      m.onBeforeCompile = (shader) => {
        try {
          patchMapDetail(shader, 90, 520, mean, 0.85);
          patchNormalDetail(shader, 90, 520, 0.8);
        } catch (e) {}
      };
      m.customProgramCacheKey = () => 'jk-ground-proc';
    }
    return m;
  }, [useSplat]);
  return html`<mesh geometry=${geo} material=${mat} receiveShadow=${true} />`;
}


export {
  TERRAIN_HILLS,
  pondShoreWeight,
  pondDepth,
  baseTerrainHeight,
  buildRiverProfile,
  RIVER,
  riverStation,
  riverSurfaceY,
  riverBedY,
  waterSurfaceAt,
  getTerrainHeight,
  BIOME_ZONES,
  getBiomeColor,
  getDominantBiome,
  MATS,
  stdMat,
  surfaceMat,
  _meanCache,
  surfaceMeanLuma,
  shaderPatchStats,
  patchMapDetail,
  patchNormalDetail,
  TERRAIN_SIZE,
  TERRAIN_SEGMENTS,
  createTerrainGeometry,
  Ground,
};
