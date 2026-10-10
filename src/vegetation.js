import { Fragment, THREE, html, useEffect, useMemo, useRef } from './core.js';
import { mulberry32 } from './data.js';
import { GRAPHICS_PRESETS, gfx } from './graphics.js';
import { useGame } from './store.js';
import { stdMat } from './terrain.js';
import { grainTiled, makeWindy, surfaceTiled } from './wind.js';

// vegetation.js - procedural plant geometry
//
// A plant is a flat list of parts: { k: geometry key, p: offset, r: euler,
// s: scale, c: optional tint }. The same list can be drawn as individual
// meshes (a handful of harvestable trees) or merged into InstancedMeshes (the
// few hundred decorative ones), so detail costs us draw calls only once.
// ============================================================

// Smooth, position-driven wobble. Because it's a function of the vertex
// position, vertices shared between faces always agree and the mesh never
// cracks open - which is what happens if you jitter each vertex randomly.
function wobble3(x, y, z, freq, seed) {
  return Math.sin(x * freq + seed) * Math.sin(y * freq * 1.37 + seed * 1.7)
       * Math.sin(z * freq * 1.11 + seed * 2.3);
}

function displaceGeometry(geo, amount, freq, seed) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = wobble3(x, y, z, freq, seed);
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    p.setXYZ(i, x + (x / l) * n * amount, y + (y / l) * n * amount, z + (z / l) * n * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

// Trunks only bulge sideways - displacing them radially from the origin would
// shorten and shear them.
function displaceXZ(geo, amount, freq, seed) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = wobble3(x, y, z, freq, seed);
    const l = Math.sqrt(x * x + z * z) || 1;
    p.setXYZ(i, x + (x / l) * n * amount, y, z + (z / l) * n * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

// A leaf/frond: tapered, drooping, built along +Y with the stem at the origin so
// a part's scale sets its length directly.
function buildLeafGeometry(steps, droop, width, tipBias) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Leaf silhouette: widest a third of the way along, tapering to a point.
    const hw = width * Math.sin(Math.PI * Math.pow(t, tipBias)) * (1 - t * 0.15);
    const y = t;
    const z = -droop * t * t;
    positions.push(-hw, y, z, hw, y, z);
    uvs.push(0, t, 1, t);
    if (i > 0) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

// Every geometry key used by the part lists, built once on first use.
const VEG_GEO = {};
function vegGeo(key) {
  if (VEG_GEO[key]) return VEG_GEO[key];
  let g;
  if (key === 'trunk') {
    // Unit height, base at y=0, tapering upward. Nine sides reads as round
    // without the cost of a smooth cylinder.
    g = new THREE.CylinderGeometry(0.62, 1, 1, 9, 3, true);
    g.translate(0, 0.5, 0);
    displaceXZ(g, 0.055, 7, 1.3);
  } else if (key === 'branch') {
    g = new THREE.CylinderGeometry(0.3, 1, 1, 6, 1, true);
    g.translate(0, 0.5, 0);
  } else if (key === 'root') {
    // Buttress root: a flattened cone leaning out from the trunk base.
    g = new THREE.ConeGeometry(1, 1, 5, 1);
    g.translate(0, 0.5, 0);
    displaceXZ(g, 0.07, 6, 2.2);
  } else if (key === 'canopy') {
    g = new THREE.IcosahedronGeometry(1, 2);
    displaceGeometry(g, 0.26, 2.4, 0.8);
  } else if (key === 'canopySmall') {
    g = new THREE.IcosahedronGeometry(1, 1);
    displaceGeometry(g, 0.3, 3.1, 1.9);
  } else if (key === 'leafCard') {
    // A sprig of leaves on a quad, bowed slightly so it catches light across
    // its face instead of flipping between fully lit and fully flat.
    g = new THREE.PlaneGeometry(1, 1, 2, 2);
    const cp = g.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i), y = cp.getY(i);
      cp.setZ(i, (0.25 - x * x) * 0.55 + (0.25 - y * y) * 0.2);
    }
    g.computeVertexNormals();
    // The sprig grows upward from the bottom of the card, so pivot there.
    g.translate(0, 0.5, 0);
    // A white vertex-colour attribute, which is what actually lets the
    // per-instance tint reach the output. three.js only multiplies vColor into
    // diffuseColor under USE_COLOR - USE_INSTANCING_COLOR alone computes the
    // varying and then never reads it - and USE_COLOR without this attribute
    // would multiply by the default (0,0,0) and render every leaf black.
    const cw = new Float32Array(g.attributes.position.count * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(cw, 3));
  } else if (key === 'leaf') {
    g = buildLeafGeometry(8, 0.42, 0.17, 0.55);
  } else if (key === 'frond') {
    g = buildLeafGeometry(12, 0.78, 0.13, 0.42);
  } else if (key === 'needleSkirt') {
    g = new THREE.ConeGeometry(1, 1, 9, 2);
    g.translate(0, 0.5, 0);
    displaceGeometry(g, 0.1, 5, 3.3);
  } else if (key === 'snowCap') {
    g = new THREE.ConeGeometry(1, 1, 9, 1);
    g.translate(0, 0.5, 0);
    displaceGeometry(g, 0.07, 6, 4.1);
  } else if (key === 'boulder') {
    g = new THREE.IcosahedronGeometry(1, 1);
    displaceGeometry(g, 0.3, 2.2, 5.5);
  } else if (key === 'pebble') {
    g = new THREE.IcosahedronGeometry(1, 0);
    displaceGeometry(g, 0.22, 3, 6.6);
  } else if (key === 'cactus') {
    g = new THREE.CapsuleGeometry(1, 2.2, 4, 9);
    g.translate(0, 1.1, 0);
    displaceXZ(g, 0.06, 9, 7.7);
  } else if (key === 'vine') {
    g = new THREE.CylinderGeometry(1, 0.7, 1, 4, 1, true);
    g.translate(0, -0.5, 0); // hangs down from its anchor
  } else {
    throw new Error('unknown vegetation geometry ' + key);
  }
  VEG_GEO[key] = g;
  return g;
}

