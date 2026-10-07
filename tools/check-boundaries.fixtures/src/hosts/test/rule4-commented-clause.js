// @expect rule 4
import {
  invoke, // Tauri's IPC
} from '@tauri-apps/api/core';
export const call = invoke;
