import { ATTACK_SWING_TIME, armChopAngle, useWanderAI, weaponForEntity } from './animals.js';
import { Fragment, THREE, html, useEffect, useFrame, useMemo, useRef } from './core.js';
import { BASE_CENTER, DISTANT_TRIBES, ENEMY_TRIBES, ESCORT_AGGRO_RANGE, ESCORT_ATTACK_COOLDOWN, ESCORT_ATTACK_DAMAGE, ESCORT_ATTACK_RANGE, ESCORT_FOLLOW_DIST, ESCORT_SPEED, FRIEND_BASE_CENTER, GARRISON_OFFSETS, PLAYER_TRIBE_COLOR, PLAYER_WARRIOR_SPAWNS, TRIBE_MEMBER_AGGRO_RANGE, TRIBE_MEMBER_ATTACK_COOLDOWN, TRIBE_MEMBER_ATTACK_RANGE, TRIBE_MEMBER_ATTACK_SPEED, TRIBE_MEMBER_DAMAGE, TRIBE_MEMBER_OFFSETS, TRIBE_SPAWN_INTERVAL } from './data.js';
import { GRAPHICS_PRESETS, fireRegistry, gfx } from './graphics.js';
import { TribalFigure, WarriorFigure } from './humanbody.js';
import { mpSend, playerTransform, remoteTribeMembers } from './multiplayer.js';
import { entityRegistry } from './shake.js';
import { useGame } from './store.js';
import { getTerrainHeight, stdMat, surfaceMat } from './terrain.js';
import { buildSoftDisc, texFrom } from './textures.js';
import { grainTiled } from './wind.js';

// Tribes.js - rival tribe camps, wandering tribesfolk and raiders
// ============================================================

// Shared low-poly tribesperson model. Used for both peaceful camp
// members (wander AI) and raiders (march toward the player's base).
// Arms hang from shoulder pivots so they can be animated. Pass armL/armR refs to have
// the walk cycle swing them (and the attack chop drive the weapon arm); without refs
// they just hang at the sides. `weapon` is a HeldWeapon id, carried in the right hand —
// turned 180 degrees because HeldWeapon is modelled for the player, who faces -Z, while
// these figures face +Z.

// ---------- Hostile tribe member: wanders near its camp, attacks if the player gets close ----------
function TribeMember({ id, spawn, color }) {
  const alive = useGame((s) => s.tribeMemberState[id]?.alive ?? true);
  const isJoiner = useGame((s) => s.mpRole === 'joiner');
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const netPhase = useRef(Math.random() * 10);
  const legRefs = useWanderAI(group, spawn, {
    speed: 1.2, fleeSpeed: 3, entityId: (!isJoiner && alive) ? id : null, registryKey: 'tribeMembers',
    aggressive: true, aggroRange: TRIBE_MEMBER_AGGRO_RANGE, attackRange: TRIBE_MEMBER_ATTACK_RANGE,
    attackSpeed: TRIBE_MEMBER_ATTACK_SPEED, attackDamage: TRIBE_MEMBER_DAMAGE, attackCooldown: TRIBE_MEMBER_ATTACK_COOLDOWN,
    frozen: isJoiner, alertTribeId: id.split('_m')[0], attackArm: armR,
  });

  // Joiner: this member's position/rotation is driven by the host's tribeSync
  // broadcast instead of local wander AI.
  useFrame((_, rawDelta) => {
    if (!isJoiner || !group.current) return;
    const net = remoteTribeMembers[id];
    if (!net) return;
    const delta = Math.min(rawDelta, 0.1);
    const g = group.current;
    const dx = net.position[0] - g.position.x;
    const dz = net.position[2] - g.position.z;
    g.position.x += dx * 0.25;
    g.position.y += (net.position[1] - g.position.y) * 0.25;
    g.position.z += dz * 0.25;
    let yawDiff = net.yaw - g.rotation.y;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    g.rotation.y += yawDiff * 0.25;
    entityRegistry.tribeMembers[id] = g.position;

    if (Math.hypot(dx, dz) > 0.05) {
      netPhase.current += delta * 4;
      const swing = Math.sin(netPhase.current) * 0.4;
      for (const leg of legRefs.current) if (leg.ref.current) leg.ref.current.rotation.x = leg.sign * swing;
    } else {
      for (const leg of legRefs.current) if (leg.ref.current) leg.ref.current.rotation.x *= 0.9;
    }
  });

  useEffect(() => {
    if (!isJoiner) return undefined;
    return () => { delete entityRegistry.tribeMembers[id]; };
  }, [id, isJoiner]);

  if (!alive) return null;
  // Arms ride the same walk cycle as the legs, with the signs flipped so each arm
  // swings opposite the leg on its side.
  legRefs.current = [
    { ref: legL, sign: 1 },
    { ref: legR, sign: -1 },
    { ref: armL, sign: -1 },
    { ref: armR, sign: 1 },
  ];

  return html`
    <group ref=${group} position=${spawn}>
      <${ContactShadow} radius=${0.42} />
      <${TribalFigure} color=${color} armL=${armL} armR=${armR}
        legL=${legL} legR=${legR} weapon=${weaponForEntity(id)} />
    </group>
  `;
}

