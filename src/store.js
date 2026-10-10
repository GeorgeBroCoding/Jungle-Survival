import { create } from './core.js';
import { ANIMAL_RESPAWN_MS, ANIMAL_SPAWNS, ATTACK_CONE, BASE_CENTER, BUILDING_TYPES, CAMP_ALERT_DURATION_MS, CAMP_CAPTURE_REWARD, COIN_DROP_MAX, COIN_DROP_MIN, COIN_SPAWN_RADIUS, CRAFTING_RECIPES, DISTANT_TRIBES, ENEMY_TRIBES, ENEMY_TRIBES_INITIAL_COUNT, GARRISON_HEALTH, LOOT_RESPAWN_MS, RESOURCES, SHOP_ITEMS, THROW_RANGE, TRIBE_MEMBER_HEALTH, TRIBE_MEMBER_OFFSETS, TRIBE_MEMBER_RESPAWN_MS, TRIBE_MEMBER_REWARD, USABLE_ITEMS, WARRIOR_BASE_COST, WARRIOR_COST_STEP, WEAPONS, generateResourceNodes } from './data.js';
import { GRAPHICS_PRESETS, graphicsSettings, saveGraphicsSettings } from './graphics.js';
import { DEFAULT_KEYBINDS, RESERVED_CODES, actionLabel, activeBinds, inputSettings, keyLabel, saveInputSettings, saveKeybinds, setActiveBinds } from './keybinds.js';
import { mpSend, playerTransform } from './multiplayer.js';
import { addScreenShake, entityRegistry } from './shake.js';
import { getTerrainHeight } from './terrain.js';

// store.js - zustand global state
// ============================================================
let toastId = 0;
let chatId = 0;

