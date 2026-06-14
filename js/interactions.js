// Global registry of "walk up and press a key" interactables.
// Each entry: { id, position: [x,y,z], radius, key: 'KeyE'|'KeyF'|'KeyR', label, onInteract: fn }
export const interactables = [];

export function registerInteractable(entry) {
  interactables.push(entry);
  return () => {
    const idx = interactables.indexOf(entry);
    if (idx >= 0) interactables.splice(idx, 1);
  };
}

export function findNearest(position, maxRadius = Infinity) {
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
