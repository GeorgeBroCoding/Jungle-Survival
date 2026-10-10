import { Fragment, THREE, html } from './core.js';
import { PLAYER_TRIBE_COLOR } from './data.js';
import { gfx } from './graphics.js';
import { HeldWeapon } from './player.js';
import { grainTiled, surfaceTiled } from './wind.js';

// humanbody.js - shared anatomy for every person in the game
//
// One body definition drives the player, the remote player, tribe members,
// raiders and recruited warriors, so they all move and read the same way.
// Limbs are lathed profiles rather than plain capsules: an upper arm is thick
// at the shoulder and thin at the elbow, a calf has a belly to it. The
// animation contract is unchanged - callers still hand in armL/armR/legL/legR
// refs and rotate them about X - so every existing walk, swing and death
// animation keeps working.
// ============================================================

// Proportions for a roughly 1.85m person, in metres from the ground.
const BODY = {
  hipY: 0.92,
  shoulderY: 1.50,
  headY: 1.70,
  shoulderX: 0.215,
  hipX: 0.095,
  upperArm: 0.32,
  foreArm: 0.28,
  thigh: 0.50,
  shin: 0.42,
  torsoTop: 1.55,
  torsoLen: 0.60,
};
// The hand sits here relative to the shoulder pivot. HeldWeapon models are
// authored with their grip 0.5 below the old shoulder, so this offset slides
// them down into the longer arm's actual hand.
const WEAPON_HAND_OFFSET = [0, -0.15, 0.03];

// Profiles run top (t=0) to bottom (t=1) with radius normalised to 1, so a
// part's scale is literally its radius and length in metres. The points are
// reversed on the way in because LatheGeometry wants ascending Y to get its
// normals pointing outward.
function latheLimb(profile, segments) {
  const pts = [];
  for (let i = profile.length - 1; i >= 0; i--) {
    pts.push(new THREE.Vector2(Math.max(0.003, profile[i][1]), -profile[i][0]));
  }
  return new THREE.LatheGeometry(pts, segments);
}

const HUMAN_GEO = {};
function humanGeo(key) {
  if (HUMAN_GEO[key]) return HUMAN_GEO[key];
  let g;
  if (key === 'ball') g = new THREE.SphereGeometry(1, 16, 12);
  else if (key === 'ballLow') g = new THREE.SphereGeometry(1, 10, 8);
  else if (key === 'box') g = new THREE.BoxGeometry(1, 1, 1);
  else if (key === 'torso') {
    // Broad at the chest, tucked at the waist, flaring again at the hips.
    g = latheLimb([[0, 0.60], [0.08, 0.92], [0.26, 1.0], [0.52, 0.84], [0.70, 0.80], [0.90, 0.93], [1, 0.72]], 16);
  } else if (key === 'upperArm') {
    g = latheLimb([[0, 0.95], [0.22, 1.0], [0.68, 0.80], [1, 0.66]], 10);
  } else if (key === 'foreArm') {
    g = latheLimb([[0, 0.90], [0.28, 0.96], [1, 0.58]], 10);
  } else if (key === 'thigh') {
    g = latheLimb([[0, 0.90], [0.24, 1.0], [0.72, 0.78], [1, 0.64]], 12);
  } else if (key === 'shin') {
    g = latheLimb([[0, 0.88], [0.20, 1.0], [0.74, 0.58], [1, 0.42]], 10);
  } else if (key === 'neck') {
    g = latheLimb([[0, 1.0], [1, 0.92]], 10);
  } else if (key === 'wrap') {
    // Open-ended cone: loincloths, skirts, sleeves.
    g = new THREE.CylinderGeometry(1, 1.25, 1, 14, 1, true);
    g.translate(0, -0.5, 0);
  } else if (key === 'band') {
    g = new THREE.TorusGeometry(1, 0.16, 6, 18);
  } else if (key === 'cone') {
    g = new THREE.ConeGeometry(1, 1, 8);
    g.translate(0, 0.5, 0);
  } else {
    throw new Error('unknown body geometry ' + key);
  }
  HUMAN_GEO[key] = g;
  return g;
}

const HUMAN_MATS = {};
// Light that goes into skin, bounces around under it and comes back out,
// which is why an ear against the sun glows red and why skin without it reads
// as painted plastic. The cheap form of it: a wrapped diffuse term so the
// light carries past the terminator, plus a red-shifted glow where the light
// is behind the surface. Both injected into the standard material rather than
// written fresh, so skin keeps the shadows, the fog and everything else.
const skinPatchStats = { ok: 0, failed: 0 };

