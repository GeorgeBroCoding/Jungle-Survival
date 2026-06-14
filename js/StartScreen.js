import React from 'react';
import html from './html.js';
import { useGame } from './store.js';

export default function StartScreen() {
  const start = useGame((s) => s.start);

  return html`
    <div class="start-screen">
      <h1>JUNGLE KING</h1>
      <p>
        Survive a vast procedural jungle. Gather wood, fiber and stone, craft tools at the workbench,
        trade with Kito using the meters you travel, and watch out for wild boars and curious monkeys
        as day turns to night.
      </p>
      <button onClick=${() => { start(); }}>Begin Survival</button>
      <div class="controls-list">
        WASD move &middot; Mouse look (click to lock) &middot; Space jump &middot; Shift sprint (drains energy)
        &middot; Ctrl crouch &middot; F gather / drink &middot; E talk to Kito / shop &middot; R craft at workbench
        &middot; Tab inventory &middot; Q cycle hotbar &middot; C toggle camera &middot; Scroll zoom &middot; Esc close menus
      </div>
    </div>
  `;
}
