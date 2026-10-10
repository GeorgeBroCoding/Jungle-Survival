// keyboard.js - global keyboard state
// ============================================================
const keys = {};
const pressHandlers = new Set();
// When the settings panel is waiting for a rebind, it parks a grabber here.
let keyCapture = null;

function isTypingInField() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  // A pending rebind swallows the key completely, so binding (say) B to jump
  // doesn't also pop the build menu on the way through.
  if (keyCapture) {
    e.preventDefault();
    const grab = keyCapture;
    keyCapture = null;
    grab(e.code);
    return;
  }
  if (isTypingInField()) return;
  if (!keys[e.code]) {
    for (const h of pressHandlers) h(e.code);
  }
  keys[e.code] = true;
});

window.addEventListener('keyup', (e) => {
  if (isTypingInField()) return;
  keys[e.code] = false;
});

function isKeyDown(code) {
  return !!keys[code];
}

// Fires once per physical key press (not held-repeat)
function onKeyPress(handler) {
  pressHandlers.add(handler);
  return () => pressHandlers.delete(handler);
}

// Lets on-screen touch buttons trigger the same one-shot actions as a key press.
function simulateKeyPress(code) {
  for (const h of pressHandlers) h(code);
}

// Lets the settings panel grab the very next physical key press for rebinding.
// Returns a cancel function.
function captureNextKey(grab) {
  keyCapture = grab;
  return () => { if (keyCapture === grab) keyCapture = null; };
}

// ============================================================

export {
  keys,
  pressHandlers,
  keyCapture,
  isTypingInField,
  isKeyDown,
  onKeyPress,
  simulateKeyPress,
  captureNextKey,
};
