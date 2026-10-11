# Does the range cull take anything you can see?

The same viewpoint (spawn, looking down the slope at 11:00), shot twice from one
page load at High:

| file | ranges | batches drawn | plant parts submitted | draw calls |
|---|---|---|---|---|
| `spawn-culled.png` | as shipped (280m / 120m) | 662 / 763 | 139,562 / 164,170 (85%) | 1397 |
| `spawn-full.png` | set to 1e6, so the pass is a no-op | 763 / 763 | 164,170 / 164,170 (100%) | 1426 |

Fifteen per cent of the map's plant parts are not submitted, and the two images
are indistinguishable. That is the whole case for the detail tier: the parts it
drops are the ones too small to resolve at the distance they sit.

It also settles a question the screenshots raised on their own. The forest at
spawn looks thin - bare trunks in the mid-ground, not much canopy - and the
obvious suspect was this section's culling. It is not: the uncalled version is
just as thin. That thinness comes from how the world is scattered, not from
anything dropped at draw time.
