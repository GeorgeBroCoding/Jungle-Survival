import { create } from 'zustand';
import { SHOP_ITEMS, CRAFTING_RECIPES, generateResourceNodes } from './data.js';

let toastId = 0;

export const useGame = create((set, get) => ({
  // --- currency ---
  meters: 0,
  addMeters: (amount) => set((s) => ({ meters: s.meters + amount })),
  spendMeters: (amount) => {
    if (get().meters < amount) return false;
    set((s) => ({ meters: s.meters - amount }));
    return true;
  },

  // --- survival stats (0-100) ---
  stats: {
    health: 100,
    hunger: 100,
    thirst: 100,
    energy: 100,
    warmth: 100,
    sanity: 100,
  },
  adjustStat: (key, delta) =>
    set((s) => ({
      stats: {
        ...s.stats,
        [key]: Math.max(0, Math.min(100, s.stats[key] + delta)),
      },
    })),

  // --- time of day, 0-24 hours ---
  timeOfDay: 8,
  setTimeOfDay: (t) => set({ timeOfDay: ((t % 24) + 24) % 24 }),

  // --- inventory: itemId -> quantity ---
  inventory: {},
  addItem: (id, qty = 1) =>
    set((s) => ({ inventory: { ...s.inventory, [id]: (s.inventory[id] || 0) + qty } })),
  removeItem: (id, qty = 1) => {
    const have = get().inventory[id] || 0;
    if (have < qty) return false;
    set((s) => {
      const next = { ...s.inventory, [id]: have - qty };
      if (next[id] <= 0) delete next[id];
      return { inventory: next };
    });
    return true;
  },
  hasItems: (cost) => {
    const inv = get().inventory;
    return Object.entries(cost).every(([k, v]) => (inv[k] || 0) >= v);
  },

  // --- resource nodes (gather/respawn) ---
  resourceNodes: generateResourceNodes(),
  depletedNodes: {}, // id -> respawnAtTimestamp
  gatherNode: (node) => {
    const id = node.id;
    if (get().depletedNodes[id]) return false;
    get().addItem(node.type, 1);
    set((s) => ({ depletedNodes: { ...s.depletedNodes, [id]: Date.now() + 30000 } }));
    get().addToast(`+1 ${node.type}`);
    return true;
  },
  tickRespawns: () => {
    const now = Date.now();
    const depleted = get().depletedNodes;
    let changed = false;
    const next = { ...depleted };
    for (const id of Object.keys(depleted)) {
      if (depleted[id] <= now) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) set({ depletedNodes: next });
  },

  // --- crafting ---
  craft: (recipeId) => {
    const recipe = CRAFTING_RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return false;
    if (!get().hasItems(recipe.cost)) return false;
    for (const [k, v] of Object.entries(recipe.cost)) get().removeItem(k, v);
    get().addItem(recipe.id, 1);
    get().addToast(`Crafted ${recipe.name}`);
    return true;
  },

  // --- shop ---
  buyItem: (itemId) => {
    const item = SHOP_ITEMS.find((i) => i.id === itemId);
    if (!item) return false;
    if (!get().spendMeters(item.price)) {
      get().addToast(`Need ${item.price} meters for ${item.name}`);
      return false;
    }
    get().addItem(item.id, 1);
    get().addToast(`Bought ${item.name}`);
    return true;
  },

  // --- UI state ---
  activePanel: null, // null | 'inventory' | 'shop' | 'crafting'
  setActivePanel: (panel) => set({ activePanel: panel }),

  nearInteractable: null, // { type: 'gather'|'shop'|'craft', label, data }
  setNearInteractable: (v) => set({ nearInteractable: v }),

  hotbarSlots: ['spear', 'torch', 'bandage'],
  activeHotbarSlot: 0,
  setActiveHotbarSlot: (i) => set({ activeHotbarSlot: i }),

  // --- toasts ---
  toasts: [],
  addToast: (msg) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },

  // --- game start ---
  started: false,
  start: () => set({ started: true }),
}));
