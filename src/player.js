import { Fragment, THREE, html, useEffect, useFrame, useRef, useThree } from './core.js';
import { ATTACK_DURATION, FRIEND_BASE_CENTER, PLAYER_COLL_R, PLAYER_SPAWN, POND_CENTER, POND_RADIUS, POND_SURFACE_Y, STATIC_OBSTACLES, WEAPONS } from './data.js';
import { gfx } from './graphics.js';
import { emitSpray } from './grass.js';
import { HumanFigure } from './humanbody.js';
import { findNearest } from './interactions.js';
import { actionForCode, inputSettings, keyHeld, panelBlocksMovement } from './keybinds.js';
import { onKeyPress } from './keyboard.js';
import { mpSend, playChingSound, playerTransform, remotePlayer, tribeMemberSyncData } from './multiplayer.js';
import { applyScreenShake } from './shake.js';
import { useGame } from './store.js';
import { getTerrainHeight, stdMat, surfaceMat, waterSurfaceAt } from './terrain.js';
import { debugWarp, touchInput } from './touch.js';
import { ContactShadow } from './tribes.js';
import { spawnRipple } from './water.js';

// Player.js - movement, camera, survival stats
// ============================================================
const WALK_SPEED = 6;
const SPRINT_MULT = 1.8;
const CROUCH_MULT = 0.5;
const JUMP_SPEED = 6.5;
const GRAVITY = 22;
// How far below the water's surface a swimming player's feet settle.
const SWIM_SUBMERSION = 0.35;
// Seconds for the death collapse to play out. The "You Died!" overlay fades in just
// behind it (see .death-screen), so the fall is visible before the UI covers it.
const DEATH_FALL_TIME = 1.1;

const UP = new THREE.Vector3(0, 1, 0);

// Plays a per-weapon sound/visual flourish when it's used to attack.
function triggerWeaponFx(weaponId) {
  if (weaponId === 'machete') {
    playChingSound();
    const [px, py, pz] = playerTransform.position;
    const yaw = playerTransform.yaw;
    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);
    useGame.getState().spawnFx('ching', [px + dirX * 1.2, py + 1.3, pz + dirZ * 1.2]);
  }
}

