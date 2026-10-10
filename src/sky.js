import { Fragment, THREE, html, useEffect, useFrame, useMemo, useRef, useThree } from './core.js';
import { GRAPHICS_PRESETS, SHADOW_FORWARD_BIAS, canopyCoverAt, fireRegistry, gfx, graphicsSettings } from './graphics.js';
import { playerTransform } from './multiplayer.js';
import { postState, skyRuntime } from './runtime.js';
import { useGame } from './store.js';
import { fbm, greyCanvasFromField, makeCanvas, smoothstep, texFrom } from './textures.js';
import { updateTrampleTrail, windUniforms } from './wind.js';

// ============================================================
// World.js - terrain, sky/lighting, day-night cycle, foliage
// ============================================================
const DAY_LENGTH_SECONDS = 600; // full 24h cycle takes 10 real minutes

// Each keyframe is what the scattering model can't tell us: how dark the night
// sky is, how strong the sunlight is, how much bounce light fills the shadows,
// how far you can see, and how visible the stars are. The sky's own colour is
// no longer keyframed - it comes out of atmoSky() - so `zen`/`hor` here are the
// *night* sky, which only shows through as `star` rises.
//
//   sunI  direct sunlight             ambI  flat fill         hemiI  sky/ground bounce
//   fogN/fogF  haze distances         star  how much night    glow   sun's share of the env map
const SKY_STATES = [
  { t: 0,    zen: '#0a1430', hor: '#101c38', grd: '#070b16', sunC: '#2d3a6a', sunI: 0.015, ambI: 0.038, hemiI: 0.088, fogN: 10, fogF: 95,  star: 1.00, glow: 0.10, cloud: '#0b1124' },
  { t: 4.6,  zen: '#0d1838', hor: '#1a2446', grd: '#0a0f1c', sunC: '#3f4d82', sunI: 0.030, ambI: 0.048, hemiI: 0.110, fogN: 11, fogF: 105, star: 0.88, glow: 0.14, cloud: '#141b33' },
  { t: 6.0,  zen: '#1b2a56', hor: '#8a5a44', grd: '#3a2d26', sunC: '#ff9d55', sunI: 0.55,  ambI: 0.075, hemiI: 0.26,  fogN: 12, fogF: 150, star: 0.40, glow: 0.60, cloud: '#f0a877' },
  { t: 7.6,  zen: '#1b2c58', hor: '#2d3a5e', grd: '#6f7a63', sunC: '#ffd6a8', sunI: 1.55,  ambI: 0.145, hemiI: 0.52,  fogN: 24, fogF: 235, star: 0.00, glow: 0.80, cloud: '#ffffff' },
  { t: 12,   zen: '#1b2c58', hor: '#2d3a5e', grd: '#8a9478', sunC: '#fff6e4', sunI: 2.45,  ambI: 0.175, hemiI: 0.68,  fogN: 40, fogF: 305, star: 0.00, glow: 1.00, cloud: '#ffffff' },
  { t: 16.6, zen: '#1b2c58', hor: '#2d3a5e', grd: '#7f8468', sunC: '#ffe3b4', sunI: 1.70,  ambI: 0.145, hemiI: 0.50,  fogN: 28, fogF: 255, star: 0.00, glow: 0.80, cloud: '#fff1dc' },
  { t: 18.3, zen: '#1b2550', hor: '#8a5440', grd: '#40302a', sunC: '#ff8441', sunI: 0.58,  ambI: 0.075, hemiI: 0.26,  fogN: 16, fogF: 165, star: 0.45, glow: 0.60, cloud: '#ef9765' },
  { t: 19.6, zen: '#0f1838', hor: '#30203a', grd: '#14101c', sunC: '#6a3f58', sunI: 0.10,  ambI: 0.060, hemiI: 0.150, fogN: 13, fogF: 125, star: 0.72, glow: 0.24, cloud: '#33243a' },
  { t: 21,   zen: '#0a1432', hor: '#111d3a', grd: '#070b16', sunC: '#2d3a6a', sunI: 0.018, ambI: 0.040, hemiI: 0.092, fogN: 10, fogF: 95,  star: 1.00, glow: 0.10, cloud: '#0c1226' },
  { t: 24,   zen: '#0a1430', hor: '#101c38', grd: '#070b16', sunC: '#2d3a6a', sunI: 0.015, ambI: 0.038, hemiI: 0.088, fogN: 10, fogF: 95,  star: 1.00, glow: 0.10, cloud: '#0b1124' },
];
// Pre-parsed so the per-frame blend never touches a hex string.
for (const st of SKY_STATES) {
  st.zenC = new THREE.Color(st.zen);
  st.horC = new THREE.Color(st.hor);
  st.grdC = new THREE.Color(st.grd);
  st.sunColor = new THREE.Color(st.sunC);
  st.cloudC = new THREE.Color(st.cloud);
}

// Reused scratch so the blend allocates nothing per frame.
const skyNow = {
  zen: new THREE.Color(), hor: new THREE.Color(), grd: new THREE.Color(),
  sunColor: new THREE.Color(), cloud: new THREE.Color(),
  sunI: 1, ambI: 0.3, hemiI: 0.6, fogN: 30, fogF: 250, star: 0, glow: 0.5,
};