// Which material each geometry key is drawn with.
function vegMat(key) {
  if (key === 'trunk' || key === 'branch' || key === 'root' || key === 'vine') {
    // Wind on the trunk too: the sway scales with height, so the base stays
    // planted and the whole tree leans as one instead of the leaves sliding
    // around a rigid stick.
    return stdMat('barkWind', () => {
      const t = surfaceTiled('bark', [1.6, 2.4]);
      return makeWindy(new THREE.MeshStandardMaterial({
        map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
        roughness: 0.95, envMapIntensity: 1.0,
      }), { mossy: true, noTrample: true });
    });
  }
  if (key === 'leafCard') {
    return stdMat('leafCard', () => {
      const t = surfaceTiled('leafCard', [1, 1]);
      return makeWindy(new THREE.MeshStandardMaterial({
        map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
        // Alpha test rather than blending: cut-outs write depth, which the
        // post chain needs, and they need no sorting.
        alphaTest: 0.32,
        transparent: false,
        side: THREE.DoubleSide,
        roughness: 0.72, envMapIntensity: 1.0,
        vertexColors: true,
      }), { translucent: true, leafLod: true });
    });
  }
  if (key === 'canopy' || key === 'canopySmall' || key === 'needleSkirt') {
    // Whole-tree shapes. Same look as a frond, but a pine's skirt sits on the
    // ground and must not fold away when you walk past it.
    return stdMat('leafWindStiff', () => {
      const t = surfaceTiled('leaf', [1.8, 1.8]);
      return makeWindy(new THREE.MeshStandardMaterial({
        map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
        roughness: 0.68, envMapIntensity: 1.0, side: THREE.DoubleSide,
      }), { translucent: true, noTrample: true });
    });
  }
  if (key === 'leaf' || key === 'frond') {
    return stdMat('leafWind', () => {
      const t = surfaceTiled('leaf', [1.8, 1.8]);
      return makeWindy(new THREE.MeshStandardMaterial({
        map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
        roughness: 0.68, envMapIntensity: 1.0, side: THREE.DoubleSide,
      }), { translucent: true });
    });
  }
  if (key === 'snowCap') {
    return stdMat('snow', () => new THREE.MeshStandardMaterial({
      color: '#eef5fa', roughness: 0.55, metalness: 0, envMapIntensity: 1.0,
    }));
  }
  if (key === 'boulder' || key === 'pebble') {
    return stdMat('rockMoss', () => {
      const t = surfaceTiled('rock', [1.4, 1.4]);
      return makeWindy(new THREE.MeshStandardMaterial({
        map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
        roughness: 0.95, envMapIntensity: 1.0,
      }), { mossy: true, still: true });
    });
  }
  if (key === 'cactus') {
    return stdMat('cactus', () => {
      const s = grainTiled('leaf', [2.4, 3.4]);
      return new THREE.MeshStandardMaterial({
        map: s.map, normalMap: s.normalMap, color: '#8fb86e', roughness: 0.75,
      });
    });
  }
  throw new Error('no material for ' + key);
}

// ---------- Plant model builders ----------
// Each returns a part list. `detail` comes from the graphics preset: 0 drops the
// fiddly extras, 2 is everything.

