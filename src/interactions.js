// interactions.js - "walk up and press a key" registry
// ============================================================
// Each entry: { id, position: [x,y,z], radius, action: 'interact'|'gather'|'craft', label, onInteract: fn }
// `action` is a rebindable action id (see keybinds.js), never a raw key code.
const interactables = [];

function registerInteractable(entry) {
  interactables.push(entry);
  return () => {
    const idx = interactables.indexOf(entry);
    if (idx >= 0) interactables.splice(idx, 1);
  };
}

function findNearest(position, maxRadius = Infinity) {
  let best = null;
  let bestDist = maxRadius;
  for (const it of interactables) {
    const dx = it.position[0] - position[0];
    const dz = it.position[2] - position[2];
    const d = Math.hypot(dx, dz);
    if (d <= (it.radius ?? 2.5) && d <= bestDist) {
      best = it;
      bestDist = d;
    }
  }
  return best;
}

// ============================================================

export {
  interactables,
  registerInteractable,
  findNearest,
};
