# Jungle King — realism audit

What the renderer actually does today, item by item, and why each one reads as
fake. Written against `index.html` at commit `f2863ce` (13,147 lines, 512 KB,
one self-contained file).

**One fact shapes everything below: there are no asset files.** Every texture,
every mesh, every sound is generated in JavaScript at load time. That is why the
world is consistent and loads instantly, and it is also the single biggest
reason it looks synthetic — procedural value noise has no grain, no history and
no dirt, and nothing in the world was ever photographed.

Four passes of work already landed (lighting, atmosphere/post, vegetation,
water). Where something is already good, this says so, because the point of an
audit is to say where the remaining budget should go — not to relitigate work
that is done.

---

## Renderer settings

| | now |
|---|---|
| `outputColorSpace` | `SRGBColorSpace` ✅ |
| tone mapping | ACES Filmic, moved into the post composite (Narkowicz fit) |
| HDR path | scene renders to a half-float target, `NoToneMapping` on the renderer, tone mapped at the end ✅ |
| antialias | MSAA on the canvas — **but the post chain renders to its own target, so MSAA never applies** ❌ |
| exposure | driven by eye adaptation from canopy cover, `EXPOSURE_BASE` 0.52 |

**Why it looks fake:** the colour pipeline is correct, which is why the sky and
the water look as good as they do. The missing piece is antialiasing: once the
scene goes through an offscreen target the canvas `antialias: true` does nothing,
so every leaf cut-out and grass blade has a hard stair-stepped edge. There is no
SMAA/FXAA in the chain. This is the single cheapest visible win left.

AgX is not available in three 0.160 (`AgXToneMapping` landed in r162). Either
pin a newer three or implement the AgX fit by hand in the composite — the latter
is ~20 lines and avoids a dependency bump.

## Lighting

One `DirectionalLight` (sun, intensity 2), one for the moon, one `AmbientLight`
at 0.18, one `HemisphereLight` at 0.6, plus a pool of fire point lights and one
shadow-casting spotlight for the nearest campfire.

**Why it looks fake:** the ambient + hemisphere pair is exactly the "fake ambient
that flattens the scene" the brief calls out. They are tinted from the real sky
model, which helps, but they are still a constant term added to every surface
regardless of what is above it. Nothing is occluded from the sky except by SSAO,
which is screen-space and misses everything off-screen. The fix is image-based
lighting from a real HDRI, which also gives every material something true to
reflect. Intensities are not in physical units and `useLegacyLights` is not set.

## Shadows

A single directional cascade: one shadow map, box pushed `SHADOW_FORWARD_BIAS`
(0.4) along the view and snapped to whole texels so it does not crawl. 1024 px
on Low up to 4096 on Ultra, `PCFSoftShadowMap`.

**Why it looks fake:** one cascade across a 30–48 m box means shadows are either
sharp near you and absent far away, or soft everywhere. Leaf shadows on the
forest floor — the single most recognisable thing about a rainforest — are mushy.
This needs real CSM. Note the known collision: three filters shadow casters by
the *view* camera's layers, and the existing `patchMapDetail` / `patchNormalDetail`
shader injection has to keep working through whatever CSM does to materials.

## Sky

A genuine single-scattering atmosphere (Preetham/Hoffman) with a line-for-line
JS twin so fog colour, ambient hue and the environment map all derive from the
same model. Night, stars, moon and clouds are art-directed on top.

**Why it looks fake:** it mostly doesn't — this is the strongest part of the
renderer. The sun travels properly (elevation 0.93 at noon, 0.12 at 17:24,
−0.86 at 22:00), so sunrise and sunset are real geometry, not a colour swap.
The remaining fault is the clouds: a scrolling 2D texture on the dome, with no
parallax, no self-shadowing and no effect on the light below them.

*(An earlier draft of this audit claimed the sun barely moved. That was wrong —
it came from sampling the sky before there was any way to set its clock, so
every sample landed at the same morning hour. `__jk.setTime()` now exists and
the measurements above are taken through it.)*

## Fog and atmosphere

Linear `THREE.Fog` per-material, plus height fog and a dawn mist gaussian
applied in the composite from the depth buffer. Heat haze on High and above.

**Why it looks fake:** linear distance fog is a flat grey veil. There is no
humidity gradient, no mist pooling in hollows (it is a function of height above
zero, not height above the local terrain), and it does not thin out through the
day.

## Terrain

600 m × 600 m heightfield, 200 segments — **3 m per quad**. Twelve gaussian
hills. One material: a procedural "ground" albedo with a Sobel-derived normal
and roughness, tiled at two scales (6.7 m macro, 1.15 m detail) and blended by
`patchMapDetail`. Vertex colours carry the biome tint and wet silt near water.

**Why it looks fake:**
- **One material for the entire world.** No mud, no leaf litter, no roots, no
  river stones. Biome variation is a vertex-colour tint over the same texture.
- **3 m quads.** The river channel is barely resolved; the player walks on the
  analytic height while seeing the smoothed mesh, so feet sink into slopes.
- No triplanar mapping, so cliffs stretch.
- Two-scale tiling hides repetition at a distance but the 1.15 m detail tile is
  plainly visible underfoot.

## Water

Rewritten last pass and genuinely good: own render pass, screen-space
refraction, Beer-Lambert depth absorption, Fresnel reflection off the same
analytic sky, caustics placed from the depth buffer, shoreline foam from
geometric depth, flow-mapped normals, a carved river with a verified downhill
profile, a 2.6 m waterfall with mist and a rainbow.

