/**
 * Last-opened context file per project — a device-local chrome preference
 * (localStorage), NOT a persisted tab set. Restore replays the remembered
 * route through the normal `?scheme`/`?path` machinery, so it rides the
 * existing tree-validated open: a file deleted since the last visit simply
 * doesn't reopen (this is why persisting the route is safe where persisting
 * tab objects wouldn't be — see context-tabs-store's lifecycle note).
 */

import {
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";

const STORAGE_KEY = "meridian:context-last-route";

export type LastContextRoute = { scheme: ProjectContextTreeScheme; path: string };

function readAll(): Record<string, LastContextRoute> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries: Record<string, LastContextRoute> = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue;
      const { scheme, path } = value as { scheme?: unknown; path?: unknown };
      if (!isProjectContextTreeScheme(scheme)) continue;
      if (typeof path !== "string" || !path) continue;
      entries[projectId] = { scheme, path };
    }
    return entries;
  } catch {
    return {};
  }
}

export function readLastContextRoute(projectId: string): LastContextRoute | null {
  return readAll()[projectId] ?? null;
}

/** Pass `null` to forget — e.g. the user closed their last tab on purpose. */
export function saveLastContextRoute(projectId: string, route: LastContextRoute | null): void {
  try {
    const all = readAll();
    if (route) {
      all[projectId] = route;
    } else {
      delete all[projectId];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable (private mode / quota) — remembering is best-effort.
  }
}
