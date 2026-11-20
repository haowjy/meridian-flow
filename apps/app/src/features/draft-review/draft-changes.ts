/** Shared change presentation data and failures. Open and listed bindings add their own command authority; only the open review adds focus and stepping. */

import { useSyncExternalStore } from "react";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { ReviewChange } from "./review-model";

type ReviewChangeItem = {
  change: ReviewChange;
};

/** Presentation data can be shared without focus or command authority. */
export type DraftChangesData = {
  documentId: string | null;
  itemKey: string | null;
  /** `gone`: the item left the list while on screen. */
  status: "idle" | "loading" | "ready" | "gone";
  items: readonly ReviewChangeItem[];
};

export type DraftChangesView = DraftChangesData & {
  /** Focus belongs only to the open review interaction binding. */
  focused: ReviewChange | null;
  /** Every Apply and Discard disables on this. */
  locked: boolean;
  canApply?: boolean;
  apply: (change: ReviewChange) => Promise<void>;
  discard: (change: ReviewChange) => Promise<void>;
};

/** A ready new document is the file itself, not a header followed by a second named row. */
export function isWholeDocumentChange(view: Pick<DraftChangesData, "status" | "items">): boolean {
  return view.status === "ready" && view.items.length === 1 && view.items[0]?.change.whole === true;
}

/** Subscribe to this item's record, not another draft's command activity. */
export function useDraftCommandState(itemKey: string) {
  const owner = useDraftCommandOwner();
  const snapshot = () => owner.state(itemKey);
  return useSyncExternalStore(owner.subscribe, snapshot, snapshot);
}
