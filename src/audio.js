import { groundSoftness } from './clutter.js';
import { POND_CENTER, POND_SURFACE_Y, riverCenterX } from './data.js';
import { RIVER, getTerrainHeight, riverSurfaceY, waterSurfaceAt } from './terrain.js';

// ============================================================
// audio.js - the whole soundtrack, synthesised
//
// Before this there was exactly one sound in the game: two oscillators that
// played when you bought something from Kito. Everything here is made with the
// Web Audio API at runtime, which is not a compromise forced by having no asset
// pipeline - it is the same decision the rest of this project makes about
// textures and meshes, and it happens to suit nature sound particularly well.
// A cicada really is amplitude-modulated noise. A frog really is a pulsed low
// tone. Rain and a waterfall really are filtered noise that differ mostly in
// their filter, and a footstep in leaf litter differs from one in mud by about
// two octaves and a decay time.
//
// The graph is three buses under one master, through one filter:
//
//   master -> muffle -> destination        muffle is the surface of the water
//     ambience   the bed, cross-faded by time of day
//     world      positioned sources (waterfall, river, pond) and footsteps
//     weather    rain and thunder
//
// Everything continuous is a looping noise buffer through a filter and a gain,
// and the mix *is* the cross-fade: each layer on its own is near-silent hiss,
// and what makes it a jungle at four in the afternoon rather than at midnight
// is which gains are up.
//
// A browser will not start an AudioContext without a user gesture, so nothing
// here exists until the first click.
// ============================================================

const AUDIO_STORAGE_KEY = 'jungleking.audio.v1';

const audioSettings = {
  volume: 0.7,
  muted: false,
};

try {
  const raw = localStorage.getItem(AUDIO_STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (typeof saved.volume === 'number' && isFinite(saved.volume)) {
      audioSettings.volume = Math.max(0, Math.min(1, saved.volume));
    }
    if (typeof saved.muted === 'boolean') audioSettings.muted = saved.muted;
  }
} catch (e) { /* storage blocked; the defaults are fine */ }

function saveAudioSettings() {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(audioSettings));
  } catch (e) { /* ignore */ }
}

const audio = {
  ctx: null,
  master: null,
  muffle: null,
  buses: {},
  layers: {},
  sources: {},
  buffers: null,
  started: false,
  failed: null,
  // What the ambience mix resolved to last frame, so it can be read from the
  // console instead of guessed at by ear.
  mix: {},
  // The filter cutoffs the frame loop last asked for. These are kept as plain
  // numbers because an AudioParam under automation does not reliably report the
  // automated value through `.value` - that reads the intrinsic value, which a
  // setTargetAtTime never touches. Without this there is no way to check from
  // outside that the canopy and the water are reaching the filters at all.
  filters: { leavesHz: 0, rainHz: 0, muffleHz: 0, fireGain: 0, ambienceDuck: 1, sub: 0 },
  // Where the listener was last put, for the same reason: an AudioListener's
  // positionX.value reads back the intrinsic value and so reports the origin
  // for ever no matter where the camera goes.
  listenerAt: [0, 0, 0],
  listenerFwd: [0, 0, -1],
  stats: { layers: 0, oneShots: 0, steps: 0, thunder: 0, calls: 0 },
};

// ---------- building blocks ----------

// Looping noise. A few seconds of it is indistinguishable from an infinite
// amount once it has been through a filter, and generating it once costs less
// than a single frame.
function makeNoiseBuffer(ctx, seconds, brown) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      // Integrated noise: 6dB/octave of low end, which is what moving water
      // and wind actually are. White noise through a lowpass is not the same
      // thing and sounds like a hiss with the top taken off.
      last = (last + 0.021 * white) / 1.02;
      d[i] = Math.max(-1, Math.min(1, last * 3.2));
    } else {
      d[i] = white;
    }
  }
  // A loop point in the middle of a waveform is a click once a cycle. Crossfade
  // the tail into the head so the seam is inaudible.
  const fade = Math.min(Math.floor(n * 0.08), Math.floor(ctx.sampleRate * 0.05));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[n - fade + i] * (1 - t);
  }
  return buf;
}

function makeNoiseSource(ctx, buffer, loop) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop !== false;
  return src;
}

