"""Measure the synthesised audio, because none of it can be heard from here.

Every sound in the game is built from Web Audio nodes at runtime, which means
each one can be rendered into an OfflineAudioContext and measured exactly: no
sound card, no user gesture, no frames, deterministic, about a second of work.
That turns claims about the soundtrack into numbers - the cicada band really is
at 4.6kHz, a splash really does sweep upward where a dry footstep sweeps down,
going under the surface really does take the high end off - and it caught a real
bug: an LFO wired to add to a mix gain instead of multiply it, which left a
layer faded down to 0.05 still running at nearly full amplitude.

The synthesis primitives in src/audio.js all take their AudioContext as an
argument for exactly this reason.

    python3 tools/audiocheck.py
"""

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

URL = os.environ.get("JK_URL", "http://localhost:4444/")

LAB = r"""
(async () => {
  const L = window.__jk.audioLab;
  const RATE = 48000;

  // A real DFT over a log-spaced set of bands. Cheap, exact enough, and it
  // answers the only question that matters here: where is the energy.
  const BANDS = [40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20000];
  function spectrum(data, from, to) {
    const n = to - from;
    const out = [];
    for (let b = 0; b < BANDS.length - 1; b++) {
      const lo = BANDS[b], hi = BANDS[b + 1];
      let energy = 0, count = 0;
      // Goertzel at a handful of probe frequencies per band.
      for (let k = 0; k < 6; k++) {
        const f = lo * Math.pow(hi / lo, k / 5);
        const w = 2 * Math.PI * f / RATE;
        const coeff = 2 * Math.cos(w);
        let s1 = 0, s2 = 0;
        for (let i = from; i < to; i++) {
          const s0 = data[i] + coeff * s1 - s2;
          s2 = s1; s1 = s0;
        }
        energy += (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
        count++;
      }
      out.push(energy / count);
    }
    return out;
  }
  function rms(data, from, to) {
    let s = 0; for (let i = from; i < to; i++) s += data[i] * data[i];
    return Math.sqrt(s / (to - from));
  }
  function peakBand(sp) {
    let bi = 0; for (let i = 1; i < sp.length; i++) if (sp[i] > sp[bi]) bi = i;
    return BANDS[bi] + '-' + BANDS[bi + 1] + 'Hz';
  }
  function centroid(sp) {
    let num = 0, den = 0;
    for (let i = 0; i < sp.length; i++) {
      const f = Math.sqrt(BANDS[i] * BANDS[i + 1]);
      num += sp[i] * f; den += sp[i];
    }
    return den > 1e-20 ? num / den : 0;
  }

  async function render(seconds, build) {
    const off = new OfflineAudioContext(1, Math.round(RATE * seconds), RATE);
    build(off);
    const buf = await off.startRendering();
    return buf.getChannelData(0);
  }

  const results = {};

  // ---- the four ambience layers, each on its own, at full mix ----
  const LAYERS = {
    air:      { type: 'bandpass', freq: 900,  q: 0.4,  trim: 0.055, brown: false },
    cicada:   { type: 'bandpass', freq: 4600, q: 11,   trim: 0.9, mod: 0.55, brown: false },
    crickets: { type: 'bandpass', freq: 7400, q: 16,   trim: 1.1, brown: false },
    leaves:   { type: 'bandpass', freq: 2200, q: 0.8,  trim: 0.5, brown: false },
    rain:     { type: 'bandpass', freq: 3400, q: 0.5,  trim: 0.5, brown: false },
    rainLow:  { type: 'lowpass',  freq: 800,  q: 0.8,  trim: 0.55, brown: true },
  };
  for (const name in LAYERS) {
    const o = LAYERS[name];
    const d = await render(0.5, (off) => {
      const nb = L.makeNoiseBuffer(off, 1.0, o.brown);
      const lay = L.makeLayer(off, off.destination, nb, o);
      lay.gain.gain.value = 1;       // full mix, so this measures the layer
    });
    const sp = spectrum(d, 2400, d.length);   // skip the first 50ms of ramp
    results['layer:' + name] = { rms: rms(d, 2400, d.length), peak: peakBand(sp), centroid: centroid(sp) };
  }

  // ---- the cross-fade actually fades ----
  // The thing that was wrong before: an LFO added to the mix gain means a
  // layer at 0.1 is still at full amplitude. Render the cicada layer at three
  // mix levels and check the amplitude tracks the level.
  const fade = {};
  for (const lvl of [1.0, 0.3, 0.05, 0.0]) {
    const d = await render(0.5, (off) => {
      const nb = L.makeNoiseBuffer(off, 1.0, false);
      const lay = L.makeLayer(off, off.destination, nb, LAYERS.cicada);
      lay.gain.gain.value = lvl;
      const lfo = off.createOscillator();
      lfo.frequency.value = 7.2;
      const lg = off.createGain();
      lg.gain.value = 0.45;
      lfo.connect(lg); lg.connect(lay.mod.gain); lfo.start();
    });
    fade['mix=' + lvl] = rms(d, 2400, d.length);
  }
  results.cicadaFade = fade;

  // ---- the four footsteps ----
  for (const surf in L.FOOTSTEP_KINDS) {
    const k = L.FOOTSTEP_KINDS[surf];
    const d = await render(0.5, (off) => {
      const nb = L.makeNoiseBuffer(off, 1.0, false);
      L.burst(off, off.destination, nb, {
        type: 'bandpass', q: k.q, dur: k.dur, attack: k.attack,
        freq: k.freq, freqTo: k.freqTo, gain: k.gain, rate: k.rate,
      });
    });
    const end = Math.round(RATE * k.dur);
    const half = Math.round(end / 2);
    const spEarly = spectrum(d, 200, half);
    const spLate = spectrum(d, half, end);
    results['step:' + surf] = {
      rms: rms(d, 0, end),
      dur: k.dur,
      early: centroid(spEarly),
      late: centroid(spLate),
      // Which way it sweeps. A splash rises; everything else falls.
      sweep: centroid(spLate) > centroid(spEarly) ? 'up' : 'down',
    };
  }

  // ---- thunder, near and far ----
  for (const [name, delay] of [['near', 0.3], ['far', 5.0]]) {
    const d = await render(6.0, (off) => {
      const nb = L.makeNoiseBuffer(off, 3.0, true);
      const near = Math.max(0, Math.min(1, 1 - delay / 5.3));
      L.burst(off, off.destination, nb, {
        type: 'lowpass', freq: 80 + near * 340, freqTo: 42,
        dur: 1.7 + (1 - near) * 2.6, attack: 0.04 + (1 - near) * 0.4,
        gain: 0.14 + near * 0.34, rate: 0.3,
      });
    });
    const sp = spectrum(d, 0, Math.round(RATE * 1.5));
    results['thunder:' + name] = { rms: rms(d, 0, d.length), peak: peakBand(sp), centroid: centroid(sp) };
  }

  // ---- a bird, a monkey, a frog: these must occupy different registers ----
  const CALLS = {
    bird:   { type: 'sine',     from: 2600, to: 4600, dur: 0.07, gain: 0.045 },
    monkey: { type: 'sawtooth', from: 560,  to: 280,  dur: 0.10, gain: 0.030 },
    frog:   { type: 'square',   from: 205,  to: 185,  dur: 0.07, gain: 0.024 },
  };
  for (const name in CALLS) {
    const d = await render(0.5, (off) => L.chirp(off, off.destination, CALLS[name]));
    const end = Math.round(RATE * CALLS[name].dur * 1.3);
    const sp = spectrum(d, 0, end);
    results['call:' + name] = { rms: rms(d, 0, end), peak: peakBand(sp), centroid: centroid(sp) };
  }

  // ---- the waterfall gets louder as you approach ----
  // Rendered, not reasoned about: the same panner at four listener distances.
  const dist = {};
  for (const m of [150, 60, 20, 3]) {
    const d = await render(0.4, (off) => {
      const nb = L.makeNoiseBuffer(off, 1.0, true);
      L.makePlace(off, off.destination, nb, m, 0, 0,
        { freq: 2800, gain: 0.95, ref: 7, max: 150, rolloff: 1.15 });
      // Listener at the origin, facing -z, which is what three.js gives it.
      if (off.listener.positionX) {
        off.listener.positionX.value = 0;
        off.listener.forwardZ.value = -1;
      }
    });
    dist[m + 'm'] = rms(d, 4800, d.length);
  }
  results.waterfallByDistance = dist;

  // ---- moving the LISTENER, not the source ----
  // The distance test above moves the panner, which proves the panner works.
  // This moves the listener instead, with setValueAtTime, exactly as the frame
  // loop does - because an AudioListener's positionX.value reads back the
  // intrinsic value and reports the origin for ever, so there is no way to see
  // from outside whether the camera is reaching it. Rendering it settles the
  // question: if these three numbers differ, the listener moves.
  const byListener = {};
  for (const m of [120, 40, 4]) {
    const d = await render(0.4, (off) => {
      const nb = L.makeNoiseBuffer(off, 1.0, true);
      L.makePlace(off, off.destination, nb, 0, 0, 0,
        { freq: 2800, gain: 0.95, ref: 7, max: 150, rolloff: 1.15 });
      const li = off.listener;
      if (li.positionX) {
        li.positionX.setValueAtTime(m, 0);
        li.positionY.setValueAtTime(0, 0);
        li.positionZ.setValueAtTime(0, 0);
        li.forwardX.setValueAtTime(0, 0);
        li.forwardY.setValueAtTime(0, 0);
        li.forwardZ.setValueAtTime(-1, 0);
        li.upX.setValueAtTime(0, 0);
        li.upY.setValueAtTime(1, 0);
        li.upZ.setValueAtTime(0, 0);
      } else {
        li.setPosition(m, 0, 0);
        li.setOrientation(0, 0, -1, 0, 1, 0);
      }
    });
    byListener[m + 'm'] = rms(d, 4800, d.length);
  }
  results.listenerByDistance = byListener;

  // ---- the underwater filter ----
  const sub = {};
  for (const s of [0, 0.5, 1]) {
    const d = await render(0.4, (off) => {
      const nb = L.makeNoiseBuffer(off, 1.0, false);
      const lay = L.makeLayer(off, off.destination, nb, { type: 'bandpass', freq: 2200, q: 0.8, trim: 1 });
      lay.gain.gain.value = 1;
      // Rebuild the master muffle exactly as startAudio does it.
      const m = off.createBiquadFilter();
      m.type = 'lowpass'; m.Q.value = 0.4;
      m.frequency.value = 20000 * Math.pow(0.035, s);
      lay.trim.disconnect();
      lay.trim.connect(m); m.connect(off.destination);
    });
    const sp = spectrum(d, 4800, d.length);
    sub['submerged=' + s] = { rms: rms(d, 4800, d.length), centroid: centroid(sp), cutoff: Math.round(20000 * Math.pow(0.035, s)) };
  }
  results.underwater = sub;

  return results;
})()
"""

