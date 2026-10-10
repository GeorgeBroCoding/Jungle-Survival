import { THREE } from './core.js';
import { mulberry32 } from './data.js';

// textures.js - procedural canvas textures, no image assets
//
// Everything here is generated at runtime from seeded noise, so the game
// stays a single file with no asset downloads. Each surface returns a small
// bundle { map, normalMap, roughnessMap } so materials get real relief and
// varying gloss instead of a flat colour.
// ============================================================
// Shared easing used by the noise lattice, the pond basin and the grass fade.
const smoothstep = (t) => t * t * (3 - 2 * t);

function makeCanvas(size, h) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = h || size;
  return cv;
}

// Seamless value noise. The lattice wraps, so the resulting tile repeats with
// no visible seam. cellsY differs from cellsX for stretched grain (bark, water).
function latticeNoise(size, cellsX, cellsY, seed) {
  const rand = mulberry32(seed);
  const cx = Math.max(1, Math.round(cellsX));
  const cy = Math.max(1, Math.round(cellsY));
  const g = new Float32Array(cx * cy);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cy;
    const y0 = Math.floor(fy);
    const ty = smoothstep(fy - y0);
    const ry0 = ((y0 % cy) + cy) % cy;
    const ry1 = (ry0 + 1) % cy;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cx;
      const x0 = Math.floor(fx);
      const tx = smoothstep(fx - x0);
      const rx0 = ((x0 % cx) + cx) % cx;
      const rx1 = (rx0 + 1) % cx;
      const a = g[ry0 * cx + rx0], b = g[ry0 * cx + rx1];
      const c = g[ry1 * cx + rx0], d = g[ry1 * cx + rx1];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

// Stacked octaves of the above: the broad shapes come from the first octave,
// the grit from the last.
function fbm(size, cellsX, cellsY, octaves, seed) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, cx = cellsX, cy = cellsY;
  for (let o = 0; o < octaves; o++) {
    const layer = latticeNoise(size, cx, cy, seed + o * 1013);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= 0.5;
    cx *= 2;
    cy *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Sobel the height field into a tangent-space normal map. Wrapping lookups keep
// the normals seamless across the tile edge, same as the height field.
function normalMapFromHeight(h, size, strength) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const s = (strength === undefined ? 2 : strength) * size / 256;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * s;
      const dy = (at(x, y + 1) - at(x, y - 1)) * s;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// Height field -> greyscale map, for roughness/AO style channels.
function greyCanvasFromField(field, size, lo, hi) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const v = Math.round((lo + (hi - lo) * field[i]) * 255);
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Map a 0..1 noise value through colour stops.
function rampColor(stops, t) {
  if (t <= stops[0].t) return stops[0].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t <= b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return stops[stops.length - 1].rgb;
}

function makeRamp(list) {
  return list.map(([t, hex]) => ({ t, rgb: hexToRgb(hex) }));
}

// Paint a colour ramp over a noise field, optionally modulated by a second
// field so the albedo doesn't track the relief exactly (real surfaces don't).
function albedoCanvas(size, field, ramp, tintField, tintAmount) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const c = rampColor(ramp, field[i]);
    const m = tintField ? 1 + (tintField[i] - 0.5) * tintAmount : 1;
    const o = i * 4;
    img.data[o] = Math.max(0, Math.min(255, c[0] * m));
    img.data[o + 1] = Math.max(0, Math.min(255, c[1] * m));
    img.data[o + 2] = Math.max(0, Math.min(255, c[2] * m));
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function texFrom(canvas, repeat, srgb) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- Surface bundles ----------
// Each builder returns { map, normalMap, roughnessMap } ready to spread onto a
// meshStandardMaterial. Built lazily and cached by SURFACES below.

function buildGroundSurface(size) {
  // Jungle floor: damp earth under a scatter of leaf litter and pebbles.
  const base = fbm(size, 4, 4, 5, 1201);
  const patch = fbm(size, 2, 2, 3, 7717);
  const grit = fbm(size, 24, 24, 2, 3301);
  const ramp = makeRamp([
    [0.00, '#24351a'], [0.32, '#33491f'], [0.52, '#405a26'],
    [0.70, '#55502b'], [0.86, '#6b5633'], [1.00, '#7d6740'],
  ]);
  const cv = albedoCanvas(size, base, ramp, patch, 0.45);
  const ctx = cv.getContext('2d');
  // Fallen leaves and twigs, the detail you actually notice underfoot.
  const rand = mulberry32(5150);
  for (let i = 0; i < Math.round(size * 1.6); i++) {
    const x = rand() * size, y = rand() * size;
    const r = size * (0.006 + rand() * 0.016);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI * 2);
    ctx.globalAlpha = 0.25 + rand() * 0.4;
    ctx.fillStyle = rand() > 0.45 ? '#6f6433' : '#4c6b2c';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 2.4, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (let i = 0; i < Math.round(size * 0.5); i++) {
    const x = rand() * size, y = rand() * size;
    const r = size * (0.004 + rand() * 0.008);
    ctx.globalAlpha = 0.3 + rand() * 0.3;
    ctx.fillStyle = rand() > 0.5 ? '#8d8477' : '#5d564c';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Pebbles push the relief up; damp hollows read as smoother.
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = base[i] * 0.65 + grit[i] * 0.35;
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(height, size, 2.6), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(patch, size, 0.72, 1.0), [1, 1], false),
  };
}

function buildBarkSurface(size) {
  // Vertical grain: many cells across, few down, so the noise stretches into
  // ridges that run with the trunk.
  const grain = fbm(size, 10, 2, 5, 4404);
  const deep = fbm(size, 3, 1, 3, 9091);
  const ramp = makeRamp([
    [0.00, '#241a10'], [0.30, '#3b2a18'], [0.55, '#553d24'],
    [0.78, '#6d5133'], [1.00, '#826444'],
  ]);
  const cv = albedoCanvas(size, grain, ramp, deep, 0.35);
  const ctx = cv.getContext('2d');
  // A few deep fissures, and patches of lichen for the humid look.
  const rand = mulberry32(8822);
  for (let i = 0; i < 18; i++) {
    const x = rand() * size;
    ctx.strokeStyle = `rgba(22,15,9,${0.25 + rand() * 0.4})`;
    ctx.lineWidth = size * (0.004 + rand() * 0.012);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    let cxp = x;
    for (let y = 0; y <= size; y += size / 8) {
      cxp += (rand() - 0.5) * size * 0.05;
      ctx.lineTo(cxp, y);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.07 + rand() * 0.12;
    ctx.fillStyle = rand() > 0.5 ? '#7f8c5a' : '#5d6b4a';
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, size * 0.03 * (0.5 + rand()), size * 0.05 * (0.5 + rand()), rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = grain[i] * 0.75 + deep[i] * 0.25;
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(height, size, 4.5), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(grain, size, 0.75, 1.0), [1, 1], false),
  };
}

function buildLeafSurface(size) {
  // Canopy foliage seen from a distance: clumped light and shade with veins.
  const clump = fbm(size, 5, 5, 4, 2211);
  const fine = fbm(size, 20, 20, 2, 6612);
  const ramp = makeRamp([
    [0.00, '#15300f'], [0.28, '#22491a'], [0.52, '#326b24'],
    [0.76, '#448c2e'], [1.00, '#62ad3f'],
  ]);
  const cv = albedoCanvas(size, clump, ramp, fine, 0.3);
  const ctx = cv.getContext('2d');
  // Individual leaf silhouettes so the canopy doesn't read as mossy fuzz.
  const rand = mulberry32(3737);
  for (let i = 0; i < Math.round(size * 1.1); i++) {
    const x = rand() * size, y = rand() * size;
    const r = size * (0.012 + rand() * 0.03);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI * 2);
    const lit = rand();
    ctx.globalAlpha = 0.3 + rand() * 0.4;
    ctx.fillStyle = lit > 0.6 ? '#6cba46' : lit > 0.3 ? '#3c7d28' : '#1d4415';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.55, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,45,15,0.35)';
    ctx.lineWidth = Math.max(1, size * 0.002);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = clump[i] * 0.6 + fine[i] * 0.4;
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(height, size, 3.2), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(fine, size, 0.55, 0.9), [1, 1], false),
  };
}

