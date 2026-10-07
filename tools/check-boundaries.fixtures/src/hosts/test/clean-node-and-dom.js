// The test host runs in Node and Chromium: Node builtins, the DOM and the engine are all fine.
import { readFileSync } from 'node:fs';
import { FAITHFUL } from '../../engine/options.js';
export const probe = () => (typeof window === 'undefined' ? readFileSync : fetch(FAITHFUL.config));
