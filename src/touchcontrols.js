import { html, useEffect, useRef, useState } from './core.js';
import { CRAFTING_RECIPES, ENEMY_TRIBES, RESOURCES, SHOP_ITEMS, WEAPONS } from './data.js';
import { BuildPanel, CraftingPanel, DeathScreen, InventoryPanel, MultiplayerPanel, ShopPanel, StatBar, StatsOverlay, TribePanel, formatTime } from './hud.js';
import { bind, keyLabel, simulateAction } from './keybinds.js';
import { keys } from './keyboard.js';
import { MapPanel, Minimap } from './map.js';
import { mpSend } from './multiplayer.js';
import { SettingsPanel } from './settings.js';
import { useGame } from './store.js';
import { isTouchDevice, touchInput } from './touch.js';
import { Raiders } from './tribes.js';

// TouchControls.js - on-screen joystick + action buttons for tablets/phones
// ============================================================
function TouchJoystick() {
  const baseRef = useRef(null);
  const thumbRef = useRef(null);
  const touchId = useRef(null);

  useEffect(() => {
    const base = baseRef.current;
    const thumb = thumbRef.current;
    const radius = 50;

    const setThumb = (dx, dy) => {
      thumb.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const onStart = (e) => {
      if (touchId.current !== null) return;
      const t = e.changedTouches[0];
      touchId.current = t.identifier;
      e.preventDefault();
    };
    const update = (t) => {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = t.clientX - cx;
      let dy = t.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx = (dx / len) * radius;
        dy = (dy / len) * radius;
      }
      setThumb(dx, dy);
      touchInput.moveX = dx / radius;
      touchInput.moveZ = dy / radius;
    };
    const onMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === touchId.current) {
          update(t);
          e.preventDefault();
        }
      }
    };
    const onEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === touchId.current) {
          touchId.current = null;
          touchInput.moveX = 0;
          touchInput.moveZ = 0;
          setThumb(0, 0);
        }
      }
    };

    base.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      base.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      touchInput.moveX = 0;
      touchInput.moveZ = 0;
    };
  }, []);

  return html`
    <div class="touch-joystick" ref=${baseRef}>
      <div class="touch-joystick-thumb" ref=${thumbRef}></div>
    </div>
  `;
}

// A button that holds down the key an action is bound to (jump/sprint/crouch).
// The code is captured on press so a rebind mid-hold can't leave a key stuck.
function TouchHoldButton({ label, action, cls = '' }) {
  const held = useRef(null);
  const onStart = (e) => { e.preventDefault(); held.current = bind(action); if (held.current) keys[held.current] = true; };
  const onEnd = (e) => { e.preventDefault(); if (held.current) keys[held.current] = false; held.current = null; };
  return html`
    <div
      class="touch-btn ${cls}"
      onTouchStart=${onStart}
      onTouchEnd=${onEnd}
      onTouchCancel=${onEnd}
    >${label}</div>
  `;
}

// A button that fires a one-shot action on tap (interact/inventory/camera/etc).
function TouchTapButton({ label, onTap, cls = '' }) {
  const onStart = (e) => { e.preventDefault(); onTap(); };
  return html`
    <div class="touch-btn ${cls}" onTouchStart=${onStart}>${label}</div>
  `;
}

function TouchControls() {
  const nearInteractable = useGame((s) => s.nearInteractable);
  const keybinds = useGame((s) => s.keybinds);
  const interactLabel = keyLabel(keybinds[nearInteractable ? nearInteractable.action : 'interact']);

  return html`
    <div class="touch-controls">
      <${TouchJoystick} />
      <div class="touch-actions">
        <div class="touch-row">
          <${TouchTapButton} label="🎒" cls="touch-btn-sm" onTap=${() => simulateAction('inventory')} />
          <${TouchTapButton} label="📷" cls="touch-btn-sm" onTap=${() => simulateAction('camera')} />
          <${TouchTapButton} label="🔁" cls="touch-btn-sm" onTap=${() => simulateAction('cycleHotbar')} />
          <${TouchTapButton} label="🔨" cls="touch-btn-sm" onTap=${() => simulateAction('build')} />
          <${TouchTapButton} label="🗺️" cls="touch-btn-sm" onTap=${() => simulateAction('map')} />
          <${TouchTapButton} label="💬" cls="touch-btn-sm" onTap=${() => useGame.getState().setChatOpen(true)} />
        </div>
        <div class="touch-row">
          <${TouchHoldButton} label="🐾" action="crouch" cls="touch-btn-sm" />
          <${TouchHoldButton} label="💨" action="sprint" cls="touch-btn-sm" />
          <${TouchHoldButton} label="⬆️" action="jump" cls="touch-btn-sm" />
        </div>
        <div class="touch-row touch-row-main">
          <${TouchTapButton} label=${interactLabel} cls="touch-btn-lg" onTap=${() => {
            const near = useGame.getState().nearInteractable;
            if (near) near.onInteract();
          }} />
          <${TouchTapButton} label="🗡️" cls="touch-btn-lg" onTap=${() => simulateAction('poke')} />
          <${TouchTapButton} label="⚔️" cls="touch-btn-lg touch-btn-attack" onTap=${() => touchInput.attack()} />
        </div>
      </div>
    </div>
  `;
}

