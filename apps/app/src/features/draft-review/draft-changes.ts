/** Shared change presentation data and failures. Open and listed bindings add their own command authority; only the open review adds focus and stepping. */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useMemo } from "react";

import {
  type ChangeCommandState,
  changeCommandState,
  type DraftCommandFailure,
  draftCommandFailure,
  draftCommandKey,
  pendingDraftCommand,
  useChangeCommandRecords,
} from "@/client/query/draft-command-record";
import { selectionOf } from "./change-selection";
import type { ReviewChange } from "./review-changes";

export type ReviewChangeItem = {
  change: ReviewChange;
  draftFailure?: DraftCommandFailure | null;
  failure: Extract<ChangeCommandState, { phase: "failed" }> | null;
};

/** Presentation data can be shared without focus or command authority. */
export type DraftChangesData = {
  documentId: string | null;
  draftId: string | null;
  /** `error`: the draft's preview could not be read. Never read it as "no changes". */
  status: "idle" | "loading" | "error" | "ready" | "gone";
  items: readonly ReviewChangeItem[];
  /**
   * The draft is still open, but its read lists no change and no command of
   * ours is hiding one. This is not evidence of terminal settlement.
   * Apply draft and Discard draft are the way to finish it.
   */
  unlisted: boolean;
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
export function isWholeDocumentChange(
  view: Pick<DraftChangesData, "status" | "items" | "unlisted">,
): boolean {
  return (
    view.status === "ready" &&
    !view.unlisted &&
    view.items.length === 1 &&
    view.items[0]?.change.target.kind === "draft"
  );
}

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

export type ActivePreview = Extract<DraftPreviewResponse, { status: "active" }>;

/** The preview when it can be listed: active, with its inline model. */
export function listablePreview(preview: DraftPreviewResponse | null): ActivePreview | null {
  return preview?.status === "active" ? preview : null;
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
        return {
          change,
          failure: state?.phase === "failed" ? state : null,
          ...(change.target.kind === "draft" && draft
            ? { draftFailure: draftCommandFailure(records.drafts, draft) }
            : {}),
        };
      }),
    [changes, records, draft],
  );
  const hiding = draft
    ? Object.values(records.queued).some((entry) => entry.prefix === draftCommandKey(draft)) ||
      pendingDraftCommand(records.drafts, draft) !== null
    : false;
  return { items, hiding };
}
