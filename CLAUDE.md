# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Jungle King** is a 3D browser-based survival game. The entire codebase lives in a **single file**: `index.html` (~5500 lines). There is no build step, no package manager, and no external asset files — everything is self-contained and runs by opening the file directly in a browser.

## Running the Game

Open `index.html` in a browser. No server, build, or install required.

```
# Local dev server (optional, for proper module resolution in some browsers)
python3 -m http.server 8080
# then open http://localhost:8080
```

There are no tests, no linters, and no CI configuration.

## Dependencies

All dependencies are loaded via `importmap` from `esm.sh` CDN (lines 7–21 of `index.html`). Nothing is installed locally:

- **React 18.2** — UI layer
- **Three.js 0.160** — 3D graphics
- **@react-three/fiber 8.15** — React renderer for Three.js
- **@react-three/drei 9.99** — R3F utility components
- **Zustand 4.5** — global state management
- **htm 3.1** — JSX-like syntax without Babel (tagged template literals)
- **PeerJS 1.5** — peer-to-peer multiplayer networking

## Code Structure Inside `index.html`

| Lines | Content |
|-------|---------|
| 1–22 | HTML head, importmap |
| 23–660 | Inline CSS |
| 661–5507 | JavaScript module (`<script type="module">`) |
| 5505–5507 | `createRoot(#root)` → mounts `ErrorBoundary` → `App` |

The JavaScript is organized as one long module with no file splitting:

1. **Constants & data** — `RESOURCES`, `CRAFTING_RECIPES`, `WEAPONS`, `ANIMAL_SPAWNS`, `ENEMY_TRIBES`, `DISTANT_TRIBES`, `SHOP_ITEMS`, `BUILDING_TYPES`, `LOOT_SPAWNS`, `CAVE_LOCATIONS`
2. **Zustand store** — `useGame` — single source of truth for all game state
3. **Utility functions** — PRNG (`mulberry32`), geometry helpers, audio (`playSound` via Web Audio API)
4. **React components** — 25+ components rendered inside an R3F `<Canvas>`, plus HUD overlay components rendered to the DOM
5. **App root** — wires everything together

## Architecture

### State Management (`useGame` Zustand store)

Every piece of mutable game state lives here: survival stats (health, hunger, thirst, energy, warmth, sanity), inventory, resource nodes, tribe/animal/raider positions, multiplayer status, time of day, buildings, meters (currency), coins. Mutations use Zustand's `set()`. Components read slices via selector functions.

### Game Loop

All per-frame logic runs inside `useFrame` hooks (R3F). There is no separate tick loop. `useFrame` callbacks handle player movement, AI, collision detection, stat decay, and entity cleanup every frame.

### Entity System

World entities (animals, raiders, tribe members) are tracked in a module-level `entityRegistry` Map keyed by entity ID. Each entry holds `{ position: [x,y,z], health, state }`. Components register themselves on mount and deregister on unmount.

### Collision & Physics

Simple 2D circle-circle collision (ignoring Y). Static obstacle positions are collected into a flat array checked each frame. Terrain uses deterministic height from a seeded PRNG (`mulberry32`) so world generation is stable across sessions.

### Multiplayer (PeerJS P2P)

Optional 2-player co-op. One player hosts (generates a room code via PeerJS broker), the other joins by code. After handshake, communication is direct P2P. Host is authoritative for tribe camp state and raid spawning. Messages are plain JSON objects with a `type` field (e.g., `"state"`, `"attack"`, `"chat"`, `"tribePos"`). Remote player position is lerped each frame.

### Audio

All sound effects are synthesized at runtime via the Web Audio API (`playSound` function). No audio files exist in the repo.

### Rendering (htm + R3F)

JSX is written using `htm` tagged templates (`html\`...\``) instead of compiled JSX. R3F components (`<mesh>`, `<boxGeometry>`, `<Canvas>`, etc.) are used directly. The 3D scene and the 2D HUD overlay are separate React trees.

## Key Conventions

- **htm syntax**: All "JSX" is written as `html\`<Component prop=${val}>...</Component>\`` — never compiled JSX syntax.
- **No modules**: Everything is in one file. Add new systems by appending functions/components before the `App` component and registering them inside `App`.
- **Seeded randomness**: Use `mulberry32` for any world-gen or deterministic random values, not `Math.random()`, so the world is reproducible.
- **Audio**: Add new sounds via `playSound(freq, type, duration, volume)` — no audio file assets.
- **State mutations**: Always go through `useGame.setState(...)` or the actions defined in the store. Never mutate state objects directly.
- **Entity cleanup**: Components that register into `entityRegistry` must deregister in their `useEffect` cleanup to avoid stale position data.