const useGame = create((set, get) => ({
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
  adjustStat: (key, delta) => {
    // Losing health jolts the camera. Triggered here, not at each damage site, because
    // every raider, animal, spear and starvation tick funnels through adjustStat. No
    // shake once dead: hostiles keep swinging at the body and it would never settle.
    if (key === 'health' && delta < 0 && !get().dead) addScreenShake(-delta);
    return set((s) => {
      const next = Math.max(0, Math.min(100, s.stats[key] + delta));
      const stats = { ...s.stats, [key]: next };
      // Health reaching zero is death, detected here because everything that can hurt
      // the player — raiders, tribe members, animals, starvation, thirst — funnels
      // through adjustStat. The !s.dead guard keeps later hits from re-triggering it.
      if (key === 'health' && next <= 0 && !s.dead) {
        const cause = s.stats.thirst <= 0 ? 'You died of thirst.'
          : s.stats.hunger <= 0 ? 'You starved to death.'
          : 'The jungle got you.';
        return { stats, dead: true, deathCause: cause };
      }
      return { stats };
    });
  },

  // --- death / respawn ---
  dead: false,
  deathCause: null,
  deathCount: 0, // bumped on respawn; Player watches it to move you back to camp
  respawn: () => {
    set((s) => ({
      dead: false,
      deathCause: null,
      deathCount: s.deathCount + 1,
      // Every survival stat goes back to full, not just health: respawning with an
      // empty thirst bar would start the 1hp/sec starvation tick again immediately
      // and kill you a second time without you touching anything.
      stats: { health: 100, hunger: 100, thirst: 100, energy: 100, warmth: 100, sanity: 100 },
      activePanel: null,
    }));
    get().addToast('You wake up back at your camp');
  },

  // --- time of day, 0-24 hours ---
  timeOfDay: 8,
  setTimeOfDay: (t) => set({ timeOfDay: ((t % 24) + 24) % 24 }),

  // --- inventory: itemId -> quantity ---
  inventory: { spear: 1 },
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
    const s = get();
    const activeWeapon = s.hotbarSlots[s.activeHotbarSlot];

    if (node.type === 'wood') {
      if (activeWeapon === 'axe' && (s.inventory.axe || 0) > 0) {
        get().addItem('wood', 1);
        get().addToast('+1 Wood (chopped with Axe)');
      } else if (activeWeapon === 'machete' && (s.inventory.machete || 0) > 0) {
        get().addItem('leaves', 2);
        get().addToast('+2 Leaves (chopped with Machete)');
      } else {
        get().addToast('Equip an Axe to chop trees for wood!');
        return false;
      }
    } else if (node.type === 'stone') {
      if (activeWeapon !== 'pickaxe' || (s.inventory.pickaxe || 0) === 0) {
        get().addToast('Equip a Pickaxe to mine stone!');
        return false;
      }
      get().addItem('stone', 1);
      get().addToast('+1 Stone');
    } else if (node.type === 'silver' || node.type === 'gold') {
      if (activeWeapon !== 'pickaxe' || (s.inventory.pickaxe || 0) === 0) {
        get().addToast('Equip a Pickaxe to mine cave ore!');
        return false;
      }
      get().addItem(node.type, 1);
      get().addToast(`+1 ${RESOURCES[node.type].name}!`);
    } else {
      get().addItem(node.type, 1);
      get().addToast(`+1 ${RESOURCES[node.type].name}`);
    }

    set((st) => ({ depletedNodes: { ...st.depletedNodes, [id]: Date.now() + 30000 } }));
    return true;
  },
  // --- general loot scattered on the map: pick up with E, respawns over time ---
  collectedLoot: {}, // id -> respawnAtTimestamp
  collectLoot: (spawn) => {
    if (get().collectedLoot[spawn.id]) return false;
    get().addItem(spawn.item, spawn.qty);
    set((s) => ({ collectedLoot: { ...s.collectedLoot, [spawn.id]: Date.now() + LOOT_RESPAWN_MS } }));
    get().addToast(`Found ${spawn.qty}x ${RESOURCES[spawn.item]?.name || spawn.item}!`);
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

    const collected = get().collectedLoot;
    let lootChanged = false;
    const nextLoot = { ...collected };
    for (const id of Object.keys(collected)) {
      if (collected[id] <= now) {
        delete nextLoot[id];
        lootChanged = true;
      }
    }
    if (lootChanged) set({ collectedLoot: nextLoot });

    get().tickAnimalRespawns();
  },

  // --- wild animals: health, death, loot, respawn ---
  animalState: Object.fromEntries(ANIMAL_SPAWNS.map((a) => [a.id, { health: a.health, alive: true, respawnAt: 0 }])),
  damageAnimal: (id, dmg) => {
    const spawn = ANIMAL_SPAWNS.find((a) => a.id === id);
    const cur = get().animalState[id];
    if (!spawn || !cur || !cur.alive) return;
    const health = cur.health - dmg;
    if (health <= 0) {
      set((s) => ({ animalState: { ...s.animalState, [id]: { health: 0, alive: false, respawnAt: Date.now() + ANIMAL_RESPAWN_MS } } }));
      for (const [k, v] of Object.entries(spawn.loot)) get().addItem(k, v);
      get().addToast(`${spawn.type === 'boar' ? 'Boar' : 'Monkey'} down! Loot collected.`);
    } else {
      set((s) => ({ animalState: { ...s.animalState, [id]: { ...cur, health } } }));
    }
  },
  tickAnimalRespawns: () => {
    const now = Date.now();
    const state = get().animalState;
    let changed = false;
    const next = { ...state };
    for (const [id, st] of Object.entries(state)) {
      if (!st.alive && st.respawnAt && st.respawnAt <= now) {
        const spawn = ANIMAL_SPAWNS.find((a) => a.id === id);
        next[id] = { health: spawn.health, alive: true, respawnAt: 0 };
        changed = true;
      }
    }
    if (changed) set({ animalState: next });
    get().tickTribeMemberRespawns();
  },

  // --- rival tribe members at their camps: health, death, loot, respawn ---
  tribeMemberState: Object.fromEntries([
    ...ENEMY_TRIBES.flatMap((tribe) =>
      TRIBE_MEMBER_OFFSETS.map((_, i) => [`${tribe.id}_m${i}`, { health: TRIBE_MEMBER_HEALTH, alive: true, respawnAt: 0 }])
    ),
    ...DISTANT_TRIBES.flatMap((tribe) =>
      TRIBE_MEMBER_OFFSETS.map((_, i) => [`dt_${tribe.id}_m${i}`, { health: TRIBE_MEMBER_HEALTH, alive: true, respawnAt: 0 }])
    ),
  ]),
  damageTribeMember: (id, dmg) => {
    const cur = get().tribeMemberState[id];
    if (!cur || !cur.alive) return;
    const tribeId = id.split('_m')[0];
    // Alert the rest of the camp - they'll all rush to fight back for a while.
    set((s) => ({ alertedCamps: { ...s.alertedCamps, [tribeId]: Date.now() + CAMP_ALERT_DURATION_MS } }));
    const health = cur.health - dmg;
    if (health <= 0) {
      set((s) => ({ tribeMemberState: { ...s.tribeMemberState, [id]: { health: 0, alive: false, respawnAt: Date.now() + TRIBE_MEMBER_RESPAWN_MS } } }));
      get().addMeters(TRIBE_MEMBER_REWARD.meters);
      get().addToast(`Rival tribesperson defeated! +${TRIBE_MEMBER_REWARD.meters}m`);
      if (ENEMY_TRIBES.some((t) => t.id === tribeId)) get().checkCampCapture(tribeId);
    } else {
      set((s) => ({ tribeMemberState: { ...s.tribeMemberState, [id]: { ...cur, health } } }));
    }
  },
  // --- alerted camps: when one member is attacked, the whole camp aggros for a while ---
  alertedCamps: {},
  // --- rival tribes that have "spawned in" and have an active camp on the map ---
  activeTribeIds: ENEMY_TRIBES.slice(0, ENEMY_TRIBES_INITIAL_COUNT).map((t) => t.id),
  setActiveTribeIds: (v) => set({ activeTribeIds: v }),
  spawnNextTribe: () => {
    // The host's tribeSync broadcast is authoritative for joiners.
    if (get().mpRole === 'joiner') return;
    const active = get().activeTribeIds;
    const next = ENEMY_TRIBES.find((t) => !active.includes(t.id));
    if (!next) return;
    set((s) => ({ activeTribeIds: [...s.activeTribeIds, next.id] }));
    get().addToast(`A new rival tribe has arrived: ${next.name}!`);
  },

  // --- captured rival camps: become the player's once every member is defeated ---
  capturedTribes: {},
  campOwners: {}, // { [tribeId]: ownerTribeId } — which enemy tribe currently controls this camp
  setCampOwner: (tribeId, ownerId) => set((s) => ({ campOwners: { ...s.campOwners, [tribeId]: ownerId } })),
  checkCampCapture: (tribeId) => {
    if (get().capturedTribes[tribeId]) return;
    const state = get().tribeMemberState;
    const allDown = TRIBE_MEMBER_OFFSETS.every((_, i) => !state[`${tribeId}_m${i}`]?.alive);
    if (!allDown) return;
    set((s) => {
      const campOwners = { ...s.campOwners };
      delete campOwners[tribeId];
      return { capturedTribes: { ...s.capturedTribes, [tribeId]: true }, campOwners };
    });
    get().addMeters(CAMP_CAPTURE_REWARD.meters);
    get().addCoins(CAMP_CAPTURE_REWARD.coins);
    const tribe = ENEMY_TRIBES.find((t) => t.id === tribeId);
    get().addToast(`${tribe.name}'s camp is now yours! +${CAMP_CAPTURE_REWARD.meters}m, +${CAMP_CAPTURE_REWARD.coins}c`);
    get().addToast(`3 tribespeople from ${tribe.name} join your side and settle into the camp!`);
    get().initGarrison(tribe.id);
  },
  tickTribeMemberRespawns: () => {
    // The host's tribeSync broadcast is authoritative for joiners.
    if (get().mpRole === 'joiner') return;
    const now = Date.now();
    const state = get().tribeMemberState;
    const captured = get().capturedTribes;
    let changed = false;
    const next = { ...state };
    for (const [id, st] of Object.entries(state)) {
      if (captured[id.split('_m')[0]]) continue; // captured camps stay empty
      if (!st.alive && st.respawnAt && st.respawnAt <= now) {
        next[id] = { health: TRIBE_MEMBER_HEALTH, alive: true, respawnAt: 0 };
        changed = true;
      }
    }
    if (changed) set({ tribeMemberState: next });
  },

  // --- weapon combat: thrown spears lying on the ground, and damage resolution ---
  groundWeapons: [], // [{ id, weaponId, position: [x,y,z] }]
  pickupWeapon: (groundId) => {
    const gw = get().groundWeapons.find((g) => g.id === groundId);
    if (!gw) return false;
    get().addItem(gw.weaponId, 1);
    set((s) => ({ groundWeapons: s.groundWeapons.filter((g) => g.id !== groundId) }));
    get().addToast(`Picked up ${WEAPONS[gw.weaponId].name}`);
    return true;
  },
  // Finds the closest animal/raider in front of the player within `range`.
  findAttackTarget: (range) => {
    const [px, , pz] = playerTransform.position;
    const yaw = playerTransform.yaw;
    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);
    let best = null;
    let bestDist = range;
    for (const [id, pos] of Object.entries(entityRegistry.animals)) {
      if (!get().animalState[id]?.alive) continue;
      const dx = pos.x - px, dz = pos.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > range || dist === 0) continue;
      const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
      if (dot > Math.cos(ATTACK_CONE / 2) && dist <= bestDist) { best = { kind: 'animal', id, dist }; bestDist = dist; }
    }
    const raid = get().raid;
    if (raid) {
      for (const r of raid.raiders) {
        const pos = entityRegistry.raiders[r.id];
        if (!pos) continue;
        const dx = pos.x - px, dz = pos.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist > range || dist === 0) continue;
        const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
        if (dot > Math.cos(ATTACK_CONE / 2) && dist <= bestDist) { best = { kind: 'raider', id: r.id, dist }; bestDist = dist; }
      }
    }
    for (const [id, pos] of Object.entries(entityRegistry.tribeMembers)) {
      if (!get().tribeMemberState[id]?.alive) continue;
      const dx = pos.x - px, dz = pos.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > range || dist === 0) continue;
      const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
      if (dot > Math.cos(ATTACK_CONE / 2) && dist <= bestDist) { best = { kind: 'tribeMember', id, dist }; bestDist = dist; }
    }
    const dr = get().distantRaid;
    if (dr) {
      for (const r of dr.raiders) {
        const pos = entityRegistry.distantRaiders[r.id];
        if (!pos) continue;
        const dx = pos.x - px, dz = pos.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist > range || dist === 0) continue;
        const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
        if (dot > Math.cos(ATTACK_CONE / 2) && dist <= bestDist) { best = { kind: 'distantRaider', id: r.id, dist }; bestDist = dist; }
      }
    }
    const itr = get().interTribalRaid;
    if (itr) {
      for (const r of itr.raiders) {
        const pos = entityRegistry.interTribalRaiders[r.id];
        if (!pos) continue;
        const dx = pos.x - px, dz = pos.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist > range || dist === 0) continue;
        const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
        if (dot > Math.cos(ATTACK_CONE / 2) && dist <= bestDist) { best = { kind: 'interTribalRaider', id: r.id, dist }; bestDist = dist; }
      }
    }
    return best;
  },
  applyDamageToTarget: (target, dmg) => {
    if (target.kind === 'animal') get().damageAnimal(target.id, dmg);
    else if (target.kind === 'raider') get().damageRaider(target.id, dmg);
    else if (target.kind === 'distantRaider') get().damageDistantRaider(target.id, dmg);
    else if (target.kind === 'interTribalRaider') get().damageInterTribalRaider(target.id, dmg);
    else if (target.kind === 'tribeMember') {
      // Rival tribe camps are simulated on the host; joiners ask the host
      // to apply the damage so health/captures stay in sync for both players.
      if (get().mpRole === 'joiner') mpSend({ t: 'tribeDamage', id: target.id, dmg });
      else get().damageTribeMember(target.id, dmg);
    }
  },
  // Spear poke: short-range stab, doesn't leave the player's hand.
  meleeAttack: (weaponId) => {
    const weapon = WEAPONS[weaponId];
    if (!weapon) return false;
    const dmg = weapon.pokeDamage ?? weapon.damage;
    const target = get().findAttackTarget(weapon.range);
    if (!target) return false;
    get().applyDamageToTarget(target, dmg);
    return true;
  },
  // Throws the equipped spear: it flies out, damages whatever it hits, and
  // lands on the ground to be picked back up later.
  flyingSpears: [], // [{ id, weaponId, start: [x,y,z], end: [x,y,z], startedAt }]
  throwWeapon: (weaponId) => {
    const weapon = WEAPONS[weaponId];
    if (!weapon || !weapon.throwable) return false;
    if (!get().removeItem(weaponId, 1)) return false;
    const [px, py, pz] = playerTransform.position;
    const yaw = playerTransform.yaw;
    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);

    const target = get().findAttackTarget(THROW_RANGE);
    if (target) get().applyDamageToTarget(target, weapon.damage);

    const landDist = target ? Math.max(1, target.dist - 0.5) : THROW_RANGE;
    const landX = px + dirX * landDist;
    const landZ = pz + dirZ * landDist;
    const id = `gw_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    set((s) => ({
      flyingSpears: [...s.flyingSpears, {
        id, weaponId,
        start: [px + dirX * 0.6, py + 1.3, pz + dirZ * 0.6],
        end: [landX, getTerrainHeight(landX, landZ) + 0.05, landZ],
        startedAt: Date.now(),
      }],
    }));
    get().addToast(target ? `Spear hit its mark! Go pick it back up.` : `Spear thrown! Go pick it back up.`);
    return true;
  },
  landSpear: (id, posOverride) => {
    set((s) => {
      const spear = s.flyingSpears.find((f) => f.id === id);
      if (!spear) return {};
      return {
        flyingSpears: s.flyingSpears.filter((f) => f.id !== id),
        groundWeapons: [...s.groundWeapons, { id: spear.id, weaponId: spear.weaponId, position: posOverride ?? spear.end }],
      };
    });
  },

  // --- visual/audio effect events (e.g. machete "ching") ---
  fxEvents: [], // [{ id, type, position }]
  spawnFx: (type, position) => {
    const id = `fx_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    set((s) => ({ fxEvents: [...s.fxEvents, { id, type, position }] }));
  },
  removeFx: (id) => set((s) => ({ fxEvents: s.fxEvents.filter((f) => f.id !== id) })),

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
  activePanel: null, // null | 'inventory' | 'shop' | 'crafting' | 'build' | 'tribe' | 'multiplayer' | 'map' | 'settings'
  setActivePanel: (panel) => set({ activePanel: panel }),

  nearInteractable: null, // { type: 'gather'|'shop'|'craft', label, data }
  setNearInteractable: (v) => set({ nearInteractable: v }),

  // --- controls / settings ---
  keybinds: { ...activeBinds },
  lookSens: inputSettings.lookSens,
  invertY: inputSettings.invertY,
  setLookSens: (v) => { inputSettings.lookSens = v; saveInputSettings(); set({ lookSens: v }); },
  setInvertY: (v) => { inputSettings.invertY = v; saveInputSettings(); set({ invertY: v }); },
  graphicsQuality: graphicsSettings.quality,
  setGraphicsQuality: (q) => {
    if (!GRAPHICS_PRESETS[q]) return;
    graphicsSettings.quality = q;
    saveGraphicsSettings();
    set({ graphicsQuality: q });
  },
  brightness: graphicsSettings.brightness,
  setBrightness: (v) => {
    const b = Math.max(0.6, Math.min(1.8, v));
    graphicsSettings.brightness = b;
    saveGraphicsSettings();
    set({ brightness: b });
  },
  showStats: graphicsSettings.showStats,
  setShowStats: (v) => {
    graphicsSettings.showStats = !!v;
    saveGraphicsSettings();
    set({ showStats: !!v });
  },

  // Rebinding is a swap, never a steal: if `code` already belongs to another
  // action, that action inherits the key this one is giving up. So no action is
  // ever left keyless, and binding cycle-hotbar to P moves build (or whatever
  // held P) onto Q.
  setKeybind: (actionId, code) => {
    if (!code) return false;
    if (RESERVED_CODES.has(code)) {
      get().addToast(`${keyLabel(code)} is reserved for closing menus`);
      return false;
    }
    const binds = { ...get().keybinds };
    if (!(actionId in binds)) return false;
    const prev = binds[actionId];
    if (prev === code) return false;
    const displaced = Object.keys(binds).find((id) => id !== actionId && binds[id] === code);
    binds[actionId] = code;
    if (displaced) binds[displaced] = prev;
    setActiveBinds(binds);
    saveKeybinds(binds);
    set({ keybinds: binds });
    get().addToast(displaced
      ? `${actionLabel(actionId)} → ${keyLabel(code)}, swapped ${actionLabel(displaced)} → ${keyLabel(prev)}`
      : `${actionLabel(actionId)} → ${keyLabel(code)}`);
    return true;
  },
  resetKeybinds: () => {
    const binds = { ...DEFAULT_KEYBINDS };
    setActiveBinds(binds);
    saveKeybinds(binds);
    set({ keybinds: binds });
    get().addToast('Controls reset to defaults');
  },

  hotbarSlots: ['spear', 'machete', 'axe', 'pickaxe', 'club', 'torch', 'bandage'],
  activeHotbarSlot: 0,
  setActiveHotbarSlot: (i) => set({ activeHotbarSlot: i }),

  // --- multiplayer (P2P) ---
  mpStatus: 'offline', // 'offline' | 'hosting' | 'connecting' | 'connected'
  setMpStatus: (v) => set({ mpStatus: v }),
  mpCode: '',
  setMpCode: (v) => set({ mpCode: v }),
  mpError: null,
  setMpError: (v) => set({ mpError: v }),
  mpRole: null, // null | 'host' | 'joiner' - host's rival-tribe simulation is authoritative
  setMpRole: (v) => set({ mpRole: v }),
  setTribeMemberState: (v) => set({ tribeMemberState: v }),
  setCapturedTribes: (v) => set({ capturedTribes: v }),
  setRaid: (v) => set({ raid: v }),
  setDistantRaid: (v) => set({ distantRaid: v }),
  setInterTribalRaid: (v) => set({ interTribalRaid: v }),

  // --- toasts ---
  toasts: [],
  addToast: (msg) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }));
    get().addNotification(msg, 'game');
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },

  // --- chat (multiplayer text messages) ---
  chatMessages: [],
  chatOpen: false,
  setChatOpen: (v) => set({ chatOpen: v }),
  addChatMessage: (from, text) => {
    const id = ++chatId;
    set((s) => ({ chatMessages: [...s.chatMessages, { id, from, text }] }));
    get().addNotification(`${from === 'me' ? 'You' : 'Friend'}: ${text}`, 'chat');
    setTimeout(() => {
      set((s) => ({ chatMessages: s.chatMessages.filter((m) => m.id !== id) }));
    }, 8000);
  },

  // --- notifications (persistent log) ---
  notifications: [],
  notifUnread: 0,
  addNotification: (msg, type = 'game') => {
    set((s) => ({
      notifications: [...s.notifications.slice(-99), { id: Date.now() + Math.random(), msg, type, time: Date.now() }],
      notifUnread: s.notifUnread + 1,
    }));
  },
  clearNotifUnread: () => set({ notifUnread: 0 }),

  // --- coins (separate currency, collected from sky drops) ---
  coins: 0,
  addCoins: (amount) => {
    set((s) => ({ coins: s.coins + amount }));
    get().addToast(`+${amount} coins`);
  },
  spendCoins: (amount) => {
    if (get().coins < amount) return false;
    set((s) => ({ coins: s.coins - amount }));
    return true;
  },

  // --- coin drops, fall from the sky and are collected on contact ---
  coinDrops: [],
  spawnCoinDrop: () => {
    const value = COIN_DROP_MIN + Math.floor(Math.random() * (COIN_DROP_MAX - COIN_DROP_MIN + 1));
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * COIN_SPAWN_RADIUS;
    const id = `coin_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const position = [Math.cos(angle) * dist, 0, Math.sin(angle) * dist];
    set((s) => ({ coinDrops: [...s.coinDrops, { id, position, value }] }));
  },
  collectCoinDrop: (id, value) => {
    set((s) => ({ coinDrops: s.coinDrops.filter((c) => c.id !== id) }));
    get().addCoins(value);
  },

  // --- the player's tribe: recruit warriors to defend against raids ---
  warriors: 3,
  warriorsRecruited: 0,
  recruitWarrior: () => {
    const cost = WARRIOR_BASE_COST + get().warriorsRecruited * WARRIOR_COST_STEP;
    if (!get().spendCoins(cost)) {
      get().addToast(`Need ${cost} coins to recruit a warrior`);
      return false;
    }
    set((s) => ({ warriors: s.warriors + 1, warriorsRecruited: s.warriorsRecruited + 1 }));
    get().addToast('A new warrior joins your tribe!');
    return true;
  },

  // --- how many warriors come with the player to fight rival tribes (the rest guard the base) ---
  escortWarriors: 0,
  setEscortWarriors: (n) => set((s) => ({ escortWarriors: Math.max(0, Math.min(n, s.warriors)) })),

  // --- use an item from the inventory ---
  useItem: (id) => {
    const usable = USABLE_ITEMS[id];
    if (!usable) return false;
    if (usable.consumed && !get().removeItem(id, 1)) {
      get().addToast(`No ${id} left to use`);
      return false;
    }
    usable.apply(get());
    return true;
  },

  // --- player-built structures ---
  buildings: [],
  placeBuilding: (typeId) => {
    const type = BUILDING_TYPES.find((b) => b.id === typeId);
    if (!type) return false;
    if (!get().hasItems(type.cost)) {
      get().addToast(`Not enough resources for ${type.name}`);
      return false;
    }
    for (const [k, v] of Object.entries(type.cost)) get().removeItem(k, v);
    const [px, , pz] = playerTransform.position;
    const yaw = playerTransform.yaw;
    const dist = 4;
    const x = px - Math.sin(yaw) * dist;
    const z = pz - Math.cos(yaw) * dist;
    const id = `bld_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    set((s) => ({ buildings: [...s.buildings, { id, type: typeId, position: [x, 0, z], rotation: yaw }] }));
    get().addToast(`Built ${type.name}`);
    return true;
  },

  // --- rival tribe raids — can target home base OR any player-owned team camp ---
  raid: null, // { tribeId, tribeName, color, targetPos, targetTribeId, raiders: [{ id, position }] }
  startRaid: () => {
    if (get().raid) return;
    const s = get();
    const available = ENEMY_TRIBES.filter((t) => s.activeTribeIds.includes(t.id) && !s.capturedTribes[t.id]);
    if (!available.length) return;
    const tribe = available[Math.floor(Math.random() * available.length)];
    const capturedIds = Object.keys(s.capturedTribes).filter((id) => s.capturedTribes[id]);
    let targetPos = BASE_CENTER;
    let targetTribeId = null;
    if (capturedIds.length > 0 && Math.random() < 0.5) {
      const tId = capturedIds[Math.floor(Math.random() * capturedIds.length)];
      const t = ENEMY_TRIBES.find((et) => et.id === tId);
      if (t) { targetPos = t.campPosition; targetTribeId = tId; }
    }
    const count = 3 + Math.floor(Math.random() * 4);
    const raiders = Array.from({ length: count }, (_, i) => ({
      id: `raider_${Date.now()}_${i}`,
      health: 40,
      position: [tribe.campPosition[0] + (Math.random() - 0.5) * 6, 0, tribe.campPosition[2] + (Math.random() - 0.5) * 6],
    }));
    const targetLabel = targetTribeId ? ENEMY_TRIBES.find((et) => et.id === targetTribeId).name + "'s camp (yours)" : 'your tribe';
    set({ raid: { tribeId: tribe.id, tribeName: tribe.name, color: tribe.color, targetPos, targetTribeId, raiders } });
    get().addToast(`${tribe.name} is raiding ${targetLabel}!`);
  },
  resolveRaider: (raiderId, raiderWon) => {
    const raid = get().raid;
    if (!raid) return;
    const raiders = raid.raiders.filter((r) => r.id !== raiderId);
    set({ raid: raiders.length ? { ...raid, raiders } : null });
    if (raiderWon) {
      if (raid.targetTribeId) {
        get().damageGarrison(raid.targetTribeId, 30);
        const tribe = ENEMY_TRIBES.find((t) => t.id === raid.targetTribeId);
        get().addToast(`A raider struck ${tribe?.name ?? ''}'s garrison!`);
      } else {
        get().adjustStat('health', -10);
        if (get().warriors > 0) set((s) => ({ warriors: s.warriors - 1, escortWarriors: Math.min(s.escortWarriors, s.warriors - 1) }));
        get().addToast('A raider broke through and damaged your tribe!');
      }
    } else {
      get().addToast('Your warriors repelled a raider!');
    }
    if (!raiders.length) get().addToast(`${raid.tribeName} retreats!`);
  },
  damageRaider: (raiderId, dmg) => {
    const raid = get().raid;
    if (!raid) return;
    const raider = raid.raiders.find((r) => r.id === raiderId);
    if (!raider) return;
    const health = (raider.health ?? 40) - dmg;
    if (health <= 0) {
      get().resolveRaider(raiderId, false);
      get().addToast('Raider struck down!');
    } else {
      set({ raid: { ...raid, raiders: raid.raiders.map((r) => (r.id === raiderId ? { ...r, health } : r)) } });
    }
  },

  // --- garrison at captured team camps ---
  garrisonHP: {},
  initGarrison: (tribeId) => {
    set((s) => ({ garrisonHP: { ...s.garrisonHP, [tribeId]: GARRISON_HEALTH } }));
  },
  damageGarrison: (tribeId, dmg) => {
    const current = get().garrisonHP[tribeId] ?? GARRISON_HEALTH;
    const hp = current - dmg;
    if (hp <= 0) {
      const gpCopy = { ...get().garrisonHP };
      const cpCopy = { ...get().capturedTribes };
      delete gpCopy[tribeId];
      delete cpCopy[tribeId];
      set({ garrisonHP: gpCopy, capturedTribes: cpCopy });
      const tribe = ENEMY_TRIBES.find((t) => t.id === tribeId);
      get().addToast(`${tribe?.name ?? tribeId}'s camp has been overrun — it's no longer yours!`);
    } else {
      set((s) => ({ garrisonHP: { ...s.garrisonHP, [tribeId]: hp } }));
    }
  },

  // --- distant tribe raids — can target any player-held area ---
  distantRaid: null,
  startDistantRaid: () => {
    if (get().distantRaid) return;
    const s = get();
    const dtribe = DISTANT_TRIBES[Math.floor(Math.random() * DISTANT_TRIBES.length)];
    const capturedIds = Object.keys(s.capturedTribes).filter((id) => s.capturedTribes[id]);
    const targets = ['base', ...capturedIds];
    const picked = targets[Math.floor(Math.random() * targets.length)];
    const targetTribeId = picked === 'base' ? null : picked;
    const targetPos = targetTribeId ? ENEMY_TRIBES.find((t) => t.id === targetTribeId).campPosition : BASE_CENTER;
    const count = 1 + Math.floor(Math.random() * 3);
    const raiders = Array.from({ length: count }, (_, i) => ({
      id: `dr_${Date.now()}_${i}`,
      health: 40,
      position: [dtribe.campPosition[0] + (Math.random() - 0.5) * 8, 0, dtribe.campPosition[2] + (Math.random() - 0.5) * 8],
    }));
    const targetName = targetTribeId ? (ENEMY_TRIBES.find((t) => t.id === targetTribeId)?.name ?? targetTribeId) + "'s camp" : 'your tribe';
    set({ distantRaid: { tribeId: dtribe.id, tribeName: dtribe.name, color: dtribe.color, targetTribeId, targetPos, raiders } });
    get().addToast(`⚠️ ${dtribe.name} is marching on ${targetName}!`);
  },
  resolveDistantRaider: (raiderId, raiderWon) => {
    const dr = get().distantRaid;
    if (!dr) return;
    const raiders = dr.raiders.filter((r) => r.id !== raiderId);
    set({ distantRaid: raiders.length ? { ...dr, raiders } : null });
    if (raiderWon) {
      if (dr.targetTribeId) {
        get().damageGarrison(dr.targetTribeId, 35);
      } else {
        get().adjustStat('health', -8);
        get().addToast('A distant raider breached your camp!');
      }
    }
    if (!raiders.length) get().addToast(`${dr.tribeName} retreats!`);
  },
  damageDistantRaider: (raiderId, dmg) => {
    const dr = get().distantRaid;
    if (!dr) return;
    const raider = dr.raiders.find((r) => r.id === raiderId);
    if (!raider) return;
    const health = (raider.health ?? 40) - dmg;
    if (health <= 0) {
      get().resolveDistantRaider(raiderId, false);
      get().addToast('Distant raider struck down!');
    } else {
      set({ distantRaid: { ...dr, raiders: dr.raiders.map((r) => (r.id === raiderId ? { ...r, health } : r)) } });
    }
  },

  // --- inter-tribal warfare: enemy tribes raid each other's camps ---
  interTribalRaid: null,
  startInterTribalRaid: () => {
    if (get().interTribalRaid) return;
    const s = get();
    const active = s.activeTribeIds;
    if (active.length < 2) return;
    const attackerCandidates = active.filter((id) => !s.capturedTribes[id]);
    if (!attackerCandidates.length) return;
    const attackerId = attackerCandidates[Math.floor(Math.random() * attackerCandidates.length)];
    const targetCandidates = active.filter((id) => id !== attackerId);
    if (!targetCandidates.length) return;
    const targetId = targetCandidates[Math.floor(Math.random() * targetCandidates.length)];
    const attacker = ENEMY_TRIBES.find((t) => t.id === attackerId);
    const target = ENEMY_TRIBES.find((t) => t.id === targetId);
    const count = 2 + Math.floor(Math.random() * 2);
    const raiders = Array.from({ length: count }, (_, i) => ({
      id: `itr_${Date.now()}_${i}`,
      health: 30,
      position: [attacker.campPosition[0] + (Math.random() - 0.5) * 8, 0, attacker.campPosition[2] + (Math.random() - 0.5) * 8],
    }));
    const targetLabel = s.capturedTribes[targetId] ? `${target.name}'s camp (yours!)` : target.name;
    set({ interTribalRaid: { attackerId, attackerName: attacker.name, attackerColor: attacker.color, targetId, targetName: target.name, targetPos: target.campPosition, raiders } });
    get().addToast(`⚔️ ${attacker.name} attacks ${targetLabel}!`);
  },
  resolveInterTribalRaider: (raiderId, raiderWon) => {
    const itr = get().interTribalRaid;
    if (!itr) return;
    const raiders = itr.raiders.filter((r) => r.id !== raiderId);
    set({ interTribalRaid: raiders.length ? { ...itr, raiders } : null });
    if (raiderWon) {
      if (get().capturedTribes[itr.targetId]) {
        get().damageGarrison(itr.targetId, 30);
      } else {
        const prevOwner = get().campOwners[itr.targetId];
        get().setCampOwner(itr.targetId, itr.attackerId);
        const target = ENEMY_TRIBES.find((t) => t.id === itr.targetId);
        const prevName = prevOwner ? ENEMY_TRIBES.find((t) => t.id === prevOwner)?.name : target.name;
        get().addToast(`${itr.attackerName} has claimed ${prevName}'s camp!`);
      }
    }
    if (!raiders.length) get().addToast(`${itr.attackerName} retreats!`);
  },
  damageInterTribalRaider: (raiderId, dmg) => {
    const itr = get().interTribalRaid;
    if (!itr) return;
    const raider = itr.raiders.find((r) => r.id === raiderId);
    if (!raider) return;
    const health = (raider.health ?? 30) - dmg;
    if (health <= 0) {
      get().resolveInterTribalRaider(raiderId, false);
      get().addToast('Warring tribesperson struck down!');
    } else {
      set({ interTribalRaid: { ...itr, raiders: itr.raiders.map((r) => (r.id === raiderId ? { ...r, health } : r)) } });
    }
  },

  // --- game start ---
  started: false,
  start: () => set({ started: true }),
}));

// ============================================================

export {
  toastId,
  chatId,
  useGame,
};
