/** Bind a listed draft's domain view to its caller's Work authority, projecting its room without mounting an editor. */

import { useMemo } from "react";
import type { DraftRef } from "@/client/query/draft-command-record";
import { discardSubjectOf, type ReviewFileTarget } from "@/client/query/work-draft-files";
import { isSameChange } from "@/core/editor/extensions/inline-review";
import { type DraftChangesView, type ReviewChangeItem, useChangeItems } from "./draft-changes";
import { baseKeyOf } from "./review-frame";
import { itemChange, type ReviewChange } from "./review-model";
import type { MembershipRead } from "./review-runtime";
import { prepareFromFrame } from "./useDraftApply";
import type { HeadlessDiscards } from "./useHeadlessDiscards";
import { useRoomReview } from "./useReviewRuntime";
import type { WorkDraftCommands } from "./useWorkDraftCommands";

const NO_ITEMS: readonly ReviewChangeItem[] = [];

/**
 * A listed draft's changes, read from the draft's review state: the same frames the manuscript paints when
 * the draft is open, otherwise its room's while `enabled` (the row is expanded). Every row carries the frame
 * it was drawn from. Apply sends that frame's snapshot; Discard edits the draft's room headlessly, finding
 * the change the row drew again by its pin, and the row reads "Discarded" with Undo (`discards`). A new
 * document is one change: Apply applies it whole and Discard closes it (item Discard).
 */
export function useDraftView(
  draft: DraftRef,
  {
    controller,
    enabled = true,
    file,
    discards,
  }: {
    controller: Pick<
      WorkDraftCommands,
      "applyChanges" | "applyDraft" | "discardDraft" | "changesLocked"
    >;
    enabled?: boolean;
    file: ReviewFileTarget;
    discards: HeadlessDiscards;
  },
): DraftChangesView & { membership: MembershipRead } {
  const room = useRoomReview(draft, { enabled });
  const wholeDocument = room.wholeItem;
  const read = useChangeItems(draft, { wholeDocument, read: enabled && !room.branchless });
  const { completing } = read;
  // A branchless item (an image, an empty create) has no text: its one change is the item, by file name.
  const items = useMemo(
    () => (room.branchless ? [{ change: itemChange(file.draft), failure: null }] : read.items),
    [room.branchless, file.draft, read.items],
  );
  // A shared runtime can be ready before this reader holds the room: no row is drawn without its capability.
  const ready = room.branchless ? room.status === "ready" : read.ready && room.status === "ready";
  const discarded = useMemo(
    () =>
      discards.entries.filter((entry) => entry.subject.itemKey === draft.itemKey && entry.change),
    [discards.entries, draft.itemKey],
  );
  const membership: MembershipRead =
    room.status === "error"
      ? { status: "failed", retry: room.retry }
      : !ready
        ? { status: "loading" }
        : wholeDocument
          ? { status: "ready" }
          : read.membership;
  const ref = { documentId: draft.documentId, itemKey: draft.itemKey };
  const send = async (change: ReviewChange) => {
    const { frame } = change;
    // A whole item, or a change with no frame (branchless), is applied as the item.
    if (wholeDocument || !frame) {
      await controller.applyDraft(ref, frame ? prepareFromFrame(draft, frame) : undefined).outcome;
      return;
    }
    await controller.applyChanges(
      ref,
      [{ id: change.id, pin: change.pin }],
      baseKeyOf(frame),
      prepareFromFrame(draft, frame),
    );
  };
  return {
    documentId: draft.documentId,
    itemKey: draft.itemKey,
    status: membership.status === "failed" ? "error" : room.status,
    membership,
    items: ready ? items : NO_ITEMS,
    wholeDocument,
    finished:
      membership.status === "ready" &&
      items.length === 0 &&
      completing === null &&
      discarded.length === 0,
    completing,
    ...(membership.status === "failed" ? { retry: membership.retry } : {}),
    focused: null,
    locked: controller.changesLocked,
    apply: send,
    discard: async (change) => {
      if (wholeDocument) {
        await controller.discardDraft(ref).outcome;
        return;
      }
      // A row is drawn only from a ready room, so the edit is made now, not after a fetch.
      if (room.status !== "ready" || room.roomName === null)
        throw new Error("A change row is drawn only from a ready room");
      discards.discardChange(
        discardSubjectOf(file),
        change,
        items.findIndex((item) => isSameChange(change, item.change.id, item.change.pin)),
        room.roomName,
      );
    },
    discarded,
    undoDiscard: discards.undo,
  };
}
