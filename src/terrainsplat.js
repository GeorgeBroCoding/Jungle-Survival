import { THREE } from './core.js';
import { smoothstep } from './textures.js';

// ============================================================
// terrainsplat.js - PBR splat-mapped ground
//
// The whole world used to be one procedural material with a vertex-colour tint
// per biome. This replaces it with six photographed CC0 layers - leaf litter,
// wet mud, moss, mossy rock, river stones, wet sand - chosen per pixel by what
// the ground is actually doing there: how steep it is, how low it sits, how
// close the water is, which biome it is in.
//
// Six layers times three maps is eighteen textures, which is more texture units
// than a fragment shader gets. They ship instead as three stacked atlases, one
// per map type, uploaded as DataArrayTextures - and because the layer index can
// be a variable in WebGL2, the shader picks layers rather than being handed a
// fixed four.
//
// Nothing here is KTX2: there is no basisu or toktx on this machine, so these
// are JPEGs. Bigger in VRAM and slower to upload than they should be, and the
// one part of the brief that cannot be met with the tools available.
// ============================================================

const TERRAIN_LAYERS = [
  'leaf litter', 'wet mud', 'moss', 'mossy rock', 'river stones', 'wet sand',
];
const TERRAIN_LAYER_COUNT = TERRAIN_LAYERS.length;
const TERRAIN_ATLAS_SIZE = 1024;

// How many world metres one tile of each layer covers. Leaf litter reads as
// litter at about a metre; rock needs to be much larger or it looks like
// gravel; stones need to be small or they look like boulders.
const TERRAIN_LAYER_SCALE = [1.6, 2.4, 1.2, 3.6, 0.9, 2.2];

// Per-layer tint. The source scans are shot in open daylight on dry ground; a
// rainforest floor is darker, damper and greener than any of them, and tinting
// the layer is honest about that where tinting the whole terrain afterwards
// would also stain the rock and the sand.
const TERRAIN_LAYER_TINT = [
  0.52, 0.47, 0.33,   // leaf litter - damp, dark, slightly olive
  0.60, 0.53, 0.42,   // wet mud
  0.52, 0.74, 0.38,   // moss - the greenest thing on the floor
  0.78, 0.80, 0.76,   // mossy rock
  0.84, 0.84, 0.80,   // river stones
  0.95, 0.90, 0.78,   // wet sand
];

const terrainSplatState = {
  ready: false,
  failed: null,
  maps: null,
  loading: false,
};

// Slice a vertically stacked atlas into a DataArrayTexture. Canvas is the only
// way to get at decoded pixels in a browser, so the image is drawn once and
// read back a layer at a time.
function atlasToArrayTexture(THREE, img, layers, srgb) {
  const size = TERRAIN_ATLAS_SIZE;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size * layers;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size * layers);
  const all = new Uint8Array(size * size * layers * 4);
  for (let i = 0; i < layers; i++) {
    const d = ctx.getImageData(0, i * size, size, size).data;
    all.set(d, i * size * size * 4);
  }
  const tex = new THREE.DataArrayTexture(all, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load ' + url));
    img.src = url;
  });
}

// Kicked off once, early. The terrain draws with its old procedural material
// until this resolves, so a slow or failed load costs appearance, never a
// black world.
function loadTerrainSplat(THREE) {
  if (terrainSplatState.loading || terrainSplatState.ready) return;
  terrainSplatState.loading = true;
  Promise.all([
    loadImage('./assets/terrain/albedo.jpg'),
    loadImage('./assets/terrain/normal.jpg'),
    loadImage('./assets/terrain/orm.jpg'),
  ]).then(([a, n, o]) => {
    terrainSplatState.maps = {
      albedo: atlasToArrayTexture(THREE, a, TERRAIN_LAYER_COUNT, true),
      normal: atlasToArrayTexture(THREE, n, TERRAIN_LAYER_COUNT, false),
      orm: atlasToArrayTexture(THREE, o, TERRAIN_LAYER_COUNT, false),
    };
    terrainSplatState.ready = true;
  }).catch((e) => {
    terrainSplatState.failed = String(e && e.message || e);
    // eslint-disable-next-line no-console
    console.warn('[jungle-king] terrain textures unavailable, keeping the procedural ground:',
      terrainSplatState.failed);
  });
}

