import React, { Fragment, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import html from './html.js';
import { useGame } from './store.js';
import { createGrassTexture, createBarkTexture, createWaterTexture } from './textures.js';
import { mulberry32 } from './data.js';

const DAY_LENGTH_SECONDS = 600; // full 24h cycle takes 10 real minutes

const SKY_KEYFRAMES = [
  { t: 0,  color: new THREE.Color('#0a0e2a') },  // midnight
  { t: 5,  color: new THREE.Color('#16213b') },  // pre-dawn
  { t: 6,  color: new THREE.Color('#f6a35c') },  // dawn
  { t: 8,  color: new THREE.Color('#8ec9f0') },  // morning
  { t: 12, color: new THREE.Color('#6fb8ee') },  // noon
  { t: 17, color: new THREE.Color('#f0a35c') },  // afternoon glow
  { t: 19, color: new THREE.Color('#c1546b') },  // sunset
  { t: 21, color: new THREE.Color('#1c1740') },  // dusk
  { t: 24, color: new THREE.Color('#0a0e2a') },  // midnight wrap
];

function getSkyColor(t) {
  for (let i = 0; i < SKY_KEYFRAMES.length - 1; i++) {
    const a = SKY_KEYFRAMES[i];
    const b = SKY_KEYFRAMES[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return a.color.clone().lerp(b.color, f);
    }
  }
  return SKY_KEYFRAMES[0].color.clone();
}

function getSunIntensity(t) {
  // Highest at noon, near-zero at night
  const angle = ((t - 6) / 24) * Math.PI * 2;
  const h = Math.sin(angle);
  return Math.max(0.05, h) * 1.4;
}

// ---------- Sky / Lighting / day-night cycle ----------
export function DayNightSystem() {
  const { scene } = useThree();
  const sunRef = useRef();
  const clockAccum = useRef(0);
  const localTime = useRef(8); // hours

  useFrame((_, delta) => {
    clockAccum.current += delta;
    localTime.current = (8 + (clockAccum.current / DAY_LENGTH_SECONDS) * 24) % 24;
    const t = localTime.current;

    const sky = getSkyColor(t);
    scene.background = sky;
    if (scene.fog) scene.fog.color = sky;

    const angle = ((t - 6) / 24) * Math.PI * 2;
    const sunDist = 150;
    const sunY = Math.sin(angle) * sunDist;
    const sunX = Math.cos(angle) * sunDist;
    if (sunRef.current) {
      sunRef.current.position.set(sunX, Math.max(sunY, -20), 40);
      sunRef.current.intensity = getSunIntensity(t);
      const warmth = Math.max(0, 1 - Math.abs(t - 6) / 4) + Math.max(0, 1 - Math.abs(t - 18) / 4);
      sunRef.current.color.set(warmth > 0.3 ? '#ffb37a' : '#ffffff');
    }

    // push time of day to store roughly once per second
    if (Math.floor(clockAccum.current * 4) !== Math.floor((clockAccum.current - delta) * 4)) {
      useGame.getState().setTimeOfDay(t);
    }
  });

  return html`
    <${Fragment}>
      <directionalLight ref=${sunRef} position=${[50, 80, 40]} intensity=${1} castShadow
        shadow-mapSize-width=${2048} shadow-mapSize-height=${2048}
        shadow-camera-far=${300} shadow-camera-left=${-120} shadow-camera-right=${120}
        shadow-camera-top=${120} shadow-camera-bottom=${-120} />
      <ambientLight intensity=${0.35} color="#bcd4ff" />
      <hemisphereLight args=${['#bcd4ff', '#3a5a30', 0.5]} />
    <//>
  `;
}

// ---------- Ground ----------
function Ground() {
  const tex = useMemo(() => createGrassTexture(), []);
  return html`
    <mesh rotation=${[-Math.PI / 2, 0, 0]} receiveShadow=${true}>
      <circleGeometry args=${[300, 64]} />
      <meshStandardMaterial map=${tex} roughness=${1} />
    </mesh>
  `;
}

// ---------- Water (pond) ----------
function Water() {
  const tex = useMemo(() => createWaterTexture(), []);
  const ref = useRef();
  useFrame((_, delta) => {
    tex.offset.x += delta * 0.02;
    tex.offset.y += delta * 0.01;
  });
  return html`
    <mesh ref=${ref} position=${[40, 0.05, -40]} rotation=${[-Math.PI / 2, 0, 0]} receiveShadow=${true}>
      <circleGeometry args=${[18, 48]} />
      <meshStandardMaterial map=${tex} transparent=${true} opacity=${0.85} roughness=${0.2} metalness=${0.1} />
    </mesh>
  `;
}

// ---------- Procedural Tree ----------
function Tree({ position, scale = 1 }) {
  const barkTex = useTreeBark();
  return html`
    <group position=${position} scale=${scale}>
      <mesh position=${[0, 1.5, 0]} castShadow=${true}>
        <cylinderGeometry args=${[0.18, 0.28, 3, 6]} />
        <meshStandardMaterial map=${barkTex} roughness=${0.9} />
      </mesh>
      <mesh position=${[0, 3.4, 0]} castShadow=${true}>
        <coneGeometry args=${[1.6, 2.2, 7]} />
        <meshStandardMaterial color="#2f7a37" roughness=${0.85} />
      </mesh>
      <mesh position=${[0, 4.6, 0]} castShadow=${true}>
        <coneGeometry args=${[1.1, 1.6, 7]} />
        <meshStandardMaterial color="#3a8f43" roughness=${0.85} />
      </mesh>
      <mesh position=${[0, 5.6, 0]} castShadow=${true}>
        <coneGeometry args=${[0.6, 1.2, 7]} />
        <meshStandardMaterial color="#4aa852" roughness=${0.85} />
      </mesh>
    </group>
  `;
}

let _barkTex = null;
function useTreeBark() {
  return useMemo(() => {
    if (!_barkTex) _barkTex = createBarkTexture();
    return _barkTex;
  }, []);
}

// ---------- Procedural Rock ----------
function Rock({ position, scale = 1 }) {
  return html`
    <mesh position=${position} scale=${scale} castShadow=${true} receiveShadow=${true}>
      <dodecahedronGeometry args=${[0.6, 0]} />
      <meshStandardMaterial color="#8a8a8a" roughness=${1} flatShading=${true} />
    </mesh>
  `;
}

// ---------- Procedural Bush ----------
function Bush({ position, scale = 1 }) {
  return html`
    <group position=${position} scale=${scale}>
      <mesh position=${[0, 0.35, 0]} castShadow=${true}>
        <icosahedronGeometry args=${[0.5, 0]} />
        <meshStandardMaterial color="#3f8f3f" flatShading=${true} roughness=${0.9} />
      </mesh>
      <mesh position=${[0.3, 0.5, 0.1]} castShadow=${true}>
        <icosahedronGeometry args=${[0.32, 0]} />
        <meshStandardMaterial color="#4aa852" flatShading=${true} roughness=${0.9} />
      </mesh>
    </group>
  `;
}

// ---------- Decorative scattered foliage (non-interactable, purely visual) ----------
function DecorativeFoliage() {
  const items = useMemo(() => {
    const rand = mulberry32(99);
    const trees = [];
    const bushes = [];
    for (let i = 0; i < 70; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 12 + rand() * 130;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      // keep clearing near spawn (0,0) and the pond (40,-40) clear-ish
      if (Math.hypot(x, z) < 10) continue;
      if (Math.hypot(x - 40, z + 40) < 14) continue;
      trees.push({ position: [x, 0, z], scale: 0.8 + rand() * 0.8 });
    }
    for (let i = 0; i < 40; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 8 + rand() * 120;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (Math.hypot(x, z) < 8) continue;
      bushes.push({ position: [x, 0, z], scale: 0.7 + rand() * 0.6 });
    }
    return { trees, bushes };
  }, []);

  return html`
    <${Fragment}>
      ${items.trees.map((t, i) => html`<${Tree} key=${'dt' + i} position=${t.position} scale=${t.scale} />`)}
      ${items.bushes.map((b, i) => html`<${Bush} key=${'db' + i} position=${b.position} scale=${b.scale} />`)}
    <//>
  `;
}

export { Tree, Rock, Bush };

export default function World() {
  return html`
    <${Fragment}>
      <${DayNightSystem} />
      <fog attach="fog" args=${['#8ec9f0', 30, 220]} />
      <${Ground} />
      <${Water} />
      <${DecorativeFoliage} />
    <//>
  `;
}
