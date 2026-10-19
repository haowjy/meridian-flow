/** Shared change presentation data and failures. Open and listed bindings add their own command authority; only the open review adds focus and stepping. */

import type { BranchCommandFailure, ChangeCommandState } from "./review-command-types";
import type { ReviewChange } from "./review-model";

export type ReviewChangeItem = {
  change: ReviewChange;
  draftFailure?: BranchCommandFailure | null;
  failure: Extract<ChangeCommandState, { phase: "failed" }> | null;
};

/** Presentation data can be shared without focus or command authority. */
export type DraftChangesData = {
  documentId: string | null;
  itemKey: string | null;
  /** `error`: the draft's preview could not be read. Never read it as "no changes". */
  status: "idle" | "loading" | "error" | "ready" | "gone";
  items: readonly ReviewChangeItem[];
  /** Read the preview again; present when `status` is `error`. */
  retry?: () => void;
};

export type DraftChangesView = DraftChangesData & {
  /** Focus belongs only to the open review interaction binding. */
  focused: ReviewChange | null;
  /** Every Apply and Discard disables on this. */
  locked: boolean;
  apply: (change: ReviewChange) => Promise<void>;
  discard: (change: ReviewChange) => Promise<void>;
};

/** A ready new document is the file itself, not a header followed by a second named row. */
export function isWholeDocumentChange(view: Pick<DraftChangesData, "status" | "items">): boolean {
  return view.status === "ready" && view.items.length === 1 && view.items[0]?.change.frame === null;
}

type DraftRef = { projectId: string; workId: string; documentId: string; itemKey: string };

/** B2b joins item failures here; text and group identity remain the runtime's. */
export function useChangeItems(
  _draft: DraftRef | null,
  changes: readonly ReviewChange[],
): { items: readonly ReviewChangeItem[] } {
  return { items: changes.map((change) => ({ change, failure: null })) };
}
