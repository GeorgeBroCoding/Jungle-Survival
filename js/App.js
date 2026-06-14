import React, { Fragment } from 'react';
import { Canvas } from '@react-three/fiber';
import html from './html.js';
import { useGame } from './store.js';
import World from './World.js';
import Player from './Player.js';
import Resources from './Resources.js';
import Animals from './Animals.js';
import { Kito, Workbench } from './Kito.js';
import Hud from './Hud.js';
import StartScreen from './StartScreen.js';

export default function App() {
  const started = useGame((s) => s.started);

  if (!started) return html`<${StartScreen} />`;

  return html`
    <${Fragment}>
      <${Canvas} shadows=${true} camera=${{ fov: 70, near: 0.1, far: 500, position: [0, 2, 14] }}>
        <${World} />
        <${Player} />
        <${Resources} />
        <${Animals} />
        <${Kito} />
        <${Workbench} />
      <//>
      <${Hud} />
    <//>
  `;
}
