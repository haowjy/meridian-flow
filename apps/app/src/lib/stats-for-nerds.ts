/**
 * "Stats for nerds" preference — whether finished turns offer their Info
 * button (a reply's usage, a compaction's context sizes).
 *
 * Device-local, like theme and text size: it is a way of looking at the app,
 * not account data. Off by default. The value is held in memory once read, so
 * the toggle still works for the session when storage is unavailable.
 */
import { createPreferenceSubscribers } from "./preference-subscribers";

export const STATS_FOR_NERDS_STORAGE_KEY = "meridian:stats-for-nerds";

let current: boolean | null = null;

function readStored(): boolean {
  try {
    return localStorage.getItem(STATS_FOR_NERDS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function resolveStatsForNerds(): boolean {
  if (typeof window === "undefined") return false;
  current ??= readStored();
  return current;
}

// Another tab changed it: follow along.
const subscribers = createPreferenceSubscribers(STATS_FOR_NERDS_STORAGE_KEY, () => {
  current = readStored();
});

export function changeStatsForNerds(enabled: boolean): void {
  current = enabled;
  try {
    if (enabled) localStorage.setItem(STATS_FOR_NERDS_STORAGE_KEY, "1");
    else localStorage.removeItem(STATS_FOR_NERDS_STORAGE_KEY);
  } catch {
    // localStorage unavailable: the in-memory value still holds for the session.
  }
  subscribers.notify();
}

export const subscribeStatsForNerds = subscribers.subscribe;
