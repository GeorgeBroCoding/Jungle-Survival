import { Fragment, html, useFrame, useRef } from './core.js';
import { playerTransform } from './multiplayer.js';
import { useGame } from './store.js';

// Coins.js - currency that falls from the sky and is collected
// ============================================================
function CoinDrop({ id, position, value }) {
  const group = useRef();
  const landed = useRef(false);
  const collected = useRef(false);

  useFrame((_, rawDelta) => {
    if (collected.current || !group.current) return;
    const delta = Math.min(rawDelta, 0.1);
    const obj = group.current;
    obj.rotation.y += delta * 3;

    if (!landed.current) {
      obj.position.y -= delta * 9;
      if (obj.position.y <= 0.6) {
        obj.position.y = 0.6;
        landed.current = true;
      }
      return;
    }

    const [px, , pz] = playerTransform.position;
    const dist = Math.hypot(obj.position.x - px, obj.position.z - pz);
    if (dist < 1.6) {
      collected.current = true;
      useGame.getState().collectCoinDrop(id, value);
    }
  });

  return html`
    <group ref=${group} position=${[position[0], 30, position[2]]}>
      <mesh rotation=${[Math.PI / 2, 0, 0]} castShadow=${true}>
        <cylinderGeometry args=${[0.4, 0.4, 0.08, 16]} />
        <meshStandardMaterial color="#ffd34d" metalness=${0.6} roughness=${0.3} emissive="#7a5a00" emissiveIntensity=${0.4} />
      </mesh>
    </group>
  `;
}

function CoinDrops() {
  const coinDrops = useGame((s) => s.coinDrops);
  return html`
    <${Fragment}>
      ${coinDrops.map((c) => html`<${CoinDrop} key=${c.id} id=${c.id} position=${c.position} value=${c.value} />`)}
    <//>
  `;
}

// Periodically spawns a coin that falls from the sky somewhere near the player
function CoinDropManager() {
  const timer = useRef(8 + Math.random() * 10);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    timer.current -= delta;
    if (timer.current <= 0) {
      useGame.getState().spawnCoinDrop();
      timer.current = 20 + Math.random() * 25;
    }
  });
  return null;
}

// ============================================================

export {
  CoinDrop,
  CoinDrops,
  CoinDropManager,
};