**What is still missing against the brief:** no reflections of *trees* (sky
only — no SSR, no planar), no Gerstner/FFT wave hierarchy (three sine waves),
no underwater view at all (swimming shows the same above-water image), no
drifting debris on the current, and the wet-rock ring around the waterfall is
not there.

## Trees

Grown recursively (`buildTreeModel`), five species — jungle giant with buttress
roots, broadleaf, acacia, dead snag, mangrove — plus palms, pines and cactus.
Foliage is alpha-tested leaf cards clumped at branch tips and forks, with
per-instance colour variation, backlit translucency, moss on bark, and wind in
world space after the instance matrix.

**Why it looks fake:**
- **Alpha test, not alpha-to-coverage.** Every leaf edge is a hard binary cut.
  This is the loudest "it's a game" signal in the whole frame.
- No LOD and no impostors. One stochastic dissolve past 45 m, then nothing — so
  draw distance is short and the forest ends rather than reaching the horizon.
- Bark is one texture for every species at every scale.
- Vines exist; lianas spanning between trees, epiphytes and bromeliads do not.
- Five species, not eight. No bamboo, no strangler fig, no banyan, no fallen
  trunks.

## Grass and ground plants

GPU-instanced curved blades in a ring of cells around the player, ~15/m², with
per-blade height/width/colour, root-to-tip gradient, shared wind, and a
trample trail that bends blades away and springs back.

**Why it looks fake:** it is close. Density is per-cell uniform rather than
driven by moisture or slope, there is no distance fade into the terrain colour
(blades just stop), and the understory large-leaf plants — monstera, elephant
ear, heliconia — do not exist. Ferns and bushes do.

## Materials and textures

Nine procedural surfaces (`ground`, `bark`, `leaf`, `leafCard`, `rock`, `skin`,
`cloth`, `hide`, fur). Each is fbm value noise → colour ramp for albedo, Sobel
for normal, a second band for roughness.

**Why it looks fake:** value noise is too smooth and too uniform. Real bark has
directional fissures, real rock has bedding planes, real mud has footprints and
cracks. Nothing has an AO map. Nothing has height, so there is no parallax.
There are no decals, no dirt accumulation in crevices.

## Animals and characters

One shared anatomy (`HumanFigure`) drives the player, remote player, tribesfolk,
raiders and warriors. Animals are box/capsule primitives with fur-ish textures.

**Why it looks fake:** no skinning — limbs are rigid parts rotated about joints,
so there is no deformation at shoulder or hip. No subsurface in skin. No hair
cards; hair is a solid shape. No foot IK, so feet intersect slopes and slide.
No footprints. No wetness or mud accumulation.

Carried-over defect: the tribesfolk melee swing plays backwards. Deferred by
the user on 7 Oct — *do not fix without being asked.*

## Post-processing

Hand-rolled chain: SSAO → bloom (bright pass, 3–5 level pyramid) → god rays →
composite (ACES + sRGB + height fog + DOF + vignette + grain). All verified by
ablation last pass.

**Why it falls short of the brief:** SSAO is a half-res 8–16 sample kernel, not
N8AO — it is noisy and misses contact darkening. There is **no antialiasing at
all** (see Renderer). No LUT colour grading. DOF is a cheap distance blur with
no bokeh.

## Audio

**One sound exists in the entire game**: `playChingSound()`, two oscillators, for
a shop purchase. There is no ambience, no footsteps, no water, no wind, no
birds, nothing positional, no `AudioListener`.

This is the largest single gap between the game and the brief, and the cheapest
to close dramatically — procedural audio needs no asset files.

---

## Blockers on this machine

Verified, not assumed:

| Spec asks for | Status |
|---|---|
| Vite + ES module split | **No Node/npm.** Native ES modules work (the browser does this unaided and an import map is already in use); a bundler does not. |
| Playwright screenshots | **No Node.** An existing hand-rolled CDP client drives headless Chrome and takes the same screenshots. |
| Baseline + per-section FPS | **Not measurable here.** Headless is swiftshader software rendering at ~1 fps. Draw calls, triangle counts and shader cost are measurable; frame rate is not. The on-screen counter (Settings → Graphics) is the only real number and has to come from the user. |
| KTX2 / Basis textures | **No `basisu`/`toktx`.** Downloaded textures stay as JPEG/PNG — larger in VRAM and slower to upload. |
| Draco / meshopt models | **No tooling.** Not blocking: every mesh here is generated at runtime, so there is nothing to compress. |
| CC0 HDRI + 2K PBR sets | **Reachable** (Poly Haven and ambientCG both answer). Changes the project from one self-contained file to a file plus an asset folder — a real change in kind, flagged rather than assumed. |
| `@dgreenheck/ez-tree` | **Reachable** via esm.sh. |

## Where the remaining budget should go, in order of visible return

1. **Antialiasing.** Nothing else in the frame is as loud as the stair-stepping.
2. **Audio.** From one sound to a layered world. No assets needed.
3. **Alpha-to-coverage on foliage**, which kills the hard leaf edges.
4. **IBL from a real HDRI**, which gives every material something true to reflect
   and lets the fake ambient term go.
5. **Terrain splat mapping**, the biggest single "one material for a whole
   world" offender.
6. **CSM**, for leaf shadows that actually read on the floor.