// The shader. Injected into MeshStandardMaterial rather than written as a
// ShaderMaterial, because the terrain has to keep three's lighting, the
// cascaded shadows and the fog - all of which live in chunks a custom material
// would have to reimplement.
const SPLAT_PARS = `
  precision highp sampler2DArray;
  uniform sampler2DArray tSplatAlbedo;
  uniform sampler2DArray tSplatNormal;
  uniform sampler2DArray tSplatOrm;
  uniform float uLayerScale[${TERRAIN_LAYER_COUNT}];
  uniform vec3 uLayerTint[${TERRAIN_LAYER_COUNT}];
  uniform float uSplatHeightBlend;
  uniform float uSplatMacro;
  uniform vec2 uPondCenter;
  uniform float uPondRadius;
  uniform float uWaterLine;
  uniform vec2 uRiverZ;        // z range the river occupies
  uniform float uRiverHalf;
  uniform vec4 uBiomeSand;     // xy centre, z radius, w unused
  uniform vec4 uBiomeRock;
  uniform vec4 uBiomeSnow;
  uniform vec4 uBiomeSwamp;
  varying vec3 vSplatWorld;
  varying vec3 vSplatNormalW;

  // Two octaves of value noise, used only to vary the ground at a scale far
  // larger than the tile. Without it the eye finds the repeat immediately, no
  // matter how good the texture is.
  float splatHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float splatNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(splatHash(i), splatHash(i + vec2(1.0, 0.0)), f.x),
               mix(splatHash(i + vec2(0.0, 1.0)), splatHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float splatFbm(vec2 p) {
    return splatNoise(p) * 0.6 + splatNoise(p * 2.7) * 0.3 + splatNoise(p * 6.1) * 0.1;
  }

  // Distance to the nearest water, which is what actually decides whether
  // ground is wet. An earlier version used height above the waterline, and
  // since most of this world sits within a metre of it, that turned the entire
  // map into a beach.
  float splatWaterDistance(vec3 wpos) {
    float d = distance(wpos.xz, uPondCenter) - uPondRadius;
    if (wpos.z > uRiverZ.x - 16.0 && wpos.z < uRiverZ.y + 16.0) {
      float u = wpos.z - uRiverZ.y;
      float cx = 40.0 + u * 0.26 + 7.0 * sin(u * 0.075);
      float m = 0.26 + 0.525 * cos(u * 0.075);
      d = min(d, abs(wpos.x - cx) / sqrt(1.0 + m * m) - uRiverHalf);
    }
    return d;
  }

  float splatBiome(vec3 wpos, vec4 zone) {
    vec2 dv = wpos.xz - zone.xy;
    return exp(-dot(dv, dv) / (2.0 * zone.z * zone.z));
  }

  // What the ground is doing here, as six weights. No painted splat map: the
  // world is generated, so the terrain can simply be asked about itself.
  void splatWeights(vec3 wpos, vec3 wnrm, out float w[${TERRAIN_LAYER_COUNT}]) {
    float slope = 1.0 - clamp(wnrm.y, 0.0, 1.0);          // 0 flat, 1 vertical
    float waterD = splatWaterDistance(wpos);
    float wet = clamp(1.0 - waterD / 7.0, 0.0, 1.0);
    // Right at the edge, and only there, the ground is bare and sandy.
    float shore = clamp(1.0 - abs(waterD) / 3.0, 0.0, 1.0);
    float vary = splatFbm(wpos.xz * 0.035);
    float vary2 = splatFbm(wpos.xz * 0.11 + 31.7);

    float sandy = splatBiome(wpos, uBiomeSand);
    float rocky = splatBiome(wpos, uBiomeRock);
    float snowy = splatBiome(wpos, uBiomeSnow);
    float swampy = splatBiome(wpos, uBiomeSwamp);
    float forest = clamp(1.0 - sandy - rocky - snowy * 0.6, 0.0, 1.0);

    w[0] = (0.60 + vary * 0.75) * (forest + snowy * 0.5) + 0.10;   // leaf litter
    w[1] = (wet * 1.5 + swampy * 1.1) * (0.5 + vary2 * 0.8);       // mud
    w[2] = (0.70 + vary2 * 1.25) * smoothstep(0.30, 0.04, slope)
         * (forest * 1.15 + swampy * 1.0);                         // moss
    w[3] = smoothstep(0.28, 0.60, slope) * 2.4 + rocky * 1.3;      // rock
    w[4] = shore * smoothstep(0.06, 0.26, slope) * 1.4 + rocky * 0.7; // stones
    w[5] = shore * 1.8 + sandy * 2.2;                              // sand
  }

  // Sampling the layer, with triplanar projection where the ground is steep
  // enough that a flat lookup would smear.
  // Warping the lookup by a low-frequency noise before sampling. A tiling
  // texture repeats on a straight grid and the eye finds that grid instantly;
  // bending the grid costs two noise taps and breaks the lines without
  // touching the texture itself.
  vec2 splatWarp(vec2 uv, vec2 wxz) {
    return uv + vec2(splatFbm(wxz * 0.021), splatFbm(wxz * 0.021 + 57.3)) * 0.55 - 0.275;
  }

  vec4 splatSample(sampler2DArray tex, vec3 wpos, vec3 wnrm, float layer, float scale) {
    vec3 blend = abs(wnrm);
    blend = max(blend - 0.42, 0.0);
    float steep = clamp((blend.x + blend.z) * 2.2, 0.0, 1.0);
    vec4 top = texture(tex, vec3(splatWarp(wpos.xz / scale, wpos.xz), layer));
    if (steep < 0.01) return top;
    // Only pay for the side projections where they matter.
    blend /= max(blend.x + blend.y + blend.z, 1e-4);
    vec4 sideX = texture(tex, vec3(splatWarp(wpos.zy / scale, wpos.xz), layer));
    vec4 sideZ = texture(tex, vec3(splatWarp(wpos.xy / scale, wpos.xz), layer));
    vec4 tri = sideX * blend.x + top * blend.y + sideZ * blend.z;
    return mix(top, tri, steep);
  }
`;

