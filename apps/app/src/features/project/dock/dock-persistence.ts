/** Browser-tab-local dock layout; storage failures never block a writer's action. */
import { durableContextTab, parseContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import type { DockDocument, DockView } from "./dock-view-store";

export const DOCK_STORAGE_KEY = "meridian:dock:v1";
export type DockSnapshot = {
  byScreen: Partial<Record<ScreenKey, DockView>>;
  occupant: DockDocument | null;
};
export type DockStorage = Pick<Storage, "getItem" | "setItem">;
export const browserDockStorage = (): DockStorage | null =>
  typeof window === "undefined" ? null : window.sessionStorage;

export function readDockSnapshot(storage: () => DockStorage | null): DockSnapshot | null {
  try {
    const raw = storage()?.getItem(DOCK_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      !value.byScreen ||
      typeof value.byScreen !== "object" ||
      Array.isArray(value.byScreen)
    )
      return null;
    const byScreen: DockSnapshot["byScreen"] = {};
    for (const [screen, view] of Object.entries(value.byScreen)) {
      if (
        (screen !== "chat" && screen !== "work" && screen !== "context") ||
        (view !== "chat" && view !== "context" && view !== "changes")
      )
        return null;
      byScreen[screen] = view;
    }
    const occupant = value.occupant;
    if (occupant === null) return { byScreen, occupant: null };
    if (
      !occupant ||
      typeof occupant.projectId !== "string" ||
      !occupant.projectId ||
      (occupant.screen !== "chat" && occupant.screen !== "work")
    )
      return null;
    const tab = parseContextTab(occupant.tab);
    return tab
      ? { byScreen, occupant: { projectId: occupant.projectId, screen: occupant.screen, tab } }
      : null;
  } catch {
    return null;
  }
}

export function writeDockSnapshot(storage: () => DockStorage | null, snapshot: DockSnapshot): void {
  try {
    storage()?.setItem(
      DOCK_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        byScreen: snapshot.byScreen,
        occupant: snapshot.occupant
          ? { ...snapshot.occupant, tab: durableContextTab(snapshot.occupant.tab) }
          : null,
      }),
    );
  } catch {
    // Layout is optional; the in-memory dock remains usable.
  }
}
