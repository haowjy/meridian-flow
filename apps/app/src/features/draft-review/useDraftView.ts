/** Listed text rows retain their room without an editor; document-only rows need no room. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { DraftChangesView } from "./draft-changes";
import { useChangeItems } from "./draft-changes";
import type { DraftRef } from "./review-command-types";
import { listedItemChanges, targetOfChanges } from "./review-model";
import { hasTreeLine, treeChange, treeLineOf } from "./tree-line";
import { useRoomReview } from "./useRoomReview";
import type { WorkBranchCommands } from "./useWorkBranchCommands";
export function useDraftView(
  draft: DraftRef,
  {
    controller,
    enabled = true,
    item,
  }: {
    controller: Pick<WorkBranchCommands, "commandChange" | "changesLocked">;
    enabled?: boolean;
    item?: ThreadDraftListItem;
  },
): DraftChangesView {
  const owner = useDraftCommandOwner();
  const discarding = Boolean(owner.state(draft.itemKey).discarding);
  // A delete's text projection is deliberately not part of review. Its tree
  // command can run without opening the room, just like any other tree-only row.
  const withoutText = item?.hasDraft === false || item?.tree?.deleted === true;
  const read = useRoomReview(enabled && !withoutText ? draft : null);
  const status = !enabled ? "idle" : withoutText ? "ready" : read.status;
  const deleteLine = item?.tree?.deleted && !item.isNew ? treeLineOf(item) : null;
  const changes =
    item && enabled
      ? deleteLine
        ? [treeChange(item, deleteLine)]
        : listedItemChanges(item, read.listedChanges)
      : read.listedChanges;
  const treeLine = !!item && hasTreeLine(item);
  const { items } = useChangeItems(draft, changes);
  return {
    documentId: draft.documentId,
    itemKey: draft.itemKey,
    status,
    items,

    retry: read.retry,
    focused: null,
    canApply:
      treeLine || (withoutText ? item?.isNew === true : (read.frame?.groups.length ?? 0) > 0),
    locked: controller.changesLocked || discarding || status !== "ready",
    apply: async (change) => {
      await controller.commandChange("apply", draft, targetOfChanges([change]));
    },
    discard: async (change) => {
      await controller.commandChange("discard", draft, targetOfChanges([change]));
    },
  };
}