// Height-aware blending of the two strongest layers. A linear cross-fade makes
// stones dissolve into mud; using each layer's own height lets the stones poke
// through it instead, which is the single thing that stops a splat map looking
// like a splat map.
const SPLAT_BODY = `
  float w[${TERRAIN_LAYER_COUNT}];
  splatWeights(vSplatWorld, normalize(vSplatNormalW), w);

  int i0 = 0;
  int i1 = 1;
  float b0 = -1.0;
  float b1 = -1.0;
  for (int i = 0; i < ${TERRAIN_LAYER_COUNT}; i++) {
    if (w[i] > b0) { b1 = b0; i1 = i0; b0 = w[i]; i0 = i; }
    else if (w[i] > b1) { b1 = w[i]; i1 = i; }
  }
  b0 = max(b0, 0.0001);
  b1 = max(b1, 0.0);

  float s0 = uLayerScale[i0];
  float s1 = uLayerScale[i1];
  vec4 orm0 = splatSample(tSplatOrm, vSplatWorld, normalize(vSplatNormalW), float(i0), s0);
  vec4 orm1 = splatSample(tSplatOrm, vSplatWorld, normalize(vSplatNormalW), float(i1), s1);

  // Each candidate's height, raised by how much the terrain wants that layer.
  float h0 = orm0.b + b0;
  float h1 = orm1.b + b1;
  float hi = max(h0, h1);
  float k = max(uSplatHeightBlend, 1e-4);
  float m0 = max(h0 - hi + k, 0.0);
  float m1 = max(h1 - hi + k, 0.0);
  float msum = max(m0 + m1, 1e-4);
  m0 /= msum;
  m1 /= msum;

  vec4 alb0 = splatSample(tSplatAlbedo, vSplatWorld, normalize(vSplatNormalW), float(i0), s0);
  vec4 alb1 = splatSample(tSplatAlbedo, vSplatWorld, normalize(vSplatNormalW), float(i1), s1);
  vec4 splatAlbedo = vec4(alb0.rgb * uLayerTint[i0], alb0.a) * m0
                  + vec4(alb1.rgb * uLayerTint[i1], alb1.a) * m1;
  vec4 splatOrm = orm0 * m0 + orm1 * m1;

  // Macro variation: a slow drift in brightness and warmth across tens of
  // metres, which is what the eye reads as "this is a place" rather than "this
  // is a texture".
  // Wet ground is darker and glossier: water fills the pores, so less light
  // scatters back out and more of it reflects. Both halves matter - darkening
  // alone reads as a stain, gloss alone as a plastic sheet.
  float splatWet = clamp(1.0 - splatWaterDistance(vSplatWorld) / 5.0, 0.0, 1.0);
  splatWet *= smoothstep(1.4, 0.1, vSplatWorld.y - uWaterLine);
  splatAlbedo.rgb *= mix(1.0, 0.46, splatWet);
  splatOrm.g = mix(splatOrm.g, splatOrm.g * 0.30 + 0.04, splatWet);

  float macro = splatFbm(vSplatWorld.xz * 0.012);
  splatAlbedo.rgb *= mix(1.0 - uSplatMacro, 1.0 + uSplatMacro, macro);
  splatAlbedo.rgb = mix(splatAlbedo.rgb, splatAlbedo.rgb * vec3(1.06, 1.0, 0.88), macro * 0.5);
`;

export {
  TERRAIN_LAYERS,
  TERRAIN_LAYER_COUNT,
  TERRAIN_ATLAS_SIZE,
  TERRAIN_LAYER_SCALE,
  TERRAIN_LAYER_TINT,
  terrainSplatState,
  atlasToArrayTexture,
  loadImage,
  loadTerrainSplat,
  SPLAT_PARS,
  SPLAT_BODY,
};
