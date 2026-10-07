// Boots the unmodified hand port. Static imports evaluate in order, so the Tauri stub is in place
// before main.js runs, and the code below runs only after main.js's top-level awaits have settled.
import './tauri-stub.js';
import '/src/main.js';

window.__skinlab.booted = true;