// ---------- A rival tribe's camp: tents, totem and a few wandering members ----------
// When captured it becomes a "team" — it keeps its own colour/identity but flies a yellow
// alliance flag; garrison warriors are always the player's yellow.
// Inter-tribal conquests repaint the camp in the conquering tribe's colour.
// ---------- Contact shadows ----------
// A shadow map can only resolve so much, and the first thing it loses is the
// tight dark patch right where something touches the ground. Without it
// everything looks like it is hovering a few centimetres up. This is the old
// trick and still the cheapest one: a soft dark disc, laid flat under the
// object, drawn without writing depth. One geometry and one material shared by
// every single one of them, so the whole effect is one draw state.
let _contactGeo = null;
let _contactMat = null;
function contactShadowGeo() {
  if (!_contactGeo) {
    _contactGeo = new THREE.PlaneGeometry(1, 1);
    _contactGeo.rotateX(-Math.PI / 2);
  }
  return _contactGeo;
}
function contactShadowMat() {
  if (!_contactMat) {
    _contactMat = new THREE.MeshBasicMaterial({
      // buildSoftDisc is white with a soft alpha falloff, so tinting it black
      // gives a blob that fades out at the edge instead of a hard circle.
      map: texFrom(buildSoftDisc(64), [1, 1], false),
      color: '#000000',
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      toneMapped: false,
    });
  }
  return _contactMat;
}

function ContactShadow({ radius = 0.5, y = 0.05, position = null }) {
  const quality = useGame((s) => s.graphicsQuality);
  if (!(GRAPHICS_PRESETS[quality] || gfx()).contactShadows) return null;
  const at = position ? [position[0], position[1] + y, position[2]] : [0, y, 0];
  return html`<mesh geometry=${contactShadowGeo()} material=${contactShadowMat()}
    position=${at} scale=${[radius * 2, 1, radius * 2]}
    renderOrder=${1} frustumCulled=${true} />`;
}

// ---------- Campfire ----------
// Purely a prop - nothing to pick up, nothing to interact with. It exists
// because a camp with no fire in it looks abandoned, and because a jungle
// night needs one warm thing in it to read as dark. The light itself is not
// here: the fire registers its position and DayNightSystem hands the nearest
// few a light out of a fixed pool, so walking into a valley full of camps can
// never trip a shader recompile.
const FIRE_GEO = {};
function fireGeo(key) {
  if (FIRE_GEO[key]) return FIRE_GEO[key];
  let g;
  if (key === 'ash') {
    g = new THREE.CircleGeometry(1.05, 18);
    g.rotateX(-Math.PI / 2);
  } else if (key === 'stones') {
    // A lumpy torus reads as a ring of stones once the rock normal map is on
    // it, and costs one draw instead of seven.
    g = new THREE.TorusGeometry(0.62, 0.14, 5, 9);
    g.rotateX(Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = Math.sin(x * 9.1 + z * 7.3) * 0.5 + Math.sin(z * 13.7 - x * 5.1) * 0.5;
      pos.setXYZ(i, x * (1 + n * 0.09), y + n * 0.045, z * (1 + n * 0.09));
    }
    g.computeVertexNormals();
  } else if (key === 'log') {
    g = new THREE.CylinderGeometry(0.052, 0.07, 0.95, 7);
  } else if (key === 'flame') {
    g = new THREE.ConeGeometry(0.21, 0.8, 7, 1, true);
  } else if (key === 'flameInner') {
    g = new THREE.ConeGeometry(0.12, 0.5, 6, 1, true);
  } else if (key === 'glow') {
    g = new THREE.PlaneGeometry(2.6, 2.6);
  } else {
    throw new Error('unknown fire geo ' + key);
  }
  FIRE_GEO[key] = g;
  return g;
}

function fireMat(key) {
  if (key === 'ash') {
    return surfaceMat('fireAsh', 'ground', [2.2, 2.2], {
      color: '#241e18', roughness: 0.98, metalness: 0,
    });
  }
  if (key === 'stones') {
    return surfaceMat('fireStones', 'rock', [2.4, 1.2], {
      color: '#8e8a80', roughness: 0.82, metalness: 0.02, envMapIntensity: 0.5,
    });
  }
  if (key === 'log') {
    return surfaceMat('fireLog', 'bark', [1.2, 2.4], {
      color: '#3a2c20', roughness: 0.92, metalness: 0,
    });
  }
  // The flames and the halo are emissive, not lit: additive, no depth write,
  // and deliberately left out of tone mapping so they stay hot-looking however
  // far the eye-adaptation exposure has drifted.
  if (key === 'flame') {
    return stdMat('fireFlame', () => new THREE.MeshBasicMaterial({
      color: '#ff7a1e', transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false,
    }));
  }
  if (key === 'flameInner') {
    return stdMat('fireCore', () => new THREE.MeshBasicMaterial({
      color: '#ffd88a', transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false,
    }));
  }
  if (key === 'glow') {
    return stdMat('fireGlow', () => new THREE.MeshBasicMaterial({
      map: texFrom(buildSoftDisc(64), [1, 1], false),
      color: '#ff8c3a', transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: false,
    }));
  }
  throw new Error('unknown fire mat ' + key);
}

