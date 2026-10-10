// data.js - static data tables
// ============================================================

// Raw resources gathered from nodes in the world (F to gather)
const RESOURCES = {
  wood:   { name: 'Wood',   color: '#8a5a2b', category: 'material' },
  fiber:  { name: 'Fiber',  color: '#9bbf5e', category: 'material' },
  stone:  { name: 'Stone',  color: '#8a8a8a', category: 'material' },
  leaves: { name: 'Leaves', color: '#3f8f3f', category: 'material' },
  silver: { name: 'Silver', color: '#c0c0d0', category: 'material' },
  gold:   { name: 'Gold',   color: '#ffd700', category: 'material' },
  berry:  { name: 'Berry',  color: '#c23b5a', category: 'food', hunger: 8 },
  meat:   { name: 'Meat',   color: '#a8453b', category: 'food', hunger: 30 },
  apple:  { name: 'Apple',  color: '#d23b3b', category: 'food', hunger: 15 },
};

// Craftable items, made at the workbench (R)
const CRAFTING_RECIPES = [
  {
    id: 'spear',
    name: 'Spear',
    desc: 'Bamboo and sharp rock. Basic melee weapon.',
    cost: { wood: 3, stone: 1 },
  },
  {
    id: 'torch',
    name: 'Torch',
    desc: 'Stick, tree sap and cloth. Lights the dark.',
    cost: { wood: 2, fiber: 1 },
  },
  {
    id: 'bandage',
    name: 'Leaf Bandage',
    desc: 'Medicinal herbs wrapped in leaves. Heals wounds.',
    cost: { leaves: 3, fiber: 1 },
  },
  {
    id: 'campfire',
    name: 'Campfire',
    desc: 'Warmth, light, and a place to cook.',
    cost: { wood: 5, stone: 3 },
  },
  {
    id: 'waterskin',
    name: 'Waterskin',
    desc: 'Animal hide pouch for carrying water.',
    cost: { fiber: 4, leaves: 2 },
  },
  {
    id: 'rope',
    name: 'Rope',
    desc: 'Woven jungle fiber. Used for building.',
    cost: { fiber: 5 },
  },
  {
    id: 'club',
    name: 'Wooden Club',
    desc: 'Heavy carved wood. Slow but hits hard.',
    cost: { wood: 6 },
  },
  {
    id: 'axe',
    name: 'Axe',
    desc: 'Stone-headed hatchet. The only tool that chops trees for wood.',
    cost: { wood: 2, stone: 4 },
  },
  {
    id: 'pickaxe',
    name: 'Pickaxe',
    desc: 'Heavy stone pick. Mines rock and can unearth silver and gold in caves.',
    cost: { wood: 3, stone: 4 },
  },
];

// Melee/throwing weapons. Whatever weapon occupies the active hotbar slot
// (and is present in the inventory) is shown held in the player's hand.
const WEAPONS = {
  spear:   { name: 'Spear',       damage: 25, pokeDamage: 18, range: 2.6, throwable: true },
  machete: { name: 'Machete',     damage: 35, range: 1.9, throwable: false },
  club:    { name: 'Wooden Club', damage: 22, range: 1.8, throwable: false },
  axe:     { name: 'Axe',         damage: 30, range: 2.0, throwable: false, canChop: true },
  pickaxe: { name: 'Pickaxe',     damage: 18, range: 2.0, throwable: false, canMine: true },
};

// Wild animals: fixed spawn points, with health/loot for combat.
const ANIMAL_SPAWNS = [
  { id: 'boar1',   type: 'boar',   position: [18, 0, 12],   health: 60, loot: { berry: 2, meat: 2 } },
  { id: 'boar2',   type: 'boar',   position: [-25, 0, -18], health: 60, loot: { berry: 2, meat: 2 } },
  { id: 'monkey1', type: 'monkey', position: [10, 0, -22],  health: 30, loot: { fiber: 2, apple: 1 } },
  { id: 'monkey2', type: 'monkey', position: [-15, 0, 20],  health: 30, loot: { fiber: 2, apple: 1 } },
];
const ANIMAL_RESPAWN_MS = 45000;

