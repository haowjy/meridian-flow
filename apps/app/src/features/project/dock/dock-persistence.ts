/** Browser-tab-local dock layout; storage failures never block a writer's action. */
import { durableContextTab, parseContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import type { DockDocument } from "./dock-view-store";
import { DOCK_VIEW_SETS, type DockView } from "./dock-views";

export const DOCK_STORAGE_KEY = "meridian:dock:v1";
export type DockSnapshot = {
  accountId: string;
  byScreen: Partial<Record<ScreenKey, DockView>>;
  occupant: DockDocument | null;
};
export type DockStorage = Pick<Storage, "getItem" | "setItem">;
export const browserDockStorage = (): DockStorage | null =>
  typeof window === "undefined" ? null : window.sessionStorage;

export function readDockSnapshot(
  storage: () => DockStorage | null,
  accountId: string | null,
): DockSnapshot | null {
  try {
    if (!accountId) return null;
    const raw = storage()?.getItem(DOCK_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      value.accountId !== accountId ||
      !value.byScreen ||
      typeof value.byScreen !== "object" ||
      Array.isArray(value.byScreen)
    )
      return null;
    const byScreen: DockSnapshot["byScreen"] = {};
    for (const [screen, view] of Object.entries(value.byScreen)) {
      if (!Object.hasOwn(DOCK_VIEW_SETS, screen)) return null;
      const key = screen as ScreenKey;
      if (!DOCK_VIEW_SETS[key].views.some((supported) => supported === view)) return null;
      byScreen[key] = view as DockView;
    }
    const occupant = value.occupant;
    if (occupant === null) return { accountId, byScreen, occupant: null };
    if (
      !occupant ||
      typeof occupant.projectId !== "string" ||
      !occupant.projectId ||
      typeof occupant.screen !== "string" ||
      !Object.hasOwn(DOCK_VIEW_SETS, occupant.screen) ||
      occupant.screen === "context"
    )
      return null;
    const tab = parseContextTab(occupant.tab);
    return tab
      ? {
          accountId,
          byScreen,
          occupant: { projectId: occupant.projectId, screen: occupant.screen, tab },
        }
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
        accountId: snapshot.accountId,
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
