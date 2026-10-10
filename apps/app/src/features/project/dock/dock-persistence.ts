/** Browser-tab-local dock layout; storage failures never block a writer's action. */
import { durableContextTab, parseContextTab } from "@/client/stores";
import type { DockDocument } from "./dock-document-store";

export const DOCK_STORAGE_KEY = "meridian:dock:v1";
export type DockSnapshot = {
  accountId: string;
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
    if (value?.version !== 1 || value.accountId !== accountId) return null;
    const occupant = value.occupant;
    if (occupant === null) return { accountId, occupant: null };
    if (
      !occupant ||
      typeof occupant.projectId !== "string" ||
      !occupant.projectId ||
      typeof occupant.screen !== "string" ||
      (occupant.screen !== "chat" && occupant.screen !== "work")
    )
      return null;
    const review = occupant.review;
    if (
      review !== null &&
      (!review ||
        typeof review.workId !== "string" ||
        !review.workId ||
        typeof review.draftId !== "string" ||
        !review.draftId)
    )
      return null;
    const tab = parseContextTab(occupant.tab);
    return tab
      ? {
          accountId,
          occupant: { projectId: occupant.projectId, screen: occupant.screen, tab, review },
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
        occupant: snapshot.occupant
          ? { ...snapshot.occupant, tab: durableContextTab(snapshot.occupant.tab) }
          : null,
      }),
    );
  } catch {
    // Layout is optional; the in-memory dock remains usable.
  }
}