def main():
    c = Chrome(width=700, height=460)
    try:
        c.goto(URL, settle=3)
        c.drain(8)
        r = c.js(LAB, timeout=300)
        if isinstance(r, dict) and r.get("__exception"):
            print("EXCEPTION:", r["__exception"]); return 1
        fails = []
        def v(name, cond, detail=""):
            print("  %s %-52s %s" % ("ok  " if cond else "FAIL", name, detail))
            if not cond: fails.append(name)

        print("--- the ambience layers, rendered one at a time ---")
        for k in sorted(k for k in r if k.startswith("layer:")):
            d = r[k]
            print("  %-16s rms %.5f  peak band %-12s centroid %6.0f Hz"
                  % (k[6:], d["rms"], d["peak"], d["centroid"]))

        print("\n--- the cross-fade ---")
        f = r["cicadaFade"]
        for k in ["mix=1", "mix=0.3", "mix=0.05", "mix=0"]:
            print("  %-10s rms %.6f" % (k, f[k]))

        print("\n--- footsteps ---")
        for k in sorted(k for k in r if k.startswith("step:")):
            d = r[k]
            print("  %-8s rms %.5f  %.0fms  %5.0f -> %5.0f Hz (%s)"
                  % (k[5:], d["rms"], d["dur"] * 1000, d["early"], d["late"], d["sweep"]))

        print("\n--- thunder ---")
        for k in ["thunder:near", "thunder:far"]:
            d = r[k]
            print("  %-13s rms %.5f  peak band %-12s centroid %5.0f Hz" % (k[8:], d["rms"], d["peak"], d["centroid"]))

        print("\n--- animal calls ---")
        for k in ["call:bird", "call:monkey", "call:frog"]:
            d = r[k]
            print("  %-8s rms %.5f  peak band %-12s centroid %6.0f Hz" % (k[5:], d["rms"], d["peak"], d["centroid"]))

        print("\n--- the waterfall by distance ---")
        for k, val in r["waterfallByDistance"].items():
            print("  %-6s rms %.5f" % (k, val))

        print("\n--- the same source, with the LISTENER moved ---")
        for k, val in r["listenerByDistance"].items():
            print("  %-6s rms %.5f" % (k, val))

        print("\n--- the underwater filter ---")
        for k, d in r["underwater"].items():
            print("  %-14s cutoff %5d Hz  rms %.5f  centroid %6.0f Hz" % (k, d["cutoff"], d["rms"], d["centroid"]))

        print("\n--- verdicts ---")
        L = lambda n: r["layer:" + n]
        v("every layer actually makes a sound", all(L(n)["rms"] > 1e-4 for n in
          ["air", "cicada", "crickets", "leaves", "rain", "rainLow"]),
          "min %.5f" % min(L(n)["rms"] for n in ["air","cicada","crickets","leaves","rain","rainLow"]))
        v("cicadas sit in the 2.5-5kHz band", L("cicada")["peak"] == "2560-5120Hz", L("cicada")["peak"])
        v("crickets sit above cicadas", L("crickets")["centroid"] > L("cicada")["centroid"] * 1.3,
          "%.0f vs %.0f Hz" % (L("crickets")["centroid"], L("cicada")["centroid"]))
        v("wind in the leaves sits below both",
          L("leaves")["centroid"] < L("cicada")["centroid"],
          "%.0f vs %.0f Hz" % (L("leaves")["centroid"], L("cicada")["centroid"]))
        v("the low rain layer is far darker than the bright one",
          L("rainLow")["centroid"] < L("rain")["centroid"] * 0.5,
          "%.0f vs %.0f Hz" % (L("rainLow")["centroid"], L("rain")["centroid"]))
        v("the cross-fade is monotonic", f["mix=1"] > f["mix=0.3"] > f["mix=0.05"] > f["mix=0"])
        v("a mix of 0.05 is near silent, not full amplitude",
          f["mix=0.05"] < f["mix=1"] * 0.12,
          "%.1f%% of full" % (100 * f["mix=0.05"] / max(1e-12, f["mix=1"])))
        v("mix 0 is silent", f["mix=0"] < 1e-6, "%.3g" % f["mix=0"])
        S = lambda n: r["step:" + n]
        v("four footsteps, four different sounds",
          len({round(S(n)["early"] / 100) for n in ["leaves", "mud", "rock", "water"]}) == 4,
          ", ".join("%s %.0fHz" % (n, S(n)["early"]) for n in ["leaves","mud","rock","water"]))
        v("mud is the darkest footstep",
          S("mud")["early"] < min(S(n)["early"] for n in ["leaves", "rock", "water"]))
        v("rock is the shortest footstep",
          S("rock")["dur"] < min(S(n)["dur"] for n in ["leaves", "mud", "water"]))
        v("a splash sweeps upward, the dry surfaces downward",
          S("water")["sweep"] == "up" and all(S(n)["sweep"] == "down" for n in ["leaves", "mud", "rock"]))
        v("thunder is below 160Hz", r["thunder:near"]["centroid"] < 160 and r["thunder:far"]["centroid"] < 160,
          "near %.0f far %.0f Hz" % (r["thunder:near"]["centroid"], r["thunder:far"]["centroid"]))
        v("distant thunder is darker than near thunder",
          r["thunder:far"]["centroid"] < r["thunder:near"]["centroid"],
          "%.0f vs %.0f Hz" % (r["thunder:far"]["centroid"], r["thunder:near"]["centroid"]))
        v("bird, monkey and frog occupy different registers",
          r["call:bird"]["centroid"] > r["call:monkey"]["centroid"] > r["call:frog"]["centroid"],
          "%.0f > %.0f > %.0f Hz" % (r["call:bird"]["centroid"], r["call:monkey"]["centroid"], r["call:frog"]["centroid"]))
        w = r["waterfallByDistance"]
        v("the waterfall gets louder as you approach",
          w["3m"] > w["20m"] > w["60m"] > w["150m"],
          " < ".join("%.5f" % w[k] for k in ["150m", "60m", "20m", "3m"]))
        lb = r["listenerByDistance"]
        v("moving the listener changes what it hears",
          lb["4m"] > lb["40m"] > lb["120m"],
          " < ".join("%.5f" % lb[k] for k in ["120m", "40m", "4m"]))
        u = r["underwater"]
        v("going under takes the high end off",
          u["submerged=1"]["centroid"] < u["submerged=0"]["centroid"] * 0.4,
          "%.0f -> %.0f Hz" % (u["submerged=0"]["centroid"], u["submerged=1"]["centroid"]))
        v("and takes level with it", u["submerged=1"]["rms"] < u["submerged=0"]["rms"] * 0.5,
          "%.5f -> %.5f" % (u["submerged=0"]["rms"], u["submerged=1"]["rms"]))

        errs = [str(l) for l in c.console() if "404" not in str(l)]
        v("no console errors", len(errs) == 0, "; ".join(errs[:3]))
        print("\n%d failure(s)" % len(fails))
        return 1 if fails else 0
    finally:
        c.close()

sys.exit(main())