// ---------- Weapon held in the right hand, swapped based on the active hotbar slot ----------
function HeldWeapon({ id }) {
  // Shared materials so every weapon in the world is one draw state each:
  // real wood grain on the hafts, worn metal on the heads, cord on the grips.
  const wood = surfaceMat('weaponWood', 'bark', [1.4, 2.6], {
    color: '#9a7446', roughness: 0.82, metalness: 0, envMapIntensity: 0.3,
  });
  const cord = surfaceMat('weaponCord', 'cloth', [2.6, 2.6], {
    color: '#6a5436', roughness: 0.95, metalness: 0,
  });
  const steel = stdMat('weaponSteel', () => new THREE.MeshStandardMaterial({
    color: '#b7bcc4', roughness: 0.28, metalness: 0.85, envMapIntensity: 1.3,
  }));
  const stone = surfaceMat('weaponStone', 'rock', [1.6, 1.6], {
    color: '#9a978e', roughness: 0.7, metalness: 0.05, envMapIntensity: 0.5,
  });

  if (id === 'spear') {
    return html`
      <group position=${[0, -0.55, -0.05]} rotation=${[1.35, 0, 0]}>
        <mesh position=${[0, 0.55, 0]} castShadow=${true} material=${wood}>
          <cylinderGeometry args=${[0.022, 0.028, 1.3, 10]} />
        </mesh>
        <mesh position=${[0, 1.25, 0]} castShadow=${true} material=${stone}>
          <coneGeometry args=${[0.055, 0.3, 8]} />
        </mesh>
        <!-- sinew lashing where the head is bound to the shaft -->
        <mesh position=${[0, 1.10, 0]} castShadow=${true} material=${cord}>
          <cylinderGeometry args=${[0.034, 0.034, 0.075, 8]} />
        </mesh>
        <mesh position=${[0, 0.30, 0]} material=${cord}>
          <cylinderGeometry args=${[0.031, 0.031, 0.13, 8]} />
        </mesh>
      </group>
    `;
  }
  if (id === 'machete') {
    return html`
      <group position=${[0, -0.5, -0.05]} rotation=${[1.15, 0, 0.1]}>
        <mesh position=${[0, 0.12, 0]} castShadow=${true} material=${wood}>
          <cylinderGeometry args=${[0.032, 0.036, 0.25, 10]} />
        </mesh>
        <mesh position=${[0, 0.12, 0]} material=${cord}>
          <cylinderGeometry args=${[0.037, 0.037, 0.16, 10]} />
        </mesh>
        <mesh position=${[0, 0.27, 0]} castShadow=${true} material=${steel}>
          <boxGeometry args=${[0.085, 0.05, 0.035]} />
        </mesh>
        <mesh position=${[0, 0.58, 0.002]} castShadow=${true} material=${steel}>
          <boxGeometry args=${[0.075, 0.72, 0.012]} />
        </mesh>
        <!-- the blade's bevelled edge catches the light down one side -->
        <mesh position=${[0.034, 0.58, 0]} rotation=${[0, 0, 0.04]} castShadow=${true} material=${steel}>
          <boxGeometry args=${[0.016, 0.70, 0.006]} />
        </mesh>
      </group>
    `;
  }
  if (id === 'club') {
    return html`
      <group position=${[0, -0.5, -0.05]} rotation=${[1.25, 0, 0]}>
        <mesh position=${[0, 0.3, 0]} castShadow=${true} material=${wood}>
          <cylinderGeometry args=${[0.036, 0.046, 0.6, 10]} />
        </mesh>
        <mesh position=${[0, 0.12, 0]} material=${cord}>
          <cylinderGeometry args=${[0.048, 0.048, 0.18, 10]} />
        </mesh>
        <mesh position=${[0, 0.68, 0]} castShadow=${true} material=${wood}>
          <sphereGeometry args=${[0.125, 12, 10]} />
        </mesh>
        <!-- stone spikes driven into the head -->
        <mesh position=${[0.11, 0.70, 0]} rotation=${[0, 0, -1.3]} castShadow=${true} material=${stone}>
          <coneGeometry args=${[0.028, 0.10, 6]} />
        </mesh>
        <mesh position=${[-0.11, 0.66, 0]} rotation=${[0, 0, 1.3]} castShadow=${true} material=${stone}>
          <coneGeometry args=${[0.028, 0.10, 6]} />
        </mesh>
        <mesh position=${[0, 0.70, 0.11]} rotation=${[1.3, 0, 0]} castShadow=${true} material=${stone}>
          <coneGeometry args=${[0.028, 0.10, 6]} />
        </mesh>
      </group>
    `;
  }
  if (id === 'axe') {
    return html`
      <group position=${[0, -0.5, -0.05]} rotation=${[1.1, 0, 0.15]}>
        <mesh position=${[0, 0.32, 0]} castShadow=${true} material=${wood}>
          <cylinderGeometry args=${[0.03, 0.038, 0.7, 10]} />
        </mesh>
        <mesh position=${[0, 0.08, 0]} material=${cord}>
          <cylinderGeometry args=${[0.04, 0.04, 0.17, 10]} />
        </mesh>
        <mesh position=${[0.06, 0.74, 0]} rotation=${[0, 0, 0.55]} castShadow=${true} material=${steel}>
          <boxGeometry args=${[0.30, 0.15, 0.055]} />
        </mesh>
        <!-- flared cutting edge -->
        <mesh position=${[0.19, 0.80, 0]} rotation=${[0, 0, 0.55]} castShadow=${true} material=${steel}>
          <boxGeometry args=${[0.10, 0.26, 0.022]} />
        </mesh>
        <mesh position=${[0, 0.72, 0]} castShadow=${true} material=${cord}>
          <cylinderGeometry args=${[0.045, 0.045, 0.10, 8]} />
        </mesh>
      </group>
    `;
  }
  if (id === 'pickaxe') {
    const halfPi = Math.PI / 2;
    return html`
      <group position=${[0, -0.5, -0.05]} rotation=${[1.15, 0, 0.1]}>
        <mesh position=${[0, 0.32, 0]} castShadow=${true} material=${wood}>
          <cylinderGeometry args=${[0.028, 0.034, 0.72, 10]} />
        </mesh>
        <mesh position=${[0, 0.08, 0]} material=${cord}>
          <cylinderGeometry args=${[0.036, 0.036, 0.17, 10]} />
        </mesh>
        <mesh position=${[0, 0.74, 0]} rotation=${[0, 0, halfPi]} castShadow=${true} material=${steel}>
          <boxGeometry args=${[0.075, 0.40, 0.055]} />
        </mesh>
        <mesh position=${[0.24, 0.74, 0]} rotation=${[0, 0, halfPi + 0.25]} castShadow=${true} material=${steel}>
          <coneGeometry args=${[0.04, 0.22, 6]} />
        </mesh>
        <mesh position=${[-0.24, 0.74, 0]} rotation=${[0, 0, halfPi - 0.25]} castShadow=${true} material=${steel}>
          <coneGeometry args=${[0.04, 0.22, 6]} />
        </mesh>
        <mesh position=${[0, 0.74, 0]} castShadow=${true} material=${cord}>
          <cylinderGeometry args=${[0.042, 0.042, 0.085, 8]} />
        </mesh>
      </group>
    `;
  }
  return null;
}

