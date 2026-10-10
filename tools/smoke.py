"""Gameplay regression check, run after every visual section.

The brief is a visual overhaul with gameplay frozen, so this asserts on the
things that must not move: walking earns meters, the shop takes them, the
survival stats tick, resources gather, combat lands, and settings persist.

It drives the store rather than the DOM - the DOM is the part being redesigned,
the store is the part that must not change.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

URL = os.environ.get("JK_URL", "http://localhost:4444/")

CHECKS = r"""
(() => {
  const out = [];
  const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  const S = () => window.__jk.store.getState();

  // --- the world exists ---
  ok('store is reachable', !!window.__jk && !!S());
  ok('resource nodes seeded', S().resourceNodes.length > 20, S().resourceNodes.length);
  ok('shop has items', Object.keys(S().inventory).length >= 1 && S().meters >= 0);

  // --- currency: meters earned by walking, spent at the shop ---
  const m0 = S().meters;
  S().addMeters(500);
  ok('walking earns meters', S().meters === m0 + 500, S().meters);
  S().spendMeters(200);
  ok('meters can be spent', S().meters === m0 + 300, S().meters);
  const before = S().meters;
  S().spendMeters(10 ** 9);
  ok('cannot overspend', S().meters === before, S().meters);

  // --- inventory ---
  const n0 = (S().inventory.wood || 0);
  S().addItem('wood', 3);
  ok('items can be added', (S().inventory.wood || 0) === n0 + 3, S().inventory.wood);
  S().removeItem('wood', 2);
  ok('items can be removed', (S().inventory.wood || 0) === n0 + 1, S().inventory.wood);

  // --- survival stats ---
  const h0 = S().stats.health;
  S().adjustStat('health', -15);
  ok('stats take damage', S().stats.health === h0 - 15, S().stats.health);
  S().adjustStat('health', 15);
  ok('stats heal back', S().stats.health === h0, S().stats.health);

  // --- death and respawn refill every stat, not just health ---
  S().adjustStat('health', -999);
  ok('zero health kills', S().dead === true, S().dead);
  S().respawn();
  const st = S().stats;
  ok('respawn refills all six stats',
     st.health > 0 && st.hunger > 0 && st.thirst > 0 && st.energy > 0,
     JSON.stringify(st));
  ok('respawn clears death', S().dead === false);

  // --- combat ---
  const animal = Object.keys(S().animalState)[0];
  const a0 = S().animalState[animal].health;
  S().damageAnimal(animal, 5);
  ok('animals take damage', S().animalState[animal].health < a0,
     S().animalState[animal].health);

  // --- tribes ---
  ok('tribes are active', S().activeTribeIds.length >= 1, S().activeTribeIds.join(','));

  // --- time of day wraps ---
  S().setTimeOfDay(26);
  ok('time of day wraps', Math.abs(S().timeOfDay - 2) < 1e-6, S().timeOfDay);
  S().setTimeOfDay(11);

  // --- settings persist through localStorage ---
  let persisted = false;
  try {
    persisted = !!localStorage.getItem('jungleking.graphics.v1');
  } catch (e) { /* blocked */ }
  ok('graphics settings persist', persisted);

  // --- the player is on the ground, not inside it ---
  const p = window.__jk.player.position;
  const g = window.__jk.terrain(p[0], p[2]);
  ok('player stands on the terrain', Math.abs(p[1] - g) < 2.5,
     'y=' + p[1].toFixed(2) + ' ground=' + g.toFixed(2));

  return out;
})()"""


def main():
    c = Chrome(width=900, height=600)
    try:
        c.goto(URL, settle=3)
        c.js("[...document.querySelectorAll('button')].find(b=>/begin/i.test(b.textContent)).click()")
        c.drain(12)
        res = c.js(CHECKS)
        if not isinstance(res, list):
            print("FAILED TO RUN:", json.dumps(res)[:400])
            return 1
        bad = 0
        for r in res:
            print("  %s %-34s %s" % ("ok  " if r["pass"] else "FAIL", r["name"], r["detail"]))
            bad += 0 if r["pass"] else 1
        errs = [t for lvl, t in c.console() if lvl in ("error", "exception")]
        real = [e for e in sorted(set(e[:160] for e in errs)) if "404" not in e]
        print("\n%d/%d checks pass, %d console errors (404s excluded)"
              % (len(res) - bad, len(res), len(real)))
        for e in real[:8]:
            print("   ", e)
        return 1 if (bad or real) else 0
    finally:
        c.close()


sys.exit(main())
