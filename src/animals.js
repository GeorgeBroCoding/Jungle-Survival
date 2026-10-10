import { Fragment, THREE, html, useEffect, useFrame, useRef } from './core.js';
import { ANIMAL_SPAWNS, CAMP_ALERT_RANGE } from './data.js';
import { furMat, humanGeo, plainMat } from './humanbody.js';
import { playerTransform, tribeMemberSyncData } from './multiplayer.js';
import { entityRegistry } from './shake.js';
import { useGame } from './store.js';
import { getTerrainHeight } from './terrain.js';
import { ContactShadow } from './tribes.js';

// ============================================================
// Animals.js - wandering/fleeing wildlife
// ============================================================
const WANDER_RADIUS = 14;
const FLEE_RANGE = 7;

// ---------- Melee swing for tribesfolk and warriors ----------
const ATTACK_SWING_TIME = 0.35; // seconds per swing

// A wind-up-and-chop for a shoulder-pivoted arm, with `p` running 0..1 over the swing.
// The arm hangs along -Y from the shoulder, and these figures face their local +Z, so a
// positive rotation.x lifts the arm up behind them and a negative one sweeps it forward
// through the target. Hence: raise back for the first third, then chop through.
function armChopAngle(p) {
  const windUp = 0.35;
  return p < windUp
    ? (p / windUp) * 0.8
    : 0.8 - ((p - windUp) / (1 - windUp)) * 2.6;
}

// Which weapon a given tribesperson carries. Hashed from their id so it is stable for
// the life of the character instead of changing on every re-render.
const TRIBE_WEAPONS = ['club', 'spear', 'machete', 'axe'];
function weaponForEntity(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return TRIBE_WEAPONS[Math.abs(h) % TRIBE_WEAPONS.length];
}

