import { Fragment, html, useEffect, useRef, useState } from './core.js';
import { GRAPHICS_ORDER, GRAPHICS_PRESETS, gfx, perfStats } from './graphics.js';
import { KEYBIND_ACTIONS, KEYBIND_GROUPS, keyLabel } from './keybinds.js';
import { captureNextKey, keys } from './keyboard.js';
import { useGame } from './store.js';

// SettingsPanel.js - controls rebinding and look settings
// ============================================================
function SettingsPanel() {
  const setActivePanel = useGame((s) => s.setActivePanel);
  const keybinds = useGame((s) => s.keybinds);
  const setKeybind = useGame((s) => s.setKeybind);
  const resetKeybinds = useGame((s) => s.resetKeybinds);
  const lookSens = useGame((s) => s.lookSens);
  const setLookSens = useGame((s) => s.setLookSens);
  const invertY = useGame((s) => s.invertY);
  const setInvertY = useGame((s) => s.setInvertY);
  const graphicsQuality = useGame((s) => s.graphicsQuality);
  const setGraphicsQuality = useGame((s) => s.setGraphicsQuality);
  const brightness = useGame((s) => s.brightness);
  const setBrightness = useGame((s) => s.setBrightness);
  const showStats = useGame((s) => s.showStats);
  const setShowStats = useGame((s) => s.setShowStats);
  const [tab, setTab] = useState('controls');
  const [listening, setListening] = useState(null); // action id waiting for a key
  const cancelRef = useRef(null);

  // Grab the next key press for this action. captureNextKey swallows it, so the
  // key being bound never also fires its old action on the way through.
  const beginRebind = (actionId) => {
    if (cancelRef.current) cancelRef.current();
    setListening(actionId);
    cancelRef.current = captureNextKey((code) => {
      cancelRef.current = null;
      setListening(null);
      if (code === 'Escape') return; // Esc cancels the rebind
      setKeybind(actionId, code);
    });
  };

  // If the panel closes mid-rebind, un-arm the grabber.
  useEffect(() => () => { if (cancelRef.current) cancelRef.current(); }, []);

  const controlsTab = html`
    <${Fragment}>
      <p class="set-hint">
        Click a key, then press the new one. <strong>Esc</strong> cancels.
        If that key already belongs to another action the two <strong>swap</strong>:
        the other action takes over the key you just freed, so nothing is ever left unbound.
      </p>
      ${KEYBIND_GROUPS.map((group) => html`
        <${Fragment} key=${group}>
          <h3 class="inv-section">${group}</h3>
          ${KEYBIND_ACTIONS.filter((a) => a.group === group).map((a) => html`
            <div class="set-row" key=${a.id}>
              <span class="set-label">${a.label}</span>
              <button
                class="key-btn ${listening === a.id ? 'listening' : ''}"
                onClick=${() => beginRebind(a.id)}
              >${listening === a.id ? 'Press a key…' : keyLabel(keybinds[a.id])}</button>
            </div>
          `)}
        <//>
      `)}
      <h3 class="inv-section">Fixed</h3>
      <div class="set-row">
        <span class="set-label">Attack — throw the spear, swing anything else</span>
        <button class="key-btn fixed">Left Click</button>
      </div>
      <div class="set-row">
        <span class="set-label">Look around — hold the wheel button and move the mouse</span>
        <button class="key-btn fixed">Middle Mouse</button>
      </div>
      <div class="set-row">
        <span class="set-label">Zoom the camera in and out</span>
        <button class="key-btn fixed">Scroll</button>
      </div>
      <div class="set-row">
        <span class="set-label">Close any menu</span>
        <button class="key-btn fixed">Esc</button>
      </div>
      <div class="set-row" style=${{ background: 'none', padding: '10px 0 0' }}>
        <span class="set-label"></span>
        <button class="buy-btn" onClick=${() => resetKeybinds()}>Reset to defaults</button>
      </div>
    <//>
  `;

  const generalTab = html`
    <${Fragment}>
      <p class="set-hint">
        Applies to both the middle-mouse drag and the look keys. Your controls and
        these settings are saved in this browser, so they survive a reload.
      </p>
      <div class="set-row">
        <span class="set-label">Look sensitivity</span>
        <div class="set-slider">
          <input
            type="range" min="0.3" max="3" step="0.1"
            value=${lookSens}
            onChange=${(e) => setLookSens(parseFloat(e.target.value))}
          />
          <strong style=${{ minWidth: '38px', color: '#ffe27a' }}>${lookSens.toFixed(1)}x</strong>
        </div>
      </div>
      <div class="set-row">
        <span class="set-label">Invert vertical look</span>
        <input type="checkbox" checked=${invertY} onChange=${(e) => setInvertY(e.target.checked)} />
      </div>
      <h3 class="inv-section">Good to know</h3>
      <p class="set-hint">
        Numpad digits mirror the number row: whenever an action sits on a number key,
        the matching numpad key fires it too.
        Esc is reserved for closing menus, so it can't be bound to an action.
      </p>
    <//>
  `;

  const preset = GRAPHICS_PRESETS[graphicsQuality] || gfx();
  const graphicsTab = html`
    <${Fragment}>
      <p class="set-hint">
        Everything in the world is generated at runtime — the textures, the trees, the
        grass, the sky. Turning this down trims the expensive parts (ground cover,
        shadow resolution, how much detail each plant gets) rather than changing how
        the game plays. It takes effect immediately and you won't lose your position.
      </p>
      <h3 class="inv-section">Quality</h3>
      <div class="set-row">
        <span class="set-label">Preset</span>
        <div class="gfx-presets">
          ${GRAPHICS_ORDER.map((key) => html`
            <button
              key=${key}
              class="key-btn ${graphicsQuality === key ? 'listening' : ''}"
              onClick=${() => setGraphicsQuality(key)}
            >${GRAPHICS_PRESETS[key].label}</button>
          `)}
        </div>
      </div>
      <h3 class="inv-section">What that gives you</h3>
      <div class="set-row">
        <span class="set-label">Grass drawn around you</span>
        <strong class="set-value">${preset.grassRadius > 0 ? preset.grassRadius + 'm' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Shadow map</span>
        <strong class="set-value">${preset.shadowMap}px</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Plants in the world</span>
        <strong class="set-value">${preset.foliage}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Plant detail</span>
        <strong class="set-value">
          ${preset.treeDetail === 0 ? 'trunks and canopies'
            : preset.treeDetail === 1 ? 'roots, branches, leaves'
            : 'everything, including vines'}
        </strong>
      </div>
      <div class="set-row">
        <span class="set-label">Render scale</span>
        <strong class="set-value">${preset.dpr.toFixed(2)}x</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Sky reflections refresh</span>
        <strong class="set-value">${preset.envSeconds > 0 ? 'every ' + preset.envSeconds + 's' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Shadow sharpness</span>
        <strong class="set-value">${(((preset.shadowExtent * 2) / preset.shadowMap) * 100).toFixed(1)}cm / texel</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Contact shadows</span>
        <strong class="set-value">${preset.contactShadows ? 'on' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Firelight</span>
        <strong class="set-value">
          ${preset.fireLights} ${preset.fireLights === 1 ? 'fire' : 'fires'}${preset.fireShadows ? ', casting shadows' : ''}
        </strong>
      </div>
      <div class="set-row">
        <span class="set-label">Eye adaptation</span>
        <strong class="set-value">${preset.eyeAdapt ? 'on' : 'off'}</strong>
      </div>
      <h3 class="inv-section">Atmosphere</h3>
      <p class="set-hint">
        With these on, the picture is built in high dynamic range and tone-mapped at the
        very end — which is what lets only genuinely bright things glow, and lets the
        distance hold haze instead of flat grey. Turning the preset down to Low skips the
        whole chain and renders straight to the screen.
      </p>
      <div class="set-row">
        <span class="set-label">Ambient occlusion</span>
        <strong class="set-value">${preset.ssaoSamples > 0 ? preset.ssaoSamples + ' samples' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Bloom</span>
        <strong class="set-value">${preset.bloom > 0 ? preset.bloomLevels + ' levels' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Light shafts</span>
        <strong class="set-value">${preset.godRays ? 'on' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Distance blur</span>
        <strong class="set-value">${preset.dof ? 'on' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Valley mist</span>
        <strong class="set-value">${preset.heightFog > 0 ? 'on' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Falling leaves</span>
        <strong class="set-value">${preset.fallingLeaves > 0 ? preset.fallingLeaves : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Dust and pollen</span>
        <strong class="set-value">${preset.dustMotes > 0 ? preset.dustMotes + ' motes' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Heat haze over fires</span>
        <strong class="set-value">${preset.heatHaze ? 'on' : 'off'}</strong>
      </div>
      <div class="set-row">
        <span class="set-label">Vignette and film grain</span>
        <strong class="set-value">${preset.vignette > 0 ? 'subtle' : 'off'}</strong>
      </div>
      <p class="set-hint">
        If the game feels heavy, <strong>Grass</strong> and <strong>Render scale</strong> are
        the two that cost the most — drop a preset and both come down together.
      </p>
      <h3 class="inv-section">Lighting</h3>
      <div class="set-row">
        <span class="set-label">Brightness</span>
        <div class="set-slider">
          <input
            type="range" min="0.6" max="1.8" step="0.05"
            value=${brightness}
            onChange=${(e) => setBrightness(parseFloat(e.target.value))}
          />
          <strong style=${{ minWidth: '38px', color: '#ffe27a' }}>${brightness.toFixed(2)}x</strong>
        </div>
      </div>
      <p class="set-hint">
        The jungle is lit by a real scattering sky and the exposure drifts on its own as you
        move between clearings and shade, the way an eye does. This is a multiplier on top of
        all that — nudge it if the whole picture reads too dark or too washed out on your screen.
      </p>
      <h3 class="inv-section">Performance readout</h3>
      <div class="set-row">
        <span class="set-label">Show frame rate on screen</span>
        <input type="checkbox" checked=${showStats} onChange=${(e) => setShowStats(e.target.checked)} />
      </div>
      <div class="set-row">
        <span class="set-label">Right now</span>
        <strong class="set-value">
          ${perfStats.fps > 0
            ? `${perfStats.fps.toFixed(0)} fps · ${perfStats.draws} draws · ${(perfStats.tris / 1000).toFixed(0)}k tris`
            : 'not measured yet'}
        </strong>
      </div>
    <//>
  `;

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel" onClick=${(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div class="tabs">
          <button class=${tab === 'controls' ? 'active' : ''} onClick=${() => setTab('controls')}>Controls</button>
          <button class=${tab === 'graphics' ? 'active' : ''} onClick=${() => setTab('graphics')}>Graphics</button>
          <button class=${tab === 'general' ? 'active' : ''} onClick=${() => setTab('general')}>General</button>
        </div>
        ${tab === 'controls' ? controlsTab : tab === 'graphics' ? graphicsTab : generalTab}
        <p class="close-hint">${keyLabel(keybinds.settings)} or Esc to close</p>
      </div>
    </div>
  `;
}

// ============================================================

export {
  SettingsPanel,
};
