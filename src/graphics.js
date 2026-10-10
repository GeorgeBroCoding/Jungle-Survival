// graphics.js - quality presets
//
// The realistic pass (instanced grass, layered terrain detail, big shadow
// maps, a live sky environment map) is not free. These presets scale the
// expensive parts so the same build runs on a laptop and on a desktop GPU.
// Everything here is applied live - no reload, and the player never moves.
// ============================================================
const GRAPHICS_KEY = 'jungleking.graphics.v1';
const GRAPHICS_PRESETS = {
  low: {
    label: 'Low', grassRadius: 12, grassPerCell: 22, foliage: 260,
    shadowMap: 1024, shadowExtent: 48, envSeconds: 0, dpr: 1.0, cascades: 1, terrainSplat: false, clutter: 0, clutterRadius: 0,
    vines: false, treeDetail: 0, waterSegments: 24,
    // Eye adaptation stays on even here: it is a grid lookup and a lerp per
    // frame with no GPU cost at all, and without it Low sits under the canopy
    // at the unadapted exposure and crushes a sixth of the frame to black.
    fireLights: 1, fireShadows: false, contactShadows: false, eyeAdapt: true,
    post: false, ssaoSamples: 0, aoStrength: 0, bloomLevels: 1, bloom: 0,
    godRays: false, dof: false, vignette: 0, grain: 0, heightFog: 0, heatHaze: false,
    dustMotes: 0, fireflies: 0, rainDrops: 0, fallingLeaves: 0,
    // Water. Refraction needs the post chain's colour buffer, so Low falls
    // back to a plain transparent surface with depth-tinted colour.
    waterRefract: false, waterSSR: 0, waterCaustics: false, waterRipples: 0,
    waterSpray: 0, waterMist: 0, waterDebris: 0, msaa: 0,
  },
  medium: {
    label: 'Medium', grassRadius: 20, grassPerCell: 55, foliage: 560,
    shadowMap: 1024, shadowExtent: 40, envSeconds: 4, dpr: 1.35, cascades: 2, terrainSplat: true, clutter: 0.7, clutterRadius: 16,
    vines: false, treeDetail: 1, waterSegments: 48,
    fireLights: 2, fireShadows: false, contactShadows: true, eyeAdapt: true,
    post: true, ssaoSamples: 8, aoStrength: 0.65, bloomLevels: 3, bloom: 0.28,
    godRays: false, dof: false, vignette: 0.26, grain: 0.012, heightFog: 1, heatHaze: false,
    dustMotes: 140, fireflies: 40, rainDrops: 900, fallingLeaves: 24,
    waterRefract: true, waterSSR: 0, waterCaustics: true, waterRipples: 8,
    waterSpray: 70, waterMist: 60, waterDebris: 22, msaa: 2,
  },
  high: {
    label: 'High', grassRadius: 28, grassPerCell: 95, foliage: 820,
    shadowMap: 1536, shadowExtent: 34, envSeconds: 2, dpr: 1.6, cascades: 3, terrainSplat: true, clutter: 1.0, clutterRadius: 22,
    vines: true, treeDetail: 2, waterSegments: 72,
    fireLights: 2, fireShadows: true, contactShadows: true, eyeAdapt: true,
    post: true, ssaoSamples: 12, aoStrength: 0.75, bloomLevels: 4, bloom: 0.30,
    godRays: true, dof: true, vignette: 0.28, grain: 0.014, heightFog: 1, heatHaze: true,
    dustMotes: 240, fireflies: 70, rainDrops: 1800, fallingLeaves: 40,
    waterRefract: true, waterSSR: 14, waterCaustics: true, waterRipples: 12,
    waterSpray: 130, waterMist: 120, waterDebris: 40, msaa: 4,
  },
  ultra: {
    label: 'Ultra', grassRadius: 38, grassPerCell: 130, foliage: 1100,
    shadowMap: 2048, shadowExtent: 30, envSeconds: 1.2, dpr: 2.0, cascades: 4, terrainSplat: true, clutter: 1.4, clutterRadius: 30,
    vines: true, treeDetail: 2, waterSegments: 96,
    fireLights: 3, fireShadows: true, contactShadows: true, eyeAdapt: true,
    post: true, ssaoSamples: 16, aoStrength: 0.8, bloomLevels: 5, bloom: 0.32,
    godRays: true, dof: true, vignette: 0.30, grain: 0.015, heightFog: 1, heatHaze: true,
    dustMotes: 340, fireflies: 110, rainDrops: 3000, fallingLeaves: 60,
    waterRefract: true, waterSSR: 22, waterCaustics: true, waterRipples: 16,
    waterSpray: 190, waterMist: 180, waterDebris: 60, msaa: 4,
  },
};

// The shadow box is pushed this far forward along the view direction (as a
// fraction of its half-size) instead of being centred on the player. You can
// only see shadows in front of you, so spending the map on what is behind you
// is waste: the shift buys ~1.4x the forward reach from a box ~30% smaller,
// which is where the extra sharpness comes from.
const SHADOW_FORWARD_BIAS = 0.4;

