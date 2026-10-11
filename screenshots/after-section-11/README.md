# Section 11, two of six viewpoints

Shot at 960x540 rather than the 1920x1080 the other sets use, and only two of
the six places. Both are limits of this machine on this day, not of the work:
headless here is swiftshader software rendering, 1920x1080 at the High preset's
device pixel ratio is 3072x1728 of software rasterisation, and a run at that
size produced no frame at all in forty minutes. At 960x540 it manages a
viewpoint roughly every ten minutes, and the machine's own background daemons
were taking well over a core throughout.

    python3 tools/shots.py after-section-11

will produce the full set at full size on hardware that can render it.

What the two show, and what they were for: the forest at spawn looks thin, and
the obvious suspect was this section's culling. `screenshots/cull-ab/` settles
that it is not - see the README there.