function sampleSky(t) {
  let a = SKY_STATES[0], b = SKY_STATES[SKY_STATES.length - 1], f = 0;
  for (let i = 0; i < SKY_STATES.length - 1; i++) {
    if (t >= SKY_STATES[i].t && t <= SKY_STATES[i + 1].t) {
      a = SKY_STATES[i];
      b = SKY_STATES[i + 1];
      f = (t - a.t) / (b.t - a.t || 1);
      break;
    }
  }
  f = smoothstep(Math.max(0, Math.min(1, f)));
  skyNow.zen.copy(a.zenC).lerp(b.zenC, f);
  skyNow.hor.copy(a.horC).lerp(b.horC, f);
  skyNow.grd.copy(a.grdC).lerp(b.grdC, f);
  skyNow.sunColor.copy(a.sunColor).lerp(b.sunColor, f);
  skyNow.cloud.copy(a.cloudC).lerp(b.cloudC, f);
  skyNow.sunI = a.sunI + (b.sunI - a.sunI) * f;
  skyNow.ambI = a.ambI + (b.ambI - a.ambI) * f;
  skyNow.hemiI = a.hemiI + (b.hemiI - a.hemiI) * f;
  skyNow.fogN = a.fogN + (b.fogN - a.fogN) * f;
  skyNow.fogF = a.fogF + (b.fogF - a.fogF) * f;
  skyNow.star = a.star + (b.star - a.star) * f;
  skyNow.glow = a.glow + (b.glow - a.glow) * f;
  return skyNow;
}

// Where the sun sits for a given hour. Noon is overhead-ish rather than dead
// vertical, which gives everything a readable shadow all day.
function sunDirectionAt(t, out) {
  const a = ((t - 6) / 24) * Math.PI * 2;
  out.set(Math.cos(a) * 0.82, Math.sin(a), 0.38).normalize();
  return out;
}

// ---------- Sky radiance, read back on the CPU ----------
// Fog, ambient fill and the environment map all sample the same scattering the
// dome draws, so the distance never reads as a painted backdrop behind the
// terrain. Allocation-free; the Colors are reused scratch.
const _atmoRGB = [0, 0, 0];
const atmoLook = {
  zenith: new THREE.Color(),
  horizon: new THREE.Color(),  // toward whatever direction was asked for
  sunward: new THREE.Color(),
  average: new THREE.Color(),  // crude irradiance estimate for the ambient fill
};
function atmoColor(dx, dy, dz, sunDir, outColor) {
  const len = Math.hypot(dx, dy, dz) || 1;
  atmoSkyJS(dx / len, dy / len, dz / len, sunDir.x, sunDir.y, sunDir.z, _atmoRGB);
  return outColor.setRGB(_atmoRGB[0], _atmoRGB[1], _atmoRGB[2]);
}
// hx/hz: which way the player is looking, so the haze reddens when you face a
// sunset instead of staying a uniform grey all the way round.
function sampleAtmosphere(sunDir, hx, hz) {
  atmoColor(0, 1, 0, sunDir, atmoLook.zenith);
  atmoColor(hx, 0.055, hz, sunDir, atmoLook.horizon);
  atmoColor(sunDir.x, Math.max(0.04, sunDir.y * 0.35), sunDir.z, sunDir, atmoLook.sunward);
  atmoLook.average.copy(atmoLook.zenith).lerp(atmoLook.horizon, 0.55).lerp(atmoLook.sunward, 0.2);
  return atmoLook;
}


// ---------- Atmosphere ----------
// The sky is no longer a painted gradient: it is a single-scattering
// atmosphere (Preetham/Hoffman), the same model three.js ships in its Sky
// example. Rayleigh scattering off air molecules is what makes the zenith blue
// and the sunset red (short wavelengths scatter out of the long sightline near
// the horizon); Mie scattering off dust and water droplets is what puts the
// white haze around the sun and along the horizon. Turbidity is how dusty the
// air is - a jungle is humid, so it sits a little above the clear-sky default.
//
// Everything below the horizon, the stars, the moon and the clouds are still
// art-directed through SKY_STATES, because scattering has nothing to say about
// any of them.
const ATMO = {
  turbidity: 3.2,
  rayleigh: 2.0,
  mieCoefficient: 0.0055,
  mieDirectionalG: 0.80,
  // Scales the model's radiance into the renderer's exposure range. Dropping
  // the internal gamma above means this is now the only brightness knob, and
  // it is set so a noon zenith lands on a saturated blue rather than clipping.
  gain: 0.22,
};

