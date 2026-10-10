import { Fragment, THREE, html, useEffect, useFrame, useRef, useState } from './core.js';
import { ATTACK_DURATION, CAVE_LOCATIONS, LOOT_SPAWNS, RESOURCES, SPEAR_FLIGHT_SPEED, WEAPONS } from './data.js';
import { HumanFigure } from './humanbody.js';
import { registerInteractable } from './interactions.js';
import { remotePlayer } from './multiplayer.js';
import { HeldWeapon } from './player.js';
import { useGame } from './store.js';
import { getTerrainHeight } from './terrain.js';
import { ContactShadow } from './tribes.js';
import { Bush, Rock, Tree } from './vegetation.js';
import { grainTiled } from './wind.js';

// ============================================================
// RemotePlayer.js - visual representation of the other player (P2P multiplayer)
// ============================================================
function RemotePlayer() {
  const group = useRef();
  const leftArm = useRef();
  const rightArm = useRef();
  const leftLeg = useRef();
  const rightLeg = useRef();
  const limbPhase = useRef(0);
  const attackTimer = useRef(0);
  const lastAttackSeq = useRef(0);
  const [visible, setVisible] = useState(false);
  const [weaponId, setWeaponId] = useState(null);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    if (!remotePlayer.active) {
      if (visible) setVisible(false);
      return;
    }
    if (!visible) setVisible(true);
    if (remotePlayer.equippedWeaponId !== weaponId) setWeaponId(remotePlayer.equippedWeaponId);

    const g = group.current;
    const [tx, ty, tz] = remotePlayer.position;
    g.position.x += (tx - g.position.x) * 0.25;
    g.position.y += (ty - g.position.y) * 0.25;
    g.position.z += (tz - g.position.z) * 0.25;

    let yawDiff = remotePlayer.yaw - g.rotation.y;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    g.rotation.y += yawDiff * 0.25;

    if (remotePlayer.attackSeq !== lastAttackSeq.current) {
      lastAttackSeq.current = remotePlayer.attackSeq;
      attackTimer.current = ATTACK_DURATION;
    }

    if (remotePlayer.moving) {
      const speedFactor = remotePlayer.sprinting ? 2.2 : remotePlayer.crouching ? 1.0 : 1.6;
      limbPhase.current += delta * speedFactor * 2.2;
      const swing = Math.sin(limbPhase.current) * (remotePlayer.crouching ? 0.3 : 0.6);
      if (leftArm.current) leftArm.current.rotation.x = swing;
      if (rightArm.current) rightArm.current.rotation.x = -swing;
      if (leftLeg.current) leftLeg.current.rotation.x = -swing;
      if (rightLeg.current) rightLeg.current.rotation.x = swing;
    } else {
      if (leftArm.current) leftArm.current.rotation.x *= 0.9;
      if (rightArm.current) rightArm.current.rotation.x *= 0.9;
      if (leftLeg.current) leftLeg.current.rotation.x *= 0.9;
      if (rightLeg.current) rightLeg.current.rotation.x *= 0.9;
    }

    if (attackTimer.current > 0) {
      attackTimer.current -= delta;
      const progress = 1 - attackTimer.current / ATTACK_DURATION;
      if (rightArm.current) rightArm.current.rotation.x = -Math.sin(progress * Math.PI) * 1.8;
    }
  });

  return html`
    <group ref=${group} visible=${visible} position=${[remotePlayer.position[0], remotePlayer.position[1], remotePlayer.position[2]]}>
      <${ContactShadow} radius=${0.44} />
      <${HumanFigure}
        skinKey="skinPale"
        clothColor="#c9a020"
        accentColor="#f0d020"
        hairColor="#3a2415"
        armL=${leftArm} armR=${rightArm}
        legL=${leftLeg} legR=${rightLeg}
        weapon=${weaponId || null}
        face=${-1}
        torsoWrap=${true}
      />
    </group>
  `;
}

