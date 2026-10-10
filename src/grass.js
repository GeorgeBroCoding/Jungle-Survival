import { Footprints, GroundClutter } from './clutter.js';
import { Fragment, THREE, html, useEffect, useFrame, useMemo, useRef } from './core.js';
import { PLAYER_SPAWN, POND_CENTER, POND_RADIUS, RIVER_HALF, mulberry32, riverCenterX } from './data.js';
import { GRAPHICS_PRESETS, canopyField, canopyReset, canopySplat, gfx } from './graphics.js';
import { playerTransform } from './multiplayer.js';
import { skyRuntime } from './runtime.js';
import { entityRegistry } from './shake.js';
import { DayNightSystem } from './sky.js';
import { useGame } from './store.js';
import { Ground, RIVER, getBiomeColor, getDominantBiome, getTerrainHeight, waterSurfaceAt } from './terrain.js';
import { buildSoftDisc, texFrom } from './textures.js';
import { InstancedModels, buildBambooModel, buildBigLeafModel, buildBushModel, buildCactusModel, buildFallenTrunkModel, buildFernModel, buildHeliconiaModel, buildPalmModel, buildPineModel, buildRockModel, buildTreeModel, vegGeo, vegMat } from './vegetation.js';
import { RiverDebris, Water, spawnRipple, waterRuntime } from './water.js';
import { Rain, WeatherSystem } from './weather.js';
import { PROJECT_WITH_WIND, WIND_GLSL, windUniforms } from './wind.js';

// grass.js - instanced ground cover that follows the player
//
// Real grass is the single biggest thing separating "flat green plane" from
// "ground you're standing on". Blades are instanced into a disc of cells around
// the player; as you walk, cells that fall out of range are recycled into the
// ones that just came into range, so the instance count is constant and nothing
// is allocated per frame. Each cell's contents are derived from its coordinates,
// so a cell looks identical every time you walk back over it.
// ============================================================
const GRASS_CELL = 2.6;
const GRASS_BLADE_H = 0.40;
// Packs a signed cell coordinate pair into one integer for Map keys - cheaper
// than building strings every time the player crosses a cell boundary.
const GRASS_KEY_BIAS = 4096;
function grassKey(cx, cz) {
  return (cx + GRASS_KEY_BIAS) * 8192 + (cz + GRASS_KEY_BIAS);
}

