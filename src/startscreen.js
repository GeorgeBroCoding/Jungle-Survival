import { React, html, useEffect } from './core.js';
import { keyLabel } from './keybinds.js';
import { Kito } from './kito.js';
import { getMapTerrainCanvas } from './map.js';
import { useGame } from './store.js';
import { warmSurfaces } from './wind.js';

// StartScreen.js - title / begin button
// ============================================================
function StartScreen() {
  const start = useGame((s) => s.start);
  const keybinds = useGame((s) => s.keybinds);
  const k = (id) => keyLabel(keybinds[id]);

  // Rasterise the map terrain while the player is still reading the intro, so the
  // minimap has it ready on spawn instead of hitching a frame on its first draw.
  useEffect(() => {
    const id = setTimeout(getMapTerrainCanvas, 50);
    // Build the procedural surfaces now too, so spawning doesn't stutter while
    // the ground, the trees and everyone's skin are all generated at once.
    const cancelWarm = warmSurfaces();
    return () => { clearTimeout(id); cancelWarm(); };
  }, []);

  return html`
    <div class="start-screen">
      <h1>JUNGLE KING</h1>
      <p>
        Survive a vast procedural jungle as the leader of your own tribe. Gather wood, fiber and stone,
        craft tools at the workbench, and build houses, lookout towers, walls and storage huts to grow
        your camp. Collect coins that fall from the sky and recruit warriors from Kito's shop to defend
        against rival tribes, who will occasionally raid your base. New rival tribes will arrive in the
        jungle over time, so choose some of your warriors to bring with you into battle - they'll fight
        back when you raid an enemy camp, and the rest will stay home to guard your base. Watch out for
        wild boars and curious monkeys as day turns to night.
      </p>
      <button onClick=${() => { start(); }}>Begin Survival</button>
      <div class="controls-list">
        ${k('moveForward')}${k('moveLeft')}${k('moveBack')}${k('moveRight')} move · Hold the middle mouse button (the wheel) and move the mouse to look around, or use ${k('lookLeft')}${k('lookDown')}${k('lookUp')}${k('lookRight')}
        · ${k('jump')} jump · ${k('sprint')} sprint (drains energy)
        · ${k('crouch')} crouch · ${k('gather')} gather / drink · ${k('interact')} talk to Kito / shop / pick up weapon · ${k('craft')} craft at workbench
        · ${k('build')} build menu · ${k('inventory')} inventory · ${k('cycleHotbar')} cycle hotbar · ${k('camera')} toggle camera · Scroll zoom · Esc close menus
        · ${k('map')} world map (you keep walking while it's open) · ${k('settings')} settings · ${k('tribe')} tribe panel
        · Left Click attack (throws spear, swings other weapons) · ${k('poke')} poke with spear
        · ${k('chat')} chat with your friend (multiplayer)
        · Every key above can be remapped in ⚙️ Settings → Controls (${k('settings')})
        · Click the ⚔️ warriors panel (top left) to choose how many warriors fight alongside you
        · On touch devices: drag the left joystick to move, drag anywhere to look, and use the on-screen buttons (including 💬 for chat)
        · Click the 🌐 Multiplayer button (top right) to play together with a friend
      </div>
    </div>
  `;
}

// ============================================================
// Error boundary — prevents React crashes from showing a black screen
// ============================================================
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(e) {
    return { hasError: true, error: e };
  }
  render() {
    if (this.state.hasError) {
      return React.createElement('div', {
        style: { position: 'fixed', inset: 0, background: '#1b150f', color: '#ffe27a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', zIndex: 999, padding: '20px' }
      },
        React.createElement('h2', null, 'Something crashed!'),
        React.createElement('pre', { style: { fontSize: '11px', color: '#aaa', maxWidth: '80%', overflow: 'auto', marginTop: '12px', whiteSpace: 'pre-wrap' } }, this.state.error?.message),
        React.createElement('button', { onClick: () => location.reload(), style: { marginTop: '20px', padding: '8px 24px', background: '#c9a227', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '15px' } }, 'Reload Game')
      );
    }
    return this.props.children;
  }
}

// ============================================================

export {
  StartScreen,
  ErrorBoundary,
};
