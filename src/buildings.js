import { Fragment, html } from './core.js';
import { useGame } from './store.js';
import { grainTiled } from './wind.js';

// Buildings.js - player-placed structures
// ============================================================
function Building({ building }) {
  const { type, position, rotation } = building;

  if (type === 'house') {
    return html`
      <group position=${position} rotation=${[0, rotation, 0]}>
        <mesh position=${[0, 0.6, 0]} castShadow=${true} receiveShadow=${true}>
          <boxGeometry args=${[2, 1.2, 2]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#caa45a" roughness=${0.85} />
        </mesh>
        <mesh position=${[0, 1.5, 0]} castShadow=${true}>
          <coneGeometry args=${[1.6, 1.2, 4]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#8a5a2b" roughness=${0.9} />
        </mesh>
      </group>
    `;
  }

  if (type === 'lookout') {
    return html`
      <group position=${position} rotation=${[0, rotation, 0]}>
        <mesh position=${[0, 2, 0]} castShadow=${true} receiveShadow=${true}>
          <cylinderGeometry args=${[0.3, 0.4, 4, 6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#8a5a2b" roughness=${0.9} />
        </mesh>
        <mesh position=${[0, 4.1, 0]} castShadow=${true} receiveShadow=${true}>
          <boxGeometry args=${[1.6, 0.2, 1.6]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#6a4222" roughness=${0.9} />
        </mesh>
        <mesh position=${[0, 4.7, 0]} castShadow=${true}>
          <coneGeometry args=${[1.2, 1, 4]} />
          <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#caa45a" />
        </mesh>
      </group>
    `;
  }

  if (type === 'wall') {
    return html`
      <mesh position=${position} rotation=${[0, rotation, 0]} castShadow=${true} receiveShadow=${true}>
        <boxGeometry args=${[3, 1.4, 0.3]} />
        <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#7a5a3a" roughness=${0.9} />
      </mesh>
    `;
  }

  // storage hut
  return html`
    <mesh position=${[position[0], 0.4, position[2]]} rotation=${[0, rotation, 0]} castShadow=${true} receiveShadow=${true}>
      <boxGeometry args=${[1, 0.8, 1]} />
      <meshStandardMaterial ...${grainTiled('bark', [1.6, 1.6])} color="#6a4222" roughness=${0.9} />
    </mesh>
  `;
}

function Buildings() {
  const buildings = useGame((s) => s.buildings);
  return html`
    <${Fragment}>
      ${buildings.map((b) => html`<${Building} key=${b.id} building=${b} />`)}
    <//>
  `;
}

// ============================================================

export {
  Building,
  Buildings,
};