// Throwing / melee combat tuning
const THROW_RANGE = 14;
const ATTACK_CONE = Math.PI / 3; // 60 degree cone in front of the player
const ATTACK_DURATION = 0.25; // seconds, arm swing animation
const SPEAR_FLIGHT_SPEED = 22; // m/s, governs the throw animation duration

// Kito's shop - priced in meters traveled
const SHOP_ITEMS = [
  { id: 'rope_buy',      name: 'Rope',                  price: 50,    desc: 'Woven fiber rope.' },
  { id: 'torch_buy',     name: 'Torch',                 price: 75,    desc: 'Burns bright in the dark.' },
  { id: 'flint_steel',   name: 'Flint and Steel',       price: 100,   desc: 'Start fires reliably.' },
  { id: 'antidote',      name: 'Antidote',              price: 150,   desc: 'Cures poison.' },
  { id: 'bandages_buy',  name: 'Bandages',              price: 80,    desc: 'Stop the bleeding.' },
  { id: 'machete',       name: 'Machete',               price: 700,   desc: 'Cuts through dense jungle.' },
  { id: 'canteen',       name: 'Canteen',               price: 150,   desc: 'Holds drinking water.' },
  { id: 'compass',       name: 'Compass',               price: 200,   desc: 'Always know which way is north.' },
  { id: 'hammock',       name: 'Hammock',               price: 300,   desc: 'A safe place to sleep above the ground.' },
  { id: 'binoculars',    name: 'Binoculars',            price: 800,   desc: 'See danger before it sees you.' },
  { id: 'climbing_gear', name: 'Climbing Gear',         price: 1000,  desc: 'Scale cliffs and trees with ease.' },
  { id: 'night_vision',  name: 'Night Vision Goggles',  price: 2000,  desc: 'The jungle never sleeps. Neither will you.' },
  { id: 'monkey_pet',    name: 'Monkey Companion',      price: 1500,  desc: 'Finds hidden fruit and steals from enemies.' },
  { id: 'parrot_pet',    name: 'Parrot Companion',      price: 1000,  desc: 'Scouts danger and warns of traps.' },
  { id: 'mystery_crate', name: 'Mystery Crate',         price: 1000,  desc: 'Random loot inside. Could be anything.' },
];

// Kito's lines - randomly picked, optionally reacting to meter balance
const KITO_LINES = {
  greeting: [
    "Ah, welcome welcome! Kito has everything a survivor needs!",
    "Back again? The jungle treats you well, eh?",
    "Step right up, my friend, take a look at my wares!",
  ],
  richReaction: [
    "Whoa! Look at all those meters you've walked! Kito is impressed!",
    "A traveler with a fortune of footsteps! What can I get for you?",
  ],
  poorReaction: [
    "Hmm, light on meters today? Walk a little more, come back soon!",
    "Every step counts, friend. Keep moving and the meters will come.",
  ],
  purchase: [
    "Excellent choice! A fine pick indeed!",
    "*wraps it up* Here you go, use it well out there!",
    "Heh, good taste. That one's one of my favorites.",
  ],
};

// Structures buildable at the workbench's "Build" menu (B)
const BUILDING_TYPES = [
  { id: 'house', name: 'House', desc: 'A simple shelter for your tribe.', cost: { wood: 10, fiber: 4 } },
  { id: 'lookout', name: 'Lookout Tower', desc: 'Spot raiders coming from afar.', cost: { wood: 15, stone: 5 } },
  { id: 'wall', name: 'Palisade Wall', desc: 'Slows down raiders.', cost: { wood: 8, stone: 2 } },
  { id: 'storage', name: 'Storage Hut', desc: 'A place to stash resources.', cost: { wood: 6, fiber: 3 } },
];