// ---------- Trees ----------
// Built by actually growing them: a trunk that splits into limbs, which split
// again, each child shorter and thinner than its parent and bent toward the
// light. Foliage hangs only off the ends, in tight clumps, the way it does on a
// real tree - scattering leaves evenly through a sphere is what made the old
// canopies read as a green cloud with a stick under it.
//
// Branches point in arbitrary directions, so parts carry a quaternion rather
// than Euler angles; `aimQuat` turns a direction into one.
const _aimUp = new THREE.Vector3(0, 1, 0);
const _aimDir = new THREE.Vector3();
const _aimQuat = new THREE.Quaternion();
function aimQuat(dx, dy, dz) {
  _aimDir.set(dx, dy, dz);
  if (_aimDir.lengthSq() < 1e-9) _aimDir.set(0, 1, 0);
  _aimDir.normalize();
  _aimQuat.setFromUnitVectors(_aimUp, _aimDir);
  return [_aimQuat.x, _aimQuat.y, _aimQuat.z, _aimQuat.w];
}

// An orthonormal pair perpendicular to `d`, so children can be fanned around
// the parent limb whatever direction it happens to point.
function perpBasis(dx, dy, dz, out) {
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.94) { ux = 1; uy = 0; uz = 0; }
  let ax = uy * dz - uz * dy, ay = uz * dx - ux * dz, az = ux * dy - uy * dx;
  let l = Math.hypot(ax, ay, az) || 1;
  ax /= l; ay /= l; az /= l;
  const bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
  out[0] = ax; out[1] = ay; out[2] = az;
  out[3] = bx; out[4] = by; out[5] = bz;
  return out;
}

const TREE_SPECIES = {
  // The classic rainforest emergent: a long clean bole, buttress roots, and
  // everything happening right at the top.
  jungleGiant: {
    height: [6.5, 9.5], radius: [0.28, 0.42], depth: 3, split: [2, 3],
    spread: 0.56, upBias: 0.38, lenFall: 0.74, radFall: 0.62, firstFork: 0.45,
    clump: [16, 21], clumpR: 0.70, cardSize: [0.36, 0.58],
    buttress: 5, vines: 3, bigLeaf: 2, bigLeafSize: 0.52,
    tints: ['#d6ecbc', '#c2dea8', '#aed096', '#e6f3cf'],
  },
  // Understorey broadleaf: shorter, forks low, and carries a wide bushy head.
  broadleaf: {
    height: [3.4, 5.4], radius: [0.18, 0.27], depth: 3, split: [2, 3],
    spread: 0.70, upBias: 0.26, lenFall: 0.76, radFall: 0.64, firstFork: 0.34,
    clump: [16, 21], clumpR: 0.68, cardSize: [0.34, 0.55],
    buttress: 0, vines: 1, bigLeaf: 2, bigLeafSize: 0.46,
    tints: ['#cde7b0', '#b5d79b', '#a0c98a', '#dcefc4'],
  },
  // Dry country: a short trunk that forks hard and spreads into a flat crown.
  acacia: {
    height: [3.0, 4.6], radius: [0.19, 0.28], depth: 3, split: [2, 3],
    spread: 1.05, upBias: -0.18, lenFall: 0.80, radFall: 0.62, firstFork: 0.42,
    clump: [12, 16], clumpR: 0.82, cardSize: [0.27, 0.45],
    buttress: 0, vines: 0, bigLeaf: 0, flatten: 0.42,
    tints: ['#cfdfa4', '#bcd092', '#aabf84', '#dde9bb'],
  },
  // Standing deadwood: all structure, no leaves. Does a lot for a treeline.
  deadTree: {
    height: [4.0, 7.0], radius: [0.20, 0.32], depth: 4, split: [2, 3],
    spread: 0.78, upBias: 0.30, lenFall: 0.70, radFall: 0.58, firstFork: 0.44,
    clump: [0, 0], clumpR: 0, cardSize: [0, 0],
    buttress: 0, vines: 0, bigLeaf: 0, bark: '#6d6457',
    tints: [],
  },
  // Swamp edge: props itself up out of the water on stilt roots.
  mangrove: {
    height: [3.2, 5.0], radius: [0.17, 0.24], depth: 3, split: [2, 3],
    spread: 0.72, upBias: 0.28, lenFall: 0.76, radFall: 0.64, firstFork: 0.34,
    clump: [14, 19], clumpR: 0.62, cardSize: [0.31, 0.50],
    buttress: 0, stilts: 6, vines: 1, bigLeaf: 1, bigLeafSize: 0.44,
    tints: ['#a8c493', '#93b57f', '#879e74', '#bcd3a6'],
  },
};

