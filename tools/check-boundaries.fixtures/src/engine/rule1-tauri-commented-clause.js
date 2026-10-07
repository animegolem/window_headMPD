// @expect rule 1
import {
  invoke, // Tauri's IPC
} from '@tauri-apps/api/core';
export const call = invoke;
