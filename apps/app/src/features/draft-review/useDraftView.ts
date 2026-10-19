/** Listed rows retain their room even without an editor and share its projection with open review. */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import type { DraftChangesView } from "./draft-changes";
import { useChangeItems } from "./draft-changes";
import type { DraftRef } from "./review-command-types";
import { itemChange, targetOfChanges } from "./review-model";
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
  const withoutText = item?.hasDraft === false;
  const read = useRoomReview(enabled && !withoutText ? draft : null);
  const status = !enabled ? "idle" : withoutText ? "ready" : read.status;
  const changes = item?.wholeItem && enabled ? [itemChange(item)] : read.changes;
  const { items } = useChangeItems(draft, changes);
  return {
    documentId: draft.documentId,
    itemKey: draft.itemKey,
    status,
    items,

    retry: read.retry,
    focused: null,
    canApply: withoutText ? item?.isNew === true : (read.frame?.groups.length ?? 0) > 0,
    locked: controller.changesLocked || status !== "ready",
    apply: async (change) => {
      await controller.commandChange("apply", draft, targetOfChanges([change]));
    },
    discard: async (change) => {
      await controller.commandChange("discard", draft, targetOfChanges([change]));
    },
  };
}