function useWanderAI(group, spawn, {
  speed = 1.6, fleeSpeed = 5, entityId = null, registryKey = 'animals',
  aggressive = false, aggroRange = FLEE_RANGE, attackRange = 1.8,
  attackSpeed = 0, attackDamage = 0, attackCooldown = 1.2,
  frozen = false, alertTribeId = null, attackArm = null,
}) {
  const state = useRef('idle');
  const timer = useRef(1 + Math.random() * 3);
  const target = useRef(new THREE.Vector3(spawn[0], 0, spawn[2]));
  const phase = useRef(Math.random() * 10);
  const legRefs = useRef([]);
  const attackTimer = useRef(0);
  const swingTimer = useRef(0); // counts down through one melee swing
  const warnedAttack = useRef(false);

  useEffect(() => {
    return () => {
      if (entityId) {
        delete entityRegistry[registryKey][entityId];
        if (registryKey === 'tribeMembers') delete tribeMemberSyncData[entityId];
      }
    };
  }, [entityId, registryKey]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    if (!group.current) return;
    if (frozen) return; // position is driven by the multiplayer host instead
    const pos = group.current.position;
    if (entityId) {
      entityRegistry[registryKey][entityId] = pos;
      if (registryKey === 'tribeMembers' && useGame.getState().mpRole === 'host') {
        tribeMemberSyncData[entityId] = { position: [pos.x, pos.y, pos.z], yaw: group.current.rotation.y };
      }
    }
    timer.current -= delta;
    attackTimer.current -= delta;
    swingTimer.current -= delta;

    // Measured against the player's own position, never the camera's. In third person
    // the camera trails the player by camDistance (6 by default, up to 12 zoomed out),
    // so using camera.position let tribespeople land hits from metres away and made
    // aggro lopsided — generous behind the player, stingy in front.
    const dx = pos.x - playerTransform.position[0];
    const dz = pos.z - playerTransform.position[2];
    const distToPlayer = Math.hypot(dx, dz);

    // A camp-mate being attacked alerts the whole camp - they rush in from much further away.
    const alertedUntil = alertTribeId ? useGame.getState().alertedCamps[alertTribeId] : 0;
    const effectiveAggroRange = alertedUntil && alertedUntil > Date.now() ? Math.max(aggroRange, CAMP_ALERT_RANGE) : aggroRange;

    if (aggressive && distToPlayer < effectiveAggroRange) {
      state.current = 'attack';
    } else if (!aggressive && distToPlayer < FLEE_RANGE) {
      state.current = 'flee';
    } else if (state.current === 'attack') {
      // lost the player - give up the chase and wander again
      state.current = 'idle';
      timer.current = 1;
      warnedAttack.current = false;
    } else if (timer.current <= 0) {
      state.current = state.current === 'wander' ? 'idle' : 'wander';
      if (state.current === 'wander') {
        const angle = Math.random() * Math.PI * 2;
        const dist = 4 + Math.random() * 8;
        let tx = pos.x + Math.cos(angle) * dist;
        let tz = pos.z + Math.sin(angle) * dist;
        // keep near spawn
        if (Math.hypot(tx - spawn[0], tz - spawn[2]) > WANDER_RADIUS) {
          tx = spawn[0];
          tz = spawn[2];
        }
        target.current.set(tx, 0, tz);
        timer.current = 3 + Math.random() * 4;
      } else {
        timer.current = 1.5 + Math.random() * 3;
      }
    }

    let dirX = 0, dirZ = 0, speedNow = 0;
    if (state.current === 'attack') {
      const len = Math.hypot(dx, dz) || 1;
      if (distToPlayer > attackRange) {
        dirX = -dx / len;
        dirZ = -dz / len;
        speedNow = attackSpeed || speed;
      } else {
        group.current.rotation.y = Math.atan2(-dx / len, -dz / len);
        if (!warnedAttack.current) {
          useGame.getState().addToast('A rival tribesperson attacks you!');
          warnedAttack.current = true;
        }
        if (attackTimer.current <= 0 && attackDamage > 0) {
          useGame.getState().adjustStat('health', -attackDamage);
          attackTimer.current = attackCooldown;
          swingTimer.current = ATTACK_SWING_TIME;
        }
      }
    } else if (state.current === 'flee') {
      const len = Math.hypot(dx, dz) || 1;
      dirX = dx / len;
      dirZ = dz / len;
      speedNow = fleeSpeed;
      if (distToPlayer > FLEE_RANGE * 1.6) {
        state.current = 'idle';
        timer.current = 1;
      }
    } else if (state.current === 'wander') {
      const tx = target.current.x - pos.x;
      const tz = target.current.z - pos.z;
      const d = Math.hypot(tx, tz);
      if (d < 0.3) {
        state.current = 'idle';
        timer.current = 1.5 + Math.random() * 3;
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

    // Melee swing, applied after the walk cycle so it overrides the arm's walk pose.
    // When the swing ends the idle decay above eases the arm back down by itself.
    if (attackArm && attackArm.current && swingTimer.current > 0) {
      attackArm.current.rotation.x = armChopAngle(1 - swingTimer.current / ATTACK_SWING_TIME);
    }

    pos.y = getTerrainHeight(pos.x, pos.z);
  });

  return legRefs;
}

// ---------- Wild Boar ----------
function Boar({ id, position }) {
  const alive = useGame((s) => s.animalState[id]?.alive ?? true);
  const group = useRef();
  const legFL = useRef();
  const legFR = useRef();
  const legBL = useRef();
  const legBR = useRef();
  const legRefs = useWanderAI(group, position, { speed: 1.4, fleeSpeed: 5.5, entityId: alive ? id : null });
  if (!alive) return null;
  legRefs.current = [
    { ref: legFL, sign: 1 },
    { ref: legFR, sign: -1 },
    { ref: legBL, sign: -1 },
    { ref: legBR, sign: 1 },
  ];

  return html`
    <group ref=${group} position=${position}>
      <${ContactShadow} radius=${0.5} />
      <!-- barrel body: a lathed drum, heavier at the shoulder than the rump -->
      <mesh geometry=${humanGeo('torso')} material=${furMat('boarFur')}
        position=${[0, 0.70, 0.40]} rotation=${[Math.PI / 2, 0, 0]}
        scale=${[0.21, 0.85, 0.20]} castShadow=${true} receiveShadow=${true} />
      <!-- shoulder hump, the giveaway silhouette of a wild pig -->
      <mesh geometry=${humanGeo('ballLow')} material=${furMat('boarFur')}
        position=${[0, 0.78, 0.24]} scale=${[0.21, 0.17, 0.22]} castShadow=${true} />
      <!-- wedge head and snout -->
      <mesh geometry=${humanGeo('ballLow')} material=${furMat('boarFur')}
        position=${[0, 0.62, 0.58]} scale=${[0.15, 0.15, 0.21]} castShadow=${true} />
      <mesh geometry=${humanGeo('cone')} material=${plainMat('snout', { color: '#b89480', roughness: 0.65 })}
        position=${[0, 0.56, 0.72]} rotation=${[Math.PI / 2, 0, 0]}
        scale=${[0.09, 0.20, 0.09]} castShadow=${true} />
      <!-- tusks -->
      <mesh geometry=${humanGeo('cone')} material=${plainMat('tusk', { color: '#e8e0cc', roughness: 0.35 })}
        position=${[0.065, 0.56, 0.78]} rotation=${[-0.5, 0, 0.25]} scale=${[0.018, 0.14, 0.018]} />
      <mesh geometry=${humanGeo('cone')} material=${plainMat('tusk', { color: '#e8e0cc', roughness: 0.35 })}
        position=${[-0.065, 0.56, 0.78]} rotation=${[-0.5, 0, -0.25]} scale=${[0.018, 0.14, 0.018]} />
      <!-- eyes -->
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('animalEye', { color: '#171008', roughness: 0.25 })}
        position=${[0.095, 0.68, 0.66]} scale=${[0.024, 0.024, 0.02]} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('animalEye', { color: '#171008', roughness: 0.25 })}
        position=${[-0.095, 0.68, 0.66]} scale=${[0.024, 0.024, 0.02]} />
      <!-- ears -->
      <mesh geometry=${humanGeo('cone')} material=${furMat('boarFur')}
        position=${[0.115, 0.76, 0.50]} rotation=${[-0.35, 0, 0.45]} scale=${[0.07, 0.15, 0.04]} castShadow=${true} />
      <mesh geometry=${humanGeo('cone')} material=${furMat('boarFur')}
        position=${[-0.115, 0.76, 0.50]} rotation=${[-0.35, 0, -0.45]} scale=${[0.07, 0.15, 0.04]} castShadow=${true} />
      <!-- bristle ridge along the spine -->
      <mesh geometry=${humanGeo('cone')} material=${plainMat('bristle', { color: '#1d140c', roughness: 0.9 })}
        position=${[0, 0.88, 0.14]} rotation=${[0.25, 0, 0]} scale=${[0.04, 0.14, 0.16]} />
      <!-- tail -->
      <mesh geometry=${humanGeo('foreArm')} material=${furMat('boarFur')}
        position=${[0, 0.74, -0.44]} rotation=${[-1.1, 0, 0]} scale=${[0.025, 0.20, 0.025]} />
      <group ref=${legFL} position=${[0.19, 0.48, 0.30]}>
        <mesh geometry=${humanGeo('shin')} material=${furMat('boarFur')}
          scale=${[0.062, 0.40, 0.062]} castShadow=${true} />
        <mesh geometry=${humanGeo('box')} material=${plainMat('hoof', { color: '#2a1d12', roughness: 0.5 })}
          position=${[0, -0.41, 0.01]} scale=${[0.07, 0.05, 0.09]} />
      </group>
      <group ref=${legFR} position=${[-0.19, 0.48, 0.30]}>
        <mesh geometry=${humanGeo('shin')} material=${furMat('boarFur')}
          scale=${[0.062, 0.40, 0.062]} castShadow=${true} />
        <mesh geometry=${humanGeo('box')} material=${plainMat('hoof', { color: '#2a1d12', roughness: 0.5 })}
          position=${[0, -0.41, 0.01]} scale=${[0.07, 0.05, 0.09]} />
      </group>
      <group ref=${legBL} position=${[0.19, 0.48, -0.34]}>
        <mesh geometry=${humanGeo('shin')} material=${furMat('boarFur')}
          scale=${[0.065, 0.40, 0.065]} castShadow=${true} />
        <mesh geometry=${humanGeo('box')} material=${plainMat('hoof', { color: '#2a1d12', roughness: 0.5 })}
          position=${[0, -0.41, 0.01]} scale=${[0.07, 0.05, 0.09]} />
      </group>
      <group ref=${legBR} position=${[-0.19, 0.48, -0.34]}>
        <mesh geometry=${humanGeo('shin')} material=${furMat('boarFur')}
          scale=${[0.065, 0.40, 0.065]} castShadow=${true} />
        <mesh geometry=${humanGeo('box')} material=${plainMat('hoof', { color: '#2a1d12', roughness: 0.5 })}
          position=${[0, -0.41, 0.01]} scale=${[0.07, 0.05, 0.09]} />
      </group>
    </group>
  `;
}

// ---------- Monkey ----------
function Monkey({ id, position }) {
  const alive = useGame((s) => s.animalState[id]?.alive ?? true);
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const legRefs = useWanderAI(group, position, { speed: 1.8, fleeSpeed: 6, entityId: alive ? id : null });
  if (!alive) return null;
  legRefs.current = [
    { ref: legL, sign: 1 },
    { ref: legR, sign: -1 },
  ];

  return html`
    <group ref=${group} position=${position}>
      <${ContactShadow} radius=${0.34} />
      <!-- hunched torso -->
      <mesh geometry=${humanGeo('torso')} material=${furMat('monkeyFur')}
        position=${[0, 0.72, 0]} rotation=${[0.18, 0, 0]}
        scale=${[0.145, 0.36, 0.125]} castShadow=${true} receiveShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${furMat('monkeyFur')}
        position=${[0, 0.40, 0.02]} scale=${[0.115, 0.095, 0.105]} castShadow=${true} />
      <!-- head, muzzle and face patch -->
      <mesh geometry=${humanGeo('ball')} material=${furMat('monkeyFur')}
        position=${[0, 0.85, 0.01]} scale=${[0.125, 0.135, 0.125]} castShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
        position=${[0, 0.825, 0.095]} scale=${[0.082, 0.072, 0.062]} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('monkeyMuzzle', { color: '#c49a72', roughness: 0.6 })}
        position=${[0, 0.80, 0.135]} scale=${[0.045, 0.034, 0.038]} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('animalEye', { color: '#171008', roughness: 0.25 })}
        position=${[0.040, 0.862, 0.120]} scale=${[0.019, 0.019, 0.014]} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('animalEye', { color: '#171008', roughness: 0.25 })}
        position=${[-0.040, 0.862, 0.120]} scale=${[0.019, 0.019, 0.014]} />
      <!-- big round ears -->
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
        position=${[0.125, 0.862, -0.005]} scale=${[0.022, 0.048, 0.044]} castShadow=${true} />
      <mesh geometry=${humanGeo('ballLow')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
        position=${[-0.125, 0.862, -0.005]} scale=${[0.022, 0.048, 0.044]} castShadow=${true} />
      <!-- long arms, bent at the elbow and hanging low like a real monkey's -->
      <group position=${[0.155, 0.80, 0.0]} rotation=${[0, 0, -0.34]}>
        <mesh geometry=${humanGeo('upperArm')} material=${furMat('monkeyFur')}
          scale=${[0.048, 0.21, 0.048]} castShadow=${true} />
        <group position=${[0, -0.21, 0]} rotation=${[0.42, 0, 0]}>
          <mesh geometry=${humanGeo('foreArm')} material=${furMat('monkeyFur')}
            scale=${[0.042, 0.20, 0.042]} castShadow=${true} />
          <mesh geometry=${humanGeo('ballLow')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
            position=${[0, -0.21, 0]} scale=${[0.034, 0.042, 0.026]} />
        </group>
      </group>
      <group position=${[-0.155, 0.80, 0.0]} rotation=${[0, 0, 0.34]}>
        <mesh geometry=${humanGeo('upperArm')} material=${furMat('monkeyFur')}
          scale=${[0.048, 0.21, 0.048]} castShadow=${true} />
        <group position=${[0, -0.21, 0]} rotation=${[0.42, 0, 0]}>
          <mesh geometry=${humanGeo('foreArm')} material=${furMat('monkeyFur')}
            scale=${[0.042, 0.20, 0.042]} castShadow=${true} />
          <mesh geometry=${humanGeo('ballLow')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
            position=${[0, -0.21, 0]} scale=${[0.034, 0.042, 0.026]} />
        </group>
      </group>
      <!-- curling tail, built from a few tapering links -->
      <mesh geometry=${humanGeo('foreArm')} material=${furMat('monkeyFur')}
        position=${[0, 0.52, -0.10]} rotation=${[-1.15, 0, 0]} scale=${[0.030, 0.26, 0.030]} />
      <mesh geometry=${humanGeo('foreArm')} material=${furMat('monkeyFur')}
        position=${[0, 0.42, -0.33]} rotation=${[-2.10, 0, 0]} scale=${[0.024, 0.22, 0.024]} />
      <mesh geometry=${humanGeo('foreArm')} material=${furMat('monkeyFur')}
        position=${[0, 0.58, -0.40]} rotation=${[-3.00, 0, 0]} scale=${[0.018, 0.16, 0.018]} />
      <group ref=${legL} position=${[0.085, 0.42, 0]}>
        <mesh geometry=${humanGeo('thigh')} material=${furMat('monkeyFur')}
          scale=${[0.058, 0.22, 0.058]} castShadow=${true} />
        <group position=${[0, -0.22, 0]} rotation=${[-0.30, 0, 0]}>
          <mesh geometry=${humanGeo('shin')} material=${furMat('monkeyFur')}
            scale=${[0.050, 0.19, 0.050]} castShadow=${true} />
          <mesh geometry=${humanGeo('box')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
            position=${[0, -0.20, 0.035]} scale=${[0.055, 0.03, 0.11]} />
        </group>
      </group>
      <group ref=${legR} position=${[-0.085, 0.42, 0]}>
        <mesh geometry=${humanGeo('thigh')} material=${furMat('monkeyFur')}
          scale=${[0.058, 0.22, 0.058]} castShadow=${true} />
        <group position=${[0, -0.22, 0]} rotation=${[-0.30, 0, 0]}>
          <mesh geometry=${humanGeo('shin')} material=${furMat('monkeyFur')}
            scale=${[0.050, 0.19, 0.050]} castShadow=${true} />
          <mesh geometry=${humanGeo('box')} material=${plainMat('monkeyFace', { color: '#d8b48c', roughness: 0.6 })}
            position=${[0, -0.20, 0.035]} scale=${[0.055, 0.03, 0.11]} />
        </group>
      </group>
    </group>
  `;
}

function Animals() {
  return html`
    <${Fragment}>
      ${ANIMAL_SPAWNS.map((a) => {
        const Comp = a.type === 'boar' ? Boar : Monkey;
        return html`<${Comp} key=${a.id} id=${a.id} position=${a.position} />`;
      })}
    <//>
  `;
}

// ============================================================

export {
  WANDER_RADIUS,
  FLEE_RANGE,
  ATTACK_SWING_TIME,
  armChopAngle,
  TRIBE_WEAPONS,
  weaponForEntity,
  useWanderAI,
  Boar,
  Monkey,
  Animals,
};
