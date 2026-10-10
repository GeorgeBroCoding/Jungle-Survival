import { THREE, html, useEffect, useFrame, useMemo, useRef, useThree } from './core.js';
import { mulberry32 } from './data.js';
import { GRAPHICS_PRESETS, gfx } from './graphics.js';
import { emitSpray, wrapHalf } from './grass.js';
import { playerTransform } from './multiplayer.js';
import { skyRuntime } from './runtime.js';
import { useGame } from './store.js';
import { getTerrainHeight, waterSurfaceAt } from './terrain.js';
import { spawnRipple, waterRuntime } from './water.js';
import { windUniforms } from './wind.js';

// ============================================================
// weather.js - rain, wetness, lightning and the wind that ties them together
//
// The one thing that makes weather read as weather rather than as a particle
// effect is that everything moves together. A squall here raises the wind,
// which leans the trees, roughens the water, tilts the rain and drives the
// spray; the rain wets every surface, which darkens and gloss them; the wet
// dries off over minutes once it stops. One state object drives all of it, and
// every other system reads from it rather than keeping its own weather.
// ============================================================

// How a storm evolves. Real weather is not a sine wave - it builds, sits, and
// clears - so this is a small state machine with dwell times rather than a
// smooth oscillation.
const WEATHER_STATES = {
  clear: { rain: 0.0, wind: 0.055, cloud: 0.18, dwell: [90, 220] },
  breezy: { rain: 0.0, wind: 0.14, cloud: 0.42, dwell: [60, 150] },
  drizzle: { rain: 0.30, wind: 0.10, cloud: 0.72, dwell: [50, 120] },
  rain: { rain: 0.78, wind: 0.17, cloud: 0.92, dwell: [60, 150] },
  storm: { rain: 1.0, wind: 0.30, cloud: 1.0, dwell: [35, 90] },
};

// Which states can follow which. A storm does not arrive out of a clear sky and
// it does not vanish into one either; it builds through cloud and clears the
// same way.
const WEATHER_NEXT = {
  clear: ['clear', 'breezy', 'breezy'],
  breezy: ['clear', 'breezy', 'drizzle'],
  drizzle: ['breezy', 'rain', 'drizzle'],
  rain: ['drizzle', 'storm', 'rain'],
  storm: ['rain', 'rain', 'drizzle'],
};

const weather = {
  state: 'clear',
  hold: 40,
  // Eased values, which is what everything else actually reads. Changing state
  // moves the target; these chase it over tens of seconds so a squall arrives
  // rather than appearing.
  rain: 0,
  wind: 0.055,
  cloud: 0.18,
  // Wetness lags the rain hard: a surface soaks in under a minute and takes
  // several to dry, which is why the world stays shining after a shower.
  wetness: 0,
  // Lightning, as a decaying flash. Set to 1 by a strike and falls away.
  flash: 0,
  thunderIn: -1,
  lastStrike: 0,
  // Set from the console to pin the weather while looking at it.
  override: null,
  stats: { strikes: 0 },
};

function weatherTarget() {
  const s = WEATHER_STATES[weather.state] || WEATHER_STATES.clear;
  return s;
}

function stepWeather(delta, rand) {
  if (weather.override) {
    const o = weather.override;
    for (const k in o) if (typeof o[k] === 'number') weather[k] = o[k];
    return;
  }
  weather.hold -= delta;
  if (weather.hold <= 0) {
    const options = WEATHER_NEXT[weather.state] || ['clear'];
    weather.state = options[Math.floor(rand() * options.length)];
    const d = WEATHER_STATES[weather.state].dwell;
    weather.hold = d[0] + rand() * (d[1] - d[0]);
  }
  const t = weatherTarget();
  // Rain starts faster than it stops, which is how showers behave.
  const rainRate = t.rain > weather.rain ? 0.12 : 0.055;
  weather.rain += (t.rain - weather.rain) * Math.min(1, delta * rainRate * 4);
  weather.wind += (t.wind - weather.wind) * Math.min(1, delta * 0.18);
  weather.cloud += (t.cloud - weather.cloud) * Math.min(1, delta * 0.10);

  // Wetness: soaks fast, dries slowly.
  const soak = weather.rain > 0.05 ? delta * 0.22 : -delta * 0.016;
  weather.wetness = Math.max(0, Math.min(1, weather.wetness + soak));

  // Lightning only in a storm, and only every so often.
  weather.flash = Math.max(0, weather.flash - delta * 6.5);
  weather.lastStrike += delta;
  if (weather.state === 'storm' && weather.lastStrike > 4 && rand() < delta * 0.22) {
    weather.flash = 1;
    weather.lastStrike = 0;
    weather.stats.strikes++;
    // Thunder follows the flash by the time sound takes to arrive. There is no
    // audio system yet - that is section 10 - so this counts down to nothing
    // for now and is the hook it will use.
    weather.thunderIn = 0.8 + rand() * 4.5;
  }
  if (weather.thunderIn > 0) {
    weather.thunderIn -= delta;
    if (weather.thunderIn <= 0) weather.thunderIn = -1;
  }
}

// ---------- Rain ----------
// Streaks, not droplets. A falling raindrop is a line to any eye and any
// camera, and drawing it as a point is the single most common way rain is got
// wrong. These are thin quads stretched along the fall direction, recycled in a
// box that follows the player.
const RAIN_HALF = 13;
const RAIN_TOP = 15;

function buildRainGeometry(THREE) {
  // A thin quad with its pivot at the top, so scaling y lengthens the streak
  // downward from where the drop is.
  const g = new THREE.PlaneGeometry(1, 1, 1, 1);
  g.translate(0, -0.5, 0);
  return g;
}

