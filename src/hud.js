import { Fragment, html, useEffect, useState } from './core.js';
import { BUILDING_TYPES, CRAFTING_RECIPES, ENEMY_TRIBES, KITO_LINES, PLAYER_TRIBE_COLOR, RESOURCES, SHOP_ITEMS, USABLE_ITEMS, WARRIOR_BASE_COST, WARRIOR_COST_STEP, WEAPONS } from './data.js';
import { perfStats } from './graphics.js';
import { bind, keyLabel } from './keybinds.js';
import { Kito, Workbench } from './kito.js';
import { mpDisconnect, mpHost, mpJoin } from './multiplayer.js';
import { useGame } from './store.js';

// Hud.js - DOM overlay (stats, hotbar, panels, toasts)
// ============================================================
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

// Groups an inventory item id into a section for the inventory panel.
function getItemCategory(id) {
  const resource = RESOURCES[id];
  if (resource) return resource.category === 'food' ? 'Food' : 'Materials';
  if (WEAPONS[id]) return 'Weapons & Tools';
  return 'Other Loot';
}

function InventoryPanel() {
  const inventory = useGame((s) => s.inventory);
  const keybinds = useGame((s) => s.keybinds);
  const setActivePanel = useGame((s) => s.setActivePanel);
  const useItem = useGame((s) => s.useItem);
  const entries = Object.entries(inventory);

  const sections = ['Food', 'Materials', 'Weapons & Tools', 'Other Loot'];
  const grouped = Object.fromEntries(sections.map((sec) => [sec, []]));
  for (const entry of entries) grouped[getItemCategory(entry[0])].push(entry);

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Inventory</h2>
        ${entries.length === 0 && html`<p>Empty. Use ${keyLabel(keybinds.gather)} near trees (Axe for wood, Machete for leaves), rocks (Pickaxe), cave ore (Pickaxe), or bush/fiber. Hunt animals or scavenge loot with ${keyLabel(keybinds.interact)}.</p>`}
        ${sections.map((sec) => grouped[sec].length === 0 ? null : html`
          <${Fragment} key=${sec}>
            <h3 class="inv-section">${sec}</h3>
            ${grouped[sec].map(([id, qty]) => {
              const resource = RESOURCES[id];
              const recipe = CRAFTING_RECIPES.find((r) => r.id === id);
              const shopItem = SHOP_ITEMS.find((i) => i.id === id);
              const weapon = WEAPONS[id];
              const name = resource?.name || recipe?.name || shopItem?.name || weapon?.name || id;
              const usable = USABLE_ITEMS[id];
              return html`
                <div class="inv-item" key=${id}>
                  <span class="name">${name}</span>
                  <span>x${qty}</span>
                  ${usable && html`
                    <button class="buy-btn" onClick=${() => useItem(id)}>${usable.label}</button>
                  `}
                </div>
              `;
            })}
          <//>
        `)}
        <p class="close-hint">${keyLabel(keybinds.inventory)} or Esc to close</p>
      </div>
    </div>
  `;
}

function ShopPanel() {
  const keybinds = useGame((s) => s.keybinds);
  const meters = useGame((s) => s.meters);
  const coins = useGame((s) => s.coins);
  const warriors = useGame((s) => s.warriors);
  const warriorsRecruited = useGame((s) => s.warriorsRecruited);
  const recruitWarrior = useGame((s) => s.recruitWarrior);
  const setActivePanel = useGame((s) => s.setActivePanel);
  const buyItem = useGame((s) => s.buyItem);
  const [line] = useState(() => {
    const pool = meters > 1000 ? KITO_LINES.richReaction : meters < 100 ? KITO_LINES.poorReaction : KITO_LINES.greeting;
    return pool[Math.floor(Math.random() * pool.length)];
  });
  const recruitCost = WARRIOR_BASE_COST + warriorsRecruited * WARRIOR_COST_STEP;

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Kito's Shop</h2>
        <p class="npc-name">"${line}"</p>
        <p style=${{ marginBottom: '10px' }}>
          Your meters: <strong style=${{ color: '#ffe27a' }}>${Math.floor(meters)}</strong>
           · 
          Your coins: <strong style=${{ color: '#ffd34d' }}>${coins}</strong>
        </p>
        <div class="shop-item">
          <div>
            <div class="name">Recruit Tribal Warrior</div>
            <div class="desc">Strengthens your tribe against rival raids. Currently: ${warriors} warriors.</div>
          </div>
          <div style=${{ textAlign: 'right' }}>
            <div class="price">${recruitCost}c</div>
            <button class="buy-btn" disabled=${coins < recruitCost} onClick=${() => recruitWarrior()}>Recruit</button>
          </div>
        </div>
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
        <p class="close-hint">${keyLabel(keybinds.interact)}, ${keyLabel(keybinds.inventory)} or Esc to close</p>
      </div>
    </div>
  `;
}