// ---------- Canopy cover field ----------
// A coarse 2.5m grid of "how much leaf is overhead", splatted once when the
// foliage is placed. The eye-adaptation code needs to know when you have
// walked under a tree, and asking the GPU is not an option - this answers it
// in a bilinear lookup. Also quality-dependent on purpose: fewer trees really
// does mean a brighter jungle.
const CANOPY_HALF = 250;
const CANOPY_CELLS = 200;
const CANOPY_CELL = (CANOPY_HALF * 2) / CANOPY_CELLS;
const canopyField = { grid: new Float32Array(CANOPY_CELLS * CANOPY_CELLS), ready: false };

function canopyReset() {
  canopyField.grid.fill(0);
  canopyField.ready = false;
}
function canopySplat(x, z, radius, weight) {
  const g = canopyField.grid;
  const fx = (x + CANOPY_HALF) / CANOPY_CELL;
  const fz = (z + CANOPY_HALF) / CANOPY_CELL;
  const rad = Math.max(0.5, radius / CANOPY_CELL);
  const i0 = Math.max(0, Math.floor(fx - rad)), i1 = Math.min(CANOPY_CELLS - 1, Math.ceil(fx + rad));
  const j0 = Math.max(0, Math.floor(fz - rad)), j1 = Math.min(CANOPY_CELLS - 1, Math.ceil(fz + rad));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5 - fx) / rad, dz = (j + 0.5 - fz) / rad;
      const d2 = dx * dx + dz * dz;
      if (d2 >= 1) continue;
      g[j * CANOPY_CELLS + i] += weight * (1 - d2);
    }
  }
}
function canopyAt(ix, iz) {
  if (ix < 0 || iz < 0 || ix >= CANOPY_CELLS || iz >= CANOPY_CELLS) return 0;
  return canopyField.grid[iz * CANOPY_CELLS + ix];
}
function canopyCoverAt(x, z) {
  if (!canopyField.ready) return 0;
  const fx = (x + CANOPY_HALF) / CANOPY_CELL - 0.5;
  const fz = (z + CANOPY_HALF) / CANOPY_CELL - 0.5;
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const v = canopyAt(i, j) * (1 - tx) * (1 - tz)
    + canopyAt(i + 1, j) * tx * (1 - tz)
    + canopyAt(i, j + 1) * (1 - tx) * tz
    + canopyAt(i + 1, j + 1) * tx * tz;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------- Fire light pool ----------
// Every campfire draws its own flame, but point lights are not free and the
// light count has to stay constant or three.js recompiles every material the
// moment a camp comes into range. So the fires register their positions here
// and DayNightSystem hands the nearest few a light out of a fixed pool.
const fireRegistry = {}; // { [id]: [x, y, z] }
const GRAPHICS_ORDER = ['low', 'medium', 'high', 'ultra'];

// `brightness` is a plain multiplier on the exposure the lighting code settles
// on. Monitors and eyes differ more than any amount of tuning can allow for,
// so this is the one knob that is a slider rather than a preset.
const graphicsSettings = { quality: 'high', brightness: 1.0, showStats: false };
try {
  const saved = JSON.parse(localStorage.getItem(GRAPHICS_KEY) || 'null');
  if (saved && GRAPHICS_PRESETS[saved.quality]) graphicsSettings.quality = saved.quality;
  if (saved && typeof saved.brightness === 'number' && isFinite(saved.brightness)) {
    graphicsSettings.brightness = Math.max(0.6, Math.min(1.8, saved.brightness));
  }
  if (saved && typeof saved.showStats === 'boolean') graphicsSettings.showStats = saved.showStats;
} catch (e) {}

// Live renderer counters, refreshed twice a second by PerfProbe. There is no
// profiler in a page like this, so the only way to answer "is it holding 60?"
// is to measure it and put the number on screen.
const perfStats = { fps: 0, ms: 0, draws: 0, tris: 0 };
function saveGraphicsSettings() {
  try { localStorage.setItem(GRAPHICS_KEY, JSON.stringify(graphicsSettings)); } catch (e) {}
}
// Read inside useFrame and in render, so it must stay cheap and allocation-free.
function gfx() { return GRAPHICS_PRESETS[graphicsSettings.quality] || GRAPHICS_PRESETS.high; }

// ============================================================

export {
  GRAPHICS_KEY,
  GRAPHICS_PRESETS,
  SHADOW_FORWARD_BIAS,
  CANOPY_HALF,
  CANOPY_CELLS,
  CANOPY_CELL,
  canopyField,
  canopyReset,
  canopySplat,
  canopyAt,
  canopyCoverAt,
  fireRegistry,
  GRAPHICS_ORDER,
  graphicsSettings,
  perfStats,
  saveGraphicsSettings,
  gfx,
};