// One continuous layer, with its own gain so the mix can fade it.
function makeLayer(ctx, dest, buffer, opts) {
  const src = makeNoiseSource(ctx, buffer);
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type || 'bandpass';
  filter.frequency.value = opts.freq || 1000;
  filter.Q.value = opts.q === undefined ? 1 : opts.q;
  // Two gains in series: `gain` is what the mix drives, `trim` is the fixed
  // level that makes the layer sit right. Keeping them apart means the mix can
  // deal in 0..1 everywhere and never has to know that cicadas need a tenth of
  // the gain that wind does.
  const trim = ctx.createGain();
  trim.gain.value = opts.trim === undefined ? 1 : opts.trim;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  // A third gain, between the mix and the trim, for anything that wants to
  // modulate this layer. It has to be its own node: an LFO connected straight
  // to `gain.gain` would be *added* to the mix level, so at a mix of 0.2 and a
  // depth of 0.5 the gain would swing from -0.3 to 0.7 and the layer would
  // still be at full amplitude with its phase flipping. Multiplying instead of
  // adding is what makes the cross-fade actually fade.
  const mod = ctx.createGain();
  mod.gain.value = opts.mod === undefined ? 1 : opts.mod;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(mod);
  mod.connect(trim);
  trim.connect(dest);
  src.start();
  return { src, filter, gain, mod, trim, level: 0 };
}

// Move a layer toward a level over a short ramp. Setting gain directly on a
// per-frame basis is a zipper noise; a 150ms ramp is inaudible and smooth.
function rampLayer(layer, level, now, seconds) {
  if (!layer) return;
  if (Math.abs(level - layer.level) < 0.002) return;
  layer.level = level;
  layer.gain.gain.cancelScheduledValues(now);
  layer.gain.gain.setTargetAtTime(level, now, (seconds || 0.4) / 3);
}

// ---------- one-shots ----------

// A chirp: a short frequency sweep. Two a beat apart is a bird; one low and
// slow with a square wave is a frog; three falling sawtooths is a howler monkey.
function chirp(ctx, dest, opts) {
  const now = ctx.currentTime + (opts.delay || 0);
  const dur = opts.dur || 0.09;
  const osc = ctx.createOscillator();
  osc.type = opts.type || 'sine';
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(Math.max(20, opts.from), now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), now + dur);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain || 0.2), now + dur * 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  audio.stats.oneShots++;
}

// A burst of filtered noise. Footsteps, splashes and thunder are all this node
// chain with different filters and envelopes, which is most of the argument for
// doing audio this way.
function burst(ctx, dest, buffer, opts) {
  const now = ctx.currentTime + (opts.delay || 0);
  const dur = opts.dur || 0.2;
  const src = makeNoiseSource(ctx, buffer, false);
  src.playbackRate.value = opts.rate || 1;
  // Start somewhere random in the buffer, or every footstep is the same
  // footstep and the walk cycle turns into a loop you can hear.
  const off = Math.random() * Math.max(0, buffer.duration - dur * (opts.rate || 1) - 0.05);
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type || 'bandpass';
  filter.frequency.setValueAtTime(Math.max(20, opts.freq || 900), now);
  if (opts.freqTo) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), now + dur);
  }
  filter.Q.value = opts.q === undefined ? 0.8 : opts.q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain || 0.2), now + (opts.attack || 0.008));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(now, off);
  src.stop(now + dur + 0.05);
  audio.stats.oneShots++;
}

// ---------- positioned sources ----------
// The waterfall is a place, not a volume slider. A PannerNode with an inverse
// distance model does the work: walk toward it and it gets louder and moves
// across the stereo field on its own, and walk behind a hill and it is still
// there, which is correct - sound does not need line of sight.
function makePlace(ctx, dest, buffer, x, y, z, opts) {
  const src = makeNoiseSource(ctx, buffer);
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type || 'lowpass';
  filter.frequency.value = opts.freq || 1800;
  filter.Q.value = opts.q === undefined ? 0.7 : opts.q;
  const gain = ctx.createGain();
  gain.gain.value = opts.gain === undefined ? 0.5 : opts.gain;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = opts.ref || 6;
  panner.maxDistance = opts.max || 140;
  panner.rolloffFactor = opts.rolloff === undefined ? 1.1 : opts.rolloff;
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
  src.connect(filter);
  filter.connect(gain);
  gain.connect(panner);
  panner.connect(dest);
  src.start();
  return { src, filter, gain, panner, pos: [x, y, z] };
}

// ---------- start ----------

function masterTarget() {
  if (audioSettings.muted) return 0;
  return Math.max(0, Math.min(1, audioSettings.volume)) * 0.55;
}

