// Static data tables for Jungle King

// Raw resources gathered from nodes in the world (F to gather)
export const RESOURCES = {
  wood:   { name: 'Wood',   color: '#8a5a2b' },
  fiber:  { name: 'Fiber',  color: '#9bbf5e' },
  stone:  { name: 'Stone',  color: '#8a8a8a' },
  leaves: { name: 'Leaves', color: '#3f8f3f' },
  berry:  { name: 'Berry',  color: '#c23b5a' },
};

// Craftable items, made at the workbench (R)
export const CRAFTING_RECIPES = [
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
];

// Kito's shop - priced in meters traveled
export const SHOP_ITEMS = [
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
export const KITO_LINES = {
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

// World resource node placement (positions are fixed for now)
export function generateResourceNodes() {
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
  return nodes;
}

// Deterministic PRNG so the world layout is stable across reloads
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
