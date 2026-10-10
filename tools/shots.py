"""Six fixed viewpoints, re-shot after every section so the work can be compared
against itself.

Playwright is what the brief asks for and what this would use if Node existed on
this machine; it does not, so this drives headless Chrome over the DevTools
protocol directly (tools/cdp.py). Same browser, same screenshots.

    python3 tools/shots.py before
    python3 tools/shots.py after-section-1

Writes screenshots/<label>/<spot>.png and prints the scene stats for each.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

URL = os.environ.get("JK_URL", "http://localhost:4444/")
WIDTH = int(os.environ.get("JK_SHOT_W", "1920"))
HEIGHT = int(os.environ.get("JK_SHOT_H", "1080"))

# Each spot: where to stand, what to face, how far to pitch, and the clock.
# `face` is a world xz point; the camera is steered onto it through the same
# look-drag channel the touch controls use, because the player controller owns
# the camera and will overwrite anything parked on it.
SPOTS = [
    dict(name="spawn",          at=(0, 8),      face=(0, -30),    pitch=-40, t=11.0),
    dict(name="riverbank",      at=(38, -96),   face=(27, -112),  pitch=-70, t=11.0),
    dict(name="lake",           at=(40, -57),   face=(40, -40),   pitch=40,  t=11.0),
    dict(name="forest-floor",   at=(-28, 26),   face=(-10, 44),   pitch=-30, t=11.0),
    dict(name="clearing-noon",  at=(16, -22),   face=(-6, -44),   pitch=-50, t=12.0),
    dict(name="clearing-dusk",  at=(16, -22),   face=(-6, -44),   pitch=-50, t=17.4),
]

HIDE_UI = """
(() => { const s = document.createElement('style'); s.id = '__hide';
  s.textContent = '#hud,.grade-overlay,.panel-overlay{display:none !important}';
  document.head.appendChild(s); return 1; })()"""

STEER = """
(() => {
  const j = window.__jk, p = j.player.position;
  const dx = %f - p[0], dz = %f - p[2];
  const f = new (j.camera.position.constructor)();
  j.camera.getWorldDirection(f);
  const err = Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz);
  j.look.lookDX = Math.max(-220, Math.min(220, err * 260));
  return +err.toFixed(3);
})()"""

STATS = """
(() => { const j = window.__jk; const p = j.player.position;
  return { pos: p.map(v => +v.toFixed(1)),
           draws: j.perf.draws, tris: j.perf.tris,
           expo: +(j.exposure() || 0).toFixed(3),
           cover: +j.canopyCoverAt(p[0], p[2]).toFixed(2),
           quality: j.graphics.quality }; })()"""


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else "before"
    quality = os.environ.get("JK_QUALITY", "high")
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "screenshots", label)
    os.makedirs(out, exist_ok=True)

    c = Chrome(width=WIDTH, height=HEIGHT)
    report = {}
    try:
        c.goto(URL, settle=3)
        c.js("""(() => { try { localStorage.setItem('jungleking.graphics.v1',
              JSON.stringify({quality:'%s', brightness:1.0, showStats:false})); } catch(e){} })()"""
             % quality)
        c.goto(URL, settle=4)
        c.js("[...document.querySelectorAll('button')].find(b=>/begin/i.test(b.textContent)).click()")
        c.drain(12)
        c.js(HIDE_UI)

        for spot in SPOTS:
            c.js("window.__jk.teleport(%f, %f)" % spot["at"])
            c.drain(3)
            c.js("window.__jk.look.lookDY = 0;")
            for _ in range(14):
                err = c.js(STEER % spot["face"])
                c.drain(1.0)
                if isinstance(err, (int, float)) and abs(err) < 0.04:
                    break
            # lookDX/lookDY are per-frame drag deltas, not absolute angles: left
            # set, they keep pitching every frame. Apply the pitch as a one-shot,
            # let exactly one frame consume it, then zero both and settle.
            c.js("window.__jk.look.lookDX = 0; window.__jk.look.lookDY = %d;" % spot["pitch"])
            c.drain(1.4)
            c.js("window.__jk.look.lookDX = 0; window.__jk.look.lookDY = 0;")
            # Set the hour LAST. A full day passes in ten real minutes, so a
            # time set before the camera finishes steering has already drifted
            # hours by the time the shutter opens - which is how "noon" came
            # back as a night shot.
            c.js("window.__jk.setTime(%f)" % spot["t"])
            c.drain(4)
            path = os.path.join(out, spot["name"] + ".png")
            c.shot_checked(path)
            st = c.js(STATS)
            report[spot["name"]] = st
            print("%-15s %s" % (spot["name"], json.dumps(st)))

        errs = [t for lvl, t in c.console() if lvl in ("error", "exception")]
        uniq = sorted(set(e[:160] for e in errs))
        # A favicon 404 is the only error this project is expected to produce.
        real = [e for e in uniq if "404" not in e]
        print("console errors: %d (%d not a 404)" % (len(errs), len(real)))
        for e in real[:10]:
            print("   ", e)
        report["_console"] = {"total": len(errs), "notFound404Excluded": real}
        with open(os.path.join(out, "stats.json"), "w") as f:
            json.dump(report, f, indent=1)
    finally:
        c.close()


main()