// Shared between the GLSL and the JS twin below, so the fog, the environment
// map and the dome can never drift apart.
const ATMO_GLSL = `
  const vec3 ATMO_UP = vec3(0.0, 1.0, 0.0);
  const float ATMO_PI = 3.141592653589793;
  const float ATMO_E = 2.718281828459045;
  // Rayleigh scattering at sea level for the three Preetham primaries
  // (680/550/450nm). Blue is five times stronger than red - that ratio is the
  // whole reason the sky is blue.
  const vec3 TOTAL_RAYLEIGH = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const vec3 MIE_CONST = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
  const float RAYLEIGH_ZENITH = 8.4E3;   // scale height of the air column, metres
  const float MIE_ZENITH = 1.25E3;       // aerosols sit much lower down
  const float CUTOFF_ANGLE = 1.6110731556870734;
  const float STEEPNESS = 1.5;
  const float SUN_EE = 1000.0;
  const float SUN_DISC_COS = 0.9999566769464485;
  const float ONE_OVER_FOURPI = 0.07957747154594767;

  // Fades the sun out as it sinks below the horizon - the "earth shadow" hack
  // that turns sunset into night without a second model.
  float atmoSunIntensity(float zenithCos) {
    zenithCos = clamp(zenithCos, -1.0, 1.0);
    return SUN_EE * max(0.0, 1.0 - pow(ATMO_E, -((CUTOFF_ANGLE - acos(zenithCos)) / STEEPNESS)));
  }
  vec3 atmoTotalMie(float T) {
    return 0.434 * ((0.2 * T) * 10E-18) * MIE_CONST;
  }
  // Rayleigh is near-isotropic with a mild forward/backward lobe...
  float atmoRayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * ATMO_PI)) * (1.0 + cosTheta * cosTheta);
  }
  // ...while Mie is sharply forward-scattering, which is the glare round the sun.
  float atmoHgPhase(float cosTheta, float g) {
    float g2 = g * g;
    return ONE_OVER_FOURPI * ((1.0 - g2) / pow(max(0.0, 1.0 - 2.0 * g * cosTheta + g2), 1.5));
  }

  vec3 atmoSky(vec3 dir, vec3 sunDir, float turbidity, float rayleighC, float mieC, float mieG, float withSun) {
    float sunE = atmoSunIntensity(dot(sunDir, ATMO_UP));
    vec3 betaR = TOTAL_RAYLEIGH * rayleighC;
    vec3 betaM = atmoTotalMie(turbidity) * mieC;

    // Optical depth along the sightline. Looking up you punch straight through
    // the thin part of the atmosphere; looking at the horizon you travel
    // through forty times as much air, which is why the horizon is pale.
    float zenithAngle = acos(max(0.0, dot(ATMO_UP, dir)));
    float denom = cos(zenithAngle) + 0.15 * pow(max(0.0001, 93.885 - ((zenithAngle * 180.0) / ATMO_PI)), -1.253);
    float inv = 1.0 / max(0.0001, denom);
    float sR = RAYLEIGH_ZENITH * inv;
    float sM = MIE_ZENITH * inv;

    vec3 Fex = exp(-(betaR * sR + betaM * sM));   // extinction along the path

    float cosTheta = dot(dir, sunDir);
    vec3 betaRTheta = betaR * atmoRayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaMTheta = betaM * atmoHgPhase(cosTheta, mieG);

    vec3 scatter = (betaRTheta + betaMTheta) / (betaR + betaM);
    vec3 Lin = pow(sunE * scatter * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0),
               pow(sunE * scatter * Fex, vec3(0.5)),
               clamp(pow(1.0 - dot(ATMO_UP, sunDir), 5.0), 0.0, 1.0));

    // Preetham carries a constant ambient term for the night sky. It is a flat
    // grey, which is fine in a model that never shows night and ruinous in one
    // that does, so it fades out over the ten degrees below the horizon and
    // hands the night over to the art-directed gradient instead.
    float dayWeight = clamp((sunDir.y + 0.10) / 0.16, 0.0, 1.0);
    vec3 L0 = vec3(0.1) * Fex * dayWeight;
    float disc = smoothstep(SUN_DISC_COS, SUN_DISC_COS + 0.00002, cosTheta);
    L0 += (sunE * 19000.0 * Fex) * disc * withSun;

    // Stock Preetham ends on pow(tex, 1/2.4) and expects the viewer to apply a
    // display gamma on top. We tone map and encode the dome ourselves, so that
    // step would be applied twice - which is exactly what flattens the zenith
    // from blue to pale grey. Returned as linear radiance instead.
    return max((Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075), vec3(0.0));
  }
`;

// ---------- Sky dome ----------
// Drawn on the inside of a big sphere with depthWrite off so it never occludes
// anything, and ridden along with the camera so it is effectively infinite.
const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = `
  uniform vec3 nightZenith;
  uniform vec3 nightHorizon;
  uniform vec3 ground;
  uniform vec3 moonColor;
  uniform vec3 cloudColor;
  uniform vec3 sunDir;
  uniform vec3 sunTint;
  uniform float nightAmount;
  uniform float cloudAmount;
  uniform float time;
  uniform float uExposure;
  uniform float uToneMap;
  uniform float uTurbidity;
  uniform float uRayleigh;
  uniform float uMieC;
  uniform float uMieG;
  uniform float uGain;
  uniform sampler2D cloudTex;
  varying vec3 vDir;

${ATMO_GLSL}

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  // Narkowicz's ACES fit. The dome does its own tone mapping and sRGB encode
  // rather than relying on three.js's output chunks, so a shader-chunk rename
  // in a future three.js can't silently break the sky.
  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 lin2srgb(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166666667)) - 0.055, step(vec3(0.0031308), c));
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;

    vec3 col = atmoSky(dir, sunDir, uTurbidity, uRayleigh, uMieC, uMieG, 1.0) * uGain;

    // Night sky underneath. By the time nightAmount is 1 the scattering term
    // has already gone to black on its own, so this is an addition, not a
    // fight: it puts back the deep blue that single scattering can't produce.
    if (nightAmount > 0.001) {
      vec3 night = mix(nightHorizon, nightZenith, pow(clamp(h, 0.0, 1.0), 0.42));
      col = mix(col, col * 0.12 + night, nightAmount);
    }

    // Below the horizon the dome carries the haze colour, slightly dimmed. It
    // is only ever visible past the edge of the terrain, so it has to match the
    // fog or there is a hard band out there. (Fed with edges in ascending order
    // because GLSL leaves smoothstep undefined when edge0 >= edge1.)
    col = mix(col, ground, smoothstep(0.0, 0.18, -h));

    float sd = max(dot(dir, sunDir), 0.0);

    // Moon sits opposite the sun so there is always something up there.
    float md = max(dot(dir, -sunDir), 0.0);
    float moonVis = pow(nightAmount, 1.2);
    col += moonColor * smoothstep(0.9988, 0.9995, md) * moonVis * 6.0;
    col += moonColor * 0.35 * pow(md, 200.0) * moonVis;

    if (nightAmount > 0.01 && h > 0.0) {
      // Quantise the direction into a grid and light up a sparse few cells.
      vec3 cell = floor(dir * 260.0);
      float s = hash(cell);
      float star = smoothstep(0.9972, 0.9999, s);
      float twinkle = 0.65 + 0.35 * sin(time * 2.4 + s * 90.0);
      col += vec3(0.85, 0.88, 1.0) * star * twinkle * pow(nightAmount, 1.5) * 1.8 * smoothstep(0.0, 0.25, h);
    }

    if (h > 0.03 && cloudAmount > 0.01) {
      // Project the view direction onto a flat plane overhead - the standard
      // cheap sky-plane trick. Clouds stretch out and thin near the horizon.
      vec2 uv = dir.xz / (h + 0.12);
      float c1 = texture2D(cloudTex, uv * 0.045 + vec2(time * 0.0035, time * 0.0012)).r;
      float c2 = texture2D(cloudTex, uv * 0.10 - vec2(time * 0.0052, time * 0.0021)).r;
      float cover = smoothstep(0.52, 0.92, c1 * 0.68 + c2 * 0.42);
      cover *= smoothstep(0.03, 0.30, h) * cloudAmount;
      // Lit rim where the cloud faces the sun, plus a silver lining when you
      // look straight through one at the sun.
      vec3 lit = mix(cloudColor * 0.42, cloudColor, smoothstep(0.0, 1.0, c2)) * 2.3;
      lit += sunTint * pow(sd, 12.0) * 1.4;
      col = mix(col, lit, cover);
    }

    // With the post chain running, the dome is just another thing drawn into
    // the HDR buffer and the composite tone maps the lot. Doing it here as
    // well would crush the sun to white before bloom ever saw how bright it is.
    gl_FragColor = uToneMap > 0.5
      ? vec4(lin2srgb(aces(col * uExposure)), 1.0)
      : vec4(col, 1.0);
  }
`;