// How wet and how muddy the player currently is. Both climb while it is
// happening and fade over minutes once it stops, which is the whole point:
// walking out of a river clean is what makes a game world feel like a diorama.
const playerGrime = { wet: 0, mud: 0 };

const SKIN_SSS = [
  '#include <lights_fragment_end>',
  '#ifdef JK_SKIN',
  '  vec3 jkSkinL = normalize( directionalLights[ 0 ].direction );',
  '  float jkNdl = dot( normal, jkSkinL );',
  // Wrap: light reaches a little past 90 degrees instead of stopping dead.
  '  float jkWrap = max( 0.0, ( jkNdl + 0.42 ) / 1.42 ) - max( 0.0, jkNdl );',
  // Transmission: strongest looking straight through a thin part at the light.
  '  float jkThrough = pow( max( 0.0, dot( normalize( vViewPosition ), jkSkinL ) ), 3.0 );',
  '  vec3 jkSub = uSkinSubColor * directionalLights[ 0 ].color',
  '    * ( jkWrap * 0.55 + jkThrough * 0.30 ) * uSkinSub;',
  '  reflectedLight.directDiffuse += jkSub * diffuseColor.rgb;',
  '#endif',
].join('\n');

// Grime belongs to the player alone. Everyone else shares one set of body
// materials, which is right - but the player is the one who wades, and a
// shared material would muddy the whole tribe at once. HumanFigure already
// looks its skin up by key, so the player simply asks for a key of its own and
// gets a material nobody else is using.
const PLAYER_SKIN_KEY = 'skinPlayer';
const playerGrimeMat = { mat: null };

// Wet darkens and sharpens the highlight. Mud darkens too, but browner, and
// takes the gloss back off, because mud is matte. Driven every frame from the
// eased values Player keeps.
function applyPlayerGrime() {
  const m = playerGrimeMat.mat;
  if (!m) return;
  const wet = Math.max(0, Math.min(1, playerGrime.wet));
  const mud = Math.max(0, Math.min(1, playerGrime.mud));
  const dark = 1 - wet * 0.32 - mud * 0.24;
  m.color.setRGB(dark, dark * (1 - mud * 0.10), dark * (1 - mud * 0.22));
  m.roughness = Math.max(0.10, 0.72 - wet * 0.50 + mud * 0.28);
}

function skinMat(key) {
  const id = 'skin:' + key;
  if (!HUMAN_MATS[id]) {
    // The player's key is not a surface; it is the pale skin with a material
    // of its own so grime can be applied to it without touching anyone else.
    const s = surfaceTiled(key === PLAYER_SKIN_KEY ? 'skinPale' : key, [1.4, 2.2]);
    HUMAN_MATS[id] = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.roughnessMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.72,
      metalness: 0,
      envMapIntensity: 1.0,
      // Lathed parts are only right-side-out if the profile winding is right;
      // double-siding them costs almost nothing at this size and removes any
      // chance of a limb turning inside out.
      side: THREE.DoubleSide,
    });
    const skinSub = HUMAN_MATS[id];
    skinSub.onBeforeCompile = (shader) => {
      try {
        if (shader.fragmentShader.indexOf('#include <lights_fragment_end>') === -1) return;
        shader.uniforms.uSkinSub = { value: 0.85 };
        shader.uniforms.uSkinSubColor = { value: new THREE.Color('#c4553a') };
        shader.fragmentShader = '#define JK_SKIN\nuniform float uSkinSub;\n'
          + 'uniform vec3 uSkinSubColor;\n'
          + shader.fragmentShader.replace('#include <lights_fragment_end>', SKIN_SSS);
        skinPatchStats.ok++;
      } catch (e) { skinPatchStats.failed++; }
    };
    skinSub.customProgramCacheKey = () => 'jk-skin-sss';
    if (key === PLAYER_SKIN_KEY) playerGrimeMat.mat = skinSub;
  }
  return HUMAN_MATS[id];
}

function clothMat(hex, surfKey) {
  const id = 'cloth:' + (surfKey || 'cloth') + ':' + hex;
  if (!HUMAN_MATS[id]) {
    const s = grainTiled(surfKey || 'cloth', [2.2, 2.2]);
    HUMAN_MATS[id] = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.roughnessMap,
      color: hex,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });
  }
  return HUMAN_MATS[id];
}