function buildRockSurface(size) {
  const body = fbm(size, 5, 5, 5, 1717);
  const crack = fbm(size, 14, 14, 3, 4242);
  const ramp = makeRamp([
    [0.00, '#3b3a37'], [0.30, '#565450'], [0.58, '#6e6c66'],
    [0.82, '#85837b'], [1.00, '#9c998f'],
  ]);
  const cv = albedoCanvas(size, body, ramp, crack, 0.3);
  const ctx = cv.getContext('2d');
  const rand = mulberry32(2929);
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = `rgba(28,27,25,${0.2 + rand() * 0.35})`;
    ctx.lineWidth = size * (0.003 + rand() * 0.008);
    ctx.beginPath();
    let x = rand() * size, y = rand() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rand() - 0.5) * size * 0.28;
      y += (rand() - 0.5) * size * 0.28;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = body[i] * 0.55 + crack[i] * 0.45;
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(height, size, 4), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(crack, size, 0.8, 1.0), [1, 1], false),
  };
}

function buildSkinSurface(size, ramp) {
  const pores = fbm(size, 26, 26, 3, 6161);
  const blotch = fbm(size, 4, 4, 3, 8383);
  const cv = albedoCanvas(size, blotch, ramp, pores, 0.16);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = pores[i] * 0.8 + blotch[i] * 0.2;
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(height, size, 1.1), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(pores, size, 0.52, 0.78), [1, 1], false),
  };
}