function Player() {
  const { camera, gl } = useThree();
  const group = useRef();
  const leftArm = useRef();
  const rightArm = useRef();
  const leftLeg = useRef();
  const rightLeg = useRef();
  const bodyVisual = useRef();
  const fpWeapon = useRef();
  const fpWeaponAnim = useRef();

  const yaw = useRef(0);
  const pitch = useRef(-0.18);
  const velocityY = useRef(0);
  const onGround = useRef(true);
  const camDistance = useRef(6);
  const cameraMode = useRef('third'); // 'third' | 'first'
  const limbPhase = useRef(0);
  const statTimer = useRef(0);
  const lastNearId = useRef(null);
  const inWater = useRef(false);
  const wasInWater = useRef(false);
  const rippleTimer = useRef(0);
  const dripTimer = useRef(0);
  const wetFor = useRef(0);
  const attackTimer = useRef(0);
  const mpSendTimer = useRef(0);
  const deathTimer = useRef(0); // seconds since death, drives the collapse animation
  const camDistanceBeforeDeath = useRef(null); // the player's own zoom, restored on respawn
  const camBase = useRef(new THREE.Vector3()); // camera position before screen shake

  const equippedWeaponId = useGame((s) => {
    const slot = s.hotbarSlots[s.activeHotbarSlot];
    return WEAPONS[slot] && (s.inventory[slot] || 0) > 0 ? slot : null;
  });

  const mpRole = useGame((s) => s.mpRole);
  useEffect(() => {
    if (mpRole === 'joiner' && group.current) {
      group.current.position.set(FRIEND_BASE_CENTER[0], getTerrainHeight(FRIEND_BASE_CENTER[0], FRIEND_BASE_CENTER[2]), FRIEND_BASE_CENTER[2]);
      velocityY.current = 0;
    }
  }, [mpRole]);

  // Respawn: put the body back on its feet at camp and undo the collapse pose.
  // Keyed on deathCount so it fires once per respawn, not on the initial mount.
  const deathCount = useGame((s) => s.deathCount);
  useEffect(() => {
    if (deathCount === 0 || !group.current) return;
    const home = mpRole === 'joiner' ? FRIEND_BASE_CENTER : PLAYER_SPAWN;
    group.current.position.set(home[0], getTerrainHeight(home[0], home[2]), home[2]);
    velocityY.current = 0;
    deathTimer.current = 0;
    if (camDistanceBeforeDeath.current !== null) {
      camDistance.current = camDistanceBeforeDeath.current;
      camDistanceBeforeDeath.current = null;
    }
    if (bodyVisual.current) {
      bodyVisual.current.rotation.set(0, 0, 0);
      bodyVisual.current.position.set(0, 0, 0);
    }
    for (const limb of [leftArm, rightArm, leftLeg, rightLeg]) {
      if (limb.current) limb.current.rotation.set(0, 0, 0);
    }
  }, [deathCount, mpRole]);

  useEffect(() => {
    const canvas = gl.domElement;
    // Camera look is a middle-mouse drag: hold the wheel button and move the mouse.
    // That leaves the left button free for attacking and the cursor free for the HUD,
    // so the game never silently swallows the pointer.
    const looking = { active: false };
    const stopLooking = () => {
      if (!looking.active) return;
      looking.active = false;
      if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
    };
    const onMouseMove = (e) => {
      if (!looking.active) return;
      const sens = 0.0022 * inputSettings.lookSens;
      yaw.current -= e.movementX * sens;
      pitch.current -= e.movementY * sens * (inputSettings.invertY ? -1 : 1);
      pitch.current = Math.max(-1.2, Math.min(0.9, pitch.current));
    };
    const onWheel = (e) => {
      camDistance.current = Math.max(2, Math.min(12, camDistance.current + e.deltaY * 0.01));
    };
    // Throw the equipped spear, or swing whatever melee weapon is in hand.
    // Shared by the left mouse button and the on-screen attack button.
    const doAttack = () => {
      const s = useGame.getState();
      if (s.activePanel !== null || s.dead) return;
      const slot = s.hotbarSlots[s.activeHotbarSlot];
      const weapon = WEAPONS[slot];
      if (!weapon || (s.inventory[slot] || 0) <= 0) return;
      attackTimer.current = ATTACK_DURATION;
      if (weapon.throwable) s.throwWeapon(slot);
      else { s.meleeAttack(slot); triggerWeaponFx(slot); }
      mpSend({ t: 'attack' });
    };
    const onMouseDown = (e) => {
      if (useGame.getState().activePanel !== null) return;
      if (e.button === 1) {
        // Middle button: start looking. preventDefault stops middle-click autoscroll.
        e.preventDefault();
        looking.active = true;
        // Pointer lock makes the drag unbounded and hides the cursor for the duration;
        // if the browser refuses it, movementX/Y still drive the look unlocked.
        if (canvas.requestPointerLock) canvas.requestPointerLock();
        return;
      }
      if (e.button === 0) doAttack();
    };
    const onMouseUp = (e) => {
      if (e.button === 1) stopLooking();
    };
    // If the lock drops for any other reason (Esc, tab switch), stop looking too,
    // otherwise the next mouse move would keep spinning the camera.
    const onPointerLockChange = () => {
      if (looking.active && document.pointerLockElement !== canvas) looking.active = false;
    };
    touchInput.attack = doAttack;

    // ---- touch: drag-to-look anywhere on the canvas ----
    const activeLookTouch = { id: null, x: 0, y: 0 };
    const onTouchStart = (e) => {
      if (useGame.getState().activePanel !== null) return;
      if (activeLookTouch.id !== null) return;
      const t = e.changedTouches[0];
      activeLookTouch.id = t.identifier;
      activeLookTouch.x = t.clientX;
      activeLookTouch.y = t.clientY;
    };
    const onTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === activeLookTouch.id) {
          touchInput.lookDX += t.clientX - activeLookTouch.x;
          touchInput.lookDY += t.clientY - activeLookTouch.y;
          activeLookTouch.x = t.clientX;
          activeLookTouch.y = t.clientY;
        }
      }
    };
    const onTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === activeLookTouch.id) activeLookTouch.id = null;
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('wheel', onWheel, { passive: true });
    // mousedown is non-passive so the middle button can cancel browser autoscroll.
    canvas.addEventListener('mousedown', onMouseDown);
    // mouseup on the window, so releasing outside the canvas still ends the look.
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', stopLooking);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: true });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: true });

    const offPress = onKeyPress((code) => {
      const s = useGame.getState();

      // Esc is reserved and unbindable: it always just closes what's open.
      if (code === 'Escape') {
        if (s.activePanel) s.setActivePanel(null);
        return;
      }

      const action = actionForCode(code);
      if (!action) return;

      // Dead players can look around and open the map or settings, nothing else.
      if (s.dead && action !== 'camera' && action !== 'map' && action !== 'settings') return;

      if (action === 'camera') {
        cameraMode.current = cameraMode.current === 'third' ? 'first' : 'third';
      }
      if (action === 'inventory') {
        s.setActivePanel(s.activePanel === 'inventory' ? null : 'inventory');
      }
      if (action === 'interact' || action === 'craft') {
        // Pressing the same key again closes the panel it opened.
        if (s.activePanel) {
          s.setActivePanel(null);
        } else {
          const near = s.nearInteractable;
          if (near && near.action === action) near.onInteract();
        }
      }
      if (action === 'gather' && !s.activePanel) {
        const near = s.nearInteractable;
        if (near && near.action === 'gather') {
          near.onInteract();
        } else if (inWater.current) {
          s.adjustStat('thirst', 35);
          s.addToast('Drank water (+35 thirst)');
        }
      }
      if (action === 'cycleHotbar') {
        s.setActiveHotbarSlot((s.activeHotbarSlot + 1) % s.hotbarSlots.length);
      }
      if (action === 'build') {
        s.setActivePanel(s.activePanel === 'build' ? null : 'build');
      }
      if (action === 'map') {
        s.setActivePanel(s.activePanel === 'map' ? null : 'map');
      }
      if (action === 'settings') {
        s.setActivePanel(s.activePanel === 'settings' ? null : 'settings');
      }
      if (action === 'tribe') {
        s.setActivePanel(s.activePanel === 'tribe' ? null : 'tribe');
      }
      if (action === 'chat' && !s.activePanel) {
        s.setChatOpen(true);
        if (document.exitPointerLock) document.exitPointerLock();
      }
      // Poke/stab with the equipped weapon without throwing it.
      if (action === 'poke' && !s.activePanel) {
        const slot = s.hotbarSlots[s.activeHotbarSlot];
        const weapon = WEAPONS[slot];
        if (weapon && (s.inventory[slot] || 0) > 0) {
          attackTimer.current = ATTACK_DURATION;
          s.meleeAttack(slot);
          triggerWeaponFx(slot);
          mpSend({ t: 'attack' });
        }
      }
    });

    // Any panel opening hands the cursor back and ends a middle-drag look, so the
    // camera can't keep spinning while the player is clicking around a panel.
    const unsub = useGame.subscribe((state, prev) => {
      if (state.activePanel !== prev.activePanel && state.activePanel !== null) {
        stopLooking();
      }
    });

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', stopLooking);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      offPress();
      unsub();
      touchInput.attack = () => {};
    };
  }, [gl]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = useGame.getState();
    const dead = s.dead;
    // A dead player is frozen exactly as an open panel freezes them: no walking, no
    // jumping, no looking. Gravity still runs so the body settles onto the ground.
    const panelOpen = panelBlocksMovement(s.activePanel) || dead;
    const pos = group.current.position;
    if (debugWarp.x !== null) {
      pos.set(debugWarp.x, getTerrainHeight(debugWarp.x, debugWarp.z) + 0.2, debugWarp.z);
      debugWarp.x = null;
      debugWarp.z = null;
    }

    // ---- input ----
    let moveX = 0;
    let moveZ = 0;
    if (!panelOpen) {
      if (keyHeld('moveForward')) moveZ -= 1;
      if (keyHeld('moveBack')) moveZ += 1;
      if (keyHeld('moveLeft')) moveX -= 1;
      if (keyHeld('moveRight')) moveX += 1;

      // ---- virtual joystick (touch) ----
      moveX += touchInput.moveX;
      moveZ += touchInput.moveZ;

      // ---- look keys: turn the camera without the mouse ----
      const lookSpeed = 1.6 * inputSettings.lookSens; // radians/sec
      const lookY = inputSettings.invertY ? -1 : 1;
      if (keyHeld('lookLeft')) yaw.current += lookSpeed * delta;
      if (keyHeld('lookRight')) yaw.current -= lookSpeed * delta;
      if (keyHeld('lookUp')) pitch.current += lookSpeed * delta * lookY;
      if (keyHeld('lookDown')) pitch.current -= lookSpeed * delta * lookY;
      pitch.current = Math.max(-1.2, Math.min(0.9, pitch.current));
    }

    // ---- touch drag-to-look ----
    if (touchInput.lookDX !== 0 || touchInput.lookDY !== 0) {
      yaw.current -= touchInput.lookDX * 0.0028;
      pitch.current -= touchInput.lookDY * 0.0028;
      pitch.current = Math.max(-1.2, Math.min(0.9, pitch.current));
      touchInput.lookDX = 0;
      touchInput.lookDY = 0;
    }
    const moving = moveX !== 0 || moveZ !== 0;
    const crouching = !panelOpen && keyHeld('crouch');
    const sprinting = !panelOpen && !crouching && moving && keyHeld('sprint') && s.stats.energy > 1;

    // ---- water check ----
    const dxw = pos.x - POND_CENTER[0];
    const dzw = pos.z - POND_CENTER[1];
    const swimming = Math.hypot(dxw, dzw) < POND_RADIUS;
    inWater.current = swimming;

    // ---- what the water does about it ----
    // Purely cosmetic: rings on the surface, a splash going in, and water
    // running off you for a few seconds after you climb out.
    const wq = gfx();
    // Cosmetic only, and deliberately separate from `swimming` above: that one
    // is gameplay - speed, floating, drinking - and is the pond, as it always
    // has been. This is just "are your feet in water", which the river counts
    // for as well.
    const wSurf = waterSurfaceAt(pos.x, pos.z);
    const wading = wSurf !== -Infinity && pos.y < wSurf + 0.55;
    if (wq.waterRipples > 0 || wq.waterSpray > 0) {
      if (wading && !wasInWater.current) {
        spawnRipple(pos.x, pos.z, 0.11);
        emitSpray(pos.x, wSurf + 0.05, pos.z, Math.min(26, wq.waterSpray),
          { speed: 2.6, spread: 0.9, up: 1.1, life: 0.85, radius: 0.3 });
      } else if (!wading && wasInWater.current) {
        wetFor.current = 5.0;
        emitSpray(pos.x, pos.y + 0.9, pos.z, Math.min(14, wq.waterSpray >> 1),
          { speed: 1.2, spread: 0.7, up: 0.5, life: 0.7, radius: 0.28, radiusY: 0.9 });
      }
      if (wading) {
        rippleTimer.current -= delta;
        if (rippleTimer.current <= 0) {
          spawnRipple(pos.x, pos.z, moving ? 0.055 : 0.018);
          rippleTimer.current = moving ? 0.26 : 0.8;
          if (moving) {
            emitSpray(pos.x, wSurf + 0.08, pos.z, 4,
              { speed: 1.4, spread: 1.0, up: 0.7, life: 0.5, radius: 0.26, bright: 0.8 });
          }
        }
      } else if (wetFor.current > 0) {
        // Dripping. Thins out as you dry off.
        wetFor.current -= delta;
        dripTimer.current -= delta;
        if (dripTimer.current <= 0) {
          const left = Math.max(0, wetFor.current) / 5.0;
          dripTimer.current = 0.12 + (1 - left) * 0.45;
          emitSpray(pos.x, pos.y + 0.7 + Math.random() * 0.6, pos.z, 1,
            { speed: 0.12, spread: 0.3, up: 0.1, life: 1.1, radius: 0.22, bright: 0.7 });
        }
      }
    }
    wasInWater.current = wading;

    // ---- speed / meter multiplier ----
    let speed = WALK_SPEED;
    let meterMult = 1;
    if (crouching) {
      speed *= CROUCH_MULT;
      meterMult = 1;
    } else if (sprinting) {
      speed *= SPRINT_MULT;
      meterMult = 1.5;
    }
    if (swimming) {
      speed *= 0.6;
      meterMult = 2;
    }

    // ---- movement ----
    let moved = 0;
    if (moving) {
      const len = Math.hypot(moveX, moveZ) || 1;
      const fwdInput = -moveZ / len; // W = forward
      const rightInput = moveX / len; // D = right

      const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw.current);
      const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, yaw.current);

      const dirX = forward.x * fwdInput + right.x * rightInput;
      const dirZ = forward.z * fwdInput + right.z * rightInput;
      const dirLen = Math.hypot(dirX, dirZ) || 1;

      const stepX = (dirX / dirLen) * speed * delta;
      const stepZ = (dirZ / dirLen) * speed * delta;
      const dep = s.depletedNodes;
      const _now = Date.now();
      // Axis-separated collision so the player can slide along obstacles
      const nx = pos.x + stepX;
      let colX = false;
      for (const o of STATIC_OBSTACLES) {
        if (dep[o.id] && dep[o.id] > _now) continue;
        if (Math.hypot(nx - o.x, pos.z - o.z) < o.r + PLAYER_COLL_R) { colX = true; break; }
      }
      if (!colX && remotePlayer.active) {
        const [rx,,rz] = remotePlayer.position;
        if (Math.hypot(nx - rx, pos.z - rz) < 0.45 + PLAYER_COLL_R) colX = true;
      }
      const nz = pos.z + stepZ;
      let colZ = false;
      for (const o of STATIC_OBSTACLES) {
        if (dep[o.id] && dep[o.id] > _now) continue;
        if (Math.hypot(pos.x - o.x, nz - o.z) < o.r + PLAYER_COLL_R) { colZ = true; break; }
      }
      if (!colZ && remotePlayer.active) {
        const [rx,,rz] = remotePlayer.position;
        if (Math.hypot(pos.x - rx, nz - rz) < 0.45 + PLAYER_COLL_R) colZ = true;
      }
      if (!colX) pos.x = nx;
      if (!colZ) pos.z = nz;
      moved = Math.hypot(colX ? 0 : stepX, colZ ? 0 : stepZ);

      // face movement direction
      group.current.rotation.y = Math.atan2(dirX / dirLen, dirZ / dirLen);

      limbPhase.current += delta * speed * 2.2;
      const swing = Math.sin(limbPhase.current) * (crouching ? 0.3 : 0.6);
      if (leftArm.current) leftArm.current.rotation.x = swing;
      if (rightArm.current) rightArm.current.rotation.x = -swing;
      if (leftLeg.current) leftLeg.current.rotation.x = -swing;
      if (rightLeg.current) rightLeg.current.rotation.x = swing;
    } else {
      const settle = Math.sin(limbPhase.current) * 0.05;
      if (leftArm.current) leftArm.current.rotation.x *= 0.9;
      if (rightArm.current) rightArm.current.rotation.x *= 0.9;
      if (leftLeg.current) leftLeg.current.rotation.x *= 0.9;
      if (rightLeg.current) rightLeg.current.rotation.x *= 0.9;
    }

    if (moved > 0) {
      s.addMeters(moved * meterMult);
    }

    // ---- attack swing animation (overrides walk-cycle arm pose) ----
    if (attackTimer.current > 0) {
      attackTimer.current = Math.max(0, attackTimer.current - delta);
      const progress = 1 - attackTimer.current / ATTACK_DURATION;
      if (rightArm.current) rightArm.current.rotation.x = -Math.sin(progress * Math.PI) * 1.8;
    }

    // ---- first-person weapon view-model: walk bob + poke animation ----
    if (fpWeaponAnim.current) {
      const bobActive = moving && onGround.current && !swimming;
      const bobAmp = sprinting ? 0.09 : 0.05;
      const targetBobX = bobActive ? Math.sin(limbPhase.current) * bobAmp * 0.4 : 0;
      const targetBobY = bobActive ? Math.abs(Math.sin(limbPhase.current)) * bobAmp : 0;

      let pokeOffsetZ = 0;
      let pokeRotX = 0;
      if (attackTimer.current > 0) {
        const progress = 1 - attackTimer.current / ATTACK_DURATION;
        pokeOffsetZ = -Math.sin(progress * Math.PI) * 0.35;
        pokeRotX = -Math.sin(progress * Math.PI) * 0.5;
      }

      const anim = fpWeaponAnim.current;
      anim.position.x += (targetBobX - anim.position.x) * 0.2;
      anim.position.y += (targetBobY - anim.position.y) * 0.2;
      anim.position.z += (pokeOffsetZ - anim.position.z) * 0.5;
      anim.rotation.x += (pokeRotX - anim.rotation.x) * 0.5;
    }

    // ---- crouch height ----
    const targetScaleY = crouching ? 0.72 : 1;
    if (bodyVisual.current) {
      bodyVisual.current.scale.y += (targetScaleY - bodyVisual.current.scale.y) * 0.2;
    }

    // ---- death: topple over and go slack ----
    if (dead) {
      deathTimer.current += delta;
      const t = Math.min(1, deathTimer.current / DEATH_FALL_TIME);
      const fall = 1 - Math.pow(1 - t, 3); // easeOutCubic, so it drops then settles
      if (bodyVisual.current) {
        // The group's pivot is at the feet, so rolling about z lays the body down.
        bodyVisual.current.rotation.z = fall * Math.PI * 0.48;
        bodyVisual.current.rotation.y = fall * 0.35;
        bodyVisual.current.position.y = -fall * 0.22;
        bodyVisual.current.scale.y += (1 - bodyVisual.current.scale.y) * 0.2;
      }
      // Limbs flop rather than holding the walk pose.
      if (leftArm.current) leftArm.current.rotation.x = -fall * 1.0;
      if (rightArm.current) rightArm.current.rotation.x = fall * 0.6;
      if (leftLeg.current) leftLeg.current.rotation.x = fall * 0.45;
      if (rightLeg.current) rightLeg.current.rotation.x = -fall * 0.3;
      // Always third person on death, pulled back a little, so you watch yourself fall.
      // The player's own zoom is remembered and handed back on respawn.
      if (camDistanceBeforeDeath.current === null) camDistanceBeforeDeath.current = camDistance.current;
      cameraMode.current = 'third';
      camDistance.current += (7.5 - camDistance.current) * 0.05;
    }

    // ---- gravity / jump / swim float ----
    if (swimming) {
      velocityY.current = 0;
      // Float just under the surface, but never below the pond floor — otherwise the
      // player's legs disappear through the ground in the shallows at the rim.
      const floorY = getTerrainHeight(pos.x, pos.z);
      const targetY = Math.max(floorY, POND_SURFACE_Y - SWIM_SUBMERSION);
      pos.y += (targetY - pos.y) * 0.1;
      onGround.current = true;
    } else {
      if (keyHeld('jump') && onGround.current && !panelOpen) {
        velocityY.current = JUMP_SPEED;
        onGround.current = false;
      }
      velocityY.current -= GRAVITY * delta;
      pos.y += velocityY.current * delta;
      const groundY = getTerrainHeight(pos.x, pos.z);
      if (pos.y <= groundY) {
        pos.y = groundY;
        velocityY.current = 0;
        onGround.current = true;
      }
    }

    // ---- camera ----
    // camBase holds the camera's unshaken position. The third-person view smooths
    // towards its target by lerping from where the camera already is, so if the shake
    // offset were written straight onto camera.position it would feed back into the
    // next frame's lerp and drag the camera around instead of just rattling it.
    if (camBase.current.lengthSq() === 0) camBase.current.copy(camera.position);
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw.current);
    if (cameraMode.current === 'third') {
      const dist = camDistance.current;
      const camPos = pos.clone();
      camPos.x -= forward.x * dist * Math.cos(pitch.current);
      camPos.z -= forward.z * dist * Math.cos(pitch.current);
      camPos.y += 1.6 + Math.sin(pitch.current) * dist * -1 + dist * 0.5;
      camPos.y = Math.max(camPos.y, getTerrainHeight(camPos.x, camPos.z) + 0.5);
      camBase.current.lerp(camPos, 0.25);
      camera.position.copy(camBase.current);
      // Aimed from the base position, so the shake stays a pure translation rather
      // than the look-at quietly cancelling it out.
      camera.lookAt(pos.x, pos.y + (dead ? 0.6 : 1.4), pos.z);
      bodyVisual.current && (bodyVisual.current.visible = true);
    } else {
      camBase.current.set(pos.x, pos.y + 1.6, pos.z);
      camera.position.copy(camBase.current);
      camera.rotation.order = 'YXZ';
      camera.rotation.y = yaw.current;
      camera.rotation.x = pitch.current;
      camera.rotation.z = 0;
      bodyVisual.current && (bodyVisual.current.visible = false);
    }

    // ---- screen shake from taking a hit ----
    // After the camera is placed and aimed, but before the first-person weapon reads
    // camera.position below, so the held weapon rattles along with the view.
    applyScreenShake(camera, delta);

    // ---- first-person held weapon view-model ----
    if (fpWeapon.current) {
      if (cameraMode.current === 'first' && equippedWeaponId) {
        fpWeapon.current.visible = true;
        fpWeapon.current.quaternion.copy(camera.quaternion);
        const handOffset = new THREE.Vector3(0.35, -0.32, -0.5).applyQuaternion(camera.quaternion);
        fpWeapon.current.position.copy(camera.position).add(handOffset);
      } else {
        fpWeapon.current.visible = false;
      }
    }

    // ---- survival stat ticking ----
    // Skipped while dead: the regen branch below would otherwise lift health back off
    // zero and leave the player walking around flagged as dead.
    if (!dead) {
      statTimer.current += delta;
      if (sprinting) s.adjustStat('energy', -delta * 6);
      if (statTimer.current > 1) {
        statTimer.current = 0;
        s.adjustStat('hunger', -0.08);
        s.adjustStat('thirst', -0.12);
        if (!sprinting) s.adjustStat('energy', crouching ? 0.5 : 1);
        if (s.stats.hunger <= 0 || s.stats.thirst <= 0) s.adjustStat('health', -1);
        else if (s.stats.health < 100) s.adjustStat('health', 0.2);
        // night drains warmth slowly
        const t = s.timeOfDay;
        if (t < 5 || t > 20) s.adjustStat('warmth', -0.6);
        else s.adjustStat('warmth', 0.4);
      }
    }

    // ---- share transform for building placement ----
    playerTransform.position[0] = pos.x;
    playerTransform.position[1] = pos.y;
    playerTransform.position[2] = pos.z;
    playerTransform.yaw = yaw.current;

    // ---- nearby interactables ----
    const near = findNearest([pos.x, pos.y, pos.z]);
    const nearId = near ? near.id : null;
    if (nearId !== lastNearId.current) {
      lastNearId.current = nearId;
      s.setNearInteractable(near);
    }

    s.tickRespawns();

    // ---- multiplayer: broadcast our transform a few times a second ----
    mpSendTimer.current += delta;
    if (mpSendTimer.current > 0.08) {
      mpSendTimer.current = 0;
      mpSend({
        t: 'state',
        position: [pos.x, pos.y, pos.z],
        yaw: group.current.rotation.y,
        moving,
        sprinting,
        crouching,
        equippedWeaponId,
      });

      // Host: keep the joiner's rival tribe camps in sync (positions, health, captures).
      if (s.mpRole === 'host') {
        mpSend({
          t: 'tribeSync',
          members: tribeMemberSyncData,
          tribeMemberState: s.tribeMemberState,
          capturedTribes: s.capturedTribes,
          activeTribeIds: s.activeTribeIds,
          raid: s.raid,
          distantRaid: s.distantRaid,
          interTribalRaid: s.interTribalRaid,
        });
      }
    }
  });

  return html`
    <${Fragment}>
    <group ref=${group} position=${PLAYER_SPAWN}>
      <${ContactShadow} radius=${0.44} />
      <group ref=${bodyVisual}>
        <${HumanFigure}
          skinKey="skinPale"
          clothColor="#3f6b8a"
          accentColor="#8a6a3c"
          hairColor="#2b1b10"
          armL=${leftArm} armR=${rightArm}
          legL=${leftLeg} legR=${rightLeg}
          weapon=${equippedWeaponId || null}
          face=${-1}
          torsoWrap=${true}
        />
      </group>
    </group>
    <group ref=${fpWeapon} visible=${false}>
      <group ref=${fpWeaponAnim}>
        <group rotation=${[0, Math.PI, 0]}>
          ${equippedWeaponId && html`<${HeldWeapon} id=${equippedWeaponId} />`}
        </group>
      </group>
    </group>
    <//>
  `;
}


export {
  WALK_SPEED,
  SPRINT_MULT,
  CROUCH_MULT,
  JUMP_SPEED,
  GRAVITY,
  SWIM_SUBMERSION,
  DEATH_FALL_TIME,
  UP,
  triggerWeaponFx,
  HeldWeapon,
  Player,
};