// Rival tribes - their camps sit far across the jungle and occasionally send raiders.
// The first ENEMY_TRIBES_INITIAL_COUNT camps exist from the start; the rest "spawn in"
// gradually over time via TribeSpawnManager, raising the total number of tribes to defeat.
const ENEMY_TRIBES = [
  { id: 'redfang', name: 'Red Fang Tribe', color: '#c2453b', campPosition: [-90, 0, -90] },
  { id: 'bonecrush', name: 'Bonecrusher Clan', color: '#4a5ad6', campPosition: [95, 0, -80] },
  { id: 'shadowleaf', name: 'Shadowleaf Raiders', color: '#3bc26a', campPosition: [85, 0, 95] },
  { id: 'skullriver', name: 'Skull River Tribe', color: '#9b59b6', campPosition: [-110, 0, 100] },
  { id: 'ironvale', name: 'Ironvale Marauders', color: '#e08e2b', campPosition: [140, 0, 10] },
  { id: 'frostfang', name: 'Frostfang Horde', color: '#5bc8e0', campPosition: [-20, 0, 150] },
  { id: 'sandriders', name: 'Sand Riders', color: '#c9a640', campPosition: [130, 0, -70] },
  { id: 'permafrost', name: 'Permafrost Clan', color: '#a8d8e8', campPosition: [-55, 0, -150] },
  { id: 'cinderwolves', name: 'Cinder Wolves', color: '#c04820', campPosition: [-140, 0, -85] },
  { id: 'bogwalkers', name: 'Bogwalkers', color: '#4a7a3a', campPosition: [20, 0, 155] },
];

const ENEMY_TRIBES_INITIAL_COUNT = 3;
// How often (in seconds) a new rival tribe camp appears, until all ENEMY_TRIBES are active.
const TRIBE_SPAWN_INTERVAL = 240;

// Distant tribes — always present on / beyond the mountains. They can never be conquered
// but periodically send raiders targeting the player's base or any team camp they hold.
const DISTANT_TRIBES = [
  { id: 'thornback', name: 'Thornback Clan',    color: '#8b1a1a', campPosition: [200, 0, 92] },
  { id: 'ashwalker', name: 'Ashwalker Horde',   color: '#5a5a6e', campPosition: [-100, 0, 200] },
  { id: 'bloodvine', name: 'Bloodvine Tribe',   color: '#c44e8b', campPosition: [-210, 0, -8] },
  { id: 'stoneclaw', name: 'Stoneclaw Raiders', color: '#7a6b45', campPosition: [205, 0, -65] },
];

// Where the player's own tribe is based - raiders march here
// ---------- The pond ----------
// The terrain is shaped to match the water disc (see getTerrainHeight): the ground
// near the pond is levelled to a common shore height so the flat disc meets it all
// the way round, then a bowl is carved below that. Without the levelling the natural
// hill tails run from 0.06 up to 0.72 around the rim — all of it above the surface —
// so the water's edge was buried in a rising bank.
const POND_CENTER = [40, -40]; // x, z
const POND_RADIUS = 18;
const POND_SURFACE_Y = 0.05;
const POND_SHORE_Y = -0.05;  // ground at the waterline, just under the surface
const POND_DEPTH = 2.2;      // below the shore at the centre, tapering to 0 at the rim
const POND_BLEND_R = 30;     // natural terrain has fully resumed by here
// How far out from the waterline the ground reads as wet silt rather than
// grass. Derived from POND_RADIUS, so it lives beside it: read from another
// module at import time, which module wins is up to the import graph.
const POND_SILT_R = POND_RADIUS + 3.5;
// The water surface is built this far past the waterline. Where the bank has
// risen above it the depth test discards it, so the edge of the water is the
// shape of the ground rather than the rim of a disc.
const POND_OVERRUN = 3.0;

const BASE_CENTER = [0, 0, 0];
const PLAYER_SPAWN = [0, 0, 8]; // where you start, and where you respawn after dying
const FRIEND_BASE_CENTER = [18, 0, 5]; // where the joining player's sub-camp appears
const PLAYER_TRIBE_COLOR = '#f0d020'; // bright yellow — the Jungle King's home tribe
const MAX_VISIBLE_WARRIORS = 16;

// Fixed ring of guard positions around the base - raiders pick the nearest
// occupied one to attack instead of marching straight to the banner.
const PLAYER_WARRIOR_SPAWNS = (() => {
  const arr = [];
  for (let i = 0; i < MAX_VISIBLE_WARRIORS; i++) {
    const angle = (i / MAX_VISIBLE_WARRIORS) * Math.PI * 2;
    const ring = 4 + (i % 3) * 1.5;
    arr.push([BASE_CENTER[0] + Math.cos(angle) * ring, 0, BASE_CENTER[2] + Math.sin(angle) * ring]);
  }
  return arr;
})();