// One terminal clump of foliage. Tight and roughly spherical: this is what
// makes the crown read as bushy rather than as a scatter of loose leaves.
function addLeafClump(parts, rand, sp, detail, x, y, z, scale, countScale) {
  if (!sp.tints.length) return;
  const lo = sp.clump[0], hi = sp.clump[1];
  let n = Math.round((lo + Math.floor(rand() * (hi - lo + 1))) * (countScale || 1));
  if (detail === 0) n = Math.max(1, Math.round(n * 0.4));
  else if (detail === 1) n = Math.max(2, Math.round(n * 0.7));
  const R = sp.clumpR * scale;
  // The clump's volume grows with the limb, but a single sprig is a sprig
  // whatever branch it is on - a leaf does not get bigger because the tree is.
  const csScale = 0.75 + 0.25 * scale;
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * rand());
    const rr = Math.pow(rand(), 0.45) * R;
    const cs = (sp.cardSize[0] + rand() * (sp.cardSize[1] - sp.cardSize[0])) * csScale;
    parts.push({
      k: 'leafCard',
      p: [
        x + Math.sin(phi) * Math.cos(a) * rr,
        y + Math.cos(phi) * rr * (sp.flatten ? sp.flatten : 0.8),
        z + Math.sin(phi) * Math.sin(a) * rr,
      ],
      r: [(rand() - 0.5) * 2.0, rand() * 6.28, (rand() - 0.5) * 1.4],
      s: [cs, cs, cs],
      c: sp.tints[Math.floor(rand() * sp.tints.length)],
    });
  }
  // An occasional broad single leaf hanging off a branch end, as an accent on
  // the silhouette. These used to be metre-and-a-half slabs floating around the
  // trunk at mid-crown with nothing joining them to the tree, which is exactly
  // how they read.
  if (!sp.bigLeaf || detail === 0 || rand() > 0.3) return;
  const big = 1 + Math.floor(rand() * sp.bigLeaf);
  // bigLeafSize is the leaf's LENGTH. The leaf geometry is already a unit-long
  // blade a third as wide, so a uniform scale keeps it leaf-shaped.
  const bs = (sp.bigLeafSize || 0.45) * csScale;
  for (let i = 0; i < big; i++) {
    const a = rand() * Math.PI * 2;
    const rr = R * (0.3 + rand() * 0.5);
    const bl = bs * (0.85 + rand() * 0.35);
    parts.push({
      k: 'leaf',
      // Hung from just below the clump centre and drooping outward, so it
      // reads as growing off the branch end rather than hovering.
      p: [x + Math.cos(a) * rr, y - R * (0.1 + rand() * 0.3), z + Math.sin(a) * rr],
      r: [1.5 + rand() * 0.9, a, (rand() - 0.5) * 0.5],
      s: [bl, bl, bl],
    });
  }
}

// Grow one limb, then its children. Depth-first; the whole tree is a few
// hundred parts at most and it is built once, at placement.
function growLimb(parts, rand, sp, detail, x, y, z, dx, dy, dz, len, rad, depth) {
  parts.push({
    k: 'branch',
    p: [x, y, z],
    q: aimQuat(dx, dy, dz),
    s: [rad, len, rad],
  });
  const ex = x + dx * len, ey = y + dy * len, ez = z + dz * len;

  if (depth >= sp.depth || len < 0.26) {
    const sc = Math.min(1.3, len * 1.2 + 0.4);
    addLeafClump(parts, rand, sp, detail, ex, ey, ez, sc);
    // A second, smaller clump back along the limb. One clump per tip leaves the
    // branch between the forks bare, which is what made the crowns read as
    // twigs with pompoms on rather than as foliage.
    if (detail > 0 && sp.tints.length) {
      const b = 0.5 + rand() * 0.2;
      addLeafClump(parts, rand, sp, detail,
        x + dx * len * b, y + dy * len * b, z + dz * len * b, sc * 0.72, 0.6);
    }
    return;
  }

  // Foliage at the forks as well as the tips. Hanging leaves only off the last
  // generation leaves the primary limbs bare all the way through the crown,
  // and on a big tree those are 4m sticks poking out above the canopy.
  if (detail > 0 && sp.tints.length) {
    addLeafClump(parts, rand, sp, detail, ex, ey, ez, Math.min(1.1, len * 0.8 + 0.3), 0.4);
  }

  const basis = [0, 0, 0, 0, 0, 0];
  perpBasis(dx, dy, dz, basis);
  const kids = sp.split[0] + (rand() < 0.55 ? (sp.split[1] - sp.split[0]) : 0);
  const roll = rand() * Math.PI * 2;
  for (let i = 0; i < kids; i++) {
    const phi = roll + (i / kids) * Math.PI * 2 + (rand() - 0.5) * 0.7;
    const ang = sp.spread * (0.65 + rand() * 0.7);
    const sa = Math.sin(ang), ca = Math.cos(ang);
    const px = basis[0] * Math.cos(phi) + basis[3] * Math.sin(phi);
    const py = basis[1] * Math.cos(phi) + basis[4] * Math.sin(phi);
    const pz = basis[2] * Math.cos(phi) + basis[5] * Math.sin(phi);
    let nx = dx * ca + px * sa;
    let ny = dy * ca + py * sa;
    let nz = dz * ca + pz * sa;
    // Phototropism: every limb bends back toward the light a little, which is
    // what stops a recursive tree looking like a fractal and starts it looking
    // like something that grew.
    ny += sp.upBias;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const childLen = len * sp.lenFall * (0.82 + rand() * 0.34);
    const childRad = rad * sp.radFall * (0.88 + rand() * 0.22);
    growLimb(parts, rand, sp, detail, ex, ey, ez, nx, ny, nz, childLen, childRad, depth + 1);
  }
}

