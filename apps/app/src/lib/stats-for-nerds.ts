/** Account preference projection for finished-turn usage details. */
import { readAccountSettingsCache } from "./account-settings-cache";

let current: boolean | null = null;
const listeners = new Set<() => void>();
export function resolveStatsForNerds(): boolean {
  return typeof window === "undefined"
    ? false
    : (current ?? readAccountSettingsCache()?.statsForNerds ?? false);
}
export function changeStatsForNerds(enabled: boolean): void {
  current = enabled;
  for (const listener of listeners) listener();
}
export function subscribeStatsForNerds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
