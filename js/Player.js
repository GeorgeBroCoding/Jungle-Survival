import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import html from './html.js';
import { useGame } from './store.js';
import { isKeyDown, onKeyPress } from './keyboard.js';
import { findNearest } from './interactions.js';

const WALK_SPEED = 4;
const SPRINT_MULT = 1.8;
const CROUCH_MULT = 0.5;
const JUMP_SPEED = 6.5;
const GRAVITY = 22;

const POND_CENTER = [40, -40];
const POND_RADIUS = 18;

const UP = new THREE.Vector3(0, 1, 0);

export default function Player() {
  const { camera, gl } = useThree();
  const group = useRef();
  const leftArm = useRef();
  const rightArm = useRef();
  const leftLeg = useRef();
  const rightLeg = useRef();
  const bodyVisual = useRef();

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

  useEffect(() => {
    const canvas = gl.domElement;
    const onClick = () => {
      if (useGame.getState().activePanel === null) canvas.requestPointerLock();
    };
    const onMouseMove = (e) => {
      if (document.pointerLockElement !== canvas) return;
      yaw.current -= e.movementX * 0.0022;
      pitch.current -= e.movementY * 0.0022;
      pitch.current = Math.max(-1.2, Math.min(0.9, pitch.current));
    };
    const onWheel = (e) => {
      camDistance.current = Math.max(2, Math.min(12, camDistance.current + e.deltaY * 0.01));
    };

    canvas.addEventListener('click', onClick);
    document.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('wheel', onWheel, { passive: true });

    const offPress = onKeyPress((code) => {
      const s = useGame.getState();

      if (code === 'KeyC') {
        cameraMode.current = cameraMode.current === 'third' ? 'first' : 'third';
      }
      if (code === 'Tab') {
        s.setActivePanel(s.activePanel === 'inventory' ? null : 'inventory');
      }
      if (code === 'Escape' && s.activePanel) {
        s.setActivePanel(null);
      }
      if (code === 'KeyE' || code === 'KeyR') {
        const near = s.nearInteractable;
        if (near && near.key === code) near.onInteract();
      }
      if (code === 'KeyF') {
        const near = s.nearInteractable;
        if (near && near.key === 'KeyF') {
          near.onInteract();
        } else if (inWater.current) {
          s.adjustStat('thirst', 35);
          s.addToast('Drank water (+35 thirst)');
        }
      }
      if (code === 'KeyQ') {
        s.setActiveHotbarSlot((s.activeHotbarSlot + 1) % s.hotbarSlots.length);
      }
      if (code === 'KeyB') s.addToast('Base building menu coming soon');
      if (code === 'KeyM') s.addToast('Full jungle map coming soon');
    });

    // Exit pointer lock whenever a panel opens
    const unsub = useGame.subscribe((state, prev) => {
      if (state.activePanel !== prev.activePanel && state.activePanel !== null) {
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      }
    });

    return () => {
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      offPress();
      unsub();
    };
  }, [gl]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = useGame.getState();
    const panelOpen = s.activePanel !== null;
    const pos = group.current.position;

    // ---- input ----
    let moveX = 0;
    let moveZ = 0;
    if (!panelOpen) {
      if (isKeyDown('KeyW')) moveZ -= 1;
      if (isKeyDown('KeyS')) moveZ += 1;
      if (isKeyDown('KeyA')) moveX -= 1;
      if (isKeyDown('KeyD')) moveX += 1;
    }
    const moving = moveX !== 0 || moveZ !== 0;
    const crouching = !panelOpen && isKeyDown('ControlLeft');
    const sprinting = !panelOpen && !crouching && moving && isKeyDown('ShiftLeft') && s.stats.energy > 1;

    // ---- water check ----
    const dxw = pos.x - POND_CENTER[0];
    const dzw = pos.z - POND_CENTER[1];
    const swimming = Math.hypot(dxw, dzw) < POND_RADIUS;
    inWater.current = swimming;

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
      pos.x += stepX;
      pos.z += stepZ;
      moved = Math.hypot(stepX, stepZ);

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

    // ---- crouch height ----
    const targetScaleY = crouching ? 0.72 : 1;
    if (bodyVisual.current) {
      bodyVisual.current.scale.y += (targetScaleY - bodyVisual.current.scale.y) * 0.2;
    }

    // ---- gravity / jump / swim float ----
    if (swimming) {
      velocityY.current = 0;
      pos.y += (-0.3 - pos.y) * 0.1;
      onGround.current = true;
    } else {
      if (isKeyDown('Space') && onGround.current && !panelOpen) {
        velocityY.current = JUMP_SPEED;
        onGround.current = false;
      }
      velocityY.current -= GRAVITY * delta;
      pos.y += velocityY.current * delta;
      if (pos.y <= 0) {
        pos.y = 0;
        velocityY.current = 0;
        onGround.current = true;
      }
    }

    // ---- camera ----
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw.current);
    if (cameraMode.current === 'third') {
      const dist = camDistance.current;
      const camPos = pos.clone();
      camPos.x -= forward.x * dist * Math.cos(pitch.current);
      camPos.z -= forward.z * dist * Math.cos(pitch.current);
      camPos.y += 1.6 + Math.sin(pitch.current) * dist * -1 + dist * 0.5;
      camera.position.lerp(camPos, 0.25);
      camera.lookAt(pos.x, pos.y + 1.4, pos.z);
      bodyVisual.current && (bodyVisual.current.visible = true);
    } else {
      camera.position.set(pos.x, pos.y + 1.6, pos.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.y = yaw.current;
      camera.rotation.x = pitch.current;
      camera.rotation.z = 0;
      bodyVisual.current && (bodyVisual.current.visible = false);
    }

    // ---- survival stat ticking ----
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

    // ---- nearby interactables ----
    const near = findNearest([pos.x, pos.y, pos.z]);
    const nearId = near ? near.id : null;
    if (nearId !== lastNearId.current) {
      lastNearId.current = nearId;
      s.setNearInteractable(near);
    }

    s.tickRespawns();
  });

  return html`
    <group ref=${group} position=${[0, 0, 8]}>
      <group ref=${bodyVisual}>
        <!-- torso -->
        <mesh position=${[0, 1.1, 0]} castShadow=${true}>
          <capsuleGeometry args=${[0.28, 0.6, 4, 8]} />
          <meshStandardMaterial color="#3f6b8a" roughness=${0.7} />
        </mesh>
        <!-- head -->
        <mesh position=${[0, 1.78, 0]} castShadow=${true}>
          <sphereGeometry args=${[0.24, 12, 12]} />
          <meshStandardMaterial color="#d8a878" roughness=${0.8} />
        </mesh>
        <!-- left arm -->
        <group ref=${leftArm} position=${[0.36, 1.35, 0]}>
          <mesh position=${[0, -0.32, 0]} castShadow=${true}>
            <capsuleGeometry args=${[0.08, 0.5, 4, 6]} />
            <meshStandardMaterial color="#d8a878" roughness=${0.8} />
          </mesh>
        </group>
        <!-- right arm -->
        <group ref=${rightArm} position=${[-0.36, 1.35, 0]}>
          <mesh position=${[0, -0.32, 0]} castShadow=${true}>
            <capsuleGeometry args=${[0.08, 0.5, 4, 6]} />
            <meshStandardMaterial color="#d8a878" roughness=${0.8} />
          </mesh>
        </group>
        <!-- left leg -->
        <group ref=${leftLeg} position=${[0.14, 0.75, 0]}>
          <mesh position=${[0, -0.35, 0]} castShadow=${true}>
            <capsuleGeometry args=${[0.1, 0.55, 4, 6]} />
            <meshStandardMaterial color="#5a4632" roughness=${0.8} />
          </mesh>
        </group>
        <!-- right leg -->
        <group ref=${rightLeg} position=${[-0.14, 0.75, 0]}>
          <mesh position=${[0, -0.35, 0]} castShadow=${true}>
            <capsuleGeometry args=${[0.1, 0.55, 4, 6]} />
            <meshStandardMaterial color="#5a4632" roughness=${0.8} />
          </mesh>
        </group>
      </group>
    </group>
  `;
}
