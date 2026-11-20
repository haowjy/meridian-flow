/** A strip row's own changes: a move or delete is its tree line; text is pressed whole. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import type { WorkBranchCommands } from "@/features/suggestion-review/usePressCommands";
import type { DraftChangesView } from "./draft-changes";
import type { DraftRef } from "./review-command-types";
import { listedItemChanges, targetOfChanges } from "./review-model";
import { hasTreeLine, treeChange, treeLineOf } from "./tree-line";

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
  const deleteLine = item?.tree?.deleted && !item.isNew ? treeLineOf(item) : null;
  const changes =
    item && enabled
      ? deleteLine
        ? [treeChange(item, deleteLine)]
        : listedItemChanges(item, [])
      : [];
  return {
    documentId: draft.documentId,
    itemKey: draft.itemKey,
    status: enabled ? "ready" : "idle",
    items: changes.map((change) => ({ change })),
    focused: null,
    canApply: (!!item && hasTreeLine(item)) || item?.isNew === true,
    locked: controller.changesLocked || !enabled,
    apply: async (change) => {
      await controller.commandChange("apply", draft, targetOfChanges([change]));
    },
    discard: async (change) => {
      await controller.commandChange("discard", draft, targetOfChanges([change]));
    },
  };
}
