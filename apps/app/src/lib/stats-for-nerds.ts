/**
 * "Stats for nerds" preference — whether finished turns offer their Info
 * button (a reply's usage, a compaction's context sizes).
 *
 * Device-local, like theme and text size: it is a way of looking at the app,
 * not account data. Off by default. The value is held in memory once read, so
 * the toggle still works for the session when storage is unavailable.
 */
export const STATS_FOR_NERDS_STORAGE_KEY = "meridian:stats-for-nerds";

const listeners = new Set<() => void>();
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

function notify(): void {
  for (const listener of listeners) listener();
}

export function changeStatsForNerds(enabled: boolean): void {
  current = enabled;
  try {
    if (enabled) localStorage.setItem(STATS_FOR_NERDS_STORAGE_KEY, "1");
    else localStorage.removeItem(STATS_FOR_NERDS_STORAGE_KEY);
  } catch {
    // localStorage unavailable: the in-memory value still holds for the session.
  }
  notify();
}

export function subscribeStatsForNerds(listener: () => void): () => void {
  listeners.add(listener);

  // Another tab changed it: follow along.
  function onStorage(event: StorageEvent): void {
    if (event.key !== STATS_FOR_NERDS_STORAGE_KEY) return;
    current = readStored();
    notify();
  }

  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