// Animal pelts: the same lathed parts as the people, wearing a directional
// strand texture instead of skin.
function furMat(key) {
  const id = 'fur:' + key;
  if (!HUMAN_MATS[id]) {
    const sf = surfaceTiled(key, [2.6, 2.6]);
    HUMAN_MATS[id] = new THREE.MeshStandardMaterial({
      map: sf.map,
      normalMap: sf.normalMap,
      roughnessMap: sf.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.9,
      metalness: 0,
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });
  }
  return HUMAN_MATS[id];
}

function plainMat(id, opts) {
  if (!HUMAN_MATS[id]) HUMAN_MATS[id] = new THREE.MeshStandardMaterial(opts);
  return HUMAN_MATS[id];
}
function hairMat(hex) {
  return plainMat('hair:' + hex, { color: hex, roughness: 0.62, metalness: 0 });
}

// ---------- One arm ----------
// The group the caller animates is the shoulder. Inside it the forearm sits in
// its own group with a fixed slight bend, so the arm has an elbow instead of
// being a single straight stick.
function HumanArm({ groupRef, side, skinKey, bandColor, face, weapon, detail }) {
  const sx = side * BODY.shoulderX;
  const bend = -face * 0.16;
  return html`
    <group ref=${groupRef} position=${[sx, BODY.shoulderY, 0]}>
      <mesh geometry=${humanGeo('ball')} material=${skinMat(skinKey)}
        position=${[0, 0.01, 0]} scale=${[0.082, 0.075, 0.082]} castShadow=${true} />
      <mesh geometry=${humanGeo('upperArm')} material=${skinMat(skinKey)}
        position=${[0, 0, 0]} scale=${[0.072, BODY.upperArm, 0.072]} castShadow=${true} />
      ${detail > 0 && bandColor && html`
        <mesh geometry=${humanGeo('band')} material=${clothMat(bandColor)}
          position=${[0, -BODY.upperArm * 0.55, 0]} rotation=${[Math.PI / 2, 0, 0]}
          scale=${[0.062, 0.062, 0.055]} castShadow=${true} />
      `}
      <group position=${[0, -BODY.upperArm, 0]} rotation=${[bend, 0, 0]}>
        <mesh geometry=${humanGeo('ballLow')} material=${skinMat(skinKey)}
          position=${[0, 0, 0]} scale=${[0.058, 0.055, 0.058]} castShadow=${true} />
        <mesh geometry=${humanGeo('foreArm')} material=${skinMat(skinKey)}
          position=${[0, 0, 0]} scale=${[0.062, BODY.foreArm, 0.062]} castShadow=${true} />
        <mesh geometry=${humanGeo('ballLow')} material=${skinMat(skinKey)}
          position=${[0, -BODY.foreArm - 0.03, face * 0.012]}
          scale=${[0.045, 0.055, 0.032]} castShadow=${true} />
      </group>
      ${weapon && html`
        <group position=${WEAPON_HAND_OFFSET} rotation=${[0, face > 0 ? Math.PI : 0, 0]}>
          <${HeldWeapon} id=${weapon} />
        </group>
      `}
    </group>
  `;
}

// ---------- Both legs ----------
// Same deal as the arms: the caller animates the hip group, the knee lives
// inside it, and the foot points the way the figure faces.
function HumanLeg({ groupRef, side, skinKey, wrapColor, face, detail }) {
  const bend = face * 0.12;
  return html`
    <group ref=${groupRef} position=${[side * BODY.hipX, BODY.hipY, 0]}>
      <mesh geometry=${humanGeo('thigh')} material=${skinMat(skinKey)}
        position=${[0, 0, 0]} scale=${[0.105, BODY.thigh, 0.105]} castShadow=${true} />
      <group position=${[0, -BODY.thigh, 0]} rotation=${[bend, 0, 0]}>
        <mesh geometry=${humanGeo('ballLow')} material=${skinMat(skinKey)}
          scale=${[0.078, 0.07, 0.078]} castShadow=${true} />
        <mesh geometry=${humanGeo('shin')} material=${skinMat(skinKey)}
          position=${[0, 0, 0]} scale=${[0.082, BODY.shin, 0.082]} castShadow=${true} />
        <mesh geometry=${humanGeo('ballLow')} material=${skinMat(skinKey)}
          position=${[0, -BODY.shin, 0]} scale=${[0.045, 0.045, 0.045]} castShadow=${true} />
        <mesh geometry=${humanGeo('box')} material=${skinMat(skinKey)}
          position=${[0, -BODY.shin - 0.035, face * 0.055]}
          scale=${[0.085, 0.055, 0.21]} castShadow=${true} />
        ${detail > 0 && wrapColor && html`
          <mesh geometry=${humanGeo('band')} material=${clothMat(wrapColor)}
            position=${[0, -BODY.shin + 0.06, 0]} rotation=${[Math.PI / 2, 0, 0]}
            scale=${[0.062, 0.062, 0.05]} castShadow=${true} />
        `}
      </group>
    </group>
  `;
}

