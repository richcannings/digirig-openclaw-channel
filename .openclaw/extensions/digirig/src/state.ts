import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDigirigRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getDigirigRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DigiRig runtime not initialized");
  }
  return runtime;
}
