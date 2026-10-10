// touch.js - on-screen controls for tablets/phones (no keyboard/mouse)
// ============================================================
const isTouchDevice = (typeof window !== 'undefined')
  && (('ontouchstart' in window) || navigator.maxTouchPoints > 0);

// Written by the virtual joystick / look-drag, consumed each frame by Player.
const touchInput = {
  moveX: 0, moveZ: 0, // virtual joystick vector, same sign convention as WASD
  lookDX: 0, lookDY: 0, // accumulated look-drag delta (pixels) since last frame
  attack: () => {}, // wired up by Player to throw/swing the equipped weapon
};

// A development hatch, next to the look-drag one above: nothing in the game
// reads or writes it, but a headless run needs to stand somewhere specific
// without walking the whole map at one frame a second. Player drains it.
const debugWarp = { x: null, z: null };

// ============================================================

export {
  isTouchDevice,
  touchInput,
  debugWarp,
};