function buildGrassBladeGeometry() {
  // Normalised to 1 unit tall so the wind shader can read position.y directly
  // as "how far up this blade are we" and bend the tip without moving the root.
  const steps = 4;
  const positions = [], uvs = [], colors = [], indices = [];
  const root = [0.16, 0.26, 0.10];
  const tip = [0.60, 0.82, 0.34];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Slim. At 8cm across the base these read as arrowheads rather than
    // grass, and a wide blade is also a lot more fill to pay for.
    const hw = 0.021 * (1 - t) * (1 - t * 0.35) + 0.0018;
    // Only enough arch to give the blade some normal variation; the real
    // curve is applied in the shader, where the instance's height is known.
    const z = 0.02 * t * t;
    positions.push(-hw, t, z, hw, t, z);
    uvs.push(0, t, 1, t);
    for (let k = 0; k < 2; k++) {
      colors.push(
        root[0] + (tip[0] - root[0]) * t,
        root[1] + (tip[1] - root[1]) * t,
        root[2] + (tip[2] - root[2]) * t
      );
    }
    if (i > 0) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// How much ground cover each biome gets. Sand and snow are nearly bare; the
// swamp is nearly solid.
function grassDensityForBiome(b) {
  if (b === 0) return 1.0;    // woodland
  if (b === 1) return 0.06;   // sandy
  if (b === 2) return 0.10;   // snow
  if (b === 3) return 0.22;   // rocky
  return 0.92;                // swamp
}

// Move the ring of populated cells to be centred on (cx, cz): hand back every
// cell that just fell out of range, then claim the ones that just came in and
// hand each to `fill`. Kept out of the component so it can be exercised
// directly - the pool must never leak a block or run dry, and a cell that stays
// in range must keep the exact blades it already had, or the grass visibly
// reshuffles itself every time you take a step.
function recycleGrassCells(book, plan, cx, cz, radius, fill) {
  book.cx = cx;
  book.cz = cz;

  for (const [key, block] of book.live) {
    const kx = Math.floor(key / 8192) - GRASS_KEY_BIAS;
    const kz = (key % 8192) - GRASS_KEY_BIAS;
    if (Math.hypot((kx - cx) * GRASS_CELL, (kz - cz) * GRASS_CELL) > radius) {
      book.free.push(block);
      book.live.delete(key);
    }
  }

  for (const off of plan.offs) {
    const gx = cx + off[0];
    const gz = cz + off[1];
    const key = grassKey(gx, gz);
    if (book.live.has(key)) continue;
    const block = book.free.pop();
    if (block === undefined) break; // pool exhausted; leave the rest bare
    book.live.set(key, block);
    fill(block, gx, gz);
  }
}

// Where the player is and how far out the grass thins, shared with the shader
// so the fade follows you rather than being baked into the scatter.
const grassFade = {
  eye: { value: new THREE.Vector2(0, 0) },
  range: { value: new THREE.Vector2(10, 14) },
};

function GrassField() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const ref = useRef();
  const timeU = windUniforms.uWindTime;
  const windU = windUniforms.uGrassWind;
  const geo = useMemo(() => buildGrassBladeGeometry(), []);

  const mat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 1.0,
    });
    // aPhase is our own instanced attribute, declared here rather than relying
    // on anything three exposes internally, so this stays stable across
    // three.js versions. Only the begin_vertex chunk name is assumed.
    m.onBeforeCompile = (shader) => {
      if (shader.vertexShader.indexOf('#include <begin_vertex>') === -1) return;
      shader.uniforms.uTime = timeU;
      shader.uniforms.uWind = windU;
      shader.uniforms.uTrail = windUniforms.uTrail;
      shader.uniforms.uTrailLife = windUniforms.uTrailLife;
      shader.uniforms.uTrampleScale = windUniforms.uTrampleScale;
      shader.uniforms.uWindTime = windUniforms.uWindTime;
      shader.uniforms.uWindStrength = windUniforms.uWindStrength;
      shader.uniforms.uGrassEye = grassFade.eye;
      shader.uniforms.uGrassFade = grassFade.range;
      shader.vertexShader = WIND_GLSL
        + 'attribute float aPhase;\nuniform float uTime;\nuniform float uWind;\n'
        + 'uniform vec2 uGrassEye;\nuniform vec2 uGrassFade;\n' + shader.vertexShader;
      if (shader.vertexShader.indexOf('#include <project_vertex>') !== -1) {
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', PROJECT_WITH_WIND);
      }
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', [
        'vec3 transformed = vec3( position );',
        'float bladeUp = clamp( position.y, 0.0, 1.0 );',
        // The blade geometry is one unit tall and the instance matrix squashes
        // it to 0.18-0.70m while leaving the width near 1. So a displacement
        // written in object space comes out magnified by 1/heightScale: the
        // same code that leans a tall blade over by a tenth lays a short one
        // flat on the ground. Everything below is therefore expressed as a
        // FRACTION of the blade's own height and converted back here.
        '#ifdef USE_INSTANCING',
        '  float jkSY = length( instanceMatrix[1].xyz );',
        '  float jkSX = max( length( instanceMatrix[0].xyz ), 0.001 );',
        '#else',
        '  float jkSY = 1.0;',
        '  float jkSX = 1.0;',
        '#endif',
        'float jkAspect = jkSY / jkSX;',
        'jkPlantH = jkSY;',
        // Two sines at different rates: a slow roll with a faster flutter on
        // top, so gusts never look metronomic.
        'float sway = sin( uTime * 1.7 + aPhase ) * 0.6 + sin( uTime * 3.3 + aPhase * 1.9 ) * 0.25;',
        'float up2 = bladeUp * bladeUp;',
        // Resting arch. It lives here rather than in the geometry for the same
        // reason: baked into the vertices it is a fixed distance, so short
        // blades were born already bent double.
        'float leanZ = up2 * 0.17 + cos( uTime * 1.3 + aPhase * 0.7 ) * up2 * uWind * 1.35 * 0.55;',
        'float leanX = sway * up2 * uWind * 1.35;',
        'transformed.x += leanX * jkAspect;',
        'transformed.z += leanZ * jkAspect;',
        // A leaning blade is still the same length, so it loses height as it
        // goes over instead of stretching.
        'transformed.y -= ( leanX * leanX + leanZ * leanZ ) * 0.5 * bladeUp;',
        // Hand the height up the blade to the world-space wind and trample.
        'jkBladeUp = up2;',
        // Grass stops dead at the edge of the ring it is scattered in, and a
        // straight line of grass ending in bare ground is impossible to miss
        // once you have seen it. Blades shrink into the ground over the last
        // few metres instead, so the layer thins out rather than ending.
        '#ifdef USE_INSTANCING',
        '  vec3 jkBladeW = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
        '  float jkFar = distance( jkBladeW.xz, uGrassEye );',
        '  float jkKeep = 1.0 - smoothstep( uGrassFade.x, uGrassFade.y, jkFar );',
        '  transformed *= jkKeep;',
        '#endif',
      ].join('\n'));
    };
    return m;
  }, [timeU, windU]);

  // The ring of cells we keep populated, nearest first, plus how many blade
  // slots that needs. Constant for a given quality preset, so the pool can be
  // sized exactly and never grow.
  const plan = useMemo(() => {
    const offs = [];
    const span = Math.ceil(q.grassRadius / GRASS_CELL);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const d = Math.hypot(dx, dz) * GRASS_CELL;
        if (d <= q.grassRadius) offs.push([dx, dz, d]);
      }
    }
    offs.sort((a, b) => a[2] - b[2]);
    return { offs, blocks: offs.length, perCell: q.grassPerCell, capacity: offs.length * q.grassPerCell };
  }, [q.grassRadius, q.grassPerCell]);

  const phaseAttr = useMemo(
    () => new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, plan.capacity)), 1),
    [plan.capacity]
  );

  // Cell bookkeeping. Rebuilt whenever the pool is resized by a quality change.
  const book = useMemo(() => ({
    live: new Map(),
    free: [],
    cx: null,
    cz: null,
  }), [plan.capacity]);

  useEffect(() => {
    book.live.clear();
    book.free.length = 0;
    for (let i = plan.blocks - 1; i >= 0; i--) book.free.push(i);
    book.cx = null;
    book.cz = null;
  }, [book, plan.blocks]);

  useEffect(() => {
    const mesh = ref.current;
    if (mesh) mesh.geometry.setAttribute('aPhase', phaseAttr);
  }, [phaseAttr, geo]);

  const scratch = useMemo(() => ({
    m: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
    e: new THREE.Euler(),
    v: new THREE.Vector3(),
    s: new THREE.Vector3(),
    c: new THREE.Color(),
  }), []);

  useFrame((_, delta) => {
    const mesh = ref.current;
    if (!mesh || plan.capacity === 0) return;
    // The clock belongs to DayNightSystem now, so that a gust crossing the
    // canopy is the same gust that moves the undergrowth. Only the grass's
    // share of its strength is set here.
    windU.value = 0.13 + Math.sin(timeU.value * 0.23) * 0.06 + Math.sin(timeU.value * 0.07) * 0.035;

    const px = playerTransform.position[0];
    const pz = playerTransform.position[2];
    grassFade.eye.value.set(px, pz);
    // Thin out over the last quarter of the ring, so the fade is always just
    // inside the edge whatever the preset's radius is.
    grassFade.range.value.set(q.grassRadius * 0.74, q.grassRadius * 0.99);
    const cx = Math.floor(px / GRASS_CELL);
    const cz = Math.floor(pz / GRASS_CELL);
    if (book.cx === cx && book.cz === cz) return; // nothing to re-scatter

    const per = plan.perCell;
    const sc = scratch;
    recycleGrassCells(book, plan, cx, cz, q.grassRadius, (block, gx, gz) => {
      const rand = mulberry32(((gx & 0xffff) << 16 ^ (gz & 0xffff)) + 17);
      const cellX = gx * GRASS_CELL;
      const cellZ = gz * GRASS_CELL;
      const density = grassDensityForBiome(getDominantBiome(cellX, cellZ));
      for (let i = 0; i < per; i++) {
        const idx = block * per + i;
        const x = cellX + rand() * GRASS_CELL;
        const z = cellZ + rand() * GRASS_CELL;
        // Grass does not grow under water. Tested against the actual surface
        // rather than against a radius, because the shallow margins reach well
        // past the channel floor - and a blade standing in the river puts the
        // depth buffer at the waterline, which tells the water shader there is
        // no water there at all.
        const gy = getTerrainHeight(x, z);
        const ws = waterSurfaceAt(x, z);
        const keep = rand() <= density && !(ws !== -Infinity && gy < ws + 0.06);
        if (!keep) {
          // Collapse unwanted blades to nothing rather than shrinking the pool -
          // keeps the slot bookkeeping trivial.
          sc.m.makeScale(0, 0, 0);
          mesh.setMatrixAt(idx, sc.m);
          phaseAttr.array[idx] = 0;
          continue;
        }
        const h = GRASS_BLADE_H * (0.45 + rand() * 1.25);
        const w = 0.8 + rand() * 0.55;
        sc.e.set((rand() - 0.5) * 0.28, rand() * Math.PI * 2, (rand() - 0.5) * 0.28);
        sc.q.setFromEuler(sc.e);
        sc.v.set(x, gy - 0.03, z);
        sc.s.set(w, h, w);
        sc.m.compose(sc.v, sc.q, sc.s);
        mesh.setMatrixAt(idx, sc.m);
        const [br, bg, bb] = getBiomeColor(x, z);
        const lift = 1.5 + rand() * 1.1; // biome colours are dark; blades catch more light
        sc.c.setRGB(
          Math.min(1, br * lift),
          Math.min(1, bg * lift * 1.05),
          Math.min(1, bb * lift)
        );
        mesh.setColorAt(idx, sc.c);
        phaseAttr.array[idx] = rand() * Math.PI * 2;
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    phaseAttr.needsUpdate = true;
  });

  if (plan.capacity === 0) return null;

  return html`
    <instancedMesh
      ref=${ref}
      args=${[geo, mat, plan.capacity]}
      castShadow=${false}
      receiveShadow=${true}
      frustumCulled=${false}
    />
  `;
}

// ---------- Decorative scattered foliage (non-interactable, purely visual) ----------
// Drawn as instances: a few hundred detailed plants cost the same handful of
// draw calls as a few dozen did before.
function DecorativeFoliage() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();

  const instances = useMemo(() => {
    const rand = mulberry32(99);
    const detail = q.treeDetail;
    const out = [];
    // Each plant also stamps its canopy into the cover field, which is what
    // the eye-adaptation code reads to know you have walked into shade.
    // `shade` is the radius of leaf it actually puts over your head.
    canopyReset();
    const add = (model, x, y, z, scale, shade) => {
      out.push({ model, position: [x, y, z], scale, rotY: rand() * Math.PI * 2 });
      if (shade > 0) canopySplat(x, z, shade * scale, 1.15);
    };
    for (let i = 0; i < q.foliage; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 10 + rand() * 220;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (Math.hypot(x, z) < 10) continue;
      // Keep a clearing around where the player appears. The exclusion above is
      // measured from the world origin, but spawn is 8m off it, so undergrowth
      // could land close enough that the third-person camera started inside a
      // fern.
      if (Math.hypot(x - PLAYER_SPAWN[0], z - PLAYER_SPAWN[2]) < 7) continue;
      const pondDist = Math.hypot(x - POND_CENTER[0], z - POND_CENTER[1]);
      if (pondDist < 14) continue; // keep the water clear
      const y = getTerrainHeight(x, z);
      // Same for the river: plants on the banks, not standing in the current.
      if (waterSurfaceAt(x, z) > y + 0.06) continue;
      const s = 0.7 + rand() * 0.9;
      const biome = getDominantBiome(x, z);
      const roll = rand();
      if (biome === 0) {
        // Woodland: emergent giants over a broadleaf understorey, palms by the
        // water, and the floor filled in with shrubs and ferns.
        if (pondDist < 32 && roll > 0.72) add(buildPalmModel(rand, detail), x, y, z, 0.8 + rand() * 0.5, 3.1);
        else if (roll > 0.60) add(buildTreeModel(rand, detail, 'jungleGiant'), x, y, z, s, 4.4);
        else if (roll > 0.54) add(buildTreeModel(rand, detail, 'strangler'), x, y, z, s * 1.05, 4.2);
        else if (roll > 0.46) add(buildBambooModel(rand, detail), x, y, z, 0.8 + rand() * 0.6, 1.1);
        else if (roll > 0.33) add(buildTreeModel(rand, detail, 'broadleaf'), x, y, z, s * 1.05, 2.8);
        else if (roll > 0.29) add(buildTreeModel(rand, detail, 'deadTree'), x, y, z, s * 0.9, 0.6);
        else if (roll > 0.24) add(buildFallenTrunkModel(rand, detail), x, y, z, 0.8 + rand() * 0.6, 1.0);
        else if (roll > 0.19) add(buildBushModel(rand, detail, false), x, y, z, s * 0.95, 1.2);
        else if (roll > 0.13) add(buildBigLeafModel(rand, detail, 'elephant'), x, y, z, 0.9 + rand() * 0.7, 0.9);
        else if (roll > 0.08) add(buildBigLeafModel(rand, detail, 'monstera'), x, y, z, 0.9 + rand() * 0.6, 0.9);
        else if (roll > 0.05) add(buildHeliconiaModel(rand, detail), x, y, z, 0.9 + rand() * 0.5, 0.7);
        else add(buildFernModel(rand, detail, false), x, y, z, 0.8 + rand() * 0.6, 0.5);
      } else if (biome === 1) {
        // Dry scrub: flat-topped acacias over cactus and bare rock.
        if (roll > 0.60) add(buildTreeModel(rand, detail, 'acacia'), x, y, z, 0.9 + rand() * 0.5, 2.2);
        else if (roll > 0.34) add(buildCactusModel(rand, detail), x, y, z, 0.7 + rand() * 0.7, 0);
        else if (roll > 0.20) add(buildTreeModel(rand, detail, 'deadTree'), x, y, z, 0.8 + rand() * 0.4, 0.5);
        else add(buildRockModel(rand, detail), x, y, z, 0.4 + rand() * 0.8, 0);
      } else if (biome === 2) {
        // Snowline: pines, with deadwood where they have given up.
        if (roll > 0.42) add(buildPineModel(rand, detail, true), x, y, z, s, 2.6);
        else if (roll > 0.26) add(buildTreeModel(rand, detail, 'deadTree'), x, y, z, s * 0.85, 0.5);
        else add(buildRockModel(rand, detail), x, y, z, 0.35 + rand() * 0.6, 0);
      } else if (biome === 3) {
        // Rocky: mostly stone, with hardy pines and standing deadwood between.
        if (roll > 0.55) add(buildRockModel(rand, detail), x, y, z, 0.45 + rand() * 1.7, 0);
        else if (roll > 0.33) add(buildPineModel(rand, detail, false), x, y, z, s * 0.85, 2.4);
        else if (roll > 0.18) add(buildTreeModel(rand, detail, 'deadTree'), x, y, z, s * 0.9, 0.5);
        else add(buildBushModel(rand, detail, false), x, y, z, s * 0.7, 0.9);
      } else {
        // Swamp: mangroves on their stilts, palms standing out of the growth,
        // and a dense floor of fern.
        if (roll > 0.72) add(buildTreeModel(rand, detail, 'mangrove'), x, y, z, s, 2.4);
        else if (roll > 0.66) add(buildBambooModel(rand, detail), x, y, z, 0.9 + rand() * 0.6, 1.1);
        else if (roll > 0.54) add(buildPalmModel(rand, detail), x, y, z, 0.75 + rand() * 0.5, 3.1);
        else if (roll > 0.50) add(buildTreeModel(rand, detail, 'deadTree'), x, y, z, s * 0.85, 0.5);
        else if (roll > 0.44) add(buildFallenTrunkModel(rand, detail), x, y, z, 0.9 + rand() * 0.5, 1.0);
        else if (roll > 0.33) add(buildBigLeafModel(rand, detail, 'elephant'), x, y, z, 1.0 + rand() * 0.8, 0.9);
        else if (roll > 0.26) add(buildHeliconiaModel(rand, detail), x, y, z, 0.9 + rand() * 0.6, 0.7);
        else if (roll > 0.26) add(buildBushModel(rand, detail, true), x, y, z, s * 1.05, 1.4);
        else add(buildFernModel(rand, detail, true), x, y, z, 0.9 + rand() * 0.7, 0.6);
      }
    }
    // The harvestable trees and bushes shade you just as much as the decorative
    // ones - more, in fact, since they cluster around the spawn and the base,
    // which is exactly where you spend your time. Leaving them out meant the
    // eye-adaptation code thought you were standing in an open field while you
    // were under a closed canopy, and the exposure never moved.
    for (const node of useGame.getState().resourceNodes) {
      if (node.type === 'wood') canopySplat(node.position[0], node.position[2], 4.6 * 1.1, 1.15);
      else if (node.type === 'fiber') canopySplat(node.position[0], node.position[2], 1.2 * 1.2, 1.15);
    }
    canopyField.ready = true;
    return out;
  }, [q.foliage, q.treeDetail]);

  return html`<${InstancedModels} instances=${instances} />`;
}

// ---------- Dust, pollen and insects ----------
// Motes drift in a box that follows the player, wrapping round as you walk, so
// a few hundred points cover the whole world. They are only really visible
// looking toward the sun - which is exactly how dust in air behaves, because
// you are seeing forward-scattered light rather than the mote itself. That one
// detail is what stops them reading as floating white dots.
const DUST_HALF = 11;
const DUST_HEIGHT = 7;
const _dustCam = new THREE.Vector3();

function DustMotes() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const count = Math.max(0, q.dustMotes | 0);
  const ref = useRef();

  const data = useMemo(() => {
    const rand = mulberry32(4242);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rand() * 2 - 1) * DUST_HALF;
      pos[i * 3 + 1] = rand() * DUST_HEIGHT;
      pos[i * 3 + 2] = (rand() * 2 - 1) * DUST_HALF;
      seed[i] = rand() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DUST_HALF * 2);
    return { geo, pos, seed, home: pos.slice() };
  }, [count]);

  const mat = useMemo(() => new THREE.PointsMaterial({
    map: texFrom(buildSoftDisc(32), [1, 1], false),
    color: '#ffeccc',
    size: 0.055,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  }), []);

  useEffect(() => () => { data.geo.dispose(); mat.dispose(); }, [data, mat]);

  useFrame((state) => {
    const pts = ref.current;
    if (!pts || count === 0) return;
    const t = state.clock.elapsedTime;
    const px = playerTransform.position[0];
    const py = playerTransform.position[1];
    const pz = playerTransform.position[2];
    const pos = data.pos;
    const home = data.home;
    const seed = data.seed;
    for (let i = 0; i < count; i++) {
      const s = seed[i];
      // Slow rise with a lazy sideways wander - closer to pollen than to rain.
      let x = home[i * 3] + Math.sin(t * 0.21 + s) * 1.3;
      let y = home[i * 3 + 1] + ((t * 0.16 + s) % DUST_HEIGHT);
      let z = home[i * 3 + 2] + Math.cos(t * 0.17 + s * 1.7) * 1.3;
      // Wrap the box around the player so the same few hundred motes serve the
      // entire world.
      x = px + wrapHalf(x - px, DUST_HALF);
      z = pz + wrapHalf(z - pz, DUST_HALF);
      pos[i * 3] = x;
      pos[i * 3 + 1] = py + (y % DUST_HEIGHT);
      pos[i * 3 + 2] = z;
    }
    data.geo.attributes.position.needsUpdate = true;

    // Forward scattering: bright looking into the light, nearly invisible with
    // the sun behind you. Also fades out at night, when there is no beam.
    state.camera.getWorldDirection(_dustCam);
    const towardSun = Math.max(0, _dustCam.dot(skyRuntime.sunDir));
    const lit = Math.max(0, Math.min(1, skyRuntime.sunI / 1.5));
    mat.opacity = 0.05 + 0.5 * Math.pow(towardSun, 3) * lit;
    mat.color.copy(skyRuntime.sunColor);
  });

  if (count === 0) return null;
  return html`<points ref=${ref} geometry=${data.geo} material=${mat} frustumCulled=${false} />`;
}

