// Lightweight global keyboard state (avoids re-render storms in the game loop)
const keys = {};
const pressHandlers = new Set();

window.addEventListener('keydown', (e) => {
  if (!keys[e.code]) {
    for (const h of pressHandlers) h(e.code);
  }
  keys[e.code] = true;
});

window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

export function isKeyDown(code) {
  return !!keys[code];
}

// Fires once per physical key press (not held-repeat)
export function onKeyPress(handler) {
  pressHandlers.add(handler);
  return () => pressHandlers.delete(handler);
}