function buildTreeModel(rand, detail, speciesKey) {
  const sp = TREE_SPECIES[speciesKey] || TREE_SPECIES.jungleGiant;
  const parts = [];
  const h = sp.height[0] + rand() * (sp.height[1] - sp.height[0]);
  const rad = sp.radius[0] + rand() * (sp.radius[1] - sp.radius[0]);
  const lean = (rand() - 0.5) * 0.10;

  // The bole: a clean length of trunk before anything forks.
  const boleH = h * sp.firstFork;
  parts.push({
    k: 'trunk',
    p: [0, 0, 0],
    q: aimQuat(lean, 1, lean * 0.7),
    s: [rad, boleH, rad],
    c: sp.bark || null,
  });

  if (sp.buttress) {
    for (let i = 0; i < sp.buttress; i++) {
      const a = (i / sp.buttress) * Math.PI * 2 + rand() * 0.5;
      const rl = rad * (3.4 + rand() * 2.2);
      parts.push({
        k: 'root',
        p: [Math.cos(a) * rad * 0.8, 0, Math.sin(a) * rad * 0.8],
        r: [Math.cos(a) * 0.95, -a, -Math.sin(a) * 0.95],
        s: [rad * 0.85, rl, rad * 0.5],
        c: sp.bark || null,
      });
    }
  }
  if (sp.stilts) {
    // Mangrove props: legs angling out of the trunk down into the mud.
    for (let i = 0; i < sp.stilts; i++) {
      const a = (i / sp.stilts) * Math.PI * 2 + rand() * 0.4;
      const up = boleH * (0.35 + rand() * 0.35);
      const out = 0.5 + rand() * 0.5;
      parts.push({
        k: 'branch',
        p: [0, up, 0],
        q: aimQuat(Math.cos(a) * out, -up, Math.sin(a) * out),
        s: [rad * 0.42, Math.hypot(out, up) * 1.04, rad * 0.42],
        c: sp.bark || null,
      });
    }
  }

  // Grow the crown from the top of the bole.
  const crownLen = h * (1 - sp.firstFork) * 0.62;
  const basis = [0, 0, 0, 0, 0, 0];
  perpBasis(lean, 1, lean * 0.7, basis);
  const trunkKids = sp.split[0] + (rand() < 0.7 ? (sp.split[1] - sp.split[0]) : 0);
  const roll0 = rand() * Math.PI * 2;
  for (let i = 0; i < trunkKids; i++) {
    const phi = roll0 + (i / trunkKids) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const ang = sp.spread * (0.55 + rand() * 0.5);
    const sa = Math.sin(ang), ca = Math.cos(ang);
    const px = basis[0] * Math.cos(phi) + basis[3] * Math.sin(phi);
    const py = basis[1] * Math.cos(phi) + basis[4] * Math.sin(phi);
    const pz = basis[2] * Math.cos(phi) + basis[5] * Math.sin(phi);
    let nx = lean * ca + px * sa, ny = ca + py * sa, nz = lean * 0.7 * ca + pz * sa;
    ny += sp.upBias * 0.5;
    const nl = Math.hypot(nx, ny, nz) || 1;
    growLimb(parts, rand, sp, detail, 0, boleH, 0, nx / nl, ny / nl, nz / nl,
      crownLen * (0.72 + rand() * 0.28), rad * 0.72, 1);
  }

  if (sp.vines && detail > 1) {
    for (let i = 0; i < sp.vines; i++) {
      const a = rand() * Math.PI * 2;
      const d = 0.5 + rand() * 1.2;
      parts.push({
        k: 'vine',
        p: [Math.cos(a) * d, boleH + crownLen * 0.5, Math.sin(a) * d],
        r: [0, 0, (rand() - 0.5) * 0.25],
        s: [0.035, 1.4 + rand() * 2.6, 0.035],
      });
    }
  }
  return parts;
}