const FIRE_LOGS = [
  { p: [0.0, 0.2, -0.17], r: [0.95, 0.0, 0.0] },
  { p: [0.16, 0.2, 0.1], r: [-0.48, 0.0, -0.82] },
  { p: [-0.16, 0.2, 0.1], r: [-0.48, 0.0, 0.82] },
];

function Campfire({ id, position, scale = 1 }) {
  const flame = useRef();
  const core = useRef();
  const glow = useRef();
  const phase = useMemo(() => Math.random() * 100, []);
  const px = position[0], py = position[1], pz = position[2];

  useEffect(() => {
    fireRegistry[id] = [px, py, pz];
    return () => { delete fireRegistry[id]; };
  }, [id, px, py, pz]);

  useFrame((state) => {
    const t = state.clock.elapsedTime + phase;
    // Same three-sine recipe the light uses, so the flame and the light it
    // casts breathe together instead of fighting each other.
    const f = 0.82 + 0.14 * Math.sin(t * 11.3) + 0.09 * Math.sin(t * 23.7) + 0.05 * Math.sin(t * 47.0);
    if (flame.current) {
      flame.current.scale.set(0.9 + f * 0.2, f, 0.9 + f * 0.2);
      flame.current.rotation.y = t * 1.6;
      flame.current.position.x = Math.sin(t * 6.1) * 0.025;
      flame.current.position.z = Math.cos(t * 5.3) * 0.025;
    }
    if (core.current) {
      core.current.scale.set(1, 0.85 + f * 0.3, 1);
      core.current.rotation.y = -t * 2.3;
    }
    if (glow.current) {
      // The halo material is shared by every fire in the world, so flickering
      // its opacity would make them all flicker in lockstep. Scale is per-mesh.
      const g = 0.82 + f * 0.26;
      glow.current.scale.set(g, g, 1);
      // Billboard it so it always faces the camera.
      glow.current.quaternion.copy(state.camera.quaternion);
    }
  });

  return html`
    <group position=${[px, py, pz]} scale=${scale}>
      <mesh geometry=${fireGeo('ash')} material=${fireMat('ash')} position=${[0, 0.015, 0]} receiveShadow=${true} />
      <mesh geometry=${fireGeo('stones')} material=${fireMat('stones')} position=${[0, 0.09, 0]}
        castShadow=${true} receiveShadow=${true} />
      ${FIRE_LOGS.map((l, i) => html`
        <mesh key=${i} geometry=${fireGeo('log')} material=${fireMat('log')}
          position=${l.p} rotation=${l.r} castShadow=${true} />
      `)}
      <mesh ref=${glow} geometry=${fireGeo('glow')} material=${fireMat('glow')} position=${[0, 0.5, 0]} renderOrder=${2} />
      <mesh ref=${flame} geometry=${fireGeo('flame')} material=${fireMat('flame')} position=${[0, 0.52, 0]} renderOrder=${3} />
      <mesh ref=${core} geometry=${fireGeo('flameInner')} material=${fireMat('flameInner')} position=${[0, 0.4, 0]} renderOrder=${4} />
    </group>
  `;
}

function TribeCamp({ tribe }) {
  const [x, , z] = tribe.campPosition;
  const captured = useGame((s) => !!s.capturedTribes[tribe.id]);
  const campOwner = useGame((s) => s.campOwners[tribe.id] ?? null);
  const garrisonHP = useGame((s) => s.garrisonHP[tribe.id] ?? 0);
  const campColor = captured
    ? PLAYER_TRIBE_COLOR
    : campOwner
    ? ENEMY_TRIBES.find((t) => t.id === campOwner)?.color ?? tribe.color
    : tribe.color;
  const garrisonCount = captured
    ? garrisonHP <= 0 ? 0 : garrisonHP <= 34 ? 1 : garrisonHP <= 67 ? 2 : 3
    : 0;
  return html`
    <${Fragment}>
      <group position=${[x, 0, z]}>
        ${[[-3, -2], [3, -2], [0, 3], [-5, 2], [5, 1], [-2, 5]].map((p, i) => html`
          <group key=${i} position=${[p[0], 0, p[1]]}>
            <mesh position=${[0, 0.9, 0]} castShadow=${true} receiveShadow=${true}>
              <coneGeometry args=${[1.4, 1.8, 7]} />
              <meshStandardMaterial color=${campColor} flatShading=${true} roughness=${0.9} />
            </mesh>
          </group>
        `)}
        <mesh position=${[0, 1.5, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.15, 0.15, 3, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#5a3c22" />
        </mesh>
        <mesh position=${[0, 3.2, 0]} castShadow=${true}>
          <coneGeometry args=${[0.4, 0.6, 5]} />
          <meshStandardMaterial color=${campColor} flatShading=${true} />
        </mesh>
        ${captured && html`
          <mesh position=${[0.55, 3.7, 0]} castShadow=${true}>
            <boxGeometry args=${[0.7, 0.42, 0.05]} />
            <meshStandardMaterial color=${PLAYER_TRIBE_COLOR} flatShading=${true} />
          </mesh>
        `}
      </group>
      <${Campfire} id=${`fire_${tribe.id}`} position=${[x + 1.8, 0, z + 1.6]} />
      ${!captured && TRIBE_MEMBER_OFFSETS.map((p, i) => html`
        <${TribeMember} key=${i} id=${`${tribe.id}_m${i}`} spawn=${[x + p[0], 0, z + p[1]]} color=${campColor} />
      `)}
      ${GARRISON_OFFSETS.slice(0, garrisonCount).map((p, i) => html`
        <${PlayerWarrior} key=${`g${i}`} spawn=${[x + p[0], 0, z + p[1]]} />
      `)}
    <//>
  `;
}