// Offsets (relative to camp center) for the wandering members of a rival camp.
const TRIBE_MEMBER_OFFSETS = [[-4, 1], [4, -1], [0, 4], [-6, 3], [6, 2], [-2, -6], [3, 6]];
// Offsets for the friendly garrison that settles into a camp once it's captured.
const GARRISON_OFFSETS = [[-2, -3], [2, -3], [0, -5]];
const GARRISON_HEALTH = 100; // hit points the garrison can absorb before a camp is retaken
const TRIBE_MEMBER_HEALTH = 25;
const TRIBE_MEMBER_RESPAWN_MS = 40000;
const TRIBE_MEMBER_REWARD = { meters: 15 };
const TRIBE_MEMBER_AGGRO_RANGE = 11;
const TRIBE_MEMBER_ATTACK_RANGE = 1.8;
const TRIBE_MEMBER_ATTACK_SPEED = 2.6;
const TRIBE_MEMBER_DAMAGE = 5;
const TRIBE_MEMBER_ATTACK_COOLDOWN = 1.2;
const CAMP_CAPTURE_REWARD = { meters: 100, coins: 20 };
// How long (ms) the rest of a camp stays alerted and rushes the player after one
// of its members is attacked - this is what makes a tribe "fight back" as a group.
const CAMP_ALERT_RANGE = 30;
const CAMP_ALERT_DURATION_MS = 10000;

// --- escort warriors: a chosen number of the player's warriors follow them into battle ---
const ESCORT_FOLLOW_DIST = 2.2;
const ESCORT_AGGRO_RANGE = 9;
const ESCORT_ATTACK_RANGE = 1.8;
const ESCORT_ATTACK_DAMAGE = 8;
const ESCORT_ATTACK_COOLDOWN = 1;
const ESCORT_SPEED = 3.4;

// Coins - a separate currency that occasionally falls from the sky and
// is spent recruiting warriors for the player's tribe.
// 1st warrior costs 10c, each one after costs 5c more (1st-5th sum to 100c).
const WARRIOR_BASE_COST = 10;
const WARRIOR_COST_STEP = 5;
const COIN_DROP_MIN = 5;
const COIN_DROP_MAX = 15;
const COIN_SPAWN_RADIUS = 50;

