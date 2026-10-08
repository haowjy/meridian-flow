/**
 * draft-changes — the model every change list renders from, whichever draft it
 * lists. `DraftChangesView` is what `DocumentChangeRows` needs: the status of
 * the draft's preview, its changes in document order with what failed on each,
 * and the commands that act on them. The open review's model
 * (`useReviewChanges`) adds focus, stepping and completion; any other draft's
 * (`useDraftChanges`) adds nothing. Both derive their items the same way here.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useMemo } from "react";

import {
  type ChangeCommandState,
  changeCommandState,
  hiddenOperationIds,
  useChangeCommandRecords,
} from "@/client/query/change-command-record";
import { selectionOf } from "./change-selection";
import type { ReviewChange } from "./review-changes";

export type ReviewChangeItem = {
  change: ReviewChange;
  failure: Extract<ChangeCommandState, { phase: "failed" }> | null;
};

export type DraftChangesView = {
  documentId: string | null;
  draftId: string | null;
  /** `error`: the draft's preview could not be read. Never read it as "no changes". */
  status: "idle" | "loading" | "error" | "ready" | "gone";
  items: readonly ReviewChangeItem[];
  /** The change the manuscript is focused on, when this draft is the open review; else null. */
  focused: ReviewChange | null;
  /** A new document is applied whole: no per-change Apply. */
  canApply: boolean;
  /** Every Apply and Discard disables on this. */
  locked: boolean;
  /**
   * The draft is still open, but its read lists no change and no command of
   * ours is hiding one: what remains (formatting) has no per-change view.
   * Apply draft and Discard draft are the way to finish it.
   */
  unlisted: boolean;
  /** Read the preview again; present when `status` is `error`. */
  retry?: () => void;
  apply: (change: ReviewChange) => Promise<void>;
  discard: (change: ReviewChange) => Promise<void>;
};

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

export type ActivePreview = Extract<
  DraftPreviewResponse,
  { status: "active"; inlineModelPresent: true }
>;

/** The preview when it can be listed: active, with its inline model. */
export function listablePreview(preview: DraftPreviewResponse | null): ActivePreview | null {
  return preview?.status === "active" && preview.inlineModelPresent ? preview : null;
}

/**
 * The changes with what failed on each (a change asks with its own class, so a
 * refusal of a larger selection shows on every change it overlaps), and
 * whether a command of ours is hiding changes from the read.
 */
export function useChangeItems(
  draft: DraftRef | null,
  changes: readonly ReviewChange[],
): { items: readonly ReviewChangeItem[]; hiding: boolean } {
  const records = useChangeCommandRecords();
  const items = useMemo<ReviewChangeItem[]>(
    () =>
      changes.map((change) => {
        const state = draft ? changeCommandState(records, draft, selectionOf([change])) : null;
        return { change, failure: state?.phase === "failed" ? state : null };
      }),
    [changes, records, draft],
  );
  const hiding = draft ? hiddenOperationIds(records, draft).size > 0 : false;
  return { items, hiding };
}