function TribeCamps() {
  const activeTribeIds = useGame((s) => s.activeTribeIds);
  return html`
    <${Fragment}>
      ${ENEMY_TRIBES.filter((t) => activeTribeIds.includes(t.id)).map((t) => html`<${TribeCamp} key=${t.id} tribe=${t} />`)}
    <//>
  `;
}

// ---------- Periodically activates the next rival tribe's camp ----------
function TribeSpawnManager() {
  const timer = useRef(TRIBE_SPAWN_INTERVAL);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = useGame.getState();
    if (s.mpRole === 'joiner') return;
    if (s.activeTribeIds.length >= ENEMY_TRIBES.length) return;
    timer.current -= delta;
    if (timer.current <= 0) {
      s.spawnNextTribe();
      timer.current = TRIBE_SPAWN_INTERVAL;
    }
  });
  return null;
}

// ---------- The player's own tribe banner, marks the raid target ----------
function PlayerTribeBase() {
  return html`
    <${Fragment}>
      <${Campfire} id="fire_base" position=${[BASE_CENTER[0] + 2.4, BASE_CENTER[1], BASE_CENTER[2] + 1.2]} />
      <group position=${BASE_CENTER}>
        <mesh position=${[0, 1.5, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.15, 0.15, 3, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#5a3c22" />
        </mesh>
        <mesh position=${[0, 3.2, 0]} castShadow=${true}>
          <coneGeometry args=${[0.45, 0.7, 5]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#ffe27a" />
        </mesh>
        <mesh position=${[0, 2.2, 0.05]} castShadow=${true}>
          <planeGeometry args=${[0.8, 1]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#c9a227" side=${THREE.DoubleSide} />
        </mesh>
      </group>
    <//>
  `;
}

// ---------- Friend's sub-camp banner: visible when a second player is connected ----------
function FriendBase() {
  const mpStatus = useGame((s) => s.mpStatus);
  if (mpStatus !== 'connected') return null;
  return html`
    <${Fragment}>
      <${Campfire} id="fire_friend" position=${[FRIEND_BASE_CENTER[0] + 2.4, FRIEND_BASE_CENTER[1], FRIEND_BASE_CENTER[2] + 1.2]} />
      <group position=${FRIEND_BASE_CENTER}>
        <mesh position=${[0, 1.5, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.15, 0.15, 3, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#5a3c22" />
        </mesh>
        <mesh position=${[0, 3.2, 0]} castShadow=${true}>
          <coneGeometry args=${[0.4, 0.6, 5]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#ffe27a" />
        </mesh>
        <mesh position=${[0, 2.2, 0.05]} castShadow=${true}>
          <planeGeometry args=${[0.7, 0.9]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#c9a227" side=${THREE.DoubleSide} />
        </mesh>
        <mesh position=${[0, 0.05, 0]} receiveShadow=${true}>
          <cylinderGeometry args=${[2.5, 2.5, 0.06, 16]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#b89a30" roughness=${0.9} />
        </mesh>
      </group>
    <//>
  `;
}

