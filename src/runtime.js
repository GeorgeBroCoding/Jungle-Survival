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