// Inventory items the player can actively "use" from the inventory panel.
// `consumed: true` removes one unit on use.
const USABLE_ITEMS = {
  bandage: { label: 'Use', consumed: true, apply: (s) => { s.adjustStat('health', 30); s.addToast('Used Leaf Bandage (+30 health)'); } },
  bandages_buy: { label: 'Use', consumed: true, apply: (s) => { s.adjustStat('health', 30); s.addToast('Used Bandages (+30 health)'); } },
  waterskin: { label: 'Drink', consumed: true, apply: (s) => { s.adjustStat('thirst', 40); s.addToast('Drank from Waterskin (+40 thirst)'); } },
  canteen: { label: 'Drink', consumed: true, apply: (s) => { s.adjustStat('thirst', 40); s.addToast('Drank from Canteen (+40 thirst)'); } },
  torch: { label: 'Light', consumed: true, apply: (s) => { s.adjustStat('warmth', 25); s.addToast('Lit Torch (+25 warmth)'); } },
  torch_buy: { label: 'Light', consumed: true, apply: (s) => { s.adjustStat('warmth', 25); s.addToast('Lit Torch (+25 warmth)'); } },
  campfire: { label: 'Set Up', consumed: true, apply: (s) => { s.adjustStat('warmth', 50); s.adjustStat('sanity', 15); s.addToast('Set up Campfire (+50 warmth, +15 sanity)'); } },
  antidote: { label: 'Use', consumed: true, apply: (s) => { s.adjustStat('health', 15); s.adjustStat('sanity', 20); s.addToast('Used Antidote (+15 health, +20 sanity)'); } },
  flint_steel: { label: 'Spark', consumed: false, apply: (s) => { s.adjustStat('warmth', 10); s.addToast('Sparked Flint and Steel (+10 warmth)'); } },
  hammock: { label: 'Rest', consumed: false, apply: (s) => { s.adjustStat('energy', 40); s.addToast('Rested in Hammock (+40 energy)'); } },
  rope: { label: 'Use', consumed: false, apply: (s) => { s.addToast('You coil the rope, ready for building.'); } },
  spear: { label: 'Equip', consumed: false, apply: (s) => { s.addToast('Spear equipped - wild animals think twice.'); } },
  machete: { label: 'Equip', consumed: false, apply: (s) => { s.addToast('Machete equipped - cuts through the jungle with ease.'); } },
  binoculars: { label: 'Use', consumed: false, apply: (s) => { s.addToast('You scan the horizon for danger.'); } },
  compass: { label: 'Use', consumed: false, apply: (s) => { s.addToast('The compass points steadily north.'); } },
  climbing_gear: { label: 'Equip', consumed: false, apply: (s) => { s.addToast('Climbing gear equipped.'); } },
  night_vision: { label: 'Equip', consumed: false, apply: (s) => { s.addToast('Night vision goggles equipped - the dark holds no secrets.'); } },
  mystery_crate: {
    label: 'Open', consumed: true, apply: (s) => {
      const loot = ['wood', 'fiber', 'stone', 'leaves', 'berry'];
      const item = loot[Math.floor(Math.random() * loot.length)];
      const qty = 2 + Math.floor(Math.random() * 4);
      s.addItem(item, qty);
      s.addToast(`Mystery Crate contained ${qty} ${RESOURCES[item].name}!`);
    },
  },
  berry: { label: 'Eat', consumed: true, apply: (s) => { s.adjustStat('hunger', RESOURCES.berry.hunger); s.addToast(`Ate Berry (+${RESOURCES.berry.hunger} hunger)`); } },
  meat: { label: 'Eat', consumed: true, apply: (s) => { s.adjustStat('hunger', RESOURCES.meat.hunger); s.addToast(`Ate Meat (+${RESOURCES.meat.hunger} hunger)`); } },
  apple: { label: 'Eat', consumed: true, apply: (s) => { s.adjustStat('hunger', RESOURCES.apple.hunger); s.addToast(`Ate Apple (+${RESOURCES.apple.hunger} hunger)`); } },
};

// General loot scattered around the map - food, materials, and odds & ends
// the player can pick up with E. Respawns after LOOT_RESPAWN_MS.
const LOOT_TABLE = ['apple', 'apple', 'meat', 'berry', 'leaves', 'leaves', 'rope', 'fiber', 'stone', 'wood'];
const LOOT_RESPAWN_MS = 90000;
const LOOT_SPAWNS = (() => {
  const rand = mulberry32(7777);
  const spawns = [];
  for (let i = 0; i < 26; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 5 + rand() * 65;
    const item = LOOT_TABLE[Math.floor(rand() * LOOT_TABLE.length)];
    const qty = (item === 'apple' || item === 'meat' || item === 'berry') ? 1 : 1 + Math.floor(rand() * 2);
    spawns.push({ id: `loot_${i}`, item, qty, position: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist] });
  }
  return spawns;
})();

// One cave per distant mountain, placed on the slope facing the origin
const CAVE_LOCATIONS = [
  { id: 'cave_ne', mx: 172.2, mz: 80.3,   r: 40 },
  { id: 'cave_e',  mx: 180.7, mz: -58.7,  r: 45 },
  { id: 'cave_se', mx: 55.5,  mz: 181.7,  r: 42 },
  { id: 'cave_sw', mx: -86.3, mz: 169.3,  r: 45 },
  { id: 'cave_w',  mx: -190,  mz: -3.3,   r: 40 },
  { id: 'cave_n',  mx: 6.6,   mz: -189.9, r: 42 },
];