// ---------- Loose idle/wander AI for friendly warriors guarding the base ----------
function useGuardWander(group, spawn, speed = 1) {
  const state = useRef('idle');
  const timer = useRef(1 + Math.random() * 3);
  const target = useRef(new THREE.Vector3(spawn[0], 0, spawn[2]));
  const phase = useRef(Math.random() * 10);
  const legRefs = useRef([]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    if (!group.current) return;
    const pos = group.current.position;
    timer.current -= delta;

    if (timer.current <= 0) {
      state.current = state.current === 'wander' ? 'idle' : 'wander';
      if (state.current === 'wander') {
        const angle = Math.random() * Math.PI * 2;
        const dist = 2 + Math.random() * 4;
        target.current.set(spawn[0] + Math.cos(angle) * dist, 0, spawn[2] + Math.sin(angle) * dist);
        timer.current = 3 + Math.random() * 4;
      } else {
        timer.current = 2 + Math.random() * 3;
      }
    }

    let dirX = 0, dirZ = 0, speedNow = 0;
    if (state.current === 'wander') {
      const tx = target.current.x - pos.x;
      const tz = target.current.z - pos.z;
      const d = Math.hypot(tx, tz);
      if (d < 0.3) {
        state.current = 'idle';
        timer.current = 2 + Math.random() * 3;
      } else {
        dirX = tx / d;
        dirZ = tz / d;
        speedNow = speed;
      }
    }

    if (speedNow > 0) {
      pos.x += dirX * speedNow * delta;
      pos.z += dirZ * speedNow * delta;
      group.current.rotation.y = Math.atan2(dirX, dirZ);
      phase.current += delta * speedNow * 3;
      const swing = Math.sin(phase.current) * 0.4;
      for (const leg of legRefs.current) {
        if (leg.ref.current) leg.ref.current.rotation.x = leg.sign * swing;
      }
    } else {
      for (const leg of legRefs.current) {
        if (leg.ref.current) leg.ref.current.rotation.x *= 0.9;
      }
    }
    pos.y = getTerrainHeight(pos.x, pos.z);
  });

  return legRefs;
}

// Shared limbs+weapon for the player's tribe warriors (guards and escorts alike).

// ---------- A recruited warrior, stands guard and patrols near the tribe base ----------
function PlayerWarrior({ spawn, color = PLAYER_TRIBE_COLOR }) {
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const legRefs = useGuardWander(group, spawn, 1);
  // Arms ride the same walk cycle as the legs, with the signs flipped so each arm
  // swings opposite the leg on its side.
  legRefs.current = [
    { ref: legL, sign: 1 },
    { ref: legR, sign: -1 },
    { ref: armL, sign: -1 },
    { ref: armR, sign: 1 },
  ];

  return html`
    <group ref=${group} position=${spawn}>
      <${ContactShadow} radius=${0.42} />
      <${WarriorFigure} legL=${legL} legR=${legR} armL=${armL} armR=${armR} weapon=${weaponForEntity('guard' + spawn[0].toFixed(1) + spawn[2].toFixed(1))} color=${color} />
    </group>
  `;
}

// Renders one PlayerWarrior per recruited warrior that's staying behind to guard the base
// (the rest are escortWarriors, chosen by the player to come along and fight).
function PlayerWarriors() {
  const warriors = useGame((s) => s.warriors);
  const escortWarriors = useGame((s) => s.escortWarriors);
  const guardCount = Math.min(Math.max(warriors - escortWarriors, 0), PLAYER_WARRIOR_SPAWNS.length);
  return html`
    <${Fragment}>
      ${PLAYER_WARRIOR_SPAWNS.slice(0, guardCount).map((spawn, i) => html`<${PlayerWarrior} key=${i} spawn=${spawn} />`)}
    <//>
  `;
}

