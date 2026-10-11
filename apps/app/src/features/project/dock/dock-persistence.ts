/** Browser-tab-local dock layout; storage failures never block a writer's action. */
import {
  browserRecord,
  browserStorage,
  isRecord,
  type RecordStorage,
} from "@/client/storage/browser-record";
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
export type DockStorage = RecordStorage;
export const browserDockStorage = (): DockStorage | null => browserStorage("session");

export function readDockSnapshot(
  storage: () => DockStorage | null,
  accountId: string | null,
): DockSnapshot | null {
  if (!accountId) return null;
  return (
    browserRecord<DockSnapshot>(
      storage,
      { key: DOCK_STORAGE_KEY, version: 1, accountId },
      (input) => {
        if (!isRecord(input)) return undefined;
        if (!isRecord(input.byScreen)) return undefined;
        const byScreen: DockSnapshot["byScreen"] = {};
        for (const [screen, view] of Object.entries(input.byScreen)) {
          if (!Object.hasOwn(DOCK_VIEW_SETS, screen)) return undefined;
          const key = screen as ScreenKey;
          if (!DOCK_VIEW_SETS[key].views.some((supported) => supported === view)) return undefined;
          byScreen[key] = view as DockView;
        }
        const occupant = input.occupant as Record<string, unknown> | null;
        if (occupant === null) return { accountId, byScreen, occupant: null };
        if (
          !occupant ||
          typeof occupant.projectId !== "string" ||
          !occupant.projectId ||
          typeof occupant.screen !== "string" ||
          !Object.hasOwn(DOCK_VIEW_SETS, occupant.screen) ||
          occupant.screen === "context"
        )
          return undefined;
        const tab = parseContextTab(occupant.tab);
        return tab
          ? { accountId, byScreen, occupant: { ...occupant, tab } as DockDocument }
          : undefined;
      },
    ).read() ?? null
  );
}

export function writeDockSnapshot(storage: () => DockStorage | null, snapshot: DockSnapshot): void {
  browserRecord<Omit<DockSnapshot, "accountId">>(
    storage,
    { key: DOCK_STORAGE_KEY, version: 1, accountId: snapshot.accountId },
    () => undefined,
  ).write({
    byScreen: snapshot.byScreen,
    occupant: snapshot.occupant
      ? { ...snapshot.occupant, tab: durableContextTab(snapshot.occupant.tab) }
      : null,
  });
}