function startAudio() {
  if (audio.started || audio.failed) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('no Web Audio in this browser');
    const ctx = new Ctx();
    audio.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.0001;
    // One filter for the whole world, so going under the surface can muffle
    // everything with a single node rather than per source. Twenty kilohertz is
    // "open"; two is "underwater".
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    muffle.Q.value = 0.4;
    master.connect(muffle);
    muffle.connect(ctx.destination);
    audio.master = master;
    audio.muffle = muffle;

    for (const name of ['ambience', 'world', 'weather']) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(master);
      audio.buses[name] = g;
    }

    const white = makeNoiseBuffer(ctx, 3, false);
    const brown = makeNoiseBuffer(ctx, 3, true);
    audio.buffers = { white, brown };

    const amb = audio.buses.ambience;
    audio.layers = {
      // Daytime air. Wide and very quiet; its only job is to stop the world
      // sounding like a vacuum between the bird calls.
      air: makeLayer(ctx, amb, white, { type: 'bandpass', freq: 900, q: 0.4, trim: 0.055 }),
      // Cicadas: a narrow band, pulsed by the LFO below. The band is narrow
      // enough to have a pitch, which is what makes it an insect rather than
      // a hiss.
      // `mod` is the midpoint the LFO below swings around; the swing is
      // multiplied by the mix level, so quiet cicadas are quiet.
      cicada: makeLayer(ctx, amb, white, { type: 'bandpass', freq: 4600, q: 11, trim: 0.9, mod: 0.55 }),
      // Night insects, higher and thinner, and steady rather than pulsed.
      crickets: makeLayer(ctx, amb, white, { type: 'bandpass', freq: 7400, q: 16, trim: 1.1 }),
      // Wind in the leaves, driven by the same wind strength that leans the
      // trees. This is the layer that ties the audio to the visible world.
      leaves: makeLayer(ctx, amb, white, { type: 'bandpass', freq: 2200, q: 0.8, trim: 0.5 }),
    };

    // Cicadas pulse, and a slow LFO on their gain is the entire effect. Without
    // it they are hiss; with it they are unmistakable. It modulates the gain's
    // AudioParam directly, so it rides on top of whatever the mix sets.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 7.2;
    const lfoGain = ctx.createGain();
    // 0.55 +/- 0.45, so the layer pulses between a tenth and full and never
    // crosses zero.
    lfoGain.gain.value = 0.45;
    lfo.connect(lfoGain);
    lfoGain.connect(audio.layers.cicada.mod.gain);
    lfo.start();
    audio.cicadaLfo = lfo;
    audio.cicadaLfoGain = lfoGain;

    // Water, as places. The waterfall sits at the foot of the drop where the
    // noise actually comes from, not at the lip.
    audio.sources.waterfall = makePlace(ctx, audio.buses.world, brown,
      riverCenterX(RIVER.fallZ), RIVER.fallBottom + 1.0, RIVER.fallZ,
      { freq: 2800, gain: 0.95, ref: 7, max: 150, rolloff: 1.15 });
    // The river gets one source downstream of the fall, which is the stretch
    // the player actually walks beside.
    const riverZ = RIVER.fallZ + 45;
    audio.sources.river = makePlace(ctx, audio.buses.world, brown,
      riverCenterX(riverZ), riverSurfaceY(riverZ) + 0.3, riverZ,
      { freq: 1400, gain: 0.34, ref: 6, max: 75, rolloff: 1.5 });
    // The pond barely makes a sound, which is the point: it is the quiet one.
    audio.sources.pond = makePlace(ctx, audio.buses.world, brown,
      POND_CENTER[0], POND_SURFACE_Y + 0.2, POND_CENTER[1],
      { freq: 600, gain: 0.14, ref: 10, max: 60, rolloff: 1.7 });

    // A campfire. One source that moves to whichever fire is nearest, for the
    // same reason the firelight shadow comes from one roving spotlight: fires
    // are built and burn out, and a jungle full of permanent sources for fires
    // that are not there is a lot of nodes doing nothing. Parked below the map
    // and silent until the frame loop finds one.
    audio.sources.fire = makePlace(ctx, audio.buses.world, brown,
      0, -400, 0, { freq: 900, gain: 0.0, ref: 3.5, max: 40, rolloff: 1.8 });

    // Rain, in two layers so it can sound different under the canopy. Open sky
    // is the bright one - a hiss on leaves and water. Under a closed canopy the
    // hiss is gone and what is left is heavy, irregular drips, which is the low
    // layer plus the scheduled drops in the frame loop.
    audio.layers.rain = makeLayer(ctx, audio.buses.weather, white,
      { type: 'bandpass', freq: 3400, q: 0.5, trim: 0.5 });
    audio.layers.rainLow = makeLayer(ctx, audio.buses.weather, brown,
      { type: 'lowpass', freq: 800, q: 0.8, trim: 0.55 });

    audio.stats.layers = Object.keys(audio.layers).length;
    audio.started = true;

    // Fade up rather than cutting in, which would be a click and a fright.
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(masterTarget(), ctx.currentTime + 1.8);
  } catch (e) {
    audio.failed = String((e && e.message) || e);
    console.warn('[jungle-king] audio unavailable:', audio.failed);
  }
}