// ---------- An escort warrior: follows the player and fights rival tribe members/raiders ----------
function useEscortAI(group, index, attackArm = null) {
  const legRefs = useRef([]);
  const phase = useRef(Math.random() * 10);
  const attackTimer = useRef(Math.random() * ESCORT_ATTACK_COOLDOWN);
  const swingTimer = useRef(0); // counts down through one melee swing

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    if (!group.current) return;
    const pos = group.current.position;
    attackTimer.current -= delta;
    swingTimer.current -= delta;

    const s = useGame.getState();
    const [px, , pz] = playerTransform.position;
    const yaw = playerTransform.yaw;

    // Look for the nearest rival tribe member or raider to fight.
    let target = null;
    let bestDist = ESCORT_AGGRO_RANGE;
    for (const [id, p] of Object.entries(entityRegistry.tribeMembers)) {
      if (!s.tribeMemberState[id]?.alive) continue;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < bestDist) { bestDist = d; target = { kind: 'tribeMember', id, pos: p }; }
    }
    if (s.raid) {
      for (const r of s.raid.raiders) {
        const p = entityRegistry.raiders[r.id];
        if (!p) continue;
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        if (d < bestDist) { bestDist = d; target = { kind: 'raider', id: r.id, pos: p }; }
      }
    }
    if (s.distantRaid) {
      for (const r of s.distantRaid.raiders) {
        const p = entityRegistry.distantRaiders[r.id];
        if (!p) continue;
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        if (d < bestDist) { bestDist = d; target = { kind: 'distantRaider', id: r.id, pos: p }; }
      }
    }
    if (s.interTribalRaid) {
      for (const r of s.interTribalRaid.raiders) {
        const p = entityRegistry.interTribalRaiders[r.id];
        if (!p) continue;
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        if (d < bestDist) { bestDist = d; target = { kind: 'interTribalRaider', id: r.id, pos: p }; }
      }
    }

    let tx, tz;
    if (target) {
      tx = target.pos.x;
      tz = target.pos.z;
    } else {
      // Hold a formation slot just behind and to the side of the player.
      const side = index % 2 === 0 ? 1 : -1;
      const spread = 0.6 + Math.floor(index / 2) * 0.45;
      const angle = yaw + Math.PI + side * spread;
      tx = px + Math.sin(angle) * ESCORT_FOLLOW_DIST;
      tz = pz + Math.cos(angle) * ESCORT_FOLLOW_DIST;
    }

    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const dist = Math.hypot(dx, dz);

    if (target && dist < ESCORT_ATTACK_RANGE) {
      group.current.rotation.y = Math.atan2(dx, dz);
      if (attackTimer.current <= 0) {
        attackTimer.current = ESCORT_ATTACK_COOLDOWN;
        swingTimer.current = ATTACK_SWING_TIME;
        if (target.kind === 'tribeMember') {
          if (s.mpRole === 'joiner') mpSend({ t: 'tribeDamage', id: target.id, dmg: ESCORT_ATTACK_DAMAGE });
          else s.damageTribeMember(target.id, ESCORT_ATTACK_DAMAGE);
        } else if (target.kind === 'distantRaider') {
          s.damageDistantRaider(target.id, ESCORT_ATTACK_DAMAGE);
        } else if (target.kind === 'interTribalRaider') {
          s.damageInterTribalRaider(target.id, ESCORT_ATTACK_DAMAGE);
        } else {
          s.damageRaider(target.id, ESCORT_ATTACK_DAMAGE);
        }
      }
    } else if (dist > 0.3) {
      const spd = target ? ESCORT_SPEED : ESCORT_SPEED * 0.7;
      pos.x += (dx / dist) * spd * delta;
      pos.z += (dz / dist) * spd * delta;
      group.current.rotation.y = Math.atan2(dx, dz);
      phase.current += delta * spd * 1.5;
      const swing = Math.sin(phase.current) * 0.4;
      for (const leg of legRefs.current) if (leg.ref.current) leg.ref.current.rotation.x = leg.sign * swing;
    } else {
      for (const leg of legRefs.current) if (leg.ref.current) leg.ref.current.rotation.x *= 0.9;
    }

    // Melee swing, after the walk cycle so it overrides the arm's walk pose.
    if (attackArm && attackArm.current && swingTimer.current > 0) {
      attackArm.current.rotation.x = armChopAngle(1 - swingTimer.current / ATTACK_SWING_TIME);
    }

    pos.y = getTerrainHeight(pos.x, pos.z);
  });

  return legRefs;
}

function EscortWarrior({ index }) {
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const legRefs = useEscortAI(group, index, armR);
  // Arms ride the same walk cycle as the legs, with the signs flipped so they swing
  // opposite the leg on the same side.
  legRefs.current = [
    { ref: legL, sign: 1 },
    { ref: legR, sign: -1 },
    { ref: armL, sign: -1 },
    { ref: armR, sign: 1 },
  ];
  const spawn = PLAYER_WARRIOR_SPAWNS[index % PLAYER_WARRIOR_SPAWNS.length];

  return html`
    <group ref=${group} position=${spawn}>
      <${ContactShadow} radius=${0.42} />
      <${WarriorFigure} legL=${legL} legR=${legR} armL=${armL} armR=${armR} weapon=${weaponForEntity('escort' + index)} />
    </group>
  `;
}

// Renders the warriors the player has chosen to bring into battle with them.
function EscortWarriors() {
  const warriors = useGame((s) => s.warriors);
  const escortWarriors = useGame((s) => s.escortWarriors);
  const count = Math.min(escortWarriors, warriors);
  return html`
    <${Fragment}>
      ${Array.from({ length: count }, (_, i) => html`<${EscortWarrior} key=${i} index=${i} />`)}
    <//>
  `;
}

// ---------- A raider marching from its tribe's camp toward a target (home base or team camp) ----------
function Raider({ id, startPosition, color, targetPos = BASE_CENTER, targetTribeId = null }) {
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const phase = useRef(Math.random() * 10);
  const resolved = useRef(false);

  useEffect(() => {
    return () => { delete entityRegistry.raiders[id]; };
  }, [id]);

  useFrame((_, rawDelta) => {
    if (resolved.current || !group.current) return;
    const delta = Math.min(rawDelta, 0.1);
    const pos = group.current.position;
    entityRegistry.raiders[id] = pos;

    let targetX, targetZ;
    if (targetTribeId) {
      targetX = targetPos[0];
      targetZ = targetPos[2];
    } else {
      const warriors = useGame.getState().warriors;
      const guardCount = Math.min(warriors, PLAYER_WARRIOR_SPAWNS.length);
      targetX = BASE_CENTER[0];
      targetZ = BASE_CENTER[2];
      if (guardCount > 0) {
        let bestDist = Infinity;
        for (let i = 0; i < guardCount; i++) {
          const [gx, , gz] = PLAYER_WARRIOR_SPAWNS[i];
          const d = Math.hypot(gx - pos.x, gz - pos.z);
          if (d < bestDist) { bestDist = d; targetX = gx; targetZ = gz; }
        }
      }
    }

    const dx = targetX - pos.x;
    const dz = targetZ - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 2) {
      resolved.current = true;
      if (useGame.getState().mpRole !== 'joiner') {
        if (targetTribeId) {
          useGame.getState().resolveRaider(id, true);
        } else {
          const warriors = useGame.getState().warriors;
          const winChance = Math.min(0.9, warriors * 0.22 + 0.08);
          useGame.getState().resolveRaider(id, Math.random() >= winChance);
        }
      }
      return;
    }

    const speed = 3;
    const dirX = dx / dist;
    const dirZ = dz / dist;
    pos.x += dirX * speed * delta;
    pos.z += dirZ * speed * delta;
    pos.y = getTerrainHeight(pos.x, pos.z);
    group.current.rotation.y = Math.atan2(dirX, dirZ);
    phase.current += delta * speed * 3;
    const swing = Math.sin(phase.current) * 0.4;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    // Arms swing opposite the leg on the same side.
    if (armL.current) armL.current.rotation.x = -swing;
    if (armR.current) armR.current.rotation.x = swing;
  });

  return html`
    <group ref=${group} position=${startPosition}>
      <${ContactShadow} radius=${0.42} />
      <${TribalFigure} color=${color} armL=${armL} armR=${armR}
        legL=${legL} legR=${legR} weapon=${weaponForEntity(id)} />
    </group>
  `;
}

