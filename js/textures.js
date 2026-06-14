import * as THREE from 'three';

// Procedural canvas textures - no image assets.

export function createGrassTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#3f7d3a';
  ctx.fillRect(0, 0, size, size);

  // speckle variation
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = Math.random();
    ctx.fillStyle = shade > 0.5
      ? `rgba(60, 110, 50, ${0.2 + Math.random() * 0.3})`
      : `rgba(30, 70, 30, ${0.2 + Math.random() * 0.3})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // patches of dirt
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 4 + Math.random() * 10;
    ctx.fillStyle = 'rgba(110, 80, 45, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createBarkTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#5a3c22';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < size; i += 3) {
    ctx.fillStyle = `rgba(40, 25, 15, ${0.2 + Math.random() * 0.3})`;
    ctx.fillRect(0, i, size, 1 + Math.random() * 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createWaterTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#1a6fa3');
  grad.addColorStop(1, '#2f9bd6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 200; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.1})`;
    ctx.beginPath();
    const y = Math.random() * size;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.3, y + 5, size * 0.7, y - 5, size, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  return tex;
}