function TribePanel() {
  const keybinds = useGame((s) => s.keybinds);
  const warriors = useGame((s) => s.warriors);
  const escortWarriors = useGame((s) => s.escortWarriors);
  const setEscortWarriors = useGame((s) => s.setEscortWarriors);
  const activeTribeIds = useGame((s) => s.activeTribeIds);
  const capturedTribes = useGame((s) => s.capturedTribes);
  const garrisonHP = useGame((s) => s.garrisonHP);
  const setActivePanel = useGame((s) => s.setActivePanel);

  const defeatedCount = Object.values(capturedTribes).filter(Boolean).length;
  const guardCount = warriors - escortWarriors;
  const myTeams = ENEMY_TRIBES.filter((t) => capturedTribes[t.id]);

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Your Tribe</h2>
        <p class="desc">
          <span style=${{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: PLAYER_TRIBE_COLOR, marginRight: '4px', verticalAlign: 'middle' }}></span>
          Home camp (yellow) + ${defeatedCount} conquered team${defeatedCount === 1 ? '' : 's'}.
          ${activeTribeIds.length < ENEMY_TRIBES.length ? ' More rival tribes will arrive.' : ''}
        </p>
        ${myTeams.length > 0 ? html`
          <div class="shop-item" style=${{ flexDirection: 'column', gap: '4px' }}>
            <div class="name">Your Teams</div>
            ${myTeams.map((t) => html`
              <div key=${t.id} style=${{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <span style=${{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', background: t.color, flexShrink: 0, border: '1px solid #fff4' }}></span>
                <span>${t.name}</span>
                <span style=${{ color: '#aaa', marginLeft: 'auto' }}>Garrison ${garrisonHP[t.id] ?? 0}/100 HP</span>
              </div>
            `)}
          </div>
        ` : null}
        <div class="shop-item">
          <div>
            <div class="name">Warriors with you</div>
            <div class="desc">
              Chosen warriors follow you and fight rivals and raiders.
              The rest (${guardCount}) guard your home camp.
            </div>
          </div>
          <div class="stepper">
            <button class="buy-btn" disabled=${escortWarriors <= 0} onClick=${() => setEscortWarriors(escortWarriors - 1)}>-</button>
            <strong>${escortWarriors} / ${warriors}</strong>
            <button class="buy-btn" disabled=${escortWarriors >= warriors} onClick=${() => setEscortWarriors(escortWarriors + 1)}>+</button>
          </div>
        </div>
        <p class="close-hint">${keyLabel(keybinds.interact)}, ${keyLabel(keybinds.inventory)} or Esc to close</p>
      </div>
    </div>
  `;
}

function CraftingPanel() {
  const keybinds = useGame((s) => s.keybinds);
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
        <p class="close-hint">${keyLabel(keybinds.craft)}, ${keyLabel(keybinds.inventory)} or Esc to close</p>
      </div>
    </div>
  `;
}

function BuildPanel() {
  const keybinds = useGame((s) => s.keybinds);
  const inventory = useGame((s) => s.inventory);
  const hasItems = useGame((s) => s.hasItems);
  const placeBuilding = useGame((s) => s.placeBuilding);
  const setActivePanel = useGame((s) => s.setActivePanel);

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Build</h2>
        <p class="npc-name">Places the structure just ahead of you.</p>
        ${BUILDING_TYPES.map((b) => {
          const costStr = Object.entries(b.cost)
            .map(([k, v]) => `${RESOURCES[k]?.name || k} x${v} (have ${inventory[k] || 0})`)
            .join(', ');
          return html`
            <div class="craft-item" key=${b.id}>
              <div>
                <div class="name">${b.name}</div>
                <div class="desc">${b.desc}</div>
                <div class="desc">${costStr}</div>
              </div>
              <button class="craft-btn" disabled=${!hasItems(b.cost)} onClick=${() => placeBuilding(b.id)}>Build</button>
            </div>
          `;
        })}
        <p class="close-hint">${keyLabel(keybinds.build)}, ${keyLabel(keybinds.inventory)} or Esc to close</p>
      </div>
    </div>
  `;
}

// ============================================================
// MultiplayerPanel.js - peer-to-peer connect screen
// ============================================================
function MultiplayerPanel() {
  const setActivePanel = useGame((s) => s.setActivePanel);
  const mpStatus = useGame((s) => s.mpStatus);
  const mpCode = useGame((s) => s.mpCode);
  const mpError = useGame((s) => s.mpError);
  const [joinCode, setJoinCode] = useState('');

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Multiplayer</h2>
        ${mpStatus === 'offline' && html`
          <p class="desc">Play together over the internet - no accounts needed. One of you hosts and shares a 4-letter code, the other joins with it.</p>
          <div class="craft-item">
            <div>
              <div class="name">Host a game</div>
              <div class="desc">Creates a code for your brother to join.</div>
            </div>
            <button class="craft-btn" onClick=${() => mpHost()}>Host</button>
          </div>
          <div class="craft-item">
            <div>
              <div class="name">Join a game</div>
              <div class="desc">Enter the code your brother gives you.</div>
              <input
                class="mp-code-input"
                value=${joinCode}
                maxLength=${4}
                placeholder="CODE"
                onChange=${(e) => setJoinCode(e.target.value.toUpperCase())}
              />
            </div>
            <button class="craft-btn" disabled=${joinCode.trim().length !== 4} onClick=${() => mpJoin(joinCode)}>Join</button>
          </div>
          ${mpError && html`<p class="desc mp-error">${mpError}</p>`}
        `}
        ${mpStatus === 'hosting' && html`
          <p class="desc">Share this code with your brother:</p>
          <div class="mp-code-display">${mpCode}</div>
          <p class="desc">Waiting for them to join...</p>
          <button class="craft-btn" onClick=${() => mpDisconnect()}>Cancel</button>
        `}
        ${mpStatus === 'connecting' && html`
          <p class="desc">Connecting...</p>
          <button class="craft-btn" onClick=${() => mpDisconnect()}>Cancel</button>
        `}
        ${mpStatus === 'connected' && html`
          <p class="desc">Connected! You can see and fight alongside each other in the jungle, and rival tribe camps are now shared between you.</p>
          <button class="craft-btn" onClick=${() => mpDisconnect()}>Disconnect</button>
        `}
        <p class="close-hint">${keyLabel(bind('inventory'))} or Esc to close</p>
      </div>
    </div>
  `;
}

// ============================================================
// DeathScreen.js - shown when health hits zero
// ============================================================
function DeathScreen() {
  const respawn = useGame((s) => s.respawn);
  const deathCause = useGame((s) => s.deathCause);
  const meters = useGame((s) => s.meters);
  const coins = useGame((s) => s.coins);
  const warriors = useGame((s) => s.warriors);

  return html`
    <div class="death-screen">
      <div class="death-inner">
        <h1>You Died!</h1>
        <p class="death-cause">${deathCause || 'The jungle got you.'}</p>
        <div class="death-tally">
          <div><strong>${Math.floor(meters)}</strong>meters walked</div>
          <div><strong>${coins}</strong>coins</div>
          <div><strong>${warriors}</strong>warriors</div>
        </div>
        <button class="death-btn" onClick=${() => respawn()}>Respawn</button>
        <p class="death-hint">
          You wake up at your camp with full health. Your gear, your meters and your
          tribe all survive — the jungle only takes your time.
        </p>
      </div>
    </div>
  `;
}

// ============================================================


// ---------- Frame-rate readout (Settings -> Graphics -> Show frame rate) ----------
function StatsOverlay() {
  const showStats = useGame((s) => s.showStats);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!showStats) return undefined;
    const timer = setInterval(() => bump((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [showStats]);
  if (!showStats) return null;
  return html`
    <div class="perf-stats">
      <span>${perfStats.fps.toFixed(0)} fps</span>
      <span>${perfStats.ms.toFixed(1)} ms</span>
      <span>${perfStats.draws} draws</span>
      <span>${(perfStats.tris / 1000).toFixed(0)}k tris</span>
    </div>
  `;
}

export {
  formatTime,
  StatBar,
  getItemCategory,
  InventoryPanel,
  ShopPanel,
  TribePanel,
  CraftingPanel,
  BuildPanel,
  MultiplayerPanel,
  DeathScreen,
  StatsOverlay,
};