function Raiders() {
  const raid = useGame((s) => s.raid);
  if (!raid) return null;
  return html`
    <${Fragment}>
      ${raid.raiders.map((r) => html`<${Raider} key=${r.id} id=${r.id} startPosition=${r.position} color=${raid.color} targetPos=${raid.targetPos ?? BASE_CENTER} targetTribeId=${raid.targetTribeId ?? null} />`)}
    <//>
  `;
}

// ---------- Periodically triggers raids from a random rival tribe ----------
function RaidManager() {
  const timer = useRef(60 + Math.random() * 40);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = useGame.getState();
    if (s.mpRole === 'joiner') return;
    if (s.raid) return;
    timer.current -= delta;
    if (timer.current <= 0) {
      s.startRaid();
      timer.current = 100 + Math.random() * 80;
    }
  });
  return null;
}

// ---------- Distant tribe camps — on/beyond the mountains, always hostile, never capturable ----------
function DistantTribeCamp({ tribe }) {
  const [x, , z] = tribe.campPosition;
  return html`
    <${Fragment}>
      <group position=${[x, 0, z]}>
        ${[[-3, -2], [3, -2], [0, 3], [-5, 2], [5, 1], [-2, 5]].map((p, i) => html`
          <group key=${i} position=${[p[0], 0, p[1]]}>
            <mesh position=${[0, 1.0, 0]} castShadow=${true} receiveShadow=${true}>
              <coneGeometry args=${[1.6, 2.0, 7]} />
              <meshStandardMaterial color=${tribe.color} flatShading=${true} roughness=${0.9} />
            </mesh>
          </group>
        `)}
        <mesh position=${[0, 2.0, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.18, 0.18, 4, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#3a2a10" />
        </mesh>
        <mesh position=${[0, 4.2, 0]} castShadow=${true}>
          <coneGeometry args=${[0.5, 0.7, 5]} />
          <meshStandardMaterial color=${tribe.color} flatShading=${true} />
        </mesh>
      </group>
      <${Campfire} id=${`fire_dt_${tribe.id}`} position=${[x + 2.1, 0, z + 1.9]} scale=${1.15} />
      ${TRIBE_MEMBER_OFFSETS.map((p, i) => html`
        <${TribeMember} key=${i} id=${`dt_${tribe.id}_m${i}`} spawn=${[x + p[0], 0, z + p[1]]} color=${tribe.color} />
      `)}
    <//>
  `;
}

function DistantTribeCamps() {
  return html`
    <${Fragment}>
      ${DISTANT_TRIBES.map((t) => html`<${DistantTribeCamp} key=${t.id} tribe=${t} />`)}
    <//>
  `;
}

// ---------- A raider from a distant tribe marching toward a specific target location ----------
function DistantRaider({ id, startPosition, color, targetPos }) {
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const phase = useRef(Math.random() * 10);
  const resolved = useRef(false);

  useEffect(() => {
    return () => { delete entityRegistry.distantRaiders[id]; };
  }, [id]);

  useFrame((_, rawDelta) => {
    if (resolved.current || !group.current) return;
    const delta = Math.min(rawDelta, 0.1);
    const pos = group.current.position;
    entityRegistry.distantRaiders[id] = pos;

    const dx = targetPos[0] - pos.x;
    const dz = targetPos[2] - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 2.5) {
      resolved.current = true;
      if (useGame.getState().mpRole !== 'joiner') useGame.getState().resolveDistantRaider(id, true);
      return;
    }

    const speed = 3.2;
    pos.x += (dx / dist) * speed * delta;
    pos.z += (dz / dist) * speed * delta;
    pos.y = getTerrainHeight(pos.x, pos.z);
    group.current.rotation.y = Math.atan2(dx, dz);
    phase.current += delta * speed * 3;
    const swing = Math.sin(phase.current) * 0.4;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    // Arms swing opposite the leg on the same side.
    if (armL.current) armL.current.rotation.x = -swing;
    if (armR.current) armR.current.rotation.x = swing;
  });

  return html`
    <group ref=${group} position=${startPosition}>
      <${ContactShadow} radius=${0.42} />
      <${TribalFigure} color=${color} armL=${armL} armR=${armR}
        legL=${legL} legR=${legR} weapon=${weaponForEntity(id)} />
      <mesh position=${[0, 1.3, 0.3]} rotation=${[Math.PI / 2.4, 0, 0]} castShadow=${true}>
        <cylinderGeometry args=${[0.025, 0.025, 1.1, 5]} />
        <meshStandardMaterial color="#2a1a0c" />
      </mesh>
    </group>
  `;
}

