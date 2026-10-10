import './keyboard.js';
import './keybinds.js';
import './graphics.js';
import './runtime.js';
import './touch.js';
import './multiplayer.js';
import './shake.js';
import './interactions.js';
import './data.js';
import './store.js';
import './textures.js';
import './wind.js';
import './sky.js';
import './terrain.js';
import './water.js';
import './vegetation.js';
import './clutter.js';
import './weather.js';
import './grass.js';
import './humanbody.js';
import './player.js';
import './entities.js';
import './kito.js';
import './animals.js';
import './tribes.js';
import './buildings.js';
import './coins.js';
import './hud.js';
import './map.js';
import './settings.js';
import './touchcontrols.js';
import './startscreen.js';
import './app.js';

import { App } from './app.js';
import { createRoot, html } from './core.js';
import { ErrorBoundary } from './startscreen.js';

// Evaluation order, pinned to the order these were written in. Without it
// the import graph decides, and a module that reads another's tables at
// import time can run before those tables exist.

// Evaluation order, pinned to the order these were written in.
// Without it the graph decides, and a module that reads another's
// tables at import time can run before those tables exist.



// ============================================================
// main.js - mount
// ============================================================
const root = createRoot(document.getElementById('root'));
root.render(html`<${ErrorBoundary}><${App} /><//>`);