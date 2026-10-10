import { Fragment, THREE, html, useEffect, useFrame, useMemo, useRef } from './core.js';
import { mulberry32 } from './data.js';
import { GRAPHICS_PRESETS, gfx } from './graphics.js';
import { recycleGrassCells } from './grass.js';
import { playerTransform } from './multiplayer.js';
import { useGame } from './store.js';
import { getTerrainHeight, waterSurfaceAt } from './terrain.js';
import { vegGeo, vegMat } from './vegetation.js';
import { grainTiled } from './wind.js';

// ============================================================
// clutter.js - what is lying on the forest floor
//
// A rainforest floor is never bare: it is fallen leaves, twigs, pebbles,
// mushrooms and rotting wood. The terrain can be as well-textured as you like
// and it will still read as a painted surface until there are objects sitting
// on it casting their own little shadows.
//
// Scattered the way the grass is - a ring of cells around the player, recycled
// as you walk, contents derived from the cell coordinates so a place looks the
// same every time you come back - rather than spread thinly over the whole map.
// Clutter only matters where you can see it.
// ============================================================

const CLUTTER_CELL = 5.0;

// Each kind: which geometry, how many per cell, how big, and how it sits.
// `flat` lies the thing down on the ground; otherwise it stands up.
const CLUTTER_KINDS = [
  { key: 'leafCard', per: 11, size: [0.20, 0.42], flat: true, sink: 0.01,
    tints: ['#6b5b32', '#7a6334', '#5d5330', '#86693a', '#4f4a2c'] },
  { key: 'branch', per: 4, size: [0.03, 0.06], long: [0.25, 0.75], flat: true, sink: 0.015,
    tints: ['#4a3f2e', '#55472f', '#3e362a'] },
  { key: 'pebble', per: 3, size: [0.045, 0.12], flat: false, sink: 0.35,
    tints: ['#6b665e', '#575249', '#7b746a'] },
  { key: 'mushroom', per: 1, size: [0.05, 0.11], flat: false, sink: 0.0,
    tints: ['#d8c9a8', '#c08a5a', '#e3d9c0', '#9c6b48'] },
];

// A cap on a stalk. Small enough that two dozen triangles is plenty.
function buildMushroomGeometry(THREE) {
  const cap = new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.52);
  cap.scale(1, 0.62, 1);
  cap.translate(0, 0.98, 0);
  const stem = new THREE.CylinderGeometry(0.22, 0.30, 1.0, 5, 1);
  stem.translate(0, 0.5, 0);
  const merged = mergeSimpleGeometries(THREE, [cap, stem]);
  cap.dispose();
  stem.dispose();
  return merged;
}