// World resource node placement (positions are fixed for now)
// ---------- The river ----------
// One river, off the high ground in the north, over a ledge, and down into the
// pond. Its centreline is a function of z rather than a spline, because
// getTerrainHeight runs for every blade of grass in the world and the nearest
// point on a spline is a search where this is two trig calls.
const RIVER_Z0 = -134;      // source, up in the hills
const RIVER_Z1 = -56;       // mouth, at the pond's north rim
const RIVER_HALF = 3.1;     // half-width of the channel floor
const RIVER_BANK = 7.0;     // the cut has faded back into the hillside by here
const RIVER_DEPTH = 0.72;   // water over the bed on an ordinary stretch
const RIVER_FALL_Z = -118;  // the ledge
const RIVER_FALL_H = 2.6;   // and how far the water drops over it
const RIVER_STATIONS = 79;

function riverCenterX(z) {
  const u = z - RIVER_Z1;
  return 40 + u * 0.26 + 7 * Math.sin(u * 0.075);
}
function riverCenterSlope(z) {
  return 0.26 + 0.525 * Math.cos((z - RIVER_Z1) * 0.075);
}

function generateResourceNodes() {
  const nodes = [];
  const rand = mulberry32(1337);
  for (let i = 0; i < 24; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 8 + rand() * 60;
    nodes.push({
      id: `tree_${i}`,
      type: 'wood',
      position: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist],
    });
  }
  for (let i = 0; i < 14; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 6 + rand() * 50;
    nodes.push({
      id: `bush_${i}`,
      type: 'fiber',
      position: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist],
    });
  }
  for (let i = 0; i < 10; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 10 + rand() * 55;
    nodes.push({
      id: `rock_${i}`,
      type: 'stone',
      position: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist],
    });
  }
  // Cave ore nodes — silver and gold near each cave entrance, require pickaxe
  for (const cave of CAVE_LOCATIONS) {
    const { mx, mz, r } = cave;
    const len = Math.sqrt(mx * mx + mz * mz);
    const dx = -mx / len, dz = -mz / len; // direction toward origin
    const px = -dz, pz = dx; // perpendicular
    const cx = mx + dx * r * 0.62;
    const cz = mz + dz * r * 0.62;
    nodes.push({ id: `silver_${cave.id}_1`, type: 'silver', position: [cx + px * 2.5, 0, cz + pz * 2.5] });
    nodes.push({ id: `silver_${cave.id}_2`, type: 'silver', position: [cx - px * 2.5, 0, cz - pz * 2.5] });
    nodes.push({ id: `gold_${cave.id}`,     type: 'gold',   position: [cx + dx * 3.5, 0, cz + dz * 3.5] });
  }
  // Nudge anything that landed in the pond out past the waterline. Two of the seeded
  // positions (a fiber bush and a rock) fall inside it, and now that the basin is
  // carved they would otherwise sit a couple of metres under the surface.
  for (const node of nodes) {
    const dx = node.position[0] - POND_CENTER[0];
    const dz = node.position[2] - POND_CENTER[1];
    const d = Math.hypot(dx, dz);
    if (d >= POND_RADIUS + 1) continue;
    const k = (POND_RADIUS + 2) / (d || 1);
    node.position[0] = POND_CENTER[0] + (d ? dx : 1) * k;
    node.position[2] = POND_CENTER[1] + (d ? dz : 0) * k;
  }
  // Same for the river. Push straight out across the channel, which is the
  // short way to dry land and cannot land the node back in the water.
  for (const node of nodes) {
    const z = node.position[2];
    if (z < RIVER_Z0 - 2 || z > RIVER_Z1 + 2) continue;
    const d = riverDistance(node.position[0], z);
    if (d >= RIVER_HALF + 2) continue;
    const cx = riverCenterX(z);
    const m = riverCenterSlope(z);
    const push = (RIVER_HALF + 3) * Math.sqrt(1 + m * m);
    node.position[0] = node.position[0] >= cx ? cx + push : cx - push;
  }
  return nodes;
}

// Pre-computed obstacle circles for player collision detection
const PLAYER_COLL_R = 0.35;
const _OBS_R = { wood: 0.72, stone: 0.55, silver: 0.32, gold: 0.32 };
const STATIC_OBSTACLES = generateResourceNodes()
  .filter((n) => _OBS_R[n.type])
  .map((n) => ({ id: n.id, x: n.position[0], z: n.position[2], r: _OBS_R[n.type] }));

