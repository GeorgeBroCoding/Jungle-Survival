import { THREE } from './core.js';

// ============================================================
// runtime.js - renderer state and shader fragments shared across modules
//
// These lived in app.js. Importing the sun's direction from the top-level
// composition dragged that whole module into evaluation ahead of the ones it
// depends on, so they sit down here instead, below everything that reads them
// and above everything that writes them.
// ============================================================

// `override` lets a single composite uniform be forced from the console, which
// is how each effect gets verified on its own: shoot the frame with it at 0,
// shoot it again at its normal value, and diff the two.
const postState = { active: false, reason: 'not started', override: null };

const skyRuntime = {
  sunDir: new THREE.Vector3(0, 1, 0),
  sunColor: new THREE.Color('#ffffff'),
  fogColor: new THREE.Color('#bcdaef'),
  exposure: 0.52,
  sunI: 0,
  star: 0,
  // Lightning, 0..1, decaying. Read by the composite as an exposure push.
  flash: 0,
};

const DEPTH_GLSL = `
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  uniform float uNear;
  uniform float uFar;

  float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

  // View space, right-handed: z is negative in front of the camera.
  vec3 viewPos(vec2 uv, float d) {
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uProjInv * clip;
    return v.xyz / v.w;
  }
  // Metres from the eye along the view axis.
  float linearDepth(float d) {
    float ndc = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  }
  bool isSky(float d) { return d >= 0.999999; }
`;

const ACES_GLSL = `
  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  // AgX, the Blender/Filament transform. three 0.160 predates AgXToneMapping,
  // so this is the same fit written out: rotate into Rec.2020, pull the
  // primaries inward, work in log2 across a 16-stop window, run a sigmoid, then
  // rotate back out. What it buys over ACES is the highlight path - ACES slews
  // bright saturated colour toward its primaries, so a sunlit leaf goes neon
  // and a hot sky goes cyan, while AgX desaturates toward white the way film
  // does. In a jungle, where most of the frame is saturated green, that is the
  // difference between "rendered" and "photographed".
  const mat3 AGX_SRGB_TO_2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164),
    vec3(0.3293, 0.9195, 0.0880),
    vec3(0.0433, 0.0113, 0.8956));
  const mat3 AGX_2020_TO_SRGB = mat3(
    vec3( 1.6605, -0.1246, -0.0182),
    vec3(-0.5876,  1.1329, -0.1006),
    vec3(-0.0728, -0.0083,  1.1187));
  const mat3 AGX_INSET = mat3(
    vec3(0.856627153315983,  0.137318972929847,  0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591,  0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562,  0.811302368396859));
  const mat3 AGX_OUTSET = mat3(
    vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272,  -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

  vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
         - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }

  vec3 agx(vec3 colour) {
    const float minEv = -12.47393;
    const float maxEv = 4.026069;
    colour = AGX_SRGB_TO_2020 * colour;
    colour = AGX_INSET * colour;
    colour = max(colour, vec3(1e-10));
    colour = (log2(colour) - minEv) / (maxEv - minEv);
    colour = agxContrast(clamp(colour, 0.0, 1.0));
    colour = AGX_OUTSET * colour;
    // Back to linear, so the sRGB encode below is the only display transform.
    colour = pow(max(colour, vec3(0.0)), vec3(2.2));
    return clamp(AGX_2020_TO_SRGB * colour, 0.0, 1.0);
  }
  vec3 lin2srgb(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166666667)) - 0.055, step(vec3(0.0031308), c));
  }
`;

export {
  postState,
  skyRuntime,
  DEPTH_GLSL,
  ACES_GLSL,
};
