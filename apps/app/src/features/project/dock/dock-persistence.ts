/** Browser-tab-local dock layout; storage failures never block a writer's action. */
import {
  browserRecord,
  browserStorage,
  isRecord,
  type RecordStorage,
} from "@/client/storage/browser-record";
import { durableContextTab, parseContextTab } from "@/client/stores";
import type { DockDocument } from "./dock-document-store";

export const DOCK_STORAGE_KEY = "meridian:dock:v1";
export type DockSnapshot = {
  accountId: string;
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
        const occupant = input.occupant;
        if (occupant === null) return { accountId, occupant: null };
        if (
          !isRecord(occupant) ||
          typeof occupant.projectId !== "string" ||
          !occupant.projectId ||
          (occupant.screen !== "chat" && occupant.screen !== "work") ||
          (occupant.screen === "work"
            ? typeof occupant.screenWorkId !== "string" || !occupant.screenWorkId
            : occupant.screenWorkId !== null)
        )
          return undefined;
        const review = occupant.review;
        if (
          review !== null &&
          (!isRecord(review) ||
            typeof review.workId !== "string" ||
            !review.workId ||
            typeof review.itemKey !== "string" ||
            !review.itemKey ||
            (review.changeId !== undefined &&
              (typeof review.changeId !== "string" || !review.changeId)))
        )
          return undefined;
        const tab = parseContextTab(occupant.tab);
        return tab
          ? {
              accountId,
              occupant: {
                projectId: occupant.projectId,
                screen: occupant.screen,
                screenWorkId: occupant.screenWorkId as string | null,
                tab,
                review:
                  review === null
                    ? null
                    : {
                        workId: review.workId as string,
                        itemKey: review.itemKey as string,
                        ...(typeof review.changeId === "string"
                          ? { changeId: review.changeId }
                          : {}),
                      },
              },
            }
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
    occupant: snapshot.occupant
      ? { ...snapshot.occupant, tab: durableContextTab(snapshot.occupant.tab) }
      : null,
  });
}