function buildClothSurface(size, ramp, seed) {
  // Woven weft: two crossed stretched noises read as thread.
  const warp = fbm(size, 48, 2, 2, seed);
  const weft = fbm(size, 2, 48, 2, seed + 77);
  const woven = new Float32Array(size * size);
  for (let i = 0; i < woven.length; i++) woven[i] = (warp[i] + weft[i]) * 0.5;
  const slub = fbm(size, 6, 6, 3, seed + 500);
  const cv = albedoCanvas(size, woven, ramp, slub, 0.3);
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(woven, size, 2.2), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(slub, size, 0.78, 1.0), [1, 1], false),
  };
}

function buildFurSurface(size, ramp, seed) {
  // Directional strands rather than isotropic blobs.
  const strands = fbm(size, 40, 7, 3, seed);
  const shade = fbm(size, 5, 5, 3, seed + 311);
  const cv = albedoCanvas(size, strands, ramp, shade, 0.34);
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(strands, size, 2.6), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(strands, size, 0.7, 0.95), [1, 1], false),
  };
}

// Water gets normals only - colour comes from the material and the sky
// reflection. Two copies of this scroll in different directions so the
// interference looks like real chop instead of a sliding pattern.
function buildWaterNormal(size) {
  const a = fbm(size, 6, 6, 4, 9311);
  const b = fbm(size, 11, 9, 3, 1559);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.6 + b[i] * 0.4;
  return normalMapFromHeight(h, size, 1.8);
}

// Soft round alpha blob, used for foam, dust motes and light shafts.
function buildSoftDisc(size) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return cv;
}

// A single grass/fern blade with a soft alpha edge, for the leaf cards that
// fill out the undergrowth and palm fronds.
function buildBladeAlpha(size) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size);
  ctx.quadraticCurveTo(size * 0.02, size * 0.55, size * 0.5, 0);
  ctx.quadraticCurveTo(size * 0.98, size * 0.55, size * 0.5, size);
  ctx.fill();
  return cv;
}

