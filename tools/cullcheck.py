"""Measure what the plant culling actually saves, against the version without it.

Frame rate is not measurable on this machine - headless is swiftshader software
rendering at about a frame a second - so the honest numbers are the ones the
renderer reports: how many draw calls it issues, how many triangles it submits,
and how many of the map's plant parts it is asked to draw at all. Those are the
inputs to frame rate, and the trade this change makes is visible in them: more
draw calls, far fewer instances.

Run against two servers to compare two commits:

    JK_URL=http://localhost:4444/ python3 tools/cullcheck.py
    JK_URL=http://localhost:4457/ python3 tools/cullcheck.py   # an older build
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

URL = os.environ.get("JK_URL", "http://localhost:4444/")
PRESETS = ["low", "medium", "high", "ultra"]

# Six places, the same ones the screenshots use, so the numbers describe the
# frames that have been looked at rather than an average of nowhere.
SPOTS = [
    ("spawn", 0, 8, 0, -30),
    ("riverbank", 38, -96, 27, -112),
    ("lake", 40, -57, 40, -40),
    ("forest-floor", -28, 26, -10, 44),
    ("clearing", 16, -22, -6, -44),
    ("ridge", -150, 150, -120, 120),
]

READ = r"""
(() => {
  const J = window.__jk;
  const p = J.perf;
  const v = J.veg || null;
  return {
    draws: p.draws, tris: p.tris,
    batches: v ? v.batches : null,
    visible: v ? v.visible : null,
    instances: v ? v.instances : null,
    drawn: v ? v.drawn : null,
    detail: v ? v.detail : null,
  };
})()
"""

def main():
    # A small window on purpose. Ultra renders at dpr 2.0, so 1280x720 becomes
    # 2560x1440 of software rasterisation and a single frame can take minutes -
    # long enough that the readout goes stale and reports the previous preset's
    # numbers, which is exactly what happened the first time this was run.
    c = Chrome(width=720, height=460)
    rows = []
    try:
        c.goto(URL, settle=3)
        c.drain(10)
        c.js("window.__jk.store.getState().start()")
        c.drain(6)
        c.js("window.__jk.setTime(12)")
        c.drain(4)
        has_veg = c.js("!!window.__jk.veg")
        print("URL %s   culling instrumented: %s" % (URL, has_veg))
        for preset in PRESETS:
            c.js("window.__jk.store.getState().setGraphicsQuality('%s')" % preset)
            # A preset change rebuilds the scatter, which is the expensive part.
            c.drain(20)
            for name, x, z, fx, fz in SPOTS:
                c.js("window.__jk.teleport(%d, %d)" % (x, z))
                c.drain(7)
                r = c.js(READ, timeout=180)
                r["preset"] = preset
                r["spot"] = name
                r["frames"] = c.js("window.__jk.perf.fps > 0 ? 1 : 0")
                rows.append(r)
                if r["batches"] is None:
                    print("  %-7s %-13s %5d draws  %7.0fk tris"
                          % (preset, name, r["draws"], r["tris"] / 1000.0))
                else:
                    print("  %-7s %-13s %5d draws  %7.0fk tris   %4d/%4d batches  %6.0fk/%6.0fk parts"
                          % (preset, name, r["draws"], r["tris"] / 1000.0,
                             r["visible"], r["batches"],
                             r["drawn"] / 1000.0, r["instances"] / 1000.0))
        print()
        print("--- per preset, averaged over the six places ---")
        for preset in PRESETS:
            sel = [r for r in rows if r["preset"] == preset]
            n = len(sel)
            d = sum(r["draws"] for r in sel) / n
            t = sum(r["tris"] for r in sel) / n
            line = "  %-7s %6.0f draws  %7.0fk tris" % (preset, d, t / 1000.0)
            if sel[0]["batches"] is not None:
                dr = sum(r["drawn"] for r in sel) / n
                inst = sel[0]["instances"]
                line += "   %6.0fk/%6.0fk parts submitted (%4.1f%%)" % (
                    dr / 1000.0, inst / 1000.0, 100.0 * dr / max(1, inst))
            print(line)
        print()
        print("--- stale readouts ---")
        for preset in PRESETS:
            sel = [r for r in rows if r["preset"] == preset]
            sig = {(r["draws"], r["tris"], r["visible"]) for r in sel}
            stale = len(sig) == 1 and len(sel) > 1
            print("  %s %-7s %d distinct readings over %d places%s"
                  % ("FAIL" if stale else "ok  ", preset, len(sig), len(sel),
                     "  (the page stopped updating; these numbers are not measurements)" if stale else ""))
            if stale:
                rows = [r for r in rows if r["preset"] != preset]

        print()
        print("--- the preset ladder must go one way ---")
        fails = 0
        order = []
        live = [p for p in PRESETS if any(r["preset"] == p for r in rows)]
        for preset in live:
            sel = [r for r in rows if r["preset"] == preset]
            order.append(sum(r["tris"] for r in sel) / len(sel))
        for i in range(len(live) - 1):
            ok = order[i] <= order[i + 1] * 1.02
            print("  %s %s <= %s  (%.0fk vs %.0fk tris)"
                  % ("ok  " if ok else "FAIL", live[i], live[i + 1],
                     order[i] / 1000.0, order[i + 1] / 1000.0))
            if not ok:
                fails += 1
        # Errors only. swiftshader complains "GPU stall due to ReadPixels" on
        # every frame, which is software rendering being software rendering.
        errs = [t for lvl, t in c.console() if lvl in ("error", "exception") and "404" not in t]
        print("  %s no console errors  %s" % ("ok  " if not errs else "FAIL", "; ".join(errs[:3])))
        if errs:
            fails += 1
        out = os.environ.get("JK_CULL_JSON")
        if out:
            with open(out, "w") as f:
                json.dump(rows, f)
            print("\nwrote %s" % out)
        print("\n%d failure(s)" % fails)
        return 1 if fails else 0
    finally:
        c.close()

sys.exit(main())