// three's BufferGeometryUtils is an addon; this only has to handle two
// non-indexed-or-indexed position/normal geometries, so it is cheaper to do it
// here than to pull the addon in.
function mergeSimpleGeometries(THREE, list) {
  const pos = [];
  const nrm = [];
  for (const g of list) {
    const gp = g.attributes.position;
    const gn = g.attributes.normal;
    const idx = g.index ? g.index.array : null;
    const count = idx ? idx.length : gp.count;
    for (let i = 0; i < count; i++) {
      const v = idx ? idx[i] : i;
      pos.push(gp.getX(v), gp.getY(v), gp.getZ(v));
      nrm.push(gn.getX(v), gn.getY(v), gn.getZ(v));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const white = new Float32Array(pos.length).fill(1);
  out.setAttribute('color', new THREE.BufferAttribute(white, 3));
  return out;
}

let _mushroomGeo = null;
function clutterGeometry(THREE, key) {
  if (key === 'mushroom') {
    if (!_mushroomGeo) _mushroomGeo = buildMushroomGeometry(THREE);
    return _mushroomGeo;
  }
  return vegGeo(key);
}

function GroundClutter() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const density = q.clutter === undefined ? 1 : q.clutter;
  const refs = useRef([]);

  const plan = useMemo(() => {
    const offs = [];
    const radius = Math.max(0, q.clutterRadius || 0);
    const span = Math.ceil(radius / CLUTTER_CELL);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const d = Math.hypot(dx, dz) * CLUTTER_CELL;
        if (d <= radius) offs.push([dx, dz, d]);
      }
    }
    offs.sort((a, b) => a[2] - b[2]);
    return { offs, blocks: offs.length, radius };
  }, [q.clutterRadius]);

  const kinds = useMemo(() => CLUTTER_KINDS.map((k) => ({
    ...k,
    count: Math.max(1, Math.round(k.per * density)),
  })), [density]);

  const books = useMemo(() => kinds.map(() => ({
    live: new Map(), free: [], cx: null, cz: null,
  })), [kinds, plan.blocks]);

  useEffect(() => {
    for (const book of books) {
      book.live.clear();
      book.free.length = 0;
      for (let i = plan.blocks - 1; i >= 0; i--) book.free.push(i);
      book.cx = null;
      book.cz = null;
    }
  }, [books, plan.blocks]);

  const scratch = useMemo(() => ({
    m: new THREE.Matrix4(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
    e: new THREE.Euler(), s: new THREE.Vector3(), c: new THREE.Color(),
  }), []);

  useFrame(() => {
    if (plan.blocks === 0) return;
    const px = playerTransform.position[0];
    const pz = playerTransform.position[2];
    const cx = Math.floor(px / CLUTTER_CELL);
    const cz = Math.floor(pz / CLUTTER_CELL);
    const sc = scratch;

    for (let ki = 0; ki < kinds.length; ki++) {
      const mesh = refs.current[ki];
      const kind = kinds[ki];
      const book = books[ki];
      if (!mesh) continue;
      if (book.cx === cx && book.cz === cz) continue;

      recycleGrassCells(book, { offs: plan.offs }, cx, cz, plan.radius, (block, gx, gz) => {
        // Seeded from the cell and the kind, so each kind scatters differently
        // and a cell looks identical every time you walk back into it.
        const rand = mulberry32(((gx & 0xffff) << 16 ^ (gz & 0xffff)) + ki * 7919 + 101);
        for (let i = 0; i < kind.count; i++) {
          const idx = block * kind.count + i;
          const x = gx * CLUTTER_CELL + rand() * CLUTTER_CELL;
          const z = gz * CLUTTER_CELL + rand() * CLUTTER_CELL;
          const y = getTerrainHeight(x, z);
          // Nothing lies on the water, and nothing sits inside the camp.
          const drowned = waterSurfaceAt(x, z) > y - 0.05;
          const keep = !drowned && rand() < 0.86;
          if (!keep) {
            sc.m.makeScale(0, 0, 0);
            mesh.setMatrixAt(idx, sc.m);
            continue;
          }
          const size = kind.size[0] + rand() * (kind.size[1] - kind.size[0]);
          if (kind.flat) {
            // Lying down, with a little tilt so it follows the ground rather
            // than hovering flat on a slope.
            sc.e.set(-Math.PI / 2 + (rand() - 0.5) * 0.5, rand() * Math.PI * 2,
              (rand() - 0.5) * 0.5);
          } else {
            sc.e.set((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25);
          }
          sc.q.setFromEuler(sc.e);
          sc.v.set(x, y - size * kind.sink, z);
          if (kind.long) {
            const len = kind.long[0] + rand() * (kind.long[1] - kind.long[0]);
            sc.s.set(size, len, size);
          } else {
            sc.s.set(size, size, size);
          }
          sc.m.compose(sc.v, sc.q, sc.s);
          mesh.setMatrixAt(idx, sc.m);
          sc.c.set(kind.tints[Math.floor(rand() * kind.tints.length)]);
          mesh.setColorAt(idx, sc.c);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  if (plan.blocks === 0) return null;
  return html`
    <${Fragment}>
      ${kinds.map((kind, i) => html`
        <instancedMesh
          key=${kind.key + i}
          ref=${(r) => { refs.current[i] = r; }}
          args=${[clutterGeometry(THREE, kind.key), clutterMaterial(kind.key), plan.blocks * kind.count]}
          castShadow=${true}
          receiveShadow=${true}
          frustumCulled=${false}
        />`)}
    <//>
  `;
}

// Clutter is tinted per instance, so every material here needs the white colour
// attribute and vertexColors - without the attribute the instances render black.
const CLUTTER_MATS = {};
function clutterMaterial(key) {
  if (CLUTTER_MATS[key]) return CLUTTER_MATS[key];
  const base = key === 'leafCard' ? vegMat('leafCard')
    : key === 'pebble' ? vegMat('pebble')
      : key === 'branch' ? vegMat('branch')
        : null;
  let m;
  if (base) {
    m = base.clone();
    m.vertexColors = true;
  } else {
    const s = grainTiled('ground', [1, 1]);
    m = new THREE.MeshStandardMaterial({
      map: s.map, normalMap: s.normalMap,
      roughness: 0.82, metalness: 0, vertexColors: true, envMapIntensity: 1.0,
    });
  }
  CLUTTER_MATS[key] = m;
  return m;
}

export {
  CLUTTER_CELL,
  CLUTTER_KINDS,
  buildMushroomGeometry,
  mergeSimpleGeometries,
  _mushroomGeo,
  clutterGeometry,
  GroundClutter,
  CLUTTER_MATS,
  clutterMaterial,
};