// ============================================================
// Resources.js - gatherable resource nodes
// ============================================================
function OreNode({ position, color }) {
  const y = getTerrainHeight(position[0], position[2]);
  return html`
    <group position=${[position[0], y, position[2]]}>
      <mesh position=${[0, 0.28, 0]} castShadow=${true}>
        <dodecahedronGeometry args=${[0.34, 0]} />
        <meshStandardMaterial color=${color} metalness=${0.7} roughness=${0.25} flatShading=${true} />
      </mesh>
      <mesh position=${[0.3, 0.16, 0.2]} castShadow=${true}>
        <dodecahedronGeometry args=${[0.2, 0]} />
        <meshStandardMaterial color=${color} metalness=${0.7} roughness=${0.25} flatShading=${true} />
      </mesh>
      <mesh position=${[-0.22, 0.14, -0.18]} castShadow=${true}>
        <dodecahedronGeometry args=${[0.16, 0]} />
        <meshStandardMaterial color=${color} metalness=${0.7} roughness=${0.25} flatShading=${true} />
      </mesh>
    </group>
  `;
}

function ResourceNode({ node }) {
  const depleted = useGame((s) => !!s.depletedNodes[node.id]);
  const activeWeapon = useGame((s) => s.hotbarSlots[s.activeHotbarSlot]);
  const hasAxe = useGame((s) => (s.inventory.axe || 0) > 0);
  const hasMachete = useGame((s) => (s.inventory.machete || 0) > 0);
  const hasPickaxe = useGame((s) => (s.inventory.pickaxe || 0) > 0);

  let label;
  if (node.type === 'wood') {
    if (activeWeapon === 'axe' && hasAxe) label = 'Chop Wood (Axe)';
    else if (activeWeapon === 'machete' && hasMachete) label = 'Chop Leaves (Machete)';
    else label = 'Gather Wood (need Axe)';
  } else if (node.type === 'stone') {
    label = (activeWeapon === 'pickaxe' && hasPickaxe) ? 'Mine Stone (Pickaxe)' : 'Mine Stone (need Pickaxe)';
  } else if (node.type === 'silver') {
    label = (activeWeapon === 'pickaxe' && hasPickaxe) ? 'Mine Silver (Pickaxe)' : 'Mine Silver (need Pickaxe)';
  } else if (node.type === 'gold') {
    label = (activeWeapon === 'pickaxe' && hasPickaxe) ? 'Mine Gold (Pickaxe)' : 'Mine Gold (need Pickaxe)';
  } else {
    label = `Gather ${RESOURCES[node.type].name}`;
  }

  useEffect(() => {
    if (depleted) return undefined;
    return registerInteractable({
      id: node.id,
      position: node.position,
      radius: 2.4,
      action: 'gather',
      label,
      onInteract: () => useGame.getState().gatherNode(node),
    });
  }, [depleted, label]);

  if (depleted) return null;

  // Each of these gets a contact shadow as well: they are small enough that
  // the sun's shadow map alone leaves them looking stuck on rather than sat on.
  if (node.type === 'wood') return html`<${Fragment}><${ContactShadow} position=${node.position} radius=${1.3} /><${Tree} position=${node.position} scale=${1.1} /><//>`;
  if (node.type === 'fiber') return html`<${Fragment}><${ContactShadow} position=${node.position} radius=${0.85} /><${Bush} position=${node.position} scale=${1.2} /><//>`;
  if (node.type === 'stone') return html`<${Fragment}><${ContactShadow} position=${node.position} radius=${0.95} /><${Rock} position=${node.position} scale=${1.5} /><//>`;
  if (node.type === 'silver') return html`<${Fragment}><${ContactShadow} position=${node.position} radius=${0.8} /><${OreNode} position=${node.position} color="#c0c0d0" /><//>`;
  if (node.type === 'gold') return html`<${Fragment}><${ContactShadow} position=${node.position} radius=${0.8} /><${OreNode} position=${node.position} color="#ffd700" /><//>`;
  return null;
}

function Resources() {
  const nodes = useGame((s) => s.resourceNodes);
  return html`
    <${Fragment}>
      ${nodes.map((n) => html`<${ResourceNode} key=${n.id} node=${n} />`)}
    <//>
  `;
}