// ---------- The same scattering, on the CPU ----------
// The fog colour, the ambient fill and the environment map all have to agree
// with what the dome is drawing, or the distance reads as a painted backdrop
// stuck behind the terrain. Rather than guess, this is a line-for-line port of
// atmoSky() above. Allocation-free: the caller passes the output in.
const _atmoFex = [0, 0, 0];
const _atmoBetaR = [0, 0, 0];
const _atmoBetaM = [0, 0, 0];
const MIE_CONST_JS = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const TOTAL_RAYLEIGH_JS = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];

function atmoSkyJS(dx, dy, dz, sx, sy, sz, out) {
  const E = Math.E, PI = Math.PI;
  const zc = Math.max(-1, Math.min(1, sy)); // sun elevation cosine against up
  const sunE = 1000 * Math.max(0, 1 - Math.pow(E, -((1.6110731556870734 - Math.acos(zc)) / 1.5)));
  const mie = 0.434 * ((0.2 * ATMO.turbidity) * 10e-18);
  for (let i = 0; i < 3; i++) {
    _atmoBetaR[i] = TOTAL_RAYLEIGH_JS[i] * ATMO.rayleigh;
    _atmoBetaM[i] = mie * MIE_CONST_JS[i] * ATMO.mieCoefficient;
  }
  const zenithAngle = Math.acos(Math.max(0, dy));
  const denom = Math.cos(zenithAngle) + 0.15 * Math.pow(Math.max(0.0001, 93.885 - ((zenithAngle * 180) / PI)), -1.253);
  const inv = 1 / Math.max(0.0001, denom);
  const sR = 8.4e3 * inv, sM = 1.25e3 * inv;
  for (let i = 0; i < 3; i++) _atmoFex[i] = Math.exp(-(_atmoBetaR[i] * sR + _atmoBetaM[i] * sM));

  const cosTheta = dx * sx + dy * sy + dz * sz;
  const rPhase = (3 / (16 * PI)) * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g = ATMO.mieDirectionalG, g2 = g * g;
  const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(Math.max(0, 1 - 2 * g * cosTheta + g2), 1.5));
  const sunUp = Math.max(0, Math.min(1, Math.pow(1 - sy, 5)));

  for (let i = 0; i < 3; i++) {
    const bR = _atmoBetaR[i], bM = _atmoBetaM[i];
    const scatter = (bR * rPhase + bM * mPhase) / (bR + bM);
    let Lin = Math.pow(Math.max(0, sunE * scatter * (1 - _atmoFex[i])), 1.5);
    const horizonMix = Math.pow(Math.max(0, sunE * scatter * _atmoFex[i]), 0.5);
    Lin *= 1 + (horizonMix - 1) * sunUp;
    // Same night-term fade as the shader, or the fog would stay grey after dark.
    const dayWeight = Math.max(0, Math.min(1, (sy + 0.10) / 0.16));
    const L0 = 0.1 * _atmoFex[i] * dayWeight; // no sun disc: this is for ambient/fog, not the dome
    const bias = i === 0 ? 0 : i === 1 ? 0.0003 : 0.00075;
    // Linear radiance, same as the shader - see the note in ATMO_GLSL.
    out[i] = Math.max(0, (Lin + L0) * 0.04 + bias) * ATMO.gain;
  }
  return out;
}

// Greyscale fbm used as the cloud mask. Seamless, so the sky plane can scroll
// forever without a visible join.
let _cloudTex = null;
function cloudTexture() {
  if (!_cloudTex) {
    const size = 256;
    const f = fbm(size, 4, 4, 5, 20250);
    _cloudTex = texFrom(greyCanvasFromField(f, size, 0, 1), [1, 1], false);
  }
  return _cloudTex;
}

function SkyDome({ uniforms }) {
  const ref = useRef();
  const geo = useMemo(() => new THREE.SphereGeometry(460, 32, 20), []);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    // Drawn first (renderOrder -1) and never written to the depth buffer, so
    // everything else paints over it. Skipping the depth test as well avoids
    // relying on a 460-unit sphere staying inside the far plane's precision.
    depthWrite: false,
    depthTest: false,
    // Authored colours: let them through untouched rather than have the tone
    // mapper flatten the sunset.
    toneMapped: false,
    fog: false,
  }), [uniforms]);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  // Ride along with the camera so the dome is effectively infinitely far away
  // and can never clip against the far plane, however far you walk.
  useFrame(({ camera }) => {
    if (ref.current) ref.current.position.copy(camera.position);
  });
  return html`<mesh ref=${ref} geometry=${geo} material=${mat} frustumCulled=${false} renderOrder=${-1} />`;
}

