import React, { Fragment, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import html from './html.js';

const WANDER_RADIUS = 14;
const FLEE_RANGE = 7;

function useWanderAI(group, spawn, { speed = 1.6, fleeSpeed = 5 }) {
  const { camera } = useThree();
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

    const dx = pos.x - camera.position.x;
    const dz = pos.z - camera.position.z;
    const distToPlayer = Math.hypot(dx, dz);

    if (distToPlayer < FLEE_RANGE) {
      state.current = 'flee';
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
    if (state.current === 'flee') {
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
  });

  return legRefs;
}

// ---------- Wild Boar ----------
function Boar({ position }) {
  const group = useRef();
  const legFL = useRef();
  const legFR = useRef();
  const legBL = useRef();
  const legBR = useRef();
  const legRefs = useWanderAI(group, position, { speed: 1.4, fleeSpeed: 5.5 });
  legRefs.current = [
    { ref: legFL, sign: 1 },
    { ref: legFR, sign: -1 },
    { ref: legBL, sign: -1 },
    { ref: legBR, sign: 1 },
  ];

  return html`
    <group ref=${group} position=${position}>
      <mesh position=${[0, 0.45, 0]} castShadow=${true}>
        <boxGeometry args=${[0.5, 0.4, 1]} />
        <meshStandardMaterial color="#6b4a35" roughness=${0.9} flatShading=${true} />
      </mesh>
      <mesh position=${[0, 0.55, 0.6]} castShadow=${true}>
        <boxGeometry args=${[0.35, 0.3, 0.4]} />
        <meshStandardMaterial color="#5a3c28" roughness=${0.9} flatShading=${true} />
      </mesh>
      <mesh position=${[0, 0.45, 0.85]} rotation=${[Math.PI / 2, 0, 0]} castShadow=${true}>
        <coneGeometry args=${[0.12, 0.3, 6]} />
        <meshStandardMaterial color="#caa48a" flatShading=${true} />
      </mesh>
      <mesh position=${[0.18, 0.75, 0.65]} rotation=${[0.3, 0, 0.3]}>
        <coneGeometry args=${[0.08, 0.2, 5]} />
        <meshStandardMaterial color="#5a3c28" flatShading=${true} />
      </mesh>
      <mesh position=${[-0.18, 0.75, 0.65]} rotation=${[0.3, 0, -0.3]}>
        <coneGeometry args=${[0.08, 0.2, 5]} />
        <meshStandardMaterial color="#5a3c28" flatShading=${true} />
      </mesh>
      <group ref=${legFL} position=${[0.18, 0.25, 0.35]}>
        <mesh position=${[0, -0.12, 0]}><cylinderGeometry args=${[0.06, 0.06, 0.25, 5]} /><meshStandardMaterial color="#3a2a1c" /></mesh>
      </group>
      <group ref=${legFR} position=${[-0.18, 0.25, 0.35]}>
        <mesh position=${[0, -0.12, 0]}><cylinderGeometry args=${[0.06, 0.06, 0.25, 5]} /><meshStandardMaterial color="#3a2a1c" /></mesh>
      </group>
      <group ref=${legBL} position=${[0.18, 0.25, -0.35]}>
        <mesh position=${[0, -0.12, 0]}><cylinderGeometry args=${[0.06, 0.06, 0.25, 5]} /><meshStandardMaterial color="#3a2a1c" /></mesh>
      </group>
      <group ref=${legBR} position=${[-0.18, 0.25, -0.35]}>
        <mesh position=${[0, -0.12, 0]}><cylinderGeometry args=${[0.06, 0.06, 0.25, 5]} /><meshStandardMaterial color="#3a2a1c" /></mesh>
      </group>
    </group>
  `;
}

// ---------- Monkey ----------
function Monkey({ position }) {
  const group = useRef();
  const legL = useRef();
  const legR = useRef();
  const legRefs = useWanderAI(group, position, { speed: 1.8, fleeSpeed: 6 });
  legRefs.current = [
    { ref: legL, sign: 1 },
    { ref: legR, sign: -1 },
  ];

  return html`
    <group ref=${group} position=${position}>
      <mesh position=${[0, 0.5, 0]} castShadow=${true}>
        <capsuleGeometry args=${[0.18, 0.3, 4, 8]} />
        <meshStandardMaterial color="#8a5a3a" roughness=${0.9} />
      </mesh>
      <mesh position=${[0, 0.85, 0]} castShadow=${true}>
        <sphereGeometry args=${[0.16, 10, 10]} />
        <meshStandardMaterial color="#a9764e" roughness=${0.9} />
      </mesh>
      <mesh position=${[0, 0.82, 0.13]}>
        <circleGeometry args=${[0.09, 8]} />
        <meshStandardMaterial color="#e8d2b0" />
      </mesh>
      <mesh position=${[0.16, 0.55, -0.05]} rotation=${[0, 0, -0.4]} castShadow=${true}>
        <capsuleGeometry args=${[0.06, 0.35, 4, 6]} />
        <meshStandardMaterial color="#8a5a3a" />
      </mesh>
      <mesh position=${[-0.16, 0.55, -0.05]} rotation=${[0, 0, 0.4]} castShadow=${true}>
        <capsuleGeometry args=${[0.06, 0.35, 4, 6]} />
        <meshStandardMaterial color="#8a5a3a" />
      </mesh>
      <mesh position=${[0, 0.55, -0.35]} rotation=${[1.0, 0, 0]} castShadow=${true}>
        <capsuleGeometry args=${[0.04, 0.5, 4, 6]} />
        <meshStandardMaterial color="#8a5a3a" />
      </mesh>
      <group ref=${legL} position=${[0.1, 0.32, 0]}>
        <mesh position=${[0, -0.12, 0]}><capsuleGeometry args=${[0.06, 0.2, 4, 6]} /><meshStandardMaterial color="#6b4226" /></mesh>
      </group>
      <group ref=${legR} position=${[-0.1, 0.32, 0]}>
        <mesh position=${[0, -0.12, 0]}><capsuleGeometry args=${[0.06, 0.2, 4, 6]} /><meshStandardMaterial color="#6b4226" /></mesh>
      </group>
    </group>
  `;
}

export default function Animals() {
  return html`
    <${Fragment}>
      <${Boar} position=${[18, 0, 12]} />
      <${Boar} position=${[-25, 0, -18]} />
      <${Monkey} position=${[10, 0, -22]} />
      <${Monkey} position=${[-15, 0, 20]} />
    <//>
  `;
}
