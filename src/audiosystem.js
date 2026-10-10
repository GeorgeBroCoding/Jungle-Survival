import { audio, playBird, playCrackle, playDrip, playFrog, playMonkey, playThunder, rampLayer, resumeAudio } from './audio.js';
import { THREE, useEffect, useFrame, useMemo, useRef, useThree } from './core.js';
import { POND_CENTER, POND_RADIUS, riverDistance } from './data.js';
import { canopyCoverAt, fireRegistry } from './graphics.js';
import { playerTransform } from './multiplayer.js';
import { useGame } from './store.js';
import { waterRuntime } from './water.js';
import { weather } from './weather.js';
import { windUniforms } from './wind.js';

// ============================================================
// audiosystem.js - what drives the sounds
//
// audio.js knows how to make noises. This knows when. It runs once a frame and
// does five things: moves the listener to the camera, cross-fades the ambience
// bed by time of day, pushes the live wind and rain into their layers, fires
// the scheduled one-shots, and muffles everything when the player's head is
// under water.
//
// Nothing here owns any state of its own that another system already has. The
// wind comes from the same uniform that leans the trees, the rain from the same
// weather object that spawns the drops, the canopy cover from the same function
// the dappled light uses. That is deliberate: if the audio kept its own idea of
// how windy it was, the leaves would rustle while the trees stood still, and
// that mismatch is far more noticeable than either one being slightly wrong.
// ============================================================

// A trapezoid over the 24-hour clock that wraps correctly at midnight, which a
// plain smoothstep pair does not. `a` and `d` are where it leaves and returns
// to zero; `b` and `c` bracket the plateau.
function clockBand(h, a, b, c, d) {
  const span = (from, to) => {
    let w = to - from;
    if (w < 0) w += 24;
    let p = h - from;
    if (p < 0) p += 24;
    return w <= 0 ? 1 : p / w;
  };
  const inWindow = (from, to) => {
    let w = to - from;
    if (w < 0) w += 24;
    let p = h - from;
    if (p < 0) p += 24;
    return p <= w;
  };
  if (!inWindow(a, d)) return 0;
  if (inWindow(a, b)) return Math.min(1, Math.max(0, span(a, b)));
  if (inWindow(c, d)) return Math.min(1, Math.max(0, 1 - span(c, d)));
  return 1;
}

function smooth(t) { return t * t * (3 - 2 * t); }

// What the bed should sound like at a given hour. Returning a plain object
// rather than setting the gains directly means this is testable from the
// console without an AudioContext, which is how the curves below were tuned.
function ambienceMix(hour, windStrength, nearWater) {
  const day = clockBand(hour, 5.0, 6.8, 17.2, 19.2);
  const night = 1 - day;
  return {
    // Daytime air, with a floor so the night is not silent between calls.
    air: 0.25 + day * 0.75,
    // Cicadas are an afternoon animal. They start as the morning warms and are
    // loudest in the worst of the heat.
    cicada: smooth(clockBand(hour, 9.0, 12.5, 16.5, 19.0)) * 0.85,
    // Crickets take over at dusk and run all night.
    crickets: smooth(clockBand(hour, 18.0, 19.8, 4.2, 5.8)) * (0.5 + nearWater * 0.3),
    // Wind in the leaves tracks the shared wind strength. The 0.055 is the
    // calm-weather baseline, so this is near zero on a still day and climbs
    // hard in a squall rather than sitting at a constant rustle.
    leaves: Math.min(1, Math.max(0, (windStrength - 0.04) / 0.26)) * 0.9 + 0.04,
    night,
    day,
  };
}

// How often each call happens, in calls per second, by hour. The dawn chorus is
// not a flourish - birds really are several times more vocal in the two hours
// after sunrise than at any other time, and a jungle that sounds the same at
// 6am as at 2pm is the thing that gives procedural ambience away.
function callRates(hour, nearWater) {
  return {
    bird: clockBand(hour, 4.6, 5.6, 8.0, 11.0) * 1.25
        + clockBand(hour, 8.0, 10.0, 15.0, 17.6) * 0.3,
    monkey: clockBand(hour, 5.6, 6.6, 8.6, 10.5) * 0.14
          + clockBand(hour, 15.5, 16.5, 17.8, 18.8) * 0.10,
    frog: clockBand(hour, 17.6, 19.0, 4.6, 5.6) * (0.10 + nearWater * 0.55),
  };
}