// ---------- Leaf clusters ----------
// A canopy made of solid lumps reads as broccoli however good the texture on
// it is, because the silhouette is wrong: real foliage is mostly holes. So the
// canopy is built from alpha-cut cards instead, each one a sprig of leaves, and
// the shape of the tree comes from how they are scattered.
//
// Alpha *test*, not blending: a cut-out writes depth, which matters here
// because the post chain reads the depth buffer for occlusion, fog and the
// distance blur. Blended foliage would be invisible to all three. It also means
// three.js copies the map onto the depth material for shadows, so the leaves
// cast leaf-shaped shadows rather than rectangles.
function drawOneLeaf(ctx, x, y, angle, len, wid, shade) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  // A pointed oval: two quadratics meeting at the tip and the stem.
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(wid, -len * 0.42, 0, -len);
  ctx.quadraticCurveTo(-wid, -len * 0.42, 0, 0);
  ctx.fillStyle = shade;
  ctx.fill();
  // Midrib, then a few side veins angled toward the tip.
  ctx.strokeStyle = 'rgba(18,42,14,0.5)';
  ctx.lineWidth = Math.max(0.6, len * 0.028);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.4, len * 0.016);
  ctx.strokeStyle = 'rgba(18,42,14,0.3)';
  for (let v = 1; v <= 4; v++) {
    const vy = -len * (v / 5);
    const vw = wid * (1 - v / 6) * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, vy);
    ctx.lineTo(vw, vy - len * 0.12);
    ctx.moveTo(0, vy);
    ctx.lineTo(-vw, vy - len * 0.12);
    ctx.stroke();
  }
  ctx.restore();
}

function buildLeafCardSurface(size) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rand = mulberry32(5150);
  const cx = size * 0.5;
  const base = size * 0.97;

  // The twig the sprig hangs off.
  ctx.strokeStyle = '#59431f';
  ctx.lineWidth = size * 0.016;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, base);
  ctx.quadraticCurveTo(cx + size * 0.02, size * 0.5, cx, size * 0.22);
  ctx.stroke();

  const GREENS = ['#2f6b22', '#3d8a2c', '#4fa036', '#28581d', '#5bb341', '#356f27'];
  const count = 17;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const side = (i % 2) ? 1 : -1;
    const ax = cx + side * size * 0.018;
    const ay = base - t * size * 0.78;
    // Leaves sweep up and outward, shorter toward the tip of the sprig.
    const ang = side * (0.5 + rand() * 0.55) + (rand() - 0.5) * 0.2;
    const len = size * (0.30 + rand() * 0.15) * (1 - t * 0.5);
    const wid = len * (0.30 + rand() * 0.14);
    drawOneLeaf(ctx, ax, ay, ang, len, wid, GREENS[Math.floor(rand() * GREENS.length)]);
  }
  // A couple of leaves crowning the tip so the sprig does not end in a stick.
  for (let i = 0; i < 3; i++) {
    const ang = (rand() - 0.5) * 0.7;
    const len = size * (0.20 + rand() * 0.1);
    drawOneLeaf(ctx, cx, size * 0.24, ang, len, len * 0.34, GREENS[Math.floor(rand() * GREENS.length)]);
  }

  // Height comes from the alpha: where there is leaf, there is relief. Using
  // luminance instead would carve the veins into the silhouette.
  const img = ctx.getImageData(0, 0, size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    const a = img.data[i * 4 + 3] / 255;
    const l = (img.data[i * 4] + img.data[i * 4 + 1] + img.data[i * 4 + 2]) / 765;
    height[i] = a * (0.45 + l * 0.55);
    rough[i] = 0.62 + (1 - l) * 0.25;
  }
  return {
    map: texFrom(cv, [1, 1], true),
    normalMap: texFrom(normalMapFromHeight(height, size, 2.2), [1, 1], false),
    roughnessMap: texFrom(greyCanvasFromField(rough, size, 0, 1), [1, 1], false),
  };
}


export {
  smoothstep,
  makeCanvas,
  latticeNoise,
  fbm,
  normalMapFromHeight,
  greyCanvasFromField,
  hexToRgb,
  rampColor,
  makeRamp,
  albedoCanvas,
  texFrom,
  buildGroundSurface,
  buildBarkSurface,
  buildLeafSurface,
  buildRockSurface,
  buildSkinSurface,
  buildClothSurface,
  buildFurSurface,
  buildWaterNormal,
  buildSoftDisc,
  buildBladeAlpha,
  drawOneLeaf,
  buildLeafCardSurface,
};