// Browsers suspend the context when the tab is hidden, and Chrome starts it
// suspended even after a gesture in some cases. Both are fixed by asking.
function resumeAudio() {
  if (audio.ctx && audio.ctx.state === 'suspended') {
    const p = audio.ctx.resume();
    if (p && p.catch) p.catch(() => {});
  }
}

function setVolume(v) {
  audioSettings.volume = Math.max(0, Math.min(1, v));
  saveAudioSettings();
  if (audio.master) {
    audio.master.gain.setTargetAtTime(masterTarget(), audio.ctx.currentTime, 0.04);
  }
}

function setMuted(m) {
  audioSettings.muted = !!m;
  saveAudioSettings();
  if (audio.master) {
    audio.master.gain.setTargetAtTime(masterTarget(), audio.ctx.currentTime, 0.04);
  }
}

// ---------- footsteps ----------

// Which surface is underfoot, as a name. Leaf litter, mud, rock and shallow
// water are four genuinely different sounds, and using one of them for all four
// is more noticeable than having no footsteps at all. The thresholds match how
// the terrain splat shader picks its layers, so what you hear is what you see.
function footstepSurface(x, z) {
  const ground = getTerrainHeight(x, z);
  const w = waterSurfaceAt(x, z);
  if (w !== -Infinity && w > ground + 0.03) return 'water';
  // Slope is tested before softness, and the order matters. groundSoftness
  // rises across the whole map while it is raining and stays up for minutes
  // afterwards, so testing softness first turned every surface in the world
  // into mud after a shower - including bare rock faces, which do not become
  // mud however wet they get. The splat shader calls it rock above about 0.40
  // of (1 - normal.y); this is the same measure from the same height function,
  // so what you hear is what you see.
  const e = 1.1;
  const gx = (getTerrainHeight(x + e, z) - getTerrainHeight(x - e, z)) / (2 * e);
  const gz = (getTerrainHeight(x, z + e) - getTerrainHeight(x, z - e)) / (2 * e);
  const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
  if (slope > 0.40) return 'rock';
  if (groundSoftness(x, z) > 0.4) return 'mud';
  return 'leaves';
}

// Centre frequency, where it sweeps to, how long, how loud. Leaf litter is a
// bright crackle that falls; mud is a damp low thud; rock is a short hard tick;
// water sweeps *upward*, because a splash is a rising spray, not a falling one.
const FOOTSTEP_KINDS = {
  leaves: { freq: 2800, freqTo: 1100, q: 0.7, dur: 0.17, gain: 0.075, rate: 1.0 },
  mud: { freq: 520, freqTo: 230, q: 1.3, dur: 0.22, gain: 0.095, rate: 0.8, attack: 0.014 },
  rock: { freq: 1900, freqTo: 950, q: 2.2, dur: 0.09, gain: 0.085, rate: 1.2 },
  water: { freq: 1400, freqTo: 3200, q: 0.5, dur: 0.30, gain: 0.115, rate: 1.0, attack: 0.02 },
};

function playFootstep(x, z) {
  audio.stats.calls++;
  if (!audio.started) return;
  const name = footstepSurface(x, z);
  const kind = FOOTSTEP_KINDS[name] || FOOTSTEP_KINDS.leaves;
  burst(audio.ctx, audio.buses.world, audio.buffers.white, {
    type: 'bandpass',
    q: kind.q,
    dur: kind.dur,
    attack: kind.attack,
    // Variation per step, or the walk cycle becomes a metronome. A real pair of
    // feet never make the same sound twice.
    freq: kind.freq * (0.82 + Math.random() * 0.36),
    freqTo: kind.freqTo * (0.85 + Math.random() * 0.3),
    gain: kind.gain * (0.7 + Math.random() * 0.6),
    rate: kind.rate * (0.9 + Math.random() * 0.2),
  });
  audio.stats.steps++;
  return name;
}

// ---------- the rest of the one-shots ----------