function Rain() {
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const count = Math.max(0, q.rainDrops | 0);
  const ref = useRef();

  const geo = useMemo(() => buildRainGeometry(THREE), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#aebdc6',
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }), []);

  const data = useMemo(() => {
    const rand = mulberry32(3141);
    const drops = [];
    for (let i = 0; i < count; i++) {
      drops.push({
        x: (rand() * 2 - 1) * RAIN_HALF,
        y: rand() * RAIN_TOP,
        z: (rand() * 2 - 1) * RAIN_HALF,
        speed: 13 + rand() * 9,
        len: 0.34 + rand() * 0.62,
        wide: 0.012 + rand() * 0.012,
      });
    }
    return { drops, m: new THREE.Matrix4(), v: new THREE.Vector3(),
             q: new THREE.Quaternion(), e: new THREE.Euler(), s: new THREE.Vector3() };
  }, [count]);

  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    const live = weather.rain;
    mesh.visible = live > 0.02;
    if (!mesh.visible) return;
    mat.opacity = 0.10 + live * 0.22;
    const d = Math.min(0.08, delta);
    const px = playerTransform.position[0];
    const py = playerTransform.position[1];
    const pz = playerTransform.position[2];
    // Rain leans with the wind, and hard rain falls faster. The lean is the
    // reason rain reads as weather rather than as a screen effect.
    const lean = weather.wind * 2.6;
    const shown = Math.floor(count * Math.min(1, live * 1.15));
    for (let i = 0; i < data.drops.length; i++) {
      const r = data.drops[i];
      if (i >= shown) {
        data.m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, data.m);
        continue;
      }
      r.y -= r.speed * d * (0.7 + live * 0.5);
      if (r.y < -2) {
        r.y = RAIN_TOP;
        r.x = (Math.random() * 2 - 1) * RAIN_HALF;
        r.z = (Math.random() * 2 - 1) * RAIN_HALF;
      }
      const wx = px + wrapHalf(r.x, RAIN_HALF);
      const wz = pz + wrapHalf(r.z, RAIN_HALF);
      // Tilted along the fall direction so the streak points where it is going.
      data.e.set(0, 0, lean * 0.5);
      data.q.setFromEuler(data.e);
      data.v.set(wx + r.y * lean * 0.08, py + r.y, wz);
      data.s.set(r.wide, r.len * (0.7 + live * 0.6), 1);
      data.m.compose(data.v, data.q, data.s);
      mesh.setMatrixAt(i, data.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (count === 0) return null;
  return html`<instancedMesh ref=${ref} args=${[geo, mat, count]}
    castShadow=${false} receiveShadow=${false} frustumCulled=${false} />`;
}

// ---------- The system that drives everything else ----------
// Nothing here draws. It advances the weather and pushes it into the wind, the
// water, the sky and the lighting, so those systems never need to know weather
// exists - they just see their own inputs change.
function WeatherSystem() {
  const { scene } = useThree();
  const quality = useGame((s) => s.graphicsQuality);
  const q = GRAPHICS_PRESETS[quality] || gfx();
  const rand = useMemo(() => mulberry32(90210), []);
  const splashTimer = useRef(0);

  useFrame((state, delta) => {
    const d = Math.min(0.1, delta);
    stepWeather(d, rand);

    // --- wind: the shared one, which the trees, grass and water already read
    windUniforms.uWindStrength.value = weather.wind;

    // --- water: rain ripples, and the chop follows the wind on its own
    waterRuntime.rain = weather.rain;

    // --- splashes where the rain lands near the player
    if (q.waterSpray > 0 && weather.rain > 0.08) {
      splashTimer.current -= d;
      if (splashTimer.current <= 0) {
        splashTimer.current = 0.06;
        const n = Math.max(1, Math.round(weather.rain * 3));
        for (let i = 0; i < n; i++) {
          const a = rand() * Math.PI * 2;
          const r = 2 + rand() * 9;
          const x = playerTransform.position[0] + Math.cos(a) * r;
          const z = playerTransform.position[2] + Math.sin(a) * r;
          const ws = waterSurfaceAt(x, z);
          if (ws !== -Infinity) {
            spawnRipple(x, z, 0.014);
          } else {
            // A drop hitting the ground throws up a small, short-lived crown.
            emitSpray(x, getTerrainHeight(x, z) + 0.02, z, 1, {
              speed: 0.8, spread: 0.9, up: 1.2, life: 0.28, radius: 0.05, bright: 0.5,
            });
          }
        }
      }
    }

    // --- wetness: the terrain and the rock shaders already know how to be wet
    //     near water; this raises that everywhere at once.
    windUniforms.uWetAmount.value = 0.9 + weather.wetness * 0.6;
    terrainWet.value = weather.wetness;

    // --- lightning: a brief, bright, cold flash that lights the whole scene.
    //     Done as an exposure and ambient push rather than a real light,
    //     because a directional light bright enough to read would also have to
    //     re-render every shadow cascade for one frame.
    skyRuntime.flash = weather.flash;

    // --- cloud cover goes to the sky dome
    if (scene) scene.userData.jkCloud = weather.cloud;
  });

  return null;
}

// A plain holder so the terrain shader can read wetness without importing the
// weather module and creating a cycle.
const terrainWet = { value: 0 };

export {
  WEATHER_STATES,
  WEATHER_NEXT,
  weather,
  weatherTarget,
  stepWeather,
  RAIN_HALF,
  RAIN_TOP,
  buildRainGeometry,
  Rain,
  WeatherSystem,
  terrainWet,
};