// Kept so existing callers and saves keep working.
function buildJungleTreeModel(rand, detail) {
  return buildTreeModel(rand, detail, 'jungleGiant');
}

function buildPalmModel(rand, detail) {
  const parts = [];
  const h = 5 + rand() * 3;
  const rad = 0.14 + rand() * 0.05;
  const curve = (rand() - 0.5) * 0.5;
  // Stacked, progressively tilted segments give the trunk its characteristic
  // sweep; one straight cylinder reads as a telegraph pole.
  const segs = 5;
  let y = 0, x = 0, tilt = 0;
  for (let i = 0; i < segs; i++) {
    const sl = h / segs;
    const sr = rad * (1 - i * 0.07);
    parts.push({ k: 'trunk', p: [x, y, 0], r: [0, 0, tilt], s: [sr, sl, sr] });
    x += Math.sin(tilt) * sl;
    y += Math.cos(tilt) * sl;
    tilt += curve / segs;
  }
  const fronds = detail > 0 ? 8 + Math.floor(rand() * 4) : 6;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rand() * 0.3;
    parts.push({
      k: 'frond',
      p: [x, y, 0],
      r: [0.55 + rand() * 0.55, a, 0],
      s: [1.5, 2.6 + rand() * 1.0, 1.5],
      c: ['#8fc97a', '#76b464', '#a3d98c'][Math.floor(rand() * 3)],
    });
  }
  // The dead, drooping skirt under the crown.
  if (detail > 0) {
    for (let i = 0; i < 4; i++) {
      const a = rand() * Math.PI * 2;
      parts.push({
        k: 'frond', p: [x, y - 0.12, 0], r: [2.3 + rand() * 0.4, a, 0],
        s: [1.1, 1.5 + rand() * 0.6, 1.1], c: '#8a7a46',
      });
    }
  }
  return parts;
}

function buildPineModel(rand, detail, snowy) {
  const parts = [];
  const h = 5 + rand() * 3.5;
  const rad = 0.15 + rand() * 0.07;
  parts.push({ k: 'trunk', p: [0, 0, 0], r: [0, rand() * 6.28, 0], s: [rad, h, rad] });
  const tiers = detail > 0 ? 5 : 3;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = h * (0.26 + t * 0.66);
    const r = (1.75 - t * 1.25) * (0.75 + rand() * 0.3);
    const th = h * (0.3 - t * 0.1);
    parts.push({
      k: 'needleSkirt', p: [0, y, 0], r: [0, rand() * 6.28, 0], s: [r, th, r],
      c: snowy ? '#4e7f63' : ['#2f6b33', '#3b7d3d', '#27592c'][Math.floor(rand() * 3)],
    });
    // Snow sits on the upper surface of each tier, thicker toward the top.
    if (snowy && (detail > 0 || i >= tiers - 2)) {
      parts.push({
        k: 'snowCap', p: [0, y + th * 0.1, 0], r: [0, rand() * 6.28, 0],
        s: [r * (0.72 + t * 0.2), th * 0.52, r * (0.72 + t * 0.2)],
      });
    }
  }
  return parts;
}

function buildBushModel(rand, detail, swamp) {
  const parts = [];
  // Same treatment as the canopy: a shrub is a cluster of sprigs, not a lump
  // of green. A few short woody stems hold them up so it has some structure
  // underneath rather than floating leaves.
  const tint = swamp
    ? ['#9ab78a', '#88a87a', '#7d9c72', '#a6c096']
    : ['#d6ecbc', '#c2dea8', '#aed096', '#e6f3cf'];
  const stems = detail > 0 ? 3 + Math.floor(rand() * 3) : 2;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rand() * 0.8;
    const lean = 0.35 + rand() * 0.4;
    parts.push({
      k: 'branch',
      p: [Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06],
      r: [Math.cos(a) * lean, -a, -Math.sin(a) * lean],
      s: [0.028, 0.42 + rand() * 0.26, 0.028],
    });
  }
  const cards = detail === 0 ? 7 : detail === 1 ? 13 : 20;
  for (let i = 0; i < cards; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.pow(rand(), 0.6) * 0.46;
    const cs = 0.42 + rand() * 0.34;
    parts.push({
      k: 'leafCard',
      p: [Math.cos(a) * d, 0.16 + rand() * 0.42, Math.sin(a) * d],
      r: [(rand() - 0.5) * 1.7, rand() * 6.28, (rand() - 0.5) * 1.3],
      s: [cs, cs, cs],
      c: tint[Math.floor(rand() * tint.length)],
    });
  }
  // A few broad fronds breaking the outline, which is what stops a shrub
  // reading as a ball of foliage.
  if (detail > 0) {
    const n = 3 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.6;
      parts.push({
        k: 'leaf',
        p: [Math.cos(a) * 0.15, 0.12 + rand() * 0.2, Math.sin(a) * 0.15],
        r: [0.6 + rand() * 0.7, a, 0],
        s: [0.95, 0.6 + rand() * 0.4, 0.95],
      });
    }
  }
  return parts;
}