function playThunder(delay) {
  if (!audio.started) return;
  // How far away it was, from how long the sound took to arrive. Near strikes
  // keep their crack; distant ones have had everything above a couple of
  // hundred hertz absorbed on the way, which is why far thunder is a rumble
  // and near thunder is a bang.
  const near = Math.max(0, Math.min(1, 1 - (delay || 2) / 5.3));
  burst(audio.ctx, audio.buses.weather, audio.buffers.brown, {
    type: 'lowpass',
    freq: 80 + near * 340,
    freqTo: 42,
    dur: 1.7 + (1 - near) * 2.6,
    attack: 0.04 + (1 - near) * 0.4,
    gain: 0.14 + near * 0.34,
    rate: 0.3,
  });
  // A second, longer tail a moment later: thunder is one strike heard off
  // several hillsides, never a single event.
  burst(audio.ctx, audio.buses.weather, audio.buffers.brown, {
    type: 'lowpass', freq: 70, freqTo: 36,
    dur: 2.2 + (1 - near) * 2.0, attack: 0.5,
    gain: 0.07 + near * 0.12, rate: 0.26, delay: 0.35 + Math.random() * 0.5,
  });
  audio.stats.thunder++;
}

function playBird() {
  if (!audio.started) return;
  const dest = audio.buses.ambience;
  const base = 1700 + Math.random() * 1900;
  chirp(audio.ctx, dest, { from: base, to: base * (1.35 + Math.random()), dur: 0.07, gain: 0.045 });
  if (Math.random() < 0.65) {
    chirp(audio.ctx, dest, { from: base * 1.1, to: base * 0.78, dur: 0.06,
      gain: 0.035, delay: 0.12 + Math.random() * 0.1 });
  }
}

function playMonkey() {
  if (!audio.started) return;
  const base = 420 + Math.random() * 280;
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    chirp(audio.ctx, audio.buses.ambience, {
      type: 'sawtooth', from: base * (1 - i * 0.04), to: base * 0.5,
      dur: 0.1, gain: 0.03, delay: i * (0.15 + Math.random() * 0.06),
    });
  }
}

function playFrog() {
  if (!audio.started) return;
  const base = 150 + Math.random() * 110;
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    chirp(audio.ctx, audio.buses.ambience, {
      type: 'square', from: base, to: base * 0.9,
      dur: 0.07, gain: 0.024, delay: i * 0.105,
    });
  }
}

// A sharp snap from a fire. The roar is the continuous source; this is the
// thing on top of it that makes a fire read as a fire rather than as noise.
function playCrackle(x, y, z) {
  if (!audio.started) return;
  const ctx = audio.ctx;
  // Its own panner at the fire's position, so a crack from the far side of the
  // camp arrives from the far side of the camp. The continuous roar cannot do
  // this job - it is one source parked on the nearest fire, and a one-shot
  // wants to come from wherever it happened.
  const f = 1400 + Math.random() * 2600;
  const src = makeNoiseSource(ctx, audio.buffers.white, false);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = f;
  filter.Q.value = 2.5 + Math.random() * 3;
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  const dur = 0.035 + Math.random() * 0.05;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.02 + Math.random() * 0.045, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  const pan = ctx.createPanner();
  pan.panningModel = 'HRTF';
  pan.distanceModel = 'inverse';
  pan.refDistance = 3;
  pan.maxDistance = 45;
  pan.rolloffFactor = 1.8;
  if (pan.positionX) {
    pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z;
  } else {
    pan.setPosition(x, y, z);
  }
  src.connect(filter); filter.connect(gain); gain.connect(pan);
  pan.connect(audio.buses.world);
  src.start(now, Math.random() * 2.5);
  src.stop(now + dur + 0.03);
  audio.stats.oneShots++;
}

// A single heavy drop off a leaf. Under a closed canopy during rain this is
// most of what you hear, and it is the detail that sells being under cover.
function playDrip() {
  if (!audio.started) return;
  const f = 900 + Math.random() * 1400;
  burst(audio.ctx, audio.buses.weather, audio.buffers.white, {
    type: 'bandpass', freq: f, freqTo: f * 0.45, q: 3.5,
    dur: 0.08, gain: 0.03 + Math.random() * 0.03, rate: 1.1,
  });
}

export {
  AUDIO_STORAGE_KEY,
  audioSettings,
  saveAudioSettings,
  audio,
  makeNoiseBuffer,
  makeNoiseSource,
  makeLayer,
  rampLayer,
  chirp,
  burst,
  makePlace,
  masterTarget,
  startAudio,
  resumeAudio,
  setVolume,
  setMuted,
  footstepSurface,
  FOOTSTEP_KINDS,
  playFootstep,
  playThunder,
  playBird,
  playMonkey,
  playFrog,
  playCrackle,
  playDrip,
};
