// shake.js - camera shake when the player takes a hit
// ============================================================
// Trauma-based: a hit raises `trauma`, which then decays on its own. The camera
// offset scales with trauma *squared*, so a shake punches hard and settles fast
// instead of trailing off in a long wobble. Kept as a plain mutable object, like
// playerTransform, so damage can trigger it without any per-frame store churn.
const screenShake = { trauma: 0 };
const SHAKE_DURATION = 0.45;   // seconds for full trauma to decay to nothing
const SHAKE_MAX_OFFSET = 0.32; // world units of camera jolt at full trauma
const SHAKE_MAX_ROLL = 0.045;  // radians of camera roll at full trauma
const SHAKE_MIN_DAMAGE = 2;    // the 1hp/sec starvation tick must not rattle the screen

// The strongest hit wins rather than accumulating, so several raiders landing blows
// on the same frame can't stack the trauma into an unplayable earthquake.
function addScreenShake(damage) {
  if (!(damage >= SHAKE_MIN_DAMAGE)) return;
  const strength = Math.min(1, 0.25 + damage * 0.03);
  screenShake.trauma = Math.max(screenShake.trauma, strength);
}

// Called once per frame after the camera has been placed, so the jolt is a pure
// offset on top of wherever the camera already was.
function applyScreenShake(camera, delta) {
  if (screenShake.trauma <= 0) return;
  const t = screenShake.trauma * screenShake.trauma;
  const mag = SHAKE_MAX_OFFSET * t;
  camera.position.x += (Math.random() * 2 - 1) * mag;
  camera.position.y += (Math.random() * 2 - 1) * mag;
  camera.position.z += (Math.random() * 2 - 1) * mag;
  camera.rotation.z += (Math.random() * 2 - 1) * SHAKE_MAX_ROLL * t;
  screenShake.trauma = Math.max(0, screenShake.trauma - delta / SHAKE_DURATION);
}

// Live world positions of animals/raiders/tribe members, updated every frame
// by their own components. Read by combat actions to avoid per-frame store churn.
const entityRegistry = { animals: {}, raiders: {}, tribeMembers: {}, distantRaiders: {}, interTribalRaiders: {} };

// ============================================================

export {
  screenShake,
  SHAKE_DURATION,
  SHAKE_MAX_OFFSET,
  SHAKE_MAX_ROLL,
  SHAKE_MIN_DAMAGE,
  addScreenShake,
  applyScreenShake,
  entityRegistry,
};