// Ferns: the bottom of the three layers. Fronds radiating from a crown, which
// is the shape that makes a forest floor read as overgrown rather than mown.
function buildFernModel(rand, detail, swamp) {
  const parts = [];
  const fronds = detail === 0 ? 5 : detail === 1 ? 8 : 11;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rand() * 0.5;
    // Outer fronds splay almost flat, inner ones stand up - a fern is a
    // shuttlecock, not a starburst.
    const t = rand();
    const droop = 0.75 + t * 0.75;
    const len = 0.55 + rand() * 0.5;
    parts.push({
      k: 'frond',
      p: [Math.cos(a) * 0.05, 0.1 + (1 - t) * 0.16, Math.sin(a) * 0.05],
      r: [droop, a, 0],
      s: [0.68 + rand() * 0.2, len, 0.68 + rand() * 0.2],
    });
  }
  if (detail > 0) {
    const sprigs = swamp ? 4 : 3;
    for (let i = 0; i < sprigs; i++) {
      const a = rand() * Math.PI * 2;
      const cs = 0.3 + rand() * 0.22;
      parts.push({
        k: 'leafCard',
        p: [Math.cos(a) * 0.16, 0.08 + rand() * 0.18, Math.sin(a) * 0.16],
        r: [(rand() - 0.5) * 1.2, rand() * 6.28, (rand() - 0.5) * 0.9],
        s: [cs, cs, cs],
        c: swamp ? '#92ad84' : '#c8e2ae',
      });
    }
  }
  return parts;
}

function buildRockModel(rand, detail) {
  const parts = [];
  const s = 0.5 + rand() * 0.25;
  parts.push({
    k: 'boulder', p: [0, s * 0.72, 0],
    r: [rand() * 6.28, rand() * 6.28, rand() * 6.28],
    s: [s * 1.25, s * (0.8 + rand() * 0.4), s * 1.1],
  });
  // A couple of smaller stones at the base; a boulder never sits alone.
  if (detail > 0) {
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = s * (1.0 + rand() * 0.8);
      const ps = s * (0.14 + rand() * 0.22);
      parts.push({
        k: 'pebble', p: [Math.cos(a) * d, ps * 0.6, Math.sin(a) * d],
        r: [rand() * 6.28, rand() * 6.28, rand() * 6.28], s: [ps * 1.3, ps, ps * 1.2],
      });
    }
  }
  return parts;
}

function buildCactusModel(rand, detail) {
  const parts = [];
  const r = 0.15 + rand() * 0.06;
  const h = 0.75 + rand() * 0.45;
  parts.push({ k: 'cactus', p: [0, 0, 0], r: [0, rand() * 6.28, 0], s: [r, h, r] });
  const arms = detail > 0 ? 1 + Math.floor(rand() * 3) : 1;
  for (let i = 0; i < arms; i++) {
    const a = rand() * Math.PI * 2;
    const ay = (0.9 + rand() * 1.1) * h;
    parts.push({
      k: 'cactus',
      p: [Math.cos(a) * r * 1.4, ay, Math.sin(a) * r * 1.4],
      r: [Math.cos(a) * 0.5, -a, -Math.sin(a) * 0.5],
      s: [r * 0.6, h * 0.42, r * 0.6],
    });
  }
  return parts;
}

// Stable per-position seed, so the same tree is the same shape every reload and
// across both multiplayer clients.
function seedFromPosition(position, salt) {
  return Math.abs(Math.round(position[0] * 73.1 + position[2] * 149.7 + (salt || 0) * 31)) + 1;
}

// ---------- Drawing a part list ----------
// Individual meshes. Used for the handful of harvestable plants, where we want
// them to be separate objects that can disappear when depleted.
function ProcModel({ model, position, scale = 1, rotY = 0 }) {
  const instances = useMemo(
    () => [{ model, position, scale, rotY }],
    [model, position, scale, rotY]
  );
  return html`<${InstancedModels} instances=${instances} />`;
}