// ============================================================
// Caves — dark rocky entrances on mountain slopes, guarding ore deposits
// ============================================================
function Cave({ id, mx, mz, r }) {
  const len = Math.sqrt(mx * mx + mz * mz);
  const dx = -mx / len, dz = -mz / len; // direction toward origin (player-facing)
  const cx = mx + dx * r * 0.58;
  const cz = mz + dz * r * 0.58;
  const y = getTerrainHeight(cx, cz);
  const yaw = Math.atan2(-dx, -dz);
  return html`
    <group position=${[cx, y, cz]} rotation=${[0, yaw, 0]}>
      <mesh position=${[-1.25, 0.85, 0]} castShadow=${true}>
        <boxGeometry args=${[0.85, 2.3, 1.3]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#4a4545" roughness=${0.95} />
      </mesh>
      <mesh position=${[1.25, 0.85, 0]} castShadow=${true}>
        <boxGeometry args=${[0.85, 2.3, 1.3]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#4a4545" roughness=${0.95} />
      </mesh>
      <mesh position=${[0, 2.25, 0]} castShadow=${true}>
        <boxGeometry args=${[3.1, 0.95, 1.3]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#3e3a3a" roughness=${0.95} />
      </mesh>
      <mesh position=${[0, 1.05, 0.38]}>
        <boxGeometry args=${[2.1, 1.9, 0.15]} />
        <meshStandardMaterial ...${grainTiled('cloth', [2.2, 2.2])} color="#080606" roughness=${1} />
      </mesh>
      <mesh position=${[-1.85, 0.28, 0.75]} castShadow=${true}>
        <dodecahedronGeometry args=${[0.52, 0]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#57504e" roughness=${0.9} />
      </mesh>
      <mesh position=${[1.65, 0.24, 0.6]} castShadow=${true}>
        <dodecahedronGeometry args=${[0.43, 0]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#524d4b" roughness=${0.9} />
      </mesh>
      <mesh position=${[0.3, 0.18, 1.1]} castShadow=${true}>
        <dodecahedronGeometry args=${[0.35, 0]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#4e4a48" roughness=${0.9} />
      </mesh>
    </group>
  `;
}

function Caves() {
  return html`
    <${Fragment}>
      ${CAVE_LOCATIONS.map((c) => html`<${Cave} key=${c.id} id=${c.id} mx=${c.mx} mz=${c.mz} r=${c.r} />`)}
    <//>
  `;
}

// ============================================================
// General loot scattered on the map - walk up and press E to pick up.
// Food (apples, meat, berries) and odds-and-ends from foraging.
// ============================================================
function LootPickup({ spawn }) {
  const collected = useGame((s) => !!s.collectedLoot[spawn.id]);

  useEffect(() => {
    if (collected) return undefined;
    return registerInteractable({
      id: spawn.id,
      position: spawn.position,
      radius: 2,
      action: 'interact',
      label: `pick up ${RESOURCES[spawn.item]?.name || spawn.item}${spawn.qty > 1 ? ` x${spawn.qty}` : ''}`,
      onInteract: () => useGame.getState().collectLoot(spawn),
    });
  }, [collected]);

  if (collected) return null;

  if (spawn.item === 'apple') {
    return html`
      <mesh position=${[spawn.position[0], 0.4, spawn.position[2]]} castShadow=${true}>
        <sphereGeometry args=${[0.18, 8, 8]} />
        <meshStandardMaterial color="#d23b3b" roughness=${0.6} />
      </mesh>
    `;
  }

  const color = RESOURCES[spawn.item]?.color || '#caa45a';
  return html`
    <mesh position=${[spawn.position[0], 0.18, spawn.position[2]]} rotation=${[0.25, 0.6, 0]} castShadow=${true}>
      <boxGeometry args=${[0.32, 0.22, 0.32]} />
      <meshStandardMaterial color=${color} roughness=${0.85} />
    </mesh>
  `;
}

function LootPickups() {
  return html`
    <${Fragment}>
      ${LOOT_SPAWNS.map((spawn) => html`<${LootPickup} key=${spawn.id} spawn=${spawn} />`)}
    <//>
  `;
}