function DistantRaiders() {
  const dr = useGame((s) => s.distantRaid);
  if (!dr) return null;
  return html`
    <${Fragment}>
      ${dr.raiders.map((r) => html`
        <${DistantRaider} key=${r.id} id=${r.id} startPosition=${r.position} color=${dr.color} targetPos=${dr.targetPos} />
      `)}
    <//>
  `;
}

// ---------- Periodically triggers raids from distant tribes on any player-held area ----------
function DistantRaidManager() {
  const timer = useRef(180 + Math.random() * 120);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = useGame.getState();
    if (s.mpRole === 'joiner') return;
    if (s.distantRaid) return;
    timer.current -= delta;
    if (timer.current <= 0) {
      s.startDistantRaid();
      timer.current = 150 + Math.random() * 120;
    }
  });
  return null;
}

// ---------- Inter-tribal raiders: enemy tribes marching on each other's camps ----------
function InterTribalRaider({ id, startPosition, color, targetPos }) {
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const phase = useRef(Math.random() * 10);
  const resolved = useRef(false);

  useEffect(() => {
    return () => { delete entityRegistry.interTribalRaiders[id]; };
  }, [id]);

  useFrame((_, rawDelta) => {
    if (resolved.current || !group.current) return;
    const delta = Math.min(rawDelta, 0.1);
    const pos = group.current.position;
    entityRegistry.interTribalRaiders[id] = pos;

    const dx = targetPos[0] - pos.x;
    const dz = targetPos[2] - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 3) {
      resolved.current = true;
      if (useGame.getState().mpRole !== 'joiner') useGame.getState().resolveInterTribalRaider(id, true);
      return;
    }

    const speed = 2.8;
    pos.x += (dx / dist) * speed * delta;
    pos.z += (dz / dist) * speed * delta;
    pos.y = getTerrainHeight(pos.x, pos.z);
    group.current.rotation.y = Math.atan2(dx, dz);
    phase.current += delta * speed * 3;
    const swing = Math.sin(phase.current) * 0.4;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    // Arms swing opposite the leg on the same side.
    if (armL.current) armL.current.rotation.x = -swing;
    if (armR.current) armR.current.rotation.x = swing;
  });

  return html`
    <group ref=${group} position=${startPosition}>
      <${ContactShadow} radius=${0.42} />
      <${TribalFigure} color=${color} armL=${armL} armR=${armR}
        legL=${legL} legR=${legR} weapon=${weaponForEntity(id)} />
    </group>
  `;
}

function InterTribalRaiders() {
  const itr = useGame((s) => s.interTribalRaid);
  if (!itr) return null;
  return html`
    <${Fragment}>
      ${itr.raiders.map((r) => html`
        <${InterTribalRaider} key=${r.id} id=${r.id} startPosition=${r.position} color=${itr.attackerColor} targetPos=${itr.targetPos} />
      `)}
    <//>
  `;
}

function InterTribalRaidManager() {
  const timer = useRef(90 + Math.random() * 60);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = useGame.getState();
    if (s.mpRole === 'joiner') return;
    if (s.interTribalRaid) return;
    if (s.activeTribeIds.length < 2) return;
    timer.current -= delta;
    if (timer.current <= 0) {
      s.startInterTribalRaid();
      timer.current = 80 + Math.random() * 70;
    }
  });
  return null;
}

// ============================================================

export {
  TribeMember,
  _contactGeo,
  _contactMat,
  contactShadowGeo,
  contactShadowMat,
  ContactShadow,
  FIRE_GEO,
  fireGeo,
  fireMat,
  FIRE_LOGS,
  Campfire,
  TribeCamp,
  TribeCamps,
  TribeSpawnManager,
  PlayerTribeBase,
  FriendBase,
  useGuardWander,
  PlayerWarrior,
  PlayerWarriors,
  useEscortAI,
  EscortWarrior,
  EscortWarriors,
  Raider,
  Raiders,
  RaidManager,
  DistantTribeCamp,
  DistantTribeCamps,
  DistantRaider,
  DistantRaiders,
  DistantRaidManager,
  InterTribalRaider,
  InterTribalRaiders,
  InterTribalRaidManager,
};
