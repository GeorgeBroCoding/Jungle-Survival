import { isKeyDown, simulateKeyPress } from './keyboard.js';

// keybinds.js - remappable action <-> key bindings
// ============================================================
// Every rebindable action lives here, and nothing else in the game refers to a
// raw key code. `held` actions are polled each frame via keyHeld(); the rest
// fire once per press and are routed through actionForCode().
const KEYBIND_ACTIONS = [
  { id: 'moveForward', group: 'Movement',  label: 'Move forward',        def: 'KeyW',        held: true },
  { id: 'moveBack',    group: 'Movement',  label: 'Move backward',       def: 'KeyS',        held: true },
  { id: 'moveLeft',    group: 'Movement',  label: 'Strafe left',         def: 'KeyA',        held: true },
  { id: 'moveRight',   group: 'Movement',  label: 'Strafe right',        def: 'KeyD',        held: true },
  { id: 'jump',        group: 'Movement',  label: 'Jump',                def: 'Space',       held: true },
  { id: 'sprint',      group: 'Movement',  label: 'Sprint',              def: 'ShiftLeft',   held: true },
  { id: 'crouch',      group: 'Movement',  label: 'Crouch',              def: 'ControlLeft', held: true },
  { id: 'lookLeft',    group: 'Camera',    label: 'Look left',           def: 'ArrowLeft',   held: true },
  { id: 'lookRight',   group: 'Camera',    label: 'Look right',          def: 'ArrowRight',  held: true },
  { id: 'lookUp',      group: 'Camera',    label: 'Look up',             def: 'ArrowUp',     held: true },
  { id: 'lookDown',    group: 'Camera',    label: 'Look down',           def: 'ArrowDown',   held: true },
  { id: 'camera',      group: 'Camera',    label: 'First / third person', def: 'KeyC' },
  { id: 'gather',      group: 'Actions',   label: 'Gather / drink water', def: 'KeyF' },
  { id: 'interact',    group: 'Actions',   label: 'Interact, shop, pick up', def: 'KeyE' },
  { id: 'craft',       group: 'Actions',   label: 'Craft at workbench',  def: 'KeyR' },
  { id: 'build',       group: 'Actions',   label: 'Build menu',          def: 'KeyB' },
  { id: 'poke',        group: 'Actions',   label: 'Poke (keep weapon)',  def: 'Digit0' },
  { id: 'cycleHotbar', group: 'Interface', label: 'Cycle hotbar slot',   def: 'KeyQ' },
  { id: 'inventory',   group: 'Interface', label: 'Inventory',           def: 'Tab' },
  { id: 'map',         group: 'Interface', label: 'World map',           def: 'KeyM' },
  { id: 'settings',    group: 'Interface', label: 'Settings',            def: 'KeyO' },
  { id: 'tribe',       group: 'Interface', label: 'Tribe panel',         def: 'KeyG' },
  { id: 'chat',        group: 'Interface', label: 'Chat with friend',    def: 'KeyT' },
];
const KEYBIND_GROUPS = ['Movement', 'Camera', 'Actions', 'Interface'];

// Esc is the universal close/cancel key, so it can never be bound to an action.
const RESERVED_CODES = new Set(['Escape']);

// The map is a heads-up panel, not a modal: you keep walking while it's open so the
// marker tracks you live. Every other panel freezes movement as before.
function panelBlocksMovement(panel) {
  return panel !== null && panel !== 'map';
}

const DEFAULT_KEYBINDS = Object.fromEntries(KEYBIND_ACTIONS.map((a) => [a.id, a.def]));
const KEYBINDS_STORAGE_KEY = 'jungleking.keybinds.v1';

// Plain-object mirrors of the store's bindings. The player's frame loop reads
// these directly so polling movement keys never costs a store lookup.
let activeBinds = { ...DEFAULT_KEYBINDS };
let codeToAction = {};
function setActiveBinds(binds) {
  activeBinds = binds;
  codeToAction = {};
  for (const id in binds) codeToAction[binds[id]] = id;
}

function loadKeybinds() {
  const binds = { ...DEFAULT_KEYBINDS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEYBINDS_STORAGE_KEY) || 'null');
    // Only trust ids we still ship, so an old save can't resurrect a dead action.
    if (saved) {
      for (const id in binds) {
        if (typeof saved[id] === 'string' && saved[id] && !RESERVED_CODES.has(saved[id])) binds[id] = saved[id];
      }
    }
  } catch (e) { /* storage disabled or corrupt: defaults are fine */ }
  return binds;
}

function saveKeybinds(binds) {
  try { localStorage.setItem(KEYBINDS_STORAGE_KEY, JSON.stringify(binds)); } catch (e) {}
}

setActiveBinds(loadKeybinds());

function bind(actionId) { return activeBinds[actionId]; }
function keyHeld(actionId) { const code = activeBinds[actionId]; return !!code && isKeyDown(code); }

// Which action a pressed key triggers. Numpad digits fall through to the
// matching number-row digit, so Numpad 0 still pokes while poke sits on 0.
function actionForCode(code) {
  if (codeToAction[code]) return codeToAction[code];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return codeToAction['Digit' + numpad[1]] || null;
  return null;
}

// Touch buttons fire actions rather than raw keys, so they follow any rebinding.
function simulateAction(actionId) {
  const code = activeBinds[actionId];
  if (code) simulateKeyPress(code);
}

const KEY_LABEL_OVERRIDES = {
  Space: 'Space', Tab: 'Tab', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'L Alt', AltRight: 'R Alt', MetaLeft: 'Cmd', MetaRight: 'Cmd', CapsLock: 'Caps',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /', NumpadEnter: 'Num Enter', NumpadDecimal: 'Num .',
};
function keyLabel(code) {
  if (!code) return '—';
  if (KEY_LABEL_OVERRIDES[code]) return KEY_LABEL_OVERRIDES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
  return code;
}
function actionLabel(actionId) {
  const action = KEYBIND_ACTIONS.find((a) => a.id === actionId);
  return action ? action.label : actionId;
}

// Mouse look tuning, also set from the settings panel. Kept as a plain object so
// the pointer-move handler reads the live value instead of a stale closure.
const INPUT_SETTINGS_KEY = 'jungleking.input.v1';
const inputSettings = { lookSens: 1, invertY: false };
try {
  const saved = JSON.parse(localStorage.getItem(INPUT_SETTINGS_KEY) || 'null');
  if (saved) {
    if (typeof saved.lookSens === 'number' && isFinite(saved.lookSens)) {
      inputSettings.lookSens = Math.max(0.3, Math.min(3, saved.lookSens));
    }
    if (typeof saved.invertY === 'boolean') inputSettings.invertY = saved.invertY;
  }
} catch (e) {}
function saveInputSettings() {
  try { localStorage.setItem(INPUT_SETTINGS_KEY, JSON.stringify(inputSettings)); } catch (e) {}
}

// ============================================================

export {
  KEYBIND_ACTIONS,
  KEYBIND_GROUPS,
  RESERVED_CODES,
  panelBlocksMovement,
  DEFAULT_KEYBINDS,
  KEYBINDS_STORAGE_KEY,
  activeBinds,
  codeToAction,
  setActiveBinds,
  loadKeybinds,
  saveKeybinds,
  bind,
  keyHeld,
  actionForCode,
  simulateAction,
  KEY_LABEL_OVERRIDES,
  keyLabel,
  actionLabel,
  INPUT_SETTINGS_KEY,
  inputSettings,
  saveInputSettings,
};
