import { html, useEffect, useFrame, useRef } from './core.js';
import { HumanFigure, clothMat, hairMat, humanGeo, plainMat } from './humanbody.js';
import { registerInteractable } from './interactions.js';
import { useGame } from './store.js';
import { ContactShadow } from './tribes.js';
import { grainTiled } from './wind.js';

// ============================================================
// Kito.js - shop NPC and crafting workbench
// ============================================================
const KITO_POS = [-8, 0, 6];
const WORKBENCH_POS = [-4, 0, 9];

// Kito the shop trader - tall, warm, colorful, feather behind ear.
function Kito() {
  const wave = useRef();
  // Declared so HumanFigure renders legs; Kito stands still, so nothing drives them.
  const legL = useRef();
  const legR = useRef();

  useEffect(() => {
    return registerInteractable({
      id: 'kito',
      position: KITO_POS,
      radius: 3,
      action: 'interact',
      label: 'Talk to Kito',
      onInteract: () => useGame.getState().setActivePanel('shop'),
    });
  }, []);

  // His left arm is held up in greeting and waves. Positive rotation.z swings
  // that arm up and away from the body, so ~1.9rad is "hand above the shoulder".
  useFrame((state) => {
    if (wave.current) {
      wave.current.rotation.z = 1.9 + Math.sin(state.clock.elapsedTime * 3) * 0.3;
    }
  });

  return html`
    <group position=${KITO_POS}>
      <${ContactShadow} radius=${0.5} />
      <!-- Kito himself: the same anatomy as everyone else, a touch bigger, in a
           trader's red vest with braided hair and a feather. -->
      <group scale=${1.06}>
        <${HumanFigure}
          skinKey="skin"
          clothColor="#c2542f"
          accentColor="#e0a13c"
          hairColor="#160f09"
          armL=${wave}
          face=${-1}
          torsoWrap=${true}
          legL=${legL}
          legR=${legR}
        />
        <!-- braid hanging down his back, with a bead on the end -->
        <mesh geometry=${humanGeo('foreArm')} material=${hairMat('#160f09')}
          position=${[0.085, 1.74, -0.11]} rotation=${[-0.22, 0, 0.1]}
          scale=${[0.035, 0.42, 0.035]} castShadow=${true} />
        <mesh geometry=${humanGeo('ballLow')} material=${plainMat('bead', { color: '#e0a13c', roughness: 0.35, metalness: 0.3 })}
          position=${[0.095, 1.31, -0.145]} scale=${[0.032, 0.032, 0.032]} />
        <!-- feather tucked behind one ear -->
        <mesh geometry=${humanGeo('cone')} material=${clothMat('#e0453c')}
          position=${[-0.12, 1.80, -0.05]} rotation=${[-0.25, 0, 0.6]}
          scale=${[0.026, 0.30, 0.026]} castShadow=${true} />
      </group>

      <!-- shop stall -->
      <group position=${[-1.4, 0, -0.4]}>
        <mesh position=${[0, 0.5, 0]} castShadow=${true} receiveShadow=${true}>
          <boxGeometry args=${[1.6, 1, 0.6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#8a5a2b" />
        </mesh>
        <mesh position=${[0, 1.4, 0]} rotation=${[0.35, 0, 0]} castShadow=${true}>
          <boxGeometry args=${[2, 0.1, 1]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#caa45a" />
        </mesh>
        <mesh position=${[-0.9, 1.7, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.04, 0.04, 2, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#5a4632" />
        </mesh>
        <mesh position=${[0.9, 1.7, 0]} castShadow=${true}>
          <cylinderGeometry args=${[0.04, 0.04, 2, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#5a4632" />
        </mesh>
      </group>
    </group>
  `;
}

// A simple crafting workbench
function Workbench() {
  useEffect(() => {
    return registerInteractable({
      id: 'workbench',
      position: WORKBENCH_POS,
      radius: 2.4,
      action: 'craft',
      label: 'Craft at Workbench',
      onInteract: () => useGame.getState().setActivePanel('crafting'),
    });
  }, []);

  return html`
    <group position=${WORKBENCH_POS}>
      <mesh position=${[0, 0.4, 0]} castShadow=${true} receiveShadow=${true}>
        <boxGeometry args=${[1.4, 0.1, 0.9]} />
        <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#8a5a2b" />
      </mesh>
      ${[[-0.6, -0.35], [0.6, -0.35], [-0.6, 0.35], [0.6, 0.35]].map(
        (p, i) => html`
        <mesh key=${i} position=${[p[0], 0.2, p[1]]} castShadow=${true}>
          <boxGeometry args=${[0.1, 0.4, 0.1]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#6a4222" />
        </mesh>
      `
      )}
      <mesh position=${[0.2, 0.5, 0.1]} rotation=${[0, 0.3, 0]} castShadow=${true}>
        <boxGeometry args=${[0.08, 0.08, 0.6]} />
        <meshStandardMaterial ...${grainTiled('rock', [1.4, 1.4])} color="#aaaaaa" metalness=${0.6} roughness=${0.4} />
      </mesh>
    </group>
  `;
}


export {
  KITO_POS,
  WORKBENCH_POS,
  Kito,
  Workbench,
};