// ---------- Head ----------
function HumanHead({ skinKey, hairColor, bandColor, face, headwear, detail }) {
  const hy = BODY.headY;
  const skin = skinMat(skinKey);
  return html`
    <${Fragment}>
      <mesh geometry=${humanGeo('neck')} material=${skin}
        position=${[0, hy - 0.10, 0]} scale=${[0.055, 0.12, 0.055]} castShadow=${true} />
      <mesh geometry=${humanGeo('ball')} material=${skin}
        position=${[0, hy, -face * 0.004]} scale=${[0.105, 0.125, 0.115]} castShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${skin}
        position=${[0, hy - 0.056, face * 0.022]} scale=${[0.084, 0.072, 0.098]} castShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${skin}
        position=${[0, hy - 0.012, face * 0.106]} scale=${[0.021, 0.027, 0.034]} castShadow=${true} />
      <mesh geometry=${humanGeo('box')} material=${skin}
        position=${[0, hy + 0.034, face * 0.096]} scale=${[0.135, 0.021, 0.028]} castShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('eyeWhite', { color: '#efe7dd', roughness: 0.3 })}
        position=${[0.043, hy + 0.012, face * 0.090]} scale=${[0.022, 0.018, 0.018]} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('eyeWhite', { color: '#efe7dd', roughness: 0.3 })}
        position=${[-0.043, hy + 0.012, face * 0.090]} scale=${[0.022, 0.018, 0.018]} />
      ${detail > 0 && html`
        <${Fragment}>
          <mesh geometry=${humanGeo('ballLow')} material=${plainMat('iris', { color: '#2a1b10', roughness: 0.25 })}
            position=${[0.043, hy + 0.012, face * 0.102]} scale=${[0.010, 0.010, 0.008]} />
          <mesh geometry=${humanGeo('ballLow')} material=${plainMat('iris', { color: '#2a1b10', roughness: 0.25 })}
            position=${[-0.043, hy + 0.012, face * 0.102]} scale=${[0.010, 0.010, 0.008]} />
          <mesh geometry=${humanGeo('box')} material=${plainMat('mouth', { color: '#7a4b42', roughness: 0.6 })}
            position=${[0, hy - 0.062, face * 0.092]} scale=${[0.046, 0.009, 0.02]} />
          <mesh geometry=${humanGeo('ballLow')} material=${skin}
            position=${[0.104, hy + 0.002, -face * 0.004]} scale=${[0.015, 0.031, 0.025]} />
          <mesh geometry=${humanGeo('ballLow')} material=${skin}
            position=${[-0.104, hy + 0.002, -face * 0.004]} scale=${[0.015, 0.031, 0.025]} />
        <//>
      `}
      <mesh geometry=${humanGeo('ball')} material=${hairMat(hairColor)}
        position=${[0, hy + 0.030, -face * 0.016]} scale=${[0.116, 0.112, 0.122]} castShadow=${true} />
      ${bandColor && html`
        <mesh geometry=${humanGeo('band')} material=${clothMat(bandColor)}
          position=${[0, hy + 0.044, 0]} rotation=${[Math.PI / 2, 0, 0]}
          scale=${[0.112, 0.112, 0.10]} castShadow=${true} />
      `}
      ${headwear === 'feathers' && html`
        <${Fragment}>
          <mesh geometry=${humanGeo('cone')} material=${clothMat(bandColor || '#c45a3a')}
            position=${[0, hy + 0.10, -face * 0.03]} rotation=${[-face * 0.35, 0, 0]}
            scale=${[0.028, 0.20, 0.028]} castShadow=${true} />
          <mesh geometry=${humanGeo('cone')} material=${clothMat('#e8e2d4')}
            position=${[0.05, hy + 0.095, -face * 0.03]} rotation=${[-face * 0.35, 0, 0.32]}
            scale=${[0.022, 0.15, 0.022]} castShadow=${true} />
          <mesh geometry=${humanGeo('cone')} material=${clothMat('#e8e2d4')}
            position=${[-0.05, hy + 0.095, -face * 0.03]} rotation=${[-face * 0.35, 0, -0.32]}
            scale=${[0.022, 0.15, 0.022]} castShadow=${true} />
        <//>
      `}
    <//>
  `;
}