function Hud() {
  const meters = useGame((s) => s.meters);
  const coins = useGame((s) => s.coins);
  const warriors = useGame((s) => s.warriors);
  const raid = useGame((s) => s.raid);
  const distantRaid = useGame((s) => s.distantRaid);
  const stats = useGame((s) => s.stats);
  const timeOfDay = useGame((s) => s.timeOfDay);
  const nearInteractable = useGame((s) => s.nearInteractable);
  const activePanel = useGame((s) => s.activePanel);
  const keybinds = useGame((s) => s.keybinds);
  const dead = useGame((s) => s.dead);
  const toasts = useGame((s) => s.toasts);
  const hotbarSlots = useGame((s) => s.hotbarSlots);
  const activeHotbarSlot = useGame((s) => s.activeHotbarSlot);
  const inventory = useGame((s) => s.inventory);
  const mpStatus = useGame((s) => s.mpStatus);
  const setActivePanel = useGame((s) => s.setActivePanel);
  const escortWarriors = useGame((s) => s.escortWarriors);
  const chatMessages = useGame((s) => s.chatMessages);
  const chatOpen = useGame((s) => s.chatOpen);
  const setChatOpen = useGame((s) => s.setChatOpen);
  const addChatMessage = useGame((s) => s.addChatMessage);
  const [chatText, setChatText] = useState('');
  const notifications = useGame((s) => s.notifications);
  const notifUnread = useGame((s) => s.notifUnread);
  const clearNotifUnread = useGame((s) => s.clearNotifUnread);
  const [notifOpen, setNotifOpen] = useState(false);
  const toggleNotif = () => { if (!notifOpen) clearNotifUnread(); setNotifOpen((v) => !v); };

  const sendChat = () => {
    const text = chatText.trim();
    if (text) {
      mpSend({ t: 'chat', text });
      addChatMessage('me', text);
    }
    setChatText('');
    setChatOpen(false);
  };

  return html`
    <div id="hud">
      <${StatsOverlay} />
      <${Minimap} />

      <div class="hud-top-right">
        <div class="meters-counter">
          <span class="label">METERS TRAVELED</span>
          ${Math.floor(meters)} m
          <div class="coins-line">🪙 ${coins}</div>
        </div>

        <div class="hud-row">
          <div class="day-clock">🕐 ${formatTime(timeOfDay)}</div>
          <div class="tribe-panel" onClick=${() => setActivePanel(activePanel === 'tribe' ? null : 'tribe')}>
            ⚔️ ${warriors} warriors (${escortWarriors} with you)
          </div>
        </div>

        <div class="hud-row">
          <button class="notif-btn" onClick=${toggleNotif}>
            🔔${notifUnread > 0 ? ` ${notifUnread}` : ''}
          </button>
          <div class="mp-button ${mpStatus === 'connected' ? 'mp-connected' : ''}" onClick=${() => setActivePanel(activePanel === 'multiplayer' ? null : 'multiplayer')}>
            🌐 ${mpStatus === 'connected' ? 'Friend Online' : 'Multiplayer'}
          </div>
          <button class="hud-btn" onClick=${() => setActivePanel(activePanel === 'map' ? null : 'map')}>
            🗺️ Map <span style=${{ opacity: 0.55 }}>${keyLabel(keybinds.map)}</span>
          </button>
          <button class="hud-btn" onClick=${() => setActivePanel(activePanel === 'settings' ? null : 'settings')}>
            ⚙️ <span style=${{ opacity: 0.55 }}>${keyLabel(keybinds.settings)}</span>
          </button>
        </div>

        ${notifOpen && html`
          <div class="notif-panel">
            <h3>NOTIFICATIONS</h3>
            ${notifications.length === 0 && html`<div style=${{ color: 'rgba(255,255,255,0.3)', fontSize: '12px' }}>No notifications yet.</div>`}
            ${[...notifications].reverse().map((n) => {
              const age = Math.floor((Date.now() - n.time) / 60000);
              const ts = age < 1 ? 'now' : age < 60 ? age + 'm' : Math.floor(age / 60) + 'h';
              return html`<div class="notif-entry ${n.type}" key=${n.id}>
                <span class="notif-time">${ts}</span>
                <span>${n.msg}</span>
              </div>`;
            })}
          </div>
        `}

        <div class="toasts">
          ${toasts.map((t) => html`<div class="toast" key=${t.id}>${t.msg}</div>`)}
        </div>
      </div>

      ${(raid || distantRaid) && html`
        <div class="raid-banners">
          ${raid && html`
            <div class="raid-banner">⚠️ ${raid.tribeName} is attacking! Raiders incoming: ${raid.raiders.length}</div>
          `}
          ${distantRaid && html`
            <div class="raid-banner" style=${{ background: 'rgba(80,20,80,0.85)' }}>🏔️ ${distantRaid.tribeName} marching on ${distantRaid.targetTribeId ? (ENEMY_TRIBES.find((t) => t.id === distantRaid.targetTribeId)?.name ?? distantRaid.targetTribeId) + "'s camp" : 'your tribe'}! (${distantRaid.raiders.length} raiders)</div>
          `}
        </div>
      `}

      <div class="stats-panel">
        <${StatBar} icon="❤️" value=${stats.health} cls="health" />
        <${StatBar} icon="🍖" value=${stats.hunger} cls="hunger" />
        <${StatBar} icon="💧" value=${stats.thirst} cls="thirst" />
        <${StatBar} icon="⚡" value=${stats.energy} cls="energy" />
        <${StatBar} icon="🔥" value=${stats.warmth} cls="warmth" />
        <${StatBar} icon="🧠" value=${stats.sanity} cls="sanity" />
      </div>

      ${!activePanel && !dead && html`<div class="crosshair"></div>`}

      ${nearInteractable && !activePanel && !dead && html`
        <div class="interact-prompt">Press ${keyLabel(keybinds[nearInteractable.action])} to ${nearInteractable.label}</div>
      `}

      <div class="hotbar">
        ${hotbarSlots.map((id, i) => html`
          <div class="slot ${i === activeHotbarSlot ? 'active' : ''}" key=${id + i}>
            ${RESOURCES[id]?.name?.[0] || WEAPONS[id]?.name?.[0] || CRAFTING_RECIPES.find((r) => r.id === id)?.name?.[0] || SHOP_ITEMS.find((it) => it.id === id)?.name?.[0] || '?'}
            <span class="count">${inventory[id] || 0}</span>
          </div>
        `)}
      </div>

      <div class="chat-log">
        ${chatMessages.map((m) => html`
          <div class="chat-msg ${m.from}" key=${m.id}>${m.from === 'me' ? 'You' : 'Friend'}: ${m.text}</div>
        `)}
      </div>

      ${chatOpen && html`
        <div class="chat-input-bar">
          <input
            type="text"
            autoFocus
            maxLength=${120}
            placeholder="Message your friend..."
            value=${chatText}
            onChange=${(e) => setChatText(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter') sendChat();
              if (e.key === 'Escape') { setChatText(''); setChatOpen(false); }
            }}
          />
          <button onClick=${sendChat}>Send</button>
        </div>
      `}

      ${activePanel === 'inventory' && html`<${InventoryPanel} />`}
      ${activePanel === 'shop' && html`<${ShopPanel} />`}
      ${activePanel === 'tribe' && html`<${TribePanel} />`}
      ${activePanel === 'crafting' && html`<${CraftingPanel} />`}
      ${activePanel === 'build' && html`<${BuildPanel} />`}
      ${activePanel === 'multiplayer' && html`<${MultiplayerPanel} />`}
      ${activePanel === 'map' && html`<${MapPanel} />`}
      ${activePanel === 'settings' && html`<${SettingsPanel} />`}

      ${isTouchDevice && !activePanel && !dead && html`<${TouchControls} />`}

      ${dead && html`<${DeathScreen} />`}
    </div>
  `;
}

// ============================================================

export {
  TouchJoystick,
  TouchHoldButton,
  TouchTapButton,
  TouchControls,
  Hud,
};