// A development hatch: the sky owns the clock and writes timeOfDay into the
// store, so setting the store does nothing to the light. Screenshots at a
// named hour need to move the clock itself.
const debugClock = { t: null };

// ---------- Environment map ----------
// Materials need something to reflect or the water and any metal read as flat
// paint. This paints a small equirectangular sky by evaluating the *same*
// scattering the dome draws, at a handful of elevations, then runs it through
// PMREM so roughness-aware reflections work. Rebuilt a few times a minute.
const ENV_ROWS = [1.0, 0.72, 0.45, 0.26, 0.12, 0.04, 0.0];
const _envColor = new THREE.Color();

// Narkowicz ACES, matching the dome's own tone mapper. Used anywhere an HDR
// radiance has to be written into an 8-bit sink - the environment canvas and
// the clear colour - because both would otherwise clip straight to white.
function acesToneMap(c, exposure) {
  const f = (v) => {
    const x = Math.max(0, v * exposure);
    return Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
  };
  return c.setRGB(f(c.r), f(c.g), f(c.b));
}

function paintEnvCanvas(cv, sky, sunDir, exposure) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  // Top half of an equirect map is the sky, bottom half the ground.
  for (let i = 0; i < ENV_ROWS.length; i++) {
    const elev = ENV_ROWS[i];                     // 1 = straight up, 0 = horizon
    const horiz = Math.sqrt(Math.max(0, 1 - elev * elev));
    atmoColor(horiz, elev, 0, sunDir, _envColor);
    _envColor.lerp(sky.zen, sky.star * (0.35 + 0.65 * elev));
    acesToneMap(_envColor, exposure);
    grad.addColorStop(i / (ENV_ROWS.length - 1) * 0.5, _envColor.getStyle());
  }
  _envColor.copy(sky.grd);
  grad.addColorStop(0.56, _envColor.getStyle());
  grad.addColorStop(1, _envColor.getStyle());
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // Equirect: longitude across, latitude down. Put a soft sun blob where the
  // light actually is so reflections have a highlight to catch.
  if (sunDir.y > -0.05) {
    const lon = Math.atan2(-sunDir.z, sunDir.x);
    const lat = Math.asin(Math.max(-1, Math.min(1, sunDir.y)));
    const sx = ((lon / (Math.PI * 2)) + 0.5) * w;
    const sy = (0.5 - lat / Math.PI) * h;
    const r = h * 0.3;
    const blob = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    const sc = sky.sunColor;
    const a = 0.95 * sky.glow;
    blob.addColorStop(0, `rgba(${Math.round(Math.min(1, sc.r) * 255)},${Math.round(Math.min(1, sc.g) * 255)},${Math.round(Math.min(1, sc.b) * 255)},${a})`);
    blob.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, w, h);
  }
  return cv;
}

// A light's colour is a multiplier on its intensity, so any hue lifted out of
// the sky has to be scaled back up to full brightness first - otherwise tinting
// the ambient toward a dark night sky silently darkens it a second time. The
// pull toward white keeps it a tint rather than a colour filter: a pure-blue
// ambient turns skin cyan.
const _white = new THREE.Color('#ffffff');
function normaliseHue(c, towardWhite) {
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  c.multiplyScalar(1 / m);
  if (towardWhite > 0) c.lerp(_white, towardWhite);
  return c;
}

// How bright the renderer is before eye adaptation moves it. Calibrated so a
// noon sky sits just under clipping and sunlit ground lands on a mid-tone.
const EXPOSURE_BASE = 0.52;
// Three slots is the most any preset uses; unused ones sit at zero intensity
// rather than unmounting, because changing the light count recompiles every
// material in the scene.
const FIRE_SLOTS = 3;

