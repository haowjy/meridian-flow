/**
 * useReviewChanges — the open review's changes as the writer sees them: in
 * document order, with the one in focus, what failed on each, and the commands
 * that act on them. The header's stepper, the manuscript's bar and the dock's
 * list all read this, so they cannot disagree about which changes exist.
 *
 * Takes the controller explicitly. The review lives in the Editor's scope, and
 * the dock sits in the Chat's: a surface outside the Editor must pass the
 * Editor scope's controller, never the ambient one.
 *
 * A change the writer has applied or discarded is already gone from the
 * preview this reads (`useDraftPreview`), and a change that failed is back with
 * its reason.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  type ChangeCommandState,
  changeCommandState,
  useChangeCommandRecords,
} from "@/client/query/change-command-record";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import type { DraftCommandOutcome } from "@/features/chat/draft-review-session";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { type ReviewChange, reviewChanges } from "./review-changes";

export type ReviewChangeItem = {
  change: ReviewChange;
  failure: Extract<ChangeCommandState, { phase: "failed" }> | null;
};

export type ReviewChangesView = {
  /** The open review, if any. */
  documentId: string | null;
  draftId: string | null;
  status: "idle" | "loading" | "ready" | "gone";
  items: readonly ReviewChangeItem[];
  focused: ReviewChange | null;
  /** The focused change's place among `items`, or -1. */
  focusedIndex: number;
  /** A new document is applied whole: no per-change Apply. */
  canApply: boolean;
  /** Every Apply and Discard disables on this. */
  locked: boolean;
  /** Every change has been handled; the review is held open to say so. */
  cleared: boolean;
  focus: (change: ReviewChange, options?: { scroll?: boolean }) => void;
  step: (direction: 1 | -1) => void;
  apply: (change: ReviewChange) => Promise<void>;
  discard: (change: ReviewChange) => Promise<void>;
};

type ActivePreview = Extract<DraftPreviewResponse, { status: "active"; inlineModelPresent: true }>;

export function useReviewChanges(
  controller: DraftReviewController,
  options?: { enabled?: boolean },
): ReviewChangesView {
  // A warm editor that is not the one in review reads nothing.
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const documentId = inline?.documentId ?? null;
  const draftId = inline?.draftId ?? null;
  const { preview } = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    draftId,
    {
      enabled: inline !== null,
    },
  );
  const records = useChangeCommandRecords();

  const active: ActivePreview | null =
    preview?.status === "active" && preview.inlineModelPresent ? preview : null;
  const changes = useMemo(
    () => (active ? reviewChanges(active.operations, active.hunks) : []),
    [active],
  );
  const draftRef = useMemo(
    () =>
      documentId && draftId
        ? { projectId: controller.projectId, workId: controller.workId, documentId, draftId }
        : null,
    [controller.projectId, controller.workId, documentId, draftId],
  );
  const items = useMemo<ReviewChangeItem[]>(
    () =>
      changes.map((change) => {
        const state = draftRef ? changeCommandState(records, draftRef, change) : null;
        return { change, failure: state?.phase === "failed" ? state : null };
      }),
    [changes, records, draftRef],
  );

  // The focused change keeps its place when the server regroups it: a refused
  // Apply refetches, and the updated change shares operations with the old one.
  const focusedClassId = controller.focusedClassId;
  const lastFocused = useRef<{ classId: string; operationIds: ReadonlySet<string> } | null>(null);
  let focused = changes.find((change) => change.classId === focusedClassId) ?? null;
  if (!focused && focusedClassId && lastFocused.current?.classId === focusedClassId) {
    const known = lastFocused.current.operationIds;
    focused = changes.find((change) => change.operationIds.some((id) => known.has(id))) ?? null;
  }
  useEffect(() => {
    if (focused) {
      lastFocused.current = {
        classId: focusedClassId ?? focused.classId,
        operationIds: new Set(focused.operationIds),
      };
    }
  }, [focused, focusedClassId]);
  const focusedIndex = focused ? changes.indexOf(focused) : -1;

  const focus = useCallback(
    (change: ReviewChange, options?: { scroll?: boolean }) => {
      lastFocused.current = {
        classId: change.classId,
        operationIds: new Set(change.operationIds),
      };
      controller.focusReviewChange(change, options);
    },
    [controller.focusReviewChange],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      if (changes.length === 0) return;
      const from = focusedIndex;
      const to =
        from < 0
          ? direction > 0
            ? 0
            : changes.length - 1
          : (from + direction + changes.length) % changes.length;
      focus(changes[to], { scroll: true });
    },
    [changes, focus, focusedIndex],
  );

  /** After a command the writer lands on the next change in the manuscript, or the one before it. */
  const settleFocus = useCallback(
    (change: ReviewChange) => {
      if (focused && focused.classId !== change.classId) return;
      const at = changes.indexOf(change);
      const next = changes[at + 1] ?? changes[at - 1];
      if (next) focus(next, { scroll: true });
    },
    [changes, focus, focused],
  );

  const run = useCallback(
    async (
      change: ReviewChange,
      command: (change: ReviewChange) => Promise<DraftCommandOutcome>,
    ) => {
      settleFocus(change);
      const outcome = await command(change);
      // The change is back (or was updated): the writer returns to it, where its reason is shown.
      if (outcome.kind === "change-refused" && outcome.code !== "gone") {
        focus(change, { scroll: true });
      }
    },
    [focus, settleFocus],
  );
  const apply = useCallback(
    (change: ReviewChange) => run(change, controller.applyChange),
    [controller.applyChange, run],
  );
  const discard = useCallback(
    (change: ReviewChange) => run(change, controller.discardChange),
    [controller.discardChange, run],
  );

  return {
    documentId,
    draftId,
    status: !inline ? "idle" : active ? "ready" : preview?.status === "gone" ? "gone" : "loading",
    items,
    focused,
    focusedIndex,
    canApply: active?.isNewDocument !== true,
    locked: controller.dispositionLocked,
    cleared: inline?.cleared === true,
    focus,
    step,
    apply,
    discard,
  };
}
