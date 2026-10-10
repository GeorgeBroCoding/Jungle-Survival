import { html, useEffect, useRef, useState } from './core.js';
import { BASE_CENTER, DISTANT_TRIBES, ENEMY_TRIBES, FRIEND_BASE_CENTER, MAP_CAVE_MOUTHS, PLAYER_TRIBE_COLOR, POND_CENTER, POND_RADIUS, RESOURCES } from './data.js';
import { Cave, Resources } from './entities.js';
import { keyLabel } from './keybinds.js';
import { KITO_POS, Kito, WORKBENCH_POS } from './kito.js';
import { playerTransform, remotePlayer } from './multiplayer.js';
import { entityRegistry } from './shake.js';
import { useGame } from './store.js';
import { getBiomeColor, getTerrainHeight } from './terrain.js';
import { Raiders } from './tribes.js';

// Map.js - top-down world map
// ============================================================
const MAP_EXTENT = 240;        // world units drawn out from the origin, each way
const MAP_PX = 592;            // canvas resolution (CSS-scaled to the panel width)
// Terrain raster resolution: built once (~120ms) and shared by the minimap and the
// full map. 480 cells over 480m is 1 m per cell, just finer than the minimap's
// ~1.13 m per pixel, so the minimap never upscales it. The start screen warms it up
// so that cost lands while the player is reading, not as a hitch on spawn.
const MAP_TERRAIN_CELLS = 480;
const MAP_MIN_SCALE = 1;
const MAP_MAX_SCALE = 5;