// One InstancedMesh per geometry key. frustumCulled is off because the instances
// are scattered across the whole map while the geometry's own bounding sphere is
// unit-sized - three would otherwise cull the entire batch the moment the
// origin left the view.
function InstancedPart({ geometry, material, matrices, colors }) {
  const ref = useRef();
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const tint = new THREE.Color();
    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]);
      tint.set(colors[i] || '#ffffff');
      mesh.setColorAt(i, tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [matrices, colors]);
  return html`
    <instancedMesh
      ref=${ref}
      args=${[geometry, material, matrices.length]}
      castShadow=${true}
      receiveShadow=${true}
      frustumCulled=${false}
    />
  `;
}

// Flatten a list of placed models into one batch per geometry key. Each part's
// local transform is composed with its plant's own placement, so the GPU gets a
// single world matrix per part and we get one draw call per geometry rather than
// one per part.
function groupModelInstances(instances) {
  const byKey = new Map();
  const m = new THREE.Matrix4();
  const parent = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const inst of instances) {
    const s = inst.scale === undefined ? 1 : inst.scale;
    e.set(0, inst.rotY || 0, 0);
    q.setFromEuler(e);
    parent.compose(v.set(inst.position[0], inst.position[1], inst.position[2]), q, sc.set(s, s, s));
    for (const part of inst.model) {
      if (part.q) {
        q.set(part.q[0], part.q[1], part.q[2], part.q[3]);
      } else {
        const r = part.r || [0, 0, 0];
        e.set(r[0], r[1], r[2]);
        q.setFromEuler(e);
      }
      local.compose(v.set(part.p[0], part.p[1], part.p[2]), q, sc.set(part.s[0], part.s[1], part.s[2]));
      m.multiplyMatrices(parent, local);
      let g = byKey.get(part.k);
      if (!g) {
        g = { matrices: [], colors: [] };
        byKey.set(part.k, g);
      }
      g.matrices.push(m.clone());
      g.colors.push(part.c || null);
    }
  }
  return Array.from(byKey.entries());
}

function InstancedModels({ instances }) {
  const groups = useMemo(() => groupModelInstances(instances), [instances]);

  return html`
    <${Fragment}>
      ${groups.map(([key, g]) => html`
        <${InstancedPart}
          key=${key}
          geometry=${vegGeo(key)}
          material=${vegMat(key)}
          matrices=${g.matrices}
          colors=${g.colors}
        />
      `)}
    <//>
  `;
}

// ---------- The plants the game code asks for by name ----------
// Same props as before, so Resources and the rest of the game are unchanged.
function Tree({ position, scale = 1 }) {
  const detail = (GRAPHICS_PRESETS[useGame((s) => s.graphicsQuality)] || gfx()).treeDetail;
  const model = useMemo(
    () => buildJungleTreeModel(mulberry32(seedFromPosition(position, 1)), detail),
    [position[0], position[2], detail]
  );
  return html`<${ProcModel} model=${model} position=${position} scale=${scale} />`;
}

function SnowTree({ position, scale = 1 }) {
  const detail = (GRAPHICS_PRESETS[useGame((s) => s.graphicsQuality)] || gfx()).treeDetail;
  const model = useMemo(
    () => buildPineModel(mulberry32(seedFromPosition(position, 2)), detail, true),
    [position[0], position[2], detail]
  );
  return html`<${ProcModel} model=${model} position=${position} scale=${scale} />`;
}

function Cactus({ position, scale = 1 }) {
  const model = useMemo(
    () => buildCactusModel(mulberry32(seedFromPosition(position, 3)), 1),
    [position[0], position[2]]
  );
  return html`<${ProcModel} model=${model} position=${position} scale=${scale} />`;
}

function Rock({ position, scale = 1 }) {
  const model = useMemo(
    () => buildRockModel(mulberry32(seedFromPosition(position, 4)), 1),
    [position[0], position[2]]
  );
  return html`<${ProcModel} model=${model} position=${position} scale=${scale} />`;
}

function Bush({ position, scale = 1 }) {
  const model = useMemo(
    () => buildBushModel(mulberry32(seedFromPosition(position, 5)), 1, false),
    [position[0], position[2]]
  );
  return html`<${ProcModel} model=${model} position=${position} scale=${scale} />`;
}

// ============================================================

export {
  wobble3,
  displaceGeometry,
  displaceXZ,
  buildLeafGeometry,
  VEG_GEO,
  vegGeo,
  vegMat,
  _aimUp,
  _aimDir,
  _aimQuat,
  aimQuat,
  perpBasis,
  TREE_SPECIES,
  addLeafClump,
  growLimb,
  buildTreeModel,
  buildJungleTreeModel,
  buildPalmModel,
  buildPineModel,
  buildBushModel,
  buildFernModel,
  buildRockModel,
  buildCactusModel,
  seedFromPosition,
  ProcModel,
  InstancedPart,
  groupModelInstances,
  InstancedModels,
  Tree,
  SnowTree,
  Cactus,
  Rock,
  Bush,
};