// Deterministic PRNG so the world layout is stable across reloads
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================


// Mouth of each cave, matching where generateResourceNodes() seeds its ore.
const MAP_CAVE_MOUTHS = CAVE_LOCATIONS.map((cave) => {
  const { mx, mz, r } = cave;
  const len = Math.sqrt(mx * mx + mz * mz) || 1;
  return { id: cave.id, x: mx + (-mx / len) * r * 0.62, z: mz + (-mz / len) * r * 0.62 };
});


// Perpendicular distance to the river centreline, in metres. The division by
// the slope is what turns "how far across in x" into a real distance where
// the river runs diagonally.
function riverDistance(x, z) {
  if (z < RIVER_Z0 - RIVER_BANK || z > RIVER_Z1 + RIVER_BANK) return 1e9;
  const m = riverCenterSlope(z);
  return Math.abs(x - riverCenterX(z)) / Math.sqrt(1 + m * m);
}

export {
  riverDistance,
  POND_SILT_R,
  MAP_CAVE_MOUTHS,
  RESOURCES,
  CRAFTING_RECIPES,
  WEAPONS,
  ANIMAL_SPAWNS,
  ANIMAL_RESPAWN_MS,
  THROW_RANGE,
  ATTACK_CONE,
  ATTACK_DURATION,
  SPEAR_FLIGHT_SPEED,
  SHOP_ITEMS,
  KITO_LINES,
  BUILDING_TYPES,
  ENEMY_TRIBES,
  ENEMY_TRIBES_INITIAL_COUNT,
  TRIBE_SPAWN_INTERVAL,
  DISTANT_TRIBES,
  POND_CENTER,
  POND_RADIUS,
  POND_SURFACE_Y,
  POND_SHORE_Y,
  POND_DEPTH,
  POND_BLEND_R,
  POND_OVERRUN,
  BASE_CENTER,
  PLAYER_SPAWN,
  FRIEND_BASE_CENTER,
  PLAYER_TRIBE_COLOR,
  MAX_VISIBLE_WARRIORS,
  PLAYER_WARRIOR_SPAWNS,
  TRIBE_MEMBER_OFFSETS,
  GARRISON_OFFSETS,
  GARRISON_HEALTH,
  TRIBE_MEMBER_HEALTH,
  TRIBE_MEMBER_RESPAWN_MS,
  TRIBE_MEMBER_REWARD,
  TRIBE_MEMBER_AGGRO_RANGE,
  TRIBE_MEMBER_ATTACK_RANGE,
  TRIBE_MEMBER_ATTACK_SPEED,
  TRIBE_MEMBER_DAMAGE,
  TRIBE_MEMBER_ATTACK_COOLDOWN,
  CAMP_CAPTURE_REWARD,
  CAMP_ALERT_RANGE,
  CAMP_ALERT_DURATION_MS,
  ESCORT_FOLLOW_DIST,
  ESCORT_AGGRO_RANGE,
  ESCORT_ATTACK_RANGE,
  ESCORT_ATTACK_DAMAGE,
  ESCORT_ATTACK_COOLDOWN,
  ESCORT_SPEED,
  WARRIOR_BASE_COST,
  WARRIOR_COST_STEP,
  COIN_DROP_MIN,
  COIN_DROP_MAX,
  COIN_SPAWN_RADIUS,
  USABLE_ITEMS,
  LOOT_TABLE,
  LOOT_RESPAWN_MS,
  LOOT_SPAWNS,
  CAVE_LOCATIONS,
  RIVER_Z0,
  RIVER_Z1,
  RIVER_HALF,
  RIVER_BANK,
  RIVER_DEPTH,
  RIVER_FALL_Z,
  RIVER_FALL_H,
  RIVER_STATIONS,
  riverCenterX,
  riverCenterSlope,
  generateResourceNodes,
  PLAYER_COLL_R,
  _OBS_R,
  STATIC_OBSTACLES,
  mulberry32,
};
