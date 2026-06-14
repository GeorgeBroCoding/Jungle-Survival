import React, { useState } from 'react';
import html from './html.js';
import { useGame } from './store.js';
import { SHOP_ITEMS, CRAFTING_RECIPES, RESOURCES, KITO_LINES } from './data.js';

const KEY_LABELS = {
  KeyE: 'E',
  KeyF: 'F',
  KeyR: 'R',
};

function formatTime(t) {
  const h = Math.floor(t);
  const m = Math.floor((t % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function StatBar({ icon, value, cls }) {
  return html`
    <div class="stat-bar">
      <div class="icon">${icon}</div>
      <div class="bar-track">
        <div class="bar-fill ${cls}" style=${{ width: `${Math.max(0, value)}%` }}></div>
      </div>
    </div>
  `;
}

function InventoryPanel() {
  const inventory = useGame((s) => s.inventory);
  const setActivePanel = useGame((s) => s.setActivePanel);
  const entries = Object.entries(inventory);

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Inventory</h2>
        ${entries.length === 0 && html`<p>Empty. Gather resources with F or buy from Kito.</p>`}
        ${entries.map(([id, qty]) => {
          const resource = RESOURCES[id];
          const recipe = CRAFTING_RECIPES.find((r) => r.id === id);
          const shopItem = SHOP_ITEMS.find((i) => i.id === id);
          const name = resource?.name || recipe?.name || shopItem?.name || id;
          return html`
            <div class="inv-item" key=${id}>
              <span class="name">${name}</span>
              <span>x${qty}</span>
            </div>
          `;
        })}
        <p class="close-hint">Tab or Esc to close</p>
      </div>
    </div>
  `;
}

function ShopPanel() {
  const meters = useGame((s) => s.meters);
  const setActivePanel = useGame((s) => s.setActivePanel);
  const buyItem = useGame((s) => s.buyItem);
  const [line] = useState(() => {
    const pool = meters > 1000 ? KITO_LINES.richReaction : meters < 100 ? KITO_LINES.poorReaction : KITO_LINES.greeting;
    return pool[Math.floor(Math.random() * pool.length)];
  });

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Kito's Shop</h2>
        <p class="npc-name">"${line}"</p>
        <p style=${{ marginBottom: '10px' }}>Your meters: <strong style=${{ color: '#ffe27a' }}>${Math.floor(meters)}</strong></p>
        ${SHOP_ITEMS.map((item) => html`
          <div class="shop-item" key=${item.id}>
            <div>
              <div class="name">${item.name}</div>
              <div class="desc">${item.desc}</div>
            </div>
            <div style=${{ textAlign: 'right' }}>
              <div class="price">${item.price}m</div>
              <button class="buy-btn" disabled=${meters < item.price} onClick=${() => buyItem(item.id)}>Buy</button>
            </div>
          </div>
        `)}
        <p class="close-hint">E, Tab or Esc to close</p>
      </div>
    </div>
  `;
}

function CraftingPanel() {
  const inventory = useGame((s) => s.inventory);
  const craft = useGame((s) => s.craft);
  const hasItems = useGame((s) => s.hasItems);
  const setActivePanel = useGame((s) => s.setActivePanel);

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Workbench</h2>
        ${CRAFTING_RECIPES.map((recipe) => {
          const costStr = Object.entries(recipe.cost)
            .map(([k, v]) => `${RESOURCES[k]?.name || k} x${v} (have ${inventory[k] || 0})`)
            .join(', ');
          return html`
            <div class="craft-item" key=${recipe.id}>
              <div>
                <div class="name">${recipe.name}</div>
                <div class="desc">${recipe.desc}</div>
                <div class="desc">${costStr}</div>
              </div>
              <button class="craft-btn" disabled=${!hasItems(recipe.cost)} onClick=${() => craft(recipe.id)}>Craft</button>
            </div>
          `;
        })}
        <p class="close-hint">R, Tab or Esc to close</p>
      </div>
    </div>
  `;
}

export default function Hud() {
  const meters = useGame((s) => s.meters);
  const stats = useGame((s) => s.stats);
  const timeOfDay = useGame((s) => s.timeOfDay);
  const nearInteractable = useGame((s) => s.nearInteractable);
  const activePanel = useGame((s) => s.activePanel);
  const toasts = useGame((s) => s.toasts);
  const hotbarSlots = useGame((s) => s.hotbarSlots);
  const activeHotbarSlot = useGame((s) => s.activeHotbarSlot);
  const inventory = useGame((s) => s.inventory);

  return html`
    <div id="hud">
      <div class="meters-counter">
        <span class="label">METERS TRAVELED</span>
        ${Math.floor(meters)} m
      </div>
      <div class="day-clock">🕐 ${formatTime(timeOfDay)}</div>

      <div class="stats-panel">
        <${StatBar} icon="❤️" value=${stats.health} cls="health" />
        <${StatBar} icon="🍖" value=${stats.hunger} cls="hunger" />
        <${StatBar} icon="💧" value=${stats.thirst} cls="thirst" />
        <${StatBar} icon="⚡" value=${stats.energy} cls="energy" />
        <${StatBar} icon="🔥" value=${stats.warmth} cls="warmth" />
        <${StatBar} icon="🧠" value=${stats.sanity} cls="sanity" />
      </div>

      ${!activePanel && html`<div class="crosshair"></div>`}

      ${nearInteractable && !activePanel && html`
        <div class="interact-prompt">Press ${KEY_LABELS[nearInteractable.key] || nearInteractable.key} to ${nearInteractable.label}</div>
      `}

      <div class="hotbar">
        ${hotbarSlots.map((id, i) => html`
          <div class="slot ${i === activeHotbarSlot ? 'active' : ''}" key=${id + i}>
            ${RESOURCES[id]?.name?.[0] || CRAFTING_RECIPES.find((r) => r.id === id)?.name?.[0] || '?'}
            <span class="count">${inventory[id] || 0}</span>
          </div>
        `)}
      </div>

      <div class="toasts">
        ${toasts.map((t) => html`<div class="toast" key=${t.id}>${t.msg}</div>`)}
      </div>

      ${activePanel === 'inventory' && html`<${InventoryPanel} />`}
      ${activePanel === 'shop' && html`<${ShopPanel} />`}
      ${activePanel === 'crafting' && html`<${CraftingPanel} />`}
    </div>
  `;
}