// ---------- Torso, clothing and the whole figure ----------
// `face` is +1 for a figure whose front is local +Z and -1 for local -Z. The
// tribes use +Z (their yaw comes from atan2(dirX, dirZ)); the player uses -Z.
function HumanFigure({
  skinKey = 'skin',
  clothColor = '#6b5a3c',
  accentColor = null,
  hairColor = '#241509',
  headwear = 'none',
  armL = null, armR = null, legL = null, legR = null,
  weapon = null,
  face = 1,
  torsoWrap = false,
}) {
  const detail = gfx().treeDetail;
  const skin = skinMat(skinKey);
  const accent = accentColor || clothColor;
  return html`
    <${Fragment}>
      <mesh geometry=${humanGeo('torso')} material=${skin}
        position=${[0, BODY.torsoTop, 0]} scale=${[0.205, BODY.torsoLen, 0.145]}
        castShadow=${true} receiveShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${skin}
        position=${[0, BODY.hipY + 0.045, 0]} scale=${[0.155, 0.115, 0.118]} castShadow=${true} />

      ${torsoWrap && html`
        <mesh geometry=${humanGeo('torso')} material=${clothMat(clothColor)}
          position=${[0, BODY.torsoTop - 0.02, 0]} scale=${[0.215, BODY.torsoLen * 0.72, 0.155]}
          castShadow=${true} />
      `}
      ${!torsoWrap && html`
        <mesh geometry=${humanGeo('band')} material=${clothMat(accent)}
          position=${[0, BODY.torsoTop - 0.26, 0]} rotation=${[Math.PI / 2, 0, 0.92]}
          scale=${[0.215, 0.215, 0.115]} castShadow=${true} />
      `}

      <mesh geometry=${humanGeo('wrap')} material=${clothMat(clothColor)}
        position=${[0, BODY.hipY + 0.10, 0]} scale=${[0.175, 0.34, 0.16]}
        castShadow=${true} />
      <mesh geometry=${humanGeo('band')} material=${clothMat(accent)}
        position=${[0, BODY.hipY + 0.085, 0]} rotation=${[Math.PI / 2, 0, 0]}
        scale=${[0.172, 0.172, 0.085]} castShadow=${true} />

      <${HumanHead} skinKey=${skinKey} hairColor=${hairColor} bandColor=${accent}
        face=${face} headwear=${headwear} detail=${detail} />
      <${HumanArm} groupRef=${armL} side=${1} skinKey=${skinKey} bandColor=${accent}
        face=${face} weapon=${null} detail=${detail} />
      <${HumanArm} groupRef=${armR} side=${-1} skinKey=${skinKey} bandColor=${accent}
        face=${face} weapon=${weapon} detail=${detail} />
      ${legL && html`<${HumanLeg} groupRef=${legL} side=${1} skinKey=${skinKey}
        wrapColor=${accent} face=${face} detail=${detail} />`}
      ${legR && html`<${HumanLeg} groupRef=${legR} side=${-1} skinKey=${skinKey}
        wrapColor=${accent} face=${face} detail=${detail} />`}
    <//>
  `;
}

// ---------- The two figure shells the game code uses ----------
// Tribesfolk and warriors: bare-chested, with the tribe's colour carried on the
// loincloth, sash, headband and armbands so factions stay readable at a
// distance even though the body itself is now skin-toned.
function TribalFigure({ color, armL = null, armR = null, legL = null, legR = null, weapon = null }) {
  return html`
    <${HumanFigure}
      skinKey="skin"
      clothColor=${color}
      accentColor=${color}
      hairColor="#1d1109"
      headwear="feathers"
      armL=${armL} armR=${armR} legL=${legL} legR=${legR}
      weapon=${weapon}
      face=${1}
    />
  `;
}

function WarriorFigure({ legL, legR, armL = null, armR = null, weapon = null, color = PLAYER_TRIBE_COLOR }) {
  return html`
    <${TribalFigure} color=${color} armL=${armL} armR=${armR}
      legL=${legL} legR=${legR} weapon=${weapon} />
  `;
}

// ============================================================

export {
  BODY,
  WEAPON_HAND_OFFSET,
  latheLimb,
  HUMAN_GEO,
  humanGeo,
  HUMAN_MATS,
  skinPatchStats,
  playerGrime,
  SKIN_SSS,
  PLAYER_SKIN_KEY,
  playerGrimeMat,
  applyPlayerGrime,
  skinMat,
  clothMat,
  furMat,
  plainMat,
  hairMat,
  HumanArm,
  HumanLeg,
  HumanHead,
  HumanFigure,
  TribalFigure,
  WarriorFigure,
};