// ============================================================
// Weapons lying on the ground (thrown spears) - walk up and press E to pick up
// ============================================================
function GroundWeapon({ gw }) {
  useEffect(() => {
    return registerInteractable({
      id: gw.id,
      position: gw.position,
      radius: 2,
      action: 'interact',
      label: `pick up ${WEAPONS[gw.weaponId].name}`,
      onInteract: () => useGame.getState().pickupWeapon(gw.id),
    });
  }, [gw.id]);

  return html`
    <group position=${[gw.position[0], getTerrainHeight(gw.position[0], gw.position[2]) + 0.3, gw.position[2]]} rotation=${[0, Math.random() * Math.PI, 0]}>
      <${HeldWeapon} id=${gw.weaponId} />
    </group>
  `;
}

function GroundWeapons() {
  const groundWeapons = useGame((s) => s.groundWeapons);
  return html`
    <${Fragment}>
      ${groundWeapons.map((gw) => html`<${GroundWeapon} key=${gw.id} gw=${gw} />`)}
    <//>
  `;
}

// ---------- A spear in flight, arcing from the player's hand to where it lands ----------
function FlyingSpear({ spear }) {
  const group = useRef();
  const landed = useRef(false);
  const duration = useRef(Math.max(0.15, Math.hypot(spear.end[0] - spear.start[0], spear.end[2] - spear.start[2]) / SPEAR_FLIGHT_SPEED));
  const yaw = Math.atan2(spear.end[0] - spear.start[0], spear.end[2] - spear.start[2]);

  useFrame(() => {
    if (landed.current || !group.current) return;
    const t = Math.min(1, (Date.now() - spear.startedAt) / 1000 / duration.current);
    const x = spear.start[0] + (spear.end[0] - spear.start[0]) * t;
    const z = spear.start[2] + (spear.end[2] - spear.start[2]) * t;
    const arcY = spear.start[1] + (spear.end[1] - spear.start[1]) * t + Math.sin(t * Math.PI) * 1.2;
    const terrY = getTerrainHeight(x, z);
    group.current.position.set(x, Math.max(arcY, terrY + 0.05), z);
    if (t >= 1 || (arcY < terrY + 0.1 && t > 0.05)) {
      landed.current = true;
      useGame.getState().landSpear(spear.id, [x, terrY + 0.05, z]);
    }
  });

  return html`
    <group ref=${group} position=${spear.start} rotation=${[1.5, yaw, 0]}>
      <${HeldWeapon} id=${spear.weaponId} />
    </group>
  `;
}

function FlyingSpears() {
  const flyingSpears = useGame((s) => s.flyingSpears);
  return html`
    <${Fragment}>
      ${flyingSpears.map((spear) => html`<${FlyingSpear} key=${spear.id} spear=${spear} />`)}
    <//>
  `;
}

// ---------- Quick visual "ching" spark burst, e.g. when swinging the machete ----------
function ChingFx({ fx }) {
  const group = useRef();
  const t = useRef(0);
  const DURATION = 0.25;

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    t.current += delta;
    if (t.current >= DURATION) {
      useGame.getState().removeFx(fx.id);
      return;
    }
    const k = t.current / DURATION;
    if (group.current) {
      const scale = 0.4 + k * 1.4;
      group.current.scale.set(scale, scale, scale);
      for (const child of group.current.children) {
        if (child.material) child.material.opacity = 1 - k;
      }
    }
  });

  return html`
    <group ref=${group} position=${fx.position}>
      ${[0, 1, 2, 3].map((i) => html`
        <mesh key=${i} rotation=${[0, 0, (i / 4) * Math.PI * 2]}>
          <planeGeometry args=${[0.6, 0.06]} />
          <meshBasicMaterial color="#fff7c0" transparent=${true} opacity=${1} side=${THREE.DoubleSide} depthWrite=${false} />
        </mesh>
      `)}
    </group>
  `;
}

function FxEffects() {
  const fxEvents = useGame((s) => s.fxEvents);
  return html`
    <${Fragment}>
      ${fxEvents.map((fx) => fx.type === 'ching' ? html`<${ChingFx} key=${fx.id} fx=${fx} />` : null)}
    <//>
  `;
}


export {
  RemotePlayer,
  OreNode,
  ResourceNode,
  Resources,
  Cave,
  Caves,
  LootPickup,
  LootPickups,
  GroundWeapon,
  GroundWeapons,
  FlyingSpear,
  FlyingSpears,
  ChingFx,
  FxEffects,
};