function AudioSystem() {
  const { camera } = useThree();

  // A browser suspends the context when the tab goes to the background, and
  // Chrome sometimes hands one back suspended even after a gesture. Both are
  // fixed by asking on the way back in. Without this the jungle comes back
  // silent after the player alt-tabs, which looks exactly like a bug.
  useEffect(() => {
    const wake = () => resumeAudio();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  const next = useRef({ bird: 1.5, monkey: 9, frog: 4, drip: 1, crackle: 0.5 });
  // Seeded from the live count: mounting part-way through a storm must not
  // replay a strike that has already been heard.
  const lastThunder = useRef(weather.thunderCount);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, delta) => {
    if (!audio.started || !audio.ctx) return;
    const ctx = audio.ctx;
    const now = ctx.currentTime;
    const d = Math.min(0.1, delta);

    // ---- the listener follows the camera
    // Without the orientation the panners still attenuate with distance but
    // never move across the stereo field, which is most of what makes a
    // waterfall feel like it is over to the left.
    const L = ctx.listener;
    camera.getWorldDirection(fwd);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (L.positionX) {
      // setValueAtTime rather than setTargetAtTime, which is what three.js's
      // own AudioListener does. An exponential approach on the listener is
      // smoother in principle but it lags the camera, and a lagging listener
      // is audible as the whole world sliding when you turn.
      L.positionX.setValueAtTime(camera.position.x, now);
      L.positionY.setValueAtTime(camera.position.y, now);
      L.positionZ.setValueAtTime(camera.position.z, now);
      L.forwardX.setValueAtTime(fwd.x, now);
      L.forwardY.setValueAtTime(fwd.y, now);
      L.forwardZ.setValueAtTime(fwd.z, now);
      L.upX.setValueAtTime(up.x, now);
      L.upY.setValueAtTime(up.y, now);
      L.upZ.setValueAtTime(up.z, now);
    } else {
      L.setPosition(camera.position.x, camera.position.y, camera.position.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    audio.listenerAt[0] = camera.position.x;
    audio.listenerAt[1] = camera.position.y;
    audio.listenerAt[2] = camera.position.z;
    audio.listenerFwd[0] = fwd.x;
    audio.listenerFwd[1] = fwd.y;
    audio.listenerFwd[2] = fwd.z;

    // The listener is the camera, because that is where the ears are. Every
    // other query here is about the *player* - whether they are under a canopy,
    // how close they are to water - and the camera sits several metres behind
    // them in third person. The sky's eye adaptation already samples the canopy
    // at the player for the same reason, and the two disagreeing would mean
    // walking under a tree darkened the picture while the rain stayed bright.
    const px = playerTransform.position[0];
    const pz = playerTransform.position[2];
    const hour = useGame.getState().timeOfDay;
    const wind = windUniforms.uWindStrength.value;

    // How close the nearest water is, as 0..1. Frogs and crickets are a
    // waterside sound, so the bed is not the same on a ridge as it is on the
    // bank of the pond.
    const toPond = Math.hypot(px - POND_CENTER[0], pz - POND_CENTER[1]) - POND_RADIUS;
    // riverDistance, not |x - centreline|: the river runs diagonally, so the
    // perpendicular distance is the x offset divided by the slope, and it
    // already returns a huge number past the river's two ends - without which
    // standing in the snow at the top of the map puts you on a riverbank.
    const toRiver = riverDistance(px, pz);
    const waterDist = Math.max(0, Math.min(toPond, toRiver));
    const nearWater = Math.max(0, Math.min(1, 1 - waterDist / 30));

    // ---- the bed
    const mix = ambienceMix(hour, wind, nearWater);
    audio.mix = mix;
    rampLayer(audio.layers.air, mix.air, now, 2.0);
    rampLayer(audio.layers.cicada, mix.cicada, now, 3.0);
    rampLayer(audio.layers.crickets, mix.crickets, now, 3.0);
    // The wind layer has to be quick - a gust that arrives in the trees three
    // seconds before it arrives in the ears is worse than no wind layer.
    rampLayer(audio.layers.leaves, mix.leaves, now, 0.5);
    // Harder wind is brighter as well as louder, because it is moving smaller
    // and smaller leaves.
    const leavesHz = 1500 + wind * 4200;
    audio.layers.leaves.filter.frequency.setTargetAtTime(leavesHz, now, 0.3);
    audio.filters.leavesHz = leavesHz;

    // ---- rain, and whether there is a canopy over it
    // Open sky is a bright hiss off ten thousand leaves. Under a closed canopy
    // that hiss is absorbed and what is left is a dull roar overhead plus
    // individual heavy drops falling through, which is the drip scheduler.
    const cover = canopyCoverAt(px, pz);
    const rainAmt = weather.rain;
    rampLayer(audio.layers.rain, rainAmt * (1 - cover * 0.78), now, 1.2);
    rampLayer(audio.layers.rainLow, rainAmt * (0.3 + cover * 0.75), now, 1.2);
    const rainHz = 2200 + (1 - cover) * 2000 + rainAmt * 900;
    audio.layers.rain.filter.frequency.setTargetAtTime(rainHz, now, 0.8);
    audio.filters.rainHz = rainHz;

    // ---- thunder, off the countdown the weather already keeps
    // weather.js sets thunderIn when lightning strikes and counts it down; the
    // flash is the strike and this is the sound arriving afterwards, with the
    // delay standing for how far away it was.
    //
    // Watching thunderCount rather than the countdown itself. The first
    // version waited to see thunderIn go positive and then negative, which
    // silently loses any strike whose countdown starts and expires inside one
    // frame - and on a slow frame that is most of them. A counter cannot be
    // missed however the frames fall.
    if (weather.thunderCount !== lastThunder.current) {
      lastThunder.current = weather.thunderCount;
      playThunder(weather.thunderDelay);
    }

    // ---- one-shots
    const rates = callRates(hour, nearWater);
    // Rain shuts the animals up, which is true and is also what stops a
    // thunderstorm sounding like a nature documentary.
    const quiet = 1 - Math.min(0.85, rainAmt * 0.9);
    const n = next.current;
    for (const kind of ['bird', 'monkey', 'frog']) {
      n[kind] -= d;
      if (n[kind] > 0) continue;
      const rate = rates[kind] * quiet;
      if (rate <= 0.0005) { n[kind] = 2 + Math.random() * 4; continue; }
      // Poisson-ish spacing: exponential gaps, so the calls clump the way real
      // ones do instead of arriving on a grid.
      n[kind] = -Math.log(1 - Math.random() * 0.999) / rate;
      if (kind === 'bird') playBird();
      else if (kind === 'monkey') playMonkey();
      else playFrog();
    }
    // Drips: only while it is raining and only under cover.
    n.drip -= d;
    if (n.drip <= 0) {
      const dripRate = rainAmt * cover * 7.0 + weather.wetness * cover * 0.5;
      if (dripRate > 0.01) {
        n.drip = -Math.log(1 - Math.random() * 0.999) / dripRate;
        playDrip();
      } else {
        n.drip = 1 + Math.random() * 2;
      }
    }

    // ---- the nearest campfire
    // One source, moved to whichever fire is closest, because fires get built
    // and burn out. Beyond the panner's reach it is silenced rather than moved,
    // so an empty camp is quiet instead of having a fire roaring under the map.
    const fire = audio.sources.fire;
    if (fire) {
      let best = null, bestD = Infinity;
      for (const id in fireRegistry) {
        const p = fireRegistry[id];
        if (!p) continue;
        const dd = (p[0] - px) * (p[0] - px) + (p[2] - pz) * (p[2] - pz);
        if (dd < bestD) { bestD = dd; best = p; }
      }
      if (best && bestD < 44 * 44) {
        if (fire.panner.positionX) {
          fire.panner.positionX.setTargetAtTime(best[0], now, 0.08);
          fire.panner.positionY.setTargetAtTime(best[1], now, 0.08);
          fire.panner.positionZ.setTargetAtTime(best[2], now, 0.08);
        } else {
          fire.panner.setPosition(best[0], best[1], best[2]);
        }
        // Rain knocks a fire down rather than putting it out.
        const fireGain = 0.30 * (1 - rainAmt * 0.45);
        fire.gain.gain.setTargetAtTime(fireGain, now, 0.4);
        audio.filters.fireGain = fireGain;
        n.crackle -= d;
        if (n.crackle <= 0) {
          n.crackle = -Math.log(1 - Math.random() * 0.999) / 3.2;
          playCrackle(best[0], best[1], best[2]);
        }
      } else {
        fire.gain.gain.setTargetAtTime(0, now, 0.5);
        audio.filters.fireGain = 0;
      }
    }

    // ---- under water
    // One lowpass on the master takes the whole world down with it, which is
    // what being under the surface sounds like: the high end is gone, the low
    // end is still there, and your own movements are louder than the world.
    const sub = Math.max(0, Math.min(1, waterRuntime.submerged));
    const muffleHz = 20000 * Math.pow(0.035, sub);
    audio.muffle.frequency.setTargetAtTime(muffleHz, now, 0.12);
    audio.filters.muffleHz = muffleHz;
    // Insects and birds do not reach you under there at all, but the water
    // does, so the ambience bus ducks and the world bus barely moves.
    const ambDuck = 1 - sub * 0.9;
    audio.buses.ambience.gain.setTargetAtTime(ambDuck, now, 0.15);
    audio.buses.weather.gain.setTargetAtTime(1 - sub * 0.75, now, 0.15);
    audio.filters.ambienceDuck = ambDuck;
    audio.filters.sub = sub;
  });

  return null;
}

export {
  clockBand,
  smooth,
  ambienceMix,
  callRates,
  AudioSystem,
};
