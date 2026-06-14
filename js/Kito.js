import React, { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import html from './html.js';
import { useGame } from './store.js';
import { registerInteractable } from './interactions.js';

const KITO_POS = [-8, 0, 6];
const WORKBENCH_POS = [-4, 0, 9];

// Kito the shop trader - tall, warm, colorful, feather behind ear.
export function Kito() {
  const wave = useRef();

  useEffect(() => {
    return registerInteractable({
      id: 'kito',
      position: KITO_POS,
      radius: 3,
      key: 'KeyE',
      label: 'Talk to Kito',
      onInteract: () => useGame.getState().setActivePanel('shop'),
    });
  }, []);

  useFrame((state) => {
    if (wave.current) {
      wave.current.rotation.z = Math.sin(state.clock.elapsedTime * 1.5) * 0.15 - 0.2;
    }
  });

  return html`
    <group position=${KITO_POS}>
      <!-- legs -->
      <mesh position=${[0.12, 0.75, 0]} castShadow=${true}>
        <capsuleGeometry args=${[0.11, 0.6, 4, 6]} />
        <meshStandardMaterial color="#8a6a3a" />
      </mesh>
      <mesh position=${[-0.12, 0.75, 0]} castShadow=${true}>
        <capsuleGeometry args=${[0.11, 0.6, 4, 6]} />
        <meshStandardMaterial color="#8a6a3a" />
      </mesh>
      <!-- torso / vest -->
      <mesh position=${[0, 1.35, 0]} castShadow=${true}>
        <capsuleGeometry args=${[0.32, 0.7, 4, 8]} />
        <meshStandardMaterial color="#c2542f" />
      </mesh>
      <mesh position=${[0, 1.35, 0.05]} castShadow=${true}>
        <boxGeometry args=${[0.5, 0.7, 0.15]} />
        <meshStandardMaterial color="#7a4a2a" />
      </mesh>
      <!-- head -->
      <mesh position=${[0, 2.15, 0]} castShadow=${true}>
        <sphereGeometry args=${[0.26, 14, 14]} />
        <meshStandardMaterial color="#5a3a22" roughness=${0.7} />
      </mesh>
      <!-- braided hair with beads -->
      <mesh position=${[0.18, 2.0, -0.15]} castShadow=${true}>
        <cylinderGeometry args=${[0.04, 0.04, 0.5, 6]} />
        <meshStandardMaterial color="#1a1a1a" />
      </mesh>
      <mesh position=${[0.18, 1.7, -0.18]}>
        <sphereGeometry args=${[0.05, 8, 8]} />
        <meshStandardMaterial color="#e0a13c" />
      </mesh>
      <!-- feather behind ear -->
      <mesh position=${[-0.28, 2.25, -0.05]} rotation=${[0, 0, 0.5]}>
        <coneGeometry args=${[0.04, 0.32, 6]} />
        <meshStandardMaterial color="#e0453c" />
      </mesh>
      <!-- waving arm -->
      <group ref=${wave} position=${[0.38, 1.65, 0]}>
        <mesh position=${[0, -0.28, 0]} castShadow=${true}>
          <capsuleGeometry args=${[0.09, 0.5, 4, 6]} />
          <meshStandardMaterial color="#5a3a22" />
        </mesh>
      </group>
      <!-- other arm -->
      <mesh position=${[-0.38, 1.35, 0]} castShadow=${true}>
        <capsuleGeometry args=${[0.09, 0.5, 4, 6]} />
        <meshStandardMaterial color="#5a3a22" />
      </mesh>

      <!-- shop stall -->
      <group position=${[-1.4, 0, -0.4]}>
        <mesh position=${[0, 0.5, 0]} castShadow=${true} receiveShadow=${true}>
          <boxGeometry args=${[1.6, 1, 0.6]} />
          <meshStandardMaterial color="#8a5a2b" />
        </mesh>
        <mesh position=${[0, 1.4, 0]} rotation=${[0.35, 0, 0]} castShadow=${true}>
          <boxGeometry args=${[2, 0.1, 1]} />
          <meshStandardMaterial color="#caa45a" />
        </mesh>
        <mesh position=${[-0.9, 1.7, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.04, 0.04, 2, 6]} />
          <meshStandardMaterial color="#5a4632" />
        </mesh>
        <mesh position=${[0.9, 1.7, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.04, 0.04, 2, 6]} />
          <meshStandardMaterial color="#5a4632" />
        </mesh>
      </group>
    </group>
  `;
}

// A simple crafting workbench
export function Workbench() {
  useEffect(() => {
    return registerInteractable({
      id: 'workbench',
      position: WORKBENCH_POS,
      radius: 2.4,
      key: 'KeyR',
      label: 'Craft at Workbench',
      onInteract: () => useGame.getState().setActivePanel('crafting'),
    });
  }, []);

  return html`
    <group position=${WORKBENCH_POS}>
      <mesh position=${[0, 0.4, 0]} castShadow=${true} receiveShadow=${true}>
        <boxGeometry args=${[1.4, 0.1, 0.9]} />
        <meshStandardMaterial color="#8a5a2b" />
      </mesh>
      ${[[-0.6, -0.35], [0.6, -0.35], [-0.6, 0.35], [0.6, 0.35]].map(
        (p, i) => html`
        <mesh key=${i} position=${[p[0], 0.2, p[1]]} castShadow=${true}>
          <boxGeometry args=${[0.1, 0.4, 0.1]} />
          <meshStandardMaterial color="#6a4222" />
        </mesh>
      `
      )}
      <mesh position=${[0.2, 0.5, 0.1]} rotation=${[0, 0.3, 0]} castShadow=${true}>
        <boxGeometry args=${[0.08, 0.08, 0.6]} />
        <meshStandardMaterial color="#aaaaaa" metalness=${0.6} roughness=${0.4} />
      </mesh>
    </group>
  `;
}