// Shift a coordinate into [-half, half) - the toroidal wrap that keeps the
// mote box centred on the player without teleporting anything into view.
function wrapHalf(v, half) {
  const span = half * 2;
  let r = (v + half) % span;
  if (r < 0) r += span;
  return r - half;
}

// ---------- Fireflies ----------
// Night here had stars, a moon and campfires, and nothing alive in it. These
// drift in a box that follows the player like the dust motes do, but they are
// lights rather than lit things: each carries its own slow pulse, and they
// only exist once the sun is properly down.
const FIREFLY_HALF = 14;

function Fireflies() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const count = Math.max(0, q.fireflies | 0);
  const ref = useRef();

  const data = useMemo(() => {
    const rand = mulberry32(2718);
    const pos = new Float32Array(Math.max(1, count) * 3);
    const col = new Float32Array(Math.max(1, count) * 3);
    const bugs = [];
    for (let i = 0; i < count; i++) {
      bugs.push({
        x: (rand() * 2 - 1) * FIREFLY_HALF,
        y: 0.35 + rand() * 2.1,
        z: (rand() * 2 - 1) * FIREFLY_HALF,
        phase: rand() * 100,
        // Each has its own blink rate, or they pulse as one organism.
        rate: 0.5 + rand() * 1.5,
        drift: 0.18 + rand() * 0.3,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FIREFLY_HALF * 3);
    return { geo, pos, col, bugs };
  }, [count]);

  const mat = useMemo(() => new THREE.PointsMaterial({
    map: texFrom(buildSoftDisc(32), [1, 1], false),
    size: 0.13,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  }), []);

  useEffect(() => () => { data.geo.dispose(); mat.dispose(); }, [data, mat]);

  useFrame((state) => {
    const pts = ref.current;
    if (!pts || count === 0) return;
    // Only after dark, and faded in rather than switched on.
    const night = Math.max(0, Math.min(1, (skyRuntime.star - 0.25) / 0.45));
    pts.visible = night > 0.01;
    if (!pts.visible) return;
    const t = state.clock.elapsedTime;
    const px = playerTransform.position[0];
    const py = playerTransform.position[1];
    const pz = playerTransform.position[2];
    const pos = data.pos;
    const col = data.col;
    for (let i = 0; i < data.bugs.length; i++) {
      const b = data.bugs[i];
      // A wandering hover: two slow sines per axis at different rates, so the
      // path never closes and never repeats visibly.
      const wx = Math.sin(t * b.drift + b.phase) * 2.6
               + Math.sin(t * b.drift * 0.37 + b.phase * 1.7) * 1.3;
      const wz = Math.cos(t * b.drift * 0.82 + b.phase * 1.3) * 2.6
               + Math.cos(t * b.drift * 0.29 + b.phase) * 1.1;
      const wy = Math.sin(t * b.drift * 1.6 + b.phase * 2.1) * 0.5;
      pos[i * 3] = px + wrapHalf(b.x + wx, FIREFLY_HALF);
      pos[i * 3 + 1] = py + b.y + wy;
      pos[i * 3 + 2] = pz + wrapHalf(b.z + wz, FIREFLY_HALF);
      // The blink: mostly dark, with a sharp rise. A sine would read as a
      // pulsing dot; a real one is off, then suddenly on.
      const k = Math.pow(Math.max(0, Math.sin(t * b.rate + b.phase)), 7) * night;
      col[i * 3] = k * 0.85;
      col[i * 3 + 1] = k * 1.0;
      col[i * 3 + 2] = k * 0.30;
    }
    data.geo.attributes.position.needsUpdate = true;
    data.geo.attributes.color.needsUpdate = true;
  });

  if (count === 0) return null;
  return html`<points ref=${ref} geometry=${data.geo} material=${mat} frustumCulled=${false} />`;
}

// ---------- Falling leaves ----------
// A handful of leaves spiralling down, recycled in a box that follows the
// player. They reuse the leaf-card geometry and material, so they cost one
// extra draw call and no extra shader.
const FALL_HALF = 9;
const FALL_TOP = 7.5;

function FallingLeaves() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const count = Math.max(0, q.fallingLeaves | 0);
  const ref = useRef();

  const data = useMemo(() => {
    const rand = mulberry32(8181);
    const leaves = [];
    for (let i = 0; i < count; i++) {
      leaves.push({
        x: (rand() * 2 - 1) * FALL_HALF,
        y: rand() * FALL_TOP,
        z: (rand() * 2 - 1) * FALL_HALF,
        fall: 0.35 + rand() * 0.45,
        spin: (rand() - 0.5) * 2.4,
        phase: rand() * 100,
        size: 0.18 + rand() * 0.16,
      });
    }
    return { leaves, m: new THREE.Matrix4(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
             e: new THREE.Euler(), s: new THREE.Vector3() };
  }, [count]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    const t = state.clock.elapsedTime;
    const px = playerTransform.position[0];
    const py = playerTransform.position[1];
    const pz = playerTransform.position[2];
    const d = Math.min(0.1, delta);
    for (let i = 0; i < data.leaves.length; i++) {
      const L = data.leaves[i];
      L.y -= L.fall * d;
      // A leaf does not drop straight: it slides sideways as it tips over.
      const swayX = Math.sin(t * 1.3 + L.phase) * 0.5;
      const swayZ = Math.cos(t * 1.1 + L.phase * 1.7) * 0.5;
      if (L.y < -0.5) {
        L.y = FALL_TOP;
        L.x = (Math.random() * 2 - 1) * FALL_HALF;
        L.z = (Math.random() * 2 - 1) * FALL_HALF;
      }
      // L.x/L.z are offsets within the box, so wrapping keeps a drifting leaf
      // inside it without ever jumping it across the player's view.
      const wx = px + wrapHalf(L.x + swayX, FALL_HALF);
      const wz = pz + wrapHalf(L.z + swayZ, FALL_HALF);
      data.e.set(t * L.spin, t * L.spin * 0.7 + L.phase, Math.sin(t * 1.7 + L.phase) * 0.9);
      data.q.setFromEuler(data.e);
      data.v.set(wx, py + L.y, wz);
      data.s.set(L.size, L.size, L.size);
      data.m.compose(data.v, data.q, data.s);
      mesh.setMatrixAt(i, data.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (count === 0) return null;
  return html`<instancedMesh ref=${ref} args=${[vegGeo('leafCard'), vegMat('leafCard'), count]}
    castShadow=${false} receiveShadow=${true} frustumCulled=${false} />`;
}

// ---------- Spray, splashes and drips ----------
// One pool of droplets serves every source: feet in the shallows, the splash
// when you go in, what runs off you when you come out, and the mist at the foot
// of a waterfall. Sources queue an emission rather than writing into the pool,
// because they run in their own frame callbacks - the player's runs before this
// one - and a queue means none of them needs to know the pool exists.
const sprayQueue = [];
function emitSpray(x, y, z, n, opts) {
  if (!(n > 0)) return;
  // A queue that is never drained means something is emitting with the system
  // switched off. Drop the oldest rather than growing without bound.
  if (sprayQueue.length > 32) sprayQueue.shift();
  sprayQueue.push({ x: x, y: y, z: z, n: n, o: opts || {} });
}

const SPRAY_GRAVITY = 9.0;

function WaterSpray() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const count = Math.max(0, q.waterSpray | 0);
  const ref = useRef();

  const data = useMemo(() => {
    const pos = new Float32Array(Math.max(1, count) * 3);
    const col = new Float32Array(Math.max(1, count) * 3);
    const drops = [];
    for (let i = 0; i < count; i++) {
      drops.push({ life: 0, max: 1, x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0, grav: 1, fade: 1 });
      pos[i * 3 + 1] = -9999;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return { geo, pos, col, drops, next: 0 };
  }, [count]);

  const mat = useMemo(() => new THREE.PointsMaterial({
    map: texFrom(buildSoftDisc(32), [1, 1], false),
    size: 0.075,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  }), []);

  useEffect(() => () => { data.geo.dispose(); mat.dispose(); }, [data, mat]);

  useFrame((state, delta) => {
    const pts = ref.current;
    if (!pts || count === 0) { sprayQueue.length = 0; return; }
    const d = Math.min(0.06, delta);

    // Drain the queue into the pool. Oldest slot first: a burst never wipes out
    // droplets that are still in the air if there is room for both.
    while (sprayQueue.length) {
      const e = sprayQueue.shift();
      const o = e.o;
      const speed = o.speed === undefined ? 2.2 : o.speed;
      const spread = o.spread === undefined ? 1.0 : o.spread;
      const up = o.up === undefined ? 1.0 : o.up;
      const life = o.life === undefined ? 0.9 : o.life;
      for (let k = 0; k < e.n; k++) {
        const p = data.drops[data.next % count];
        data.next++;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random());
        p.x = e.x + Math.cos(a) * r * (o.radius || 0.18);
        p.y = e.y + (o.radiusY || 0) * (Math.random() - 0.5);
        p.z = e.z + Math.sin(a) * r * (o.radius || 0.18);
        p.vx = Math.cos(a) * r * speed * spread;
        p.vz = Math.sin(a) * r * speed * spread;
        p.vy = speed * up * (0.5 + Math.random() * 0.8);
        p.grav = o.grav === undefined ? 1 : o.grav;
        p.max = life * (0.7 + Math.random() * 0.6);
        p.life = p.max;
        p.fade = o.bright === undefined ? 1 : o.bright;
      }
    }

    const pos = data.pos, col = data.col;
    let live = 0;
    for (let i = 0; i < count; i++) {
      const p = data.drops[i];
      if (p.life <= 0) { pos[i * 3 + 1] = -9999; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
      p.life -= d;
      p.vy -= SPRAY_GRAVITY * p.grav * d;
      p.x += p.vx * d; p.y += p.vy * d; p.z += p.vz * d;
      // A droplet that lands back in the water stops being a droplet and
      // becomes a ring on the surface.
      if (p.vy < 0) {
        // A droplet that lands back in water becomes a ring on the surface; one
        // that lands on the ground just stops.
        const ws = waterSurfaceAt(p.x, p.z);
        const floor = ws === -Infinity ? getTerrainHeight(p.x, p.z) - 0.02 : ws;
        if (p.y < floor) {
          if (ws !== -Infinity && p.life > 0.12) spawnRipple(p.x, p.z, 0.006);
          p.life = 0;
          pos[i * 3 + 1] = -9999;
          continue;
        }
      }
      live++;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      // Droplets are lit by the sun, not emissive, so they go out with it.
      const k = Math.max(0, p.life / p.max) * p.fade
              * (0.25 + 0.75 * Math.min(1, Math.max(0, skyRuntime.sunI)));
      col[i * 3] = k; col[i * 3 + 1] = k * 1.02; col[i * 3 + 2] = k * 1.06;
    }
    waterRuntime.stats.spray = live;
    data.geo.attributes.position.needsUpdate = true;
    data.geo.attributes.color.needsUpdate = true;
  });

  if (count === 0) return null;
  return html`<points ref=${ref} geometry=${data.geo} material=${mat} frustumCulled=${false} />`;
}

// Animals standing or wading in the pond hold rings on the surface the same way
// the player does. Cheap: a handful of entities, throttled.
const _animalRipple = { t: 0 };
const _mistTimer = { t: 0 };
function WaterDisturbance() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();

  useFrame((state, delta) => {
    // Mist at the foot of the fall. Only while it is in sight: the pool is
    // finite and droplets spent on something 200m away are droplets the splash
    // in front of you does not get.
    if (q.waterMist > 0) {
      const fz = RIVER.zs[Math.min(RIVER.n - 1, RIVER.fallI + 1)];
      const fx = riverCenterX(fz);
      const dx = playerTransform.position[0] - fx;
      const dz = playerTransform.position[2] - fz;
      if (dx * dx + dz * dz < 55 * 55) {
        _mistTimer.t -= delta;
        if (_mistTimer.t <= 0) {
          _mistTimer.t = 0.07;
          emitSpray(fx, RIVER.surf[RIVER.fallI + 1] + 0.15, fz, Math.max(1, q.waterMist / 28 | 0), {
            // Mist hangs: almost no weight, thrown up and outward by the water
            // hitting the pool.
            speed: 1.1, spread: 1.5, up: 1.4, life: 2.2, radius: RIVER_HALF * 0.9,
            radiusY: 0.4, grav: 0.12, bright: 0.55,
          });
        }
      }
    }
    if (q.waterRipples <= 0) return;
    _animalRipple.t -= delta;
    if (_animalRipple.t > 0) return;
    _animalRipple.t = 0.45;
    for (const id in entityRegistry.animals) {
      const a = entityRegistry.animals[id];
      if (!a) continue;
      if (Math.hypot(a[0] - POND_CENTER[0], a[2] - POND_CENTER[1]) > POND_RADIUS) continue;
      spawnRipple(a[0], a[2], 0.03);
    }
    // Rain drives the surface too. The rate is zero until there is weather to
    // drive it, which is the next section; the hook is here so the water does
    // not have to be reopened for it.
    const rain = waterRuntime.rain;
    if (rain > 0) {
      const n = Math.min(4, Math.round(rain * 4));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * POND_RADIUS;
        spawnRipple(POND_CENTER[0] + Math.cos(a) * r, POND_CENTER[1] + Math.sin(a) * r, 0.012);
      }
    }
  });

  return null;
}

function World() {
  return html`
    <${Fragment}>
      <${DayNightSystem} />
      <fog attach="fog" args=${['#bcdaef', 40, 305]} />
      <${Ground} />
      <${Water} />
      <${GrassField} />
      <${DustMotes} />
      <${FallingLeaves} />
      <${WeatherSystem} />
      <${Rain} />
      <${Fireflies} />
      <${GroundClutter} />
      <${Footprints} />
      <${WaterSpray} />
      <${RiverDebris} />
      <${WaterDisturbance} />
      <${DecorativeFoliage} />
    <//>
  `;
}

// ============================================================

export {
  GRASS_CELL,
  GRASS_BLADE_H,
  GRASS_KEY_BIAS,
  grassKey,
  buildGrassBladeGeometry,
  grassDensityForBiome,
  recycleGrassCells,
  grassFade,
  GrassField,
  DecorativeFoliage,
  DUST_HALF,
  DUST_HEIGHT,
  _dustCam,
  DustMotes,
  wrapHalf,
  FIREFLY_HALF,
  Fireflies,
  FALL_HALF,
  FALL_TOP,
  FallingLeaves,
  sprayQueue,
  emitSpray,
  SPRAY_GRAVITY,
  WaterSpray,
  _animalRipple,
  _mistTimer,
  WaterDisturbance,
  World,
};