function DayNightSystem() {
  const { scene, gl, camera } = useThree();
  // Only needed at render time, to decide which lights cast shadows. The frame
  // loop reads gfx() directly so it always sees the live preset.
  const quality = useGame((s) => s.graphicsQuality);
  const qRender = GRAPHICS_PRESETS[quality] || gfx();
  const sunRef = useRef();
  const moonRef = useRef();
  const ambRef = useRef();
  const hemiRef = useRef();
  const fire0 = useRef(); const fire1 = useRef(); const fire2 = useRef();
  const fireRefs = [fire0, fire1, fire2];
  // Firelight shadows come from a single spotlight hung above the nearest fire
  // rather than from the point light itself. A shadow-casting point light has
  // to render the scene six times, once per cube face, and three.js filters
  // shadow casters by the *view* camera's layers, so there is no way to show it
  // only the handful of things that matter. One spotlight is one pass, and
  // light coming from above a fire throws shadows outward from it much the way
  // the fire does.
  const fireSpot = useRef();
  const fireSpotTarget = useMemo(() => new THREE.Object3D(), []);
  const clockAccum = useRef(0);
  const localTime = useRef(8); // hours
  const sunDir = useRef(new THREE.Vector3(0, 1, 0));
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  const shadowSetup = useRef({ map: 0, extent: 0 });
  const envAge = useRef(1e9);
  const expo = useRef(EXPOSURE_BASE);
  // Per-frame scratch, so none of this allocates inside useFrame.
  const tmp = useMemo(() => ({
    fwd: new THREE.Vector3(), centre: new THREE.Vector3(),
    right: new THREE.Vector3(), up: new THREE.Vector3(),
    fog: new THREE.Color(), hue: new THREE.Color(), clear: new THREE.Color(),
    night: new THREE.Color(), ground: new THREE.Color(),
    jungle: new THREE.Color('#3f5a28'),
    picks: [],
  }), []);

  const uniforms = useMemo(() => ({
    nightZenith: { value: new THREE.Color('#01030c') },
    nightHorizon: { value: new THREE.Color('#040814') },
    ground: { value: new THREE.Color('#8a9478') },
    moonColor: { value: new THREE.Color('#aebbd8') },
    cloudColor: { value: new THREE.Color('#ffffff') },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunTint: { value: new THREE.Color('#fff6e4') },
    nightAmount: { value: 0 },
    cloudAmount: { value: 1 },
    time: { value: 0 },
    uExposure: { value: EXPOSURE_BASE },
    uToneMap: { value: 1 },
    uTurbidity: { value: ATMO.turbidity },
    uRayleigh: { value: ATMO.rayleigh },
    uMieC: { value: ATMO.mieCoefficient },
    uMieG: { value: ATMO.mieDirectionalG },
    uGain: { value: ATMO.gain },
    cloudTex: { value: cloudTexture() },
  }), []);

  // One canvas and one PMREM generator reused for every environment rebuild.
  const env = useMemo(() => {
    const cv = makeCanvas(128, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    let pmrem = null;
    try {
      pmrem = new THREE.PMREMGenerator(gl);
      pmrem.compileEquirectangularShader();
    } catch (e) {
      pmrem = null;
    }
    return { cv, tex, pmrem, rt: null };
  }, [gl]);

  useEffect(() => () => {
    if (env.rt) env.rt.dispose();
    if (env.pmrem) env.pmrem.dispose();
    env.tex.dispose();
    scene.environment = null;
  }, [env, scene]);

  useFrame((_, delta) => {
    const q = gfx();
    clockAccum.current += delta;
    if (debugClock.t !== null) {
      clockAccum.current = (((debugClock.t - 8) + 24) % 24) / 24 * DAY_LENGTH_SECONDS;
      debugClock.t = null;
    }
    localTime.current = (8 + (clockAccum.current / DAY_LENGTH_SECONDS) * 24) % 24;
    const t = localTime.current;
    const sky = sampleSky(t);
    const dir = sunDirectionAt(t, sunDir.current);
    const px = playerTransform.position[0];
    const py = playerTransform.position[1];
    const pz = playerTransform.position[2];

    // Which way the player is facing, flattened - used both to aim the haze
    // and to push the shadow box toward what is actually on screen.
    camera.getWorldDirection(tmp.fwd);
    tmp.fwd.y = 0;
    if (tmp.fwd.lengthSq() < 1e-6) tmp.fwd.set(0, 0, -1);
    tmp.fwd.normalize();

    sampleAtmosphere(dir, tmp.fwd.x, tmp.fwd.z);

    // --- eye adaptation ---
    // Walking under the canopy cuts the light by up to ~80%; the eye opens up
    // to compensate, but slowly, so the jungle reads dark for a second or two
    // before it resolves. Coming back out is much faster, the way squinting is.
    let targetExpo = EXPOSURE_BASE * graphicsSettings.brightness;
    if (q.eyeAdapt) {
      const dayF = 1 - sky.star;
      const occl = 1 - 0.78 * canopyCoverAt(px, pz) * dayF;
      targetExpo *= Math.pow(1 / Math.max(0.1, occl), 0.45) * (1 + 0.30 * (1 - dayF));
    }
    const tau = targetExpo > expo.current ? 2.2 : 0.7;
    expo.current += (targetExpo - expo.current) * (1 - Math.exp(-delta / tau));
    if (!isFinite(expo.current)) expo.current = EXPOSURE_BASE;
    // When the post chain is running it applies the exposure in its composite,
    // and the renderer must leave materials in linear radiance.
    skyRuntime.exposure = expo.current;
    if (!postState.active) gl.toneMappingExposure = expo.current;
    uniforms.uToneMap.value = postState.active ? 0 : 1;

    // --- haze: the fog colour is the sky the player is looking at, so the
    // distance goes blue-grey by day and reddens if you face a sunset ---
    tmp.fog.copy(atmoLook.horizon).lerp(sky.hor, sky.star);

    // --- sky dome ---
    uniforms.nightZenith.value.copy(sky.zen);
    uniforms.nightHorizon.value.copy(sky.hor);
    // Everything below the horizon line is the haze colour, a little dimmer -
    // that band is only ever seen beyond the edge of the terrain, and if it
    // disagreed with the fog you would see exactly where the world stops.
    uniforms.ground.value.copy(tmp.fog).multiplyScalar(0.72);
    uniforms.sunTint.value.copy(sky.sunColor);
    uniforms.cloudColor.value.copy(sky.cloud);
    uniforms.sunDir.value.copy(dir);
    uniforms.nightAmount.value = sky.star;
    uniforms.time.value = clockAccum.current;
    uniforms.uExposure.value = expo.current;
    uniforms.uTurbidity.value = ATMO.turbidity;
    uniforms.uRayleigh.value = ATMO.rayleigh;
    uniforms.uMieC.value = ATMO.mieCoefficient;
    uniforms.uMieG.value = ATMO.mieDirectionalG;
    uniforms.uGain.value = ATMO.gain;

    // The clear colour is never actually seen (the dome covers it and is drawn
    // first) but it is an 8-bit sink, so give it a tone-mapped copy rather than
    // an HDR one that would clip to white if the dome ever failed to draw.
    tmp.clear.copy(tmp.fog);
    scene.background = acesToneMap(tmp.clear, expo.current);
    skyRuntime.sunDir.copy(dir);
    skyRuntime.sunColor.copy(sky.sunColor);
    skyRuntime.fogColor.copy(tmp.fog);
    skyRuntime.sunI = sky.sunI;
    skyRuntime.star = sky.star;

    // --- wind and leaf backlighting ---
    windUniforms.uWindTime.value = clockAccum.current;
    // A slow breathing of the overall strength on top of the per-gust wave, so
    // the forest has quiet minutes and restless ones.
    windUniforms.uWindStrength.value = 0.075 + 0.035 * Math.sin(clockAccum.current * 0.043);
    windUniforms.uSunTint.value.copy(sky.sunColor);
    windUniforms.uLeafTrans.value = Math.min(1.4, sky.sunI) * 0.85;
    // The translucency term works in view space, so the sun direction has to
    // come along for the ride.
    windUniforms.uSunDirView.value.copy(dir).transformDirection(camera.matrixWorldInverse);
    updateTrampleTrail(delta);
    if (scene.fog) {
      scene.fog.color.copy(tmp.fog);
      scene.fog.near = sky.fogN;
      scene.fog.far = sky.fogF;
    }

    // --- sun ---
    if (sunRef.current) {
      const sun = sunRef.current;
      const e = q.shadowExtent;
      // Fit the box to what you can see rather than wrapping the player: push
      // it forward along the view direction, then snap the centre to whole
      // shadow texels so the edges stop crawling as you walk.
      tmp.centre.set(px, py, pz).addScaledVector(tmp.fwd, e * SHADOW_FORWARD_BIAS);
      const texel = (2 * e) / Math.max(1, q.shadowMap);
      tmp.right.set(0, 1, 0).cross(dir);
      if (tmp.right.lengthSq() < 1e-6) tmp.right.set(1, 0, 0);
      tmp.right.normalize();
      tmp.up.copy(dir).cross(tmp.right).normalize();
      const ar = Math.round(tmp.centre.dot(tmp.right) / texel) * texel;
      const au = Math.round(tmp.centre.dot(tmp.up) / texel) * texel;
      const ad = tmp.centre.dot(dir);
      tmp.centre.copy(tmp.right).multiplyScalar(ar).addScaledVector(tmp.up, au).addScaledVector(dir, ad);

      sun.position.copy(tmp.centre).addScaledVector(dir, 110);
      sunTarget.position.copy(tmp.centre);
      sun.target = sunTarget;
      sun.color.copy(sky.sunColor);
      sun.intensity = sky.sunI;
      sun.visible = sky.sunI > 0.02;

      const setup = shadowSetup.current;
      if (setup.map !== q.shadowMap || setup.extent !== e) {
        setup.map = q.shadowMap;
        setup.extent = e;
        sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
        const c = sun.shadow.camera;
        c.left = -e; c.right = e; c.top = e; c.bottom = -e;
        c.near = 1;
        c.far = 240;
        c.updateProjectionMatrix();
        // Smaller texels need less bias; too much and small objects detach
        // from their own shadow.
        sun.shadow.bias = -(0.00008 + texel * 0.008);
        sun.shadow.normalBias = Math.max(0.02, texel * 1.2);
        // Force the shadow map to be reallocated at the new resolution.
        if (sun.shadow.map) {
          sun.shadow.map.dispose();
          sun.shadow.map = null;
        }
      }
    }

    // --- moon fill: faint and cold, opposite the sun. No shadows; it is a
    // fill light, and the point is that night is genuinely dark. ---
    if (moonRef.current) {
      const m = moonRef.current;
      m.position.set(px - dir.x * 80, Math.max(6, -dir.y * 80), pz - dir.z * 80);
      m.target = sunTarget;
      m.intensity = 0.30 * sky.star;
      m.visible = sky.star > 0.02;
    }

    // --- ambient and sky bounce take their hue from the scattering, their
    // strength from the keyframes ---
    if (ambRef.current) {
      normaliseHue(tmp.hue.copy(atmoLook.average), 0.30);
      normaliseHue(tmp.night.copy(uniforms.nightZenith.value), 0.25);
      ambRef.current.color.copy(tmp.hue).lerp(tmp.night, sky.star * 0.8);
      ambRef.current.intensity = sky.ambI;
    }
    if (hemiRef.current) {
      normaliseHue(tmp.hue.copy(atmoLook.zenith), 0.22);
      normaliseHue(tmp.night.copy(uniforms.nightZenith.value), 0.25);
      hemiRef.current.color.copy(tmp.hue).lerp(tmp.night, sky.star * 0.8);
      // The ground half of the hemisphere light is the jungle bouncing back up.
      normaliseHue(tmp.ground.copy(sky.grd).lerp(tmp.jungle, 0.5), 0.1);
      hemiRef.current.groundColor.copy(tmp.ground);
      hemiRef.current.intensity = sky.hemiI;
    }

    // --- campfires: a fixed pool of lights, handed to the nearest fires ---
    const picks = tmp.picks;
    picks.length = 0;
    for (const id in fireRegistry) {
      const p = fireRegistry[id];
      if (!p) continue;
      const d2 = (p[0] - px) * (p[0] - px) + (p[2] - pz) * (p[2] - pz);
      if (d2 > 4900) continue; // 70m
      picks.push(p, d2);
    }
    // Tiny list (a dozen at most), so a selection sort beats allocating.
    for (let s = 0; s < q.fireLights && s * 2 < picks.length; s++) {
      let best = s;
      for (let i = s + 1; i * 2 < picks.length; i++) {
        if (picks[i * 2 + 1] < picks[best * 2 + 1]) best = i;
      }
      if (best !== s) {
        const p0 = picks[s * 2], d0 = picks[s * 2 + 1];
        picks[s * 2] = picks[best * 2]; picks[s * 2 + 1] = picks[best * 2 + 1];
        picks[best * 2] = p0; picks[best * 2 + 1] = d0;
      }
    }
    const tt = clockAccum.current;
    // A fire is the brightest thing in a jungle at night and barely noticeable
    // at noon, so its strength rides the day cycle. Left at its night value it
    // would put a hot orange pool in the middle of a sunlit camp.
    const fireBase = 2.0 + 7.5 * sky.star;
    let nearestFire = null;
    let nearestFlicker = 0;
    for (let s = 0; s < FIRE_SLOTS; s++) {
      const light = fireRefs[s].current;
      if (!light) continue;
      const p = (s < q.fireLights) ? picks[s * 2] : null;
      if (!p) { light.intensity = 0; continue; }
      // Three detuned sines plus a slow drift: a fire never settles, and
      // whatever it lights should never settle either.
      const k = s * 2.3;
      const flick = Math.max(0, 0.78
        + 0.16 * Math.sin(tt * 11.3 + k)
        + 0.10 * Math.sin(tt * 23.7 + k * 2.1)
        + 0.06 * Math.sin(tt * 47.0 + k * 3.7));
      light.position.set(
        p[0] + Math.sin(tt * 5.1 + k) * 0.07,
        p[1] + 0.35 + Math.sin(tt * 7.3 + k) * 0.05,
        p[2] + Math.cos(tt * 4.3 + k) * 0.07,
      );
      // The nearest fire gives up part of its light to the shadow-casting
      // spotlight; the rest keep all of theirs, since nothing shadows for them.
      const share = (s === 0 && q.fireShadows) ? 0.6 : 1;
      light.intensity = flick * fireBase * share;
      if (s === 0) { nearestFire = p; nearestFlicker = flick; }
    }
    if (fireSpot.current) {
      const spot = fireSpot.current;
      if (nearestFire && q.fireShadows && spot.parent) {
        // Hung above the fire and aimed down at it, so shadows splay outward
        // from the flames. The jitter is what makes them crawl.
        spot.position.set(
          nearestFire[0] + Math.sin(tt * 3.7) * 0.12,
          nearestFire[1] + 2.6,
          nearestFire[2] + Math.cos(tt * 3.1) * 0.12,
        );
        fireSpotTarget.position.set(nearestFire[0], nearestFire[1], nearestFire[2]);
        spot.target = fireSpotTarget;
        // Scaled up by ~2.6 because it is 2.6m further away than the point
        // light it is standing in for, and both fall off with the square.
        spot.intensity = nearestFlicker * fireBase * 0.5 * 2.6;
      } else {
        spot.intensity = 0;
      }
    }

    // --- environment map, throttled ---
    envAge.current += delta;
    if (q.envSeconds > 0 && env.pmrem && envAge.current >= q.envSeconds) {
      envAge.current = 0;
      try {
        paintEnvCanvas(env.cv, sky, dir, expo.current);
        env.tex.needsUpdate = true;
        const next = env.pmrem.fromEquirectangular(env.tex);
        if (env.rt) env.rt.dispose();
        env.rt = next;
        scene.environment = next.texture;
      } catch (e) {
        env.pmrem = null; // one failure is enough; don't retry every tick
      }
    } else if (q.envSeconds === 0 && scene.environment) {
      scene.environment = null;
    }

    // push time of day to store roughly four times a second
    if (Math.floor(clockAccum.current * 4) !== Math.floor((clockAccum.current - delta) * 4)) {
      useGame.getState().setTimeOfDay(t);
    }
  });

  return html`
    <${Fragment}>
      <${SkyDome} uniforms=${uniforms} />
      <primitive object=${sunTarget} />
      <directionalLight ref=${sunRef} position=${[50, 80, 40]} intensity=${2} castShadow=${true}
        shadow-mapSize-width=${2048} shadow-mapSize-height=${2048}
        shadow-bias=${-0.0004} shadow-normalBias=${0.035} />
      <directionalLight ref=${moonRef} position=${[-50, 60, -40]} intensity=${0} color="#7d93c8" />
      <ambientLight ref=${ambRef} intensity=${0.18} color="#bcd4ff" />
      <hemisphereLight ref=${hemiRef} args=${['#bcd4ff', '#3a5a30', 0.6]} />
      <!-- Only as many lights as the preset actually uses get mounted: every
           light in the scene is evaluated per fragment on every lit material,
           whether or not it is switched on. Changing the count recompiles the
           materials, which is why it follows the preset and not the player's
           distance from the nearest camp. -->
      ${fireRefs.slice(0, qRender.fireLights).map((r, i) => html`
        <pointLight key=${i} ref=${r} color="#ff9a42" intensity=${0} distance=${17} decay=${2} />
      `)}
      ${!!qRender.fireShadows && html`
        <${Fragment}>
          <primitive object=${fireSpotTarget} />
          <spotLight ref=${fireSpot} color="#ff9a42" intensity=${0}
            distance=${16} decay=${2} angle=${1.15} penumbra=${0.85}
            castShadow=${true}
            shadow-mapSize-width=${1024} shadow-mapSize-height=${1024}
            shadow-bias=${-0.0015} shadow-normalBias=${0.03}
            shadow-camera-near=${0.4} shadow-camera-far=${14} />
        <//>
      `}
    <//>
  `;
}


export {
  debugClock,
  DAY_LENGTH_SECONDS,
  SKY_STATES,
  skyNow,
  sampleSky,
  sunDirectionAt,
  _atmoRGB,
  atmoLook,
  atmoColor,
  sampleAtmosphere,
  ATMO,
  ATMO_GLSL,
  SKY_VERT,
  SKY_FRAG,
  _atmoFex,
  _atmoBetaR,
  _atmoBetaM,
  MIE_CONST_JS,
  TOTAL_RAYLEIGH_JS,
  atmoSkyJS,
  _cloudTex,
  cloudTexture,
  SkyDome,
  ENV_ROWS,
  _envColor,
  acesToneMap,
  paintEnvCanvas,
  _white,
  normaliseHue,
  EXPOSURE_BASE,
  FIRE_SLOTS,
  DayNightSystem,
};
