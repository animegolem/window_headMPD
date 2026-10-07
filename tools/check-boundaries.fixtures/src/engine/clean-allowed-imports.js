import { unzipSync } from 'fflate';
import jpeg from 'jpeg-js';
import { newQuickJSWASMModule } from 'quickjs-emscripten-core';
import wasmVariant from '@jitl/quickjs-wasmfile-release-sync';
import ngVariant from '@jitl/quickjs-ng-wasmfile-release-sync';
import browserBuild from 'fflate/esm/browser.js';
import { FAITHFUL } from './options.js';
export const later = () => import('./contracts');
export const lazy = () => import("quickjs-emscripten-core");
/** @type {import('./contracts').CreateEngineFn} */
export const createEngine = () => ({ unzipSync, jpeg, newQuickJSWASMModule, wasmVariant, ngVariant, browserBuild, FAITHFUL });
/** @typedef {import('quickjs-emscripten-core').QuickJSContext} Context */