// The terrain layer never changes, so rasterise it once into an offscreen canvas
// and blit it under the live markers each frame.
let mapTerrainCanvas = null;
function getMapTerrainCanvas() {
  if (mapTerrainCanvas) return mapTerrainCanvas;
  const n = MAP_TERRAIN_CELLS;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(n, n);
  const step = (MAP_EXTENT * 2) / n;
  for (let j = 0; j < n; j++) {
    const z = -MAP_EXTENT + (j + 0.5) * step;
    for (let i = 0; i < n; i++) {
      const x = -MAP_EXTENT + (i + 0.5) * step;
      const h = getTerrainHeight(x, z);
      // Crude hill-shading: a light from the north-west, plus altitude lightening,
      // so the hills and the mountain ring read as relief rather than flat colour.
      const slope = (getTerrainHeight(x + step, z) - h) + (getTerrainHeight(x, z + step) - h);
      let shade = 1 + Math.max(-0.5, Math.min(0.5, slope * 0.45)) + Math.min(0.3, h * 0.014);
      let [r, g, b] = getBiomeColor(x, z);
      const pondDist = Math.hypot(x - POND_CENTER[0], z - POND_CENTER[1]);
      if (pondDist < POND_RADIUS) {
        const t = Math.min(1, (POND_RADIUS - pondDist) / 5);
        r = r * (1 - t) + 0.11 * t;
        g = g * (1 - t) + 0.33 * t;
        b = b * (1 - t) + 0.56 * t;
        shade = 1;
      }
      const o = (j * n + i) * 4;
      img.data[o] = Math.max(0, Math.min(255, r * shade * 255));
      img.data[o + 1] = Math.max(0, Math.min(255, g * shade * 255));
      img.data[o + 2] = Math.max(0, Math.min(255, b * shade * 255));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  mapTerrainCanvas = cv;
  return cv;
}

// Shared by the minimap and the full map: the live markers both want to draw, in
// back-to-front order. `ctx` is already translated so world → canvas is toX/toY.
// `small` trims the detail that only makes sense at full-map size.
function drawMapMarkers(ctx, toX, toY, world, opts) {
  const { small = false, onScreen, scale = 1 } = opts;

  const dot = (sx, sy, r, fill, stroke) => {
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.lineWidth = small ? 1 : 1.5; ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  const diamond = (sx, sy, r, fill, stroke) => {
    ctx.beginPath();
    ctx.moveTo(sx, sy - r);
    ctx.lineTo(sx + r, sy);
    ctx.lineTo(sx, sy + r);
    ctx.lineTo(sx - r, sy);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.lineWidth = small ? 1 : 1.5; ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  const caption = (text, sx, sy, color, size = 10) => {
    if (small) return;
    ctx.font = `600 ${size}px 'Segoe UI', Tahoma, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(text, sx, sy);
    ctx.fillStyle = color;
    ctx.fillText(text, sx, sy);
  };

  // ---- resource nodes (full map only, and only when asked: there are ~80) ----
  if (!small && world.showResources) {
    for (const node of world.resourceNodes) {
      if (world.depletedNodes[node.id]) continue;
      const sx = toX(node.position[0]), sy = toY(node.position[2]);
      if (!onScreen(sx, sy, 2)) continue;
      dot(sx, sy, 2, RESOURCES[node.type]?.color || '#ffffff');
    }
  }

  // ---- caves ----
  for (const mouth of MAP_CAVE_MOUTHS) {
    const sx = toX(mouth.x), sy = toY(mouth.z);
    if (!onScreen(sx, sy)) continue;
    dot(sx, sy, small ? 3.5 : 5, '#241f2e', '#cfc7e0');
    if (!small) {
      dot(sx, sy, 1.8, '#cfc7e0');
      if (scale >= 1.8) caption('Cave', sx, sy + 15, '#d8d0e8', 9);
    }
  }

  // ---- the player's own buildings ----
  for (const b of world.buildings) {
    const sx = toX(b.position[0]), sy = toY(b.position[2]);
    if (!onScreen(sx, sy)) continue;
    const half = small ? 1.8 : 2.5;
    ctx.fillStyle = '#f4ecd8';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1;
    ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
    ctx.strokeRect(sx - half, sy - half, half * 2, half * 2);
  }

  // ---- Kito and the workbench ----
  const kitoX = toX(KITO_POS[0]), kitoY = toY(KITO_POS[2]);
  if (onScreen(kitoX, kitoY)) {
    dot(kitoX, kitoY, small ? 3.5 : 5, '#7fd8d8', 'rgba(0,0,0,0.8)');
    if (scale >= 1.5) caption('Kito', kitoX, kitoY - 9, '#9fe8e8', 9);
  }
  const benchX = toX(WORKBENCH_POS[0]), benchY = toY(WORKBENCH_POS[2]);
  if (onScreen(benchX, benchY)) {
    dot(benchX, benchY, small ? 3 : 4, '#b98a4a', 'rgba(0,0,0,0.8)');
    if (scale >= 1.5) caption('Workbench', benchX, benchY + 14, '#d8ab6a', 9);
  }

  // ---- rival tribe camps ----
  for (const tribe of ENEMY_TRIBES) {
    if (!world.activeTribeIds.includes(tribe.id)) continue;
    const sx = toX(tribe.campPosition[0]), sy = toY(tribe.campPosition[2]);
    if (!onScreen(sx, sy, 40)) continue;
    const captured = !!world.capturedTribes[tribe.id];
    const ownerId = world.campOwners[tribe.id];
    const owner = ownerId ? ENEMY_TRIBES.find((t) => t.id === ownerId) : null;
    const color = captured ? PLAYER_TRIBE_COLOR : (owner ? owner.color : tribe.color);
    dot(sx, sy, small ? 5 : 7, color, 'rgba(0,0,0,0.85)');
    if (captured) {
      ctx.beginPath();
      ctx.arc(sx, sy, small ? 7.5 : 10, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PLAYER_TRIBE_COLOR;
      ctx.stroke();
    }
    caption(captured ? `${tribe.name} (yours)` : tribe.name, sx, sy - 12, color, 9);
  }

  // ---- distant tribes: never capturable, always a threat ----
  for (const tribe of DISTANT_TRIBES) {
    const sx = toX(tribe.campPosition[0]), sy = toY(tribe.campPosition[2]);
    if (!onScreen(sx, sy, 40)) continue;
    diamond(sx, sy, small ? 5 : 7, tribe.color, 'rgba(0,0,0,0.85)');
    caption(tribe.name, sx, sy - 12, tribe.color, 9);
  }

  // ---- your home camp ----
  const baseX = toX(BASE_CENTER[0]), baseY = toY(BASE_CENTER[2]);
  if (onScreen(baseX, baseY, 40)) {
    dot(baseX, baseY, small ? 6 : 8, PLAYER_TRIBE_COLOR, '#1b150f');
    caption('★', baseX, baseY + 4, '#1b150f', 11);
    caption('Your camp', baseX, baseY - 13, PLAYER_TRIBE_COLOR, 9);
  }
  if (world.mpStatus === 'connected') {
    const fx = toX(FRIEND_BASE_CENTER[0]), fy = toY(FRIEND_BASE_CENTER[2]);
    if (onScreen(fx, fy, 40)) {
      dot(fx, fy, small ? 4.5 : 6, '#6ad8ff', '#1b150f');
      caption("Friend's camp", fx, fy - 11, '#9fe4ff', 9);
    }
  }

  // ---- wildlife ----
  for (const id in entityRegistry.animals) {
    const pos = entityRegistry.animals[id];
    if (!pos) continue;
    const sx = toX(pos.x), sy = toY(pos.z);
    if (!onScreen(sx, sy, 2)) continue;
    dot(sx, sy, small ? 2 : 2.5, '#c98a5a', 'rgba(0,0,0,0.6)');
  }

  // ---- raiders currently on the march ----
  const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 180);
  for (const group of ['raiders', 'distantRaiders', 'interTribalRaiders']) {
    for (const id in entityRegistry[group]) {
      const pos = entityRegistry[group][id];
      if (!pos) continue;
      const sx = toX(pos.x), sy = toY(pos.z);
      if (!onScreen(sx, sy, 2)) continue;
      dot(sx, sy, small ? 2.8 : 3.5, `rgba(255,70,50,${pulse.toFixed(2)})`, 'rgba(0,0,0,0.7)');
    }
  }

  // ---- the other player ----
  if (remotePlayer.active) {
    const sx = toX(remotePlayer.position[0]), sy = toY(remotePlayer.position[2]);
    if (onScreen(sx, sy)) {
      dot(sx, sy, small ? 4 : 5, '#6ad8ff', '#07242e');
      caption('Friend', sx, sy - 10, '#9fe4ff', 9);
    }
  }
}

// The white arrow for the player, pointing where they're actually facing.
function drawPlayerArrow(ctx, sx, sy, yaw, tip) {
  const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
  const back = tip * 0.67;
  ctx.beginPath();
  ctx.moveTo(sx + fwdX * tip, sy + fwdZ * tip);
  ctx.lineTo(sx - fwdX * back - fwdZ * back * 0.75, sy - fwdZ * back + fwdX * back * 0.75);
  ctx.lineTo(sx - fwdX * back + fwdZ * back * 0.75, sy - fwdZ * back - fwdX * back * 0.75);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1b150f';
  ctx.stroke();
}

// ============================================================
// Minimap.js - always-on circular minimap, north up
// ============================================================
const MINIMAP_PX = 168;    // canvas resolution, matching the CSS size 1:1
const MINIMAP_RANGE = 95;  // world metres from the centre to the rim

function Minimap() {
  const setActivePanel = useGame((s) => s.setActivePanel);
  const activePanel = useGame((s) => s.activePanel);
  const activeTribeIds = useGame((s) => s.activeTribeIds);
  const capturedTribes = useGame((s) => s.capturedTribes);
  const campOwners = useGame((s) => s.campOwners);
  const buildings = useGame((s) => s.buildings);
  const mpStatus = useGame((s) => s.mpStatus);
  const canvasRef = useRef(null);
  const coordsRef = useRef(null);

  const worldRef = useRef(null);
  worldRef.current = {
    activeTribeIds, capturedTribes, campOwners, buildings, mpStatus,
    resourceNodes: [], depletedNodes: {}, showResources: false,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const terrain = getMapTerrainCanvas();
    const R = MINIMAP_PX / 2;
    const ppu = R / MINIMAP_RANGE;
    let raf = 0;
    let lastCoords = '';

    const draw = () => {
      const world = worldRef.current;
      const [px, , pz] = playerTransform.position;
      const toX = (x) => R + (x - px) * ppu;
      const toY = (z) => R + (z - pz) * ppu;
      // Anything beyond the rim is off the minimap entirely.
      const onScreen = (sx, sy) => Math.hypot(sx - R, sy - R) <= R - 1;

      ctx.save();
      ctx.beginPath();
      ctx.arc(R, R, R, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = '#0a140a';
      ctx.fillRect(0, 0, MINIMAP_PX, MINIMAP_PX);
      ctx.imageSmoothingEnabled = true;
      const span = MAP_EXTENT * 2 * ppu;
      ctx.drawImage(terrain, toX(-MAP_EXTENT), toY(-MAP_EXTENT), span, span);

      drawMapMarkers(ctx, toX, toY, world, { small: true, onScreen, scale: 0 });

      // Raiders off the edge get pinned to the rim, so a raid always shows you
      // which way it's coming from even before it's in range.
      for (const group of ['raiders', 'distantRaiders']) {
        for (const id in entityRegistry[group]) {
          const pos = entityRegistry[group][id];
          if (!pos) continue;
          const dx = pos.x - px, dz = pos.z - pz;
          const d = Math.hypot(dx, dz);
          if (d <= MINIMAP_RANGE || d === 0) continue; // already drawn in place
          const k = (R - 6) / (d * ppu);
          ctx.beginPath();
          ctx.arc(R + dx * ppu * k, R + dz * ppu * k, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,70,50,0.8)';
          ctx.fill();
        }
      }

      drawPlayerArrow(ctx, R, R, playerTransform.yaw, 7);
      ctx.restore();

      // Inner rim shading, drawn outside the clip so it reads as a lens edge.
      ctx.beginPath();
      ctx.arc(R, R, R - 1, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.stroke();

      const coords = `${Math.round(px)}, ${Math.round(pz)}`;
      if (coords !== lastCoords && coordsRef.current) {
        coordsRef.current.textContent = coords;
        lastCoords = coords;
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return html`
    <div
      class="minimap"
      title="Open the full map"
      onClick=${() => setActivePanel(activePanel === 'map' ? null : 'map')}
    >
      <canvas ref=${canvasRef} width=${MINIMAP_PX} height=${MINIMAP_PX}></canvas>
      <div class="mm-tick">N</div>
      <div class="mm-coords" ref=${coordsRef}>0, 0</div>
    </div>
  `;
}

function MapPanel() {
  const setActivePanel = useGame((s) => s.setActivePanel);
  const keybinds = useGame((s) => s.keybinds);
  const activeTribeIds = useGame((s) => s.activeTribeIds);
  const capturedTribes = useGame((s) => s.capturedTribes);
  const campOwners = useGame((s) => s.campOwners);
  const buildings = useGame((s) => s.buildings);
  const resourceNodes = useGame((s) => s.resourceNodes);
  const depletedNodes = useGame((s) => s.depletedNodes);
  const mpStatus = useGame((s) => s.mpStatus);
  const [showResources, setShowResources] = useState(false);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef(null);
  const view = useRef({ cx: 0, cz: 0, scale: 1 });

  // The draw loop reads world state through a ref, so it never has to be torn
  // down and rebuilt when a tribe spawns or a building goes up.
  const worldRef = useRef(null);
  worldRef.current = {
    activeTribeIds, capturedTribes, campOwners, buildings,
    resourceNodes, depletedNodes, showResources, mpStatus,
  };

  const clampView = () => {
    const v = view.current;
    v.scale = Math.max(MAP_MIN_SCALE, Math.min(MAP_MAX_SCALE, v.scale));
    const span = MAP_EXTENT / v.scale;
    const limit = Math.max(0, MAP_EXTENT - span);
    v.cx = Math.max(-limit, Math.min(limit, v.cx));
    v.cz = Math.max(-limit, Math.min(limit, v.cz));
  };

  const centerOnPlayer = () => {
    // At fit zoom the whole jungle is already on screen and panning is pinned to
    // the origin, so centering only means anything once we've zoomed in a little.
    if (view.current.scale < 2.2) view.current.scale = 2.2;
    view.current.cx = playerTransform.position[0];
    view.current.cz = playerTransform.position[2];
    clampView();
  };
  const fitWorld = () => {
    view.current.cx = 0;
    view.current.cz = 0;
    view.current.scale = 1;
  };
  const zoomBy = (factor) => {
    view.current.scale *= factor;
    clampView();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const terrain = getMapTerrainCanvas();
    let raf = 0;

    const draw = () => {
      const v = view.current;
      const world = worldRef.current;
      const ppu = (MAP_PX / (MAP_EXTENT * 2)) * v.scale;
      const toX = (x) => MAP_PX / 2 + (x - v.cx) * ppu;
      const toY = (z) => MAP_PX / 2 + (z - v.cz) * ppu;
      const onScreen = (sx, sy, pad = 8) =>
        sx >= -pad && sy >= -pad && sx <= MAP_PX + pad && sy <= MAP_PX + pad;

      ctx.fillStyle = '#0a140a';
      ctx.fillRect(0, 0, MAP_PX, MAP_PX);

      // ---- terrain ----
      ctx.imageSmoothingEnabled = true;
      const x0 = toX(-MAP_EXTENT), y0 = toY(-MAP_EXTENT);
      ctx.drawImage(terrain, x0, y0, toX(MAP_EXTENT) - x0, toY(MAP_EXTENT) - y0);

      // ---- 50m graticule ----
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      for (let g = -MAP_EXTENT; g <= MAP_EXTENT; g += 50) {
        const gx = toX(g), gy = toY(g);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, MAP_PX); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(MAP_PX, gy); ctx.stroke();
      }

      drawMapMarkers(ctx, toX, toY, world, { onScreen, scale: v.scale });

      // ---- you, pointing where you're facing ----
      const [px, , pz] = playerTransform.position;
      drawPlayerArrow(ctx, toX(px), toY(pz), playerTransform.yaw, 9);

      // ---- readouts ----
      ctx.font = "600 11px 'Segoe UI', Tahoma, sans-serif";
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      const readout = `X ${Math.round(px)}   Z ${Math.round(pz)}   ·   ${v.scale.toFixed(1)}x`;
      ctx.strokeText(readout, 10, MAP_PX - 10);
      ctx.fillStyle = '#ffe27a';
      ctx.fillText(readout, 10, MAP_PX - 10);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    // ---- zoom / pan ----
    // Wheel and drag are wired by hand so the wheel can preventDefault (otherwise
    // it scrolls the panel behind the map) and so dragging survives leaving the canvas.
    const pxPerWorld = () => (MAP_PX / (MAP_EXTENT * 2)) * view.current.scale;
    const canvasPoint = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * MAP_PX,
        y: ((e.clientY - rect.top) / rect.height) * MAP_PX,
      };
    };
    const onWheel = (e) => {
      e.preventDefault();
      const v = view.current;
      const p = canvasPoint(e);
      // World point under the cursor, held fixed across the zoom.
      const wx = v.cx + (p.x - MAP_PX / 2) / pxPerWorld();
      const wz = v.cz + (p.y - MAP_PX / 2) / pxPerWorld();
      v.scale *= e.deltaY < 0 ? 1.12 : 1 / 1.12;
      clampView();
      v.cx = wx - (p.x - MAP_PX / 2) / pxPerWorld();
      v.cz = wz - (p.y - MAP_PX / 2) / pxPerWorld();
      clampView();
    };

    let dragFrom = null;
    const onPointerDown = (e) => {
      dragFrom = { x: e.clientX, y: e.clientY, cx: view.current.cx, cz: view.current.cz };
      setDragging(true);
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!dragFrom) return;
      const rect = canvas.getBoundingClientRect();
      const perWorld = pxPerWorld() * (rect.width / MAP_PX);
      view.current.cx = dragFrom.cx - (e.clientX - dragFrom.x) / perWorld;
      view.current.cz = dragFrom.cz - (e.clientY - dragFrom.y) / perWorld;
      clampView();
    };
    const onPointerUp = () => {
      if (!dragFrom) return;
      dragFrom = null;
      setDragging(false);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  return html`
    <div class="panel-overlay" onClick=${() => setActivePanel(null)}>
      <div class="panel panel-wide" onClick=${(e) => e.stopPropagation()}>
        <h2>Jungle Map</h2>
        <div class="map-wrap">
          <canvas
            class="map-canvas ${dragging ? 'dragging' : ''}"
            ref=${canvasRef}
            width=${MAP_PX}
            height=${MAP_PX}
          ></canvas>
          <div class="map-compass">N ↑</div>
        </div>
        <div class="map-toolbar">
          <button class="buy-btn" onClick=${centerOnPlayer}>Center on me</button>
          <button class="buy-btn" onClick=${fitWorld}>Whole jungle</button>
          <button class="buy-btn" onClick=${() => zoomBy(1 / 1.4)}>−</button>
          <button class="buy-btn" onClick=${() => zoomBy(1.4)}>+</button>
          <label class="spacer">
            <input type="checkbox" checked=${showResources} onChange=${(e) => setShowResources(e.target.checked)} />
            Resources
          </label>
        </div>
        <div class="map-legend">
          <span><i style=${{ background: '#ffffff' }}></i>You</span>
          <span><i style=${{ background: PLAYER_TRIBE_COLOR }}></i>Your camp / captured</span>
          <span><i style=${{ background: '#c2453b' }}></i>Rival camp (tribe colour)</span>
          <span><i style=${{ background: '#8b1a1a', borderRadius: '2px' }}></i>Distant tribe (diamond)</span>
          <span><i style=${{ background: '#ff4632' }}></i>Raiders marching</span>
          <span><i style=${{ background: '#c98a5a' }}></i>Wildlife</span>
          <span><i style=${{ background: '#7fd8d8' }}></i>Kito</span>
          <span><i style=${{ background: '#241f2e' }}></i>Cave (silver / gold)</span>
        </div>
        <p class="close-hint">
          Scroll to zoom, drag to pan · you can still walk around with
          ${keyLabel(keybinds.moveForward)}${keyLabel(keybinds.moveLeft)}${keyLabel(keybinds.moveBack)}${keyLabel(keybinds.moveRight)}
          while this is open · ${keyLabel(keybinds.map)} or Esc to close
        </p>
      </div>
    </div>
  `;
}

// ============================================================

export {
  MAP_EXTENT,
  MAP_PX,
  MAP_TERRAIN_CELLS,
  MAP_MIN_SCALE,
  MAP_MAX_SCALE,
  mapTerrainCanvas,
  getMapTerrainCanvas,
  drawMapMarkers,
  drawPlayerArrow,
  MINIMAP_PX,
  MINIMAP_RANGE,
  Minimap,
  MapPanel,
};
