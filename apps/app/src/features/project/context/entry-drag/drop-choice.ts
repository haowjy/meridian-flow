/**
 * What a drop that asks offers. A list row dropped within one list moves at
 * once. One dropped on another list (the project's files and Your files are
 * two) can only be copied, and any other source names a document without being
 * a row to reposition, so the list holds the drop as a `PendingChoice` and asks
 * at the drop point: Move, Copy or Cancel, or Copy and Cancel between lists. The hover
 * hint, the decision to ask and the menu all come from `dropChoices`, derived
 * from `resolveDrop` against the trees as they are when each asks, so a
 * destination renamed or removed while the menu was open is judged by
 * identity, not by what the drop saw. A new action is a new item here and a
 * branch in the list's `choose`; the menu's mechanics don't change.
 */
import { t } from "@lingui/core/macro";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import type { EntryDrag } from "./entry";
import {
  type CopyPlan,
  type MovePlan,
  planCopy,
  planMove,
  type ReadyCopy,
  type ReadyMove,
  type ResolvedDrop,
} from "./move-plan";

export type DropAction = "move" | "copy";

export type DropChoiceItem = {
  action: DropAction;
  label: string;
  enabled: boolean;
  reason?: string;
};

/**
 * A drop waiting for its choice. Captured at the drop, before `dragend` clears
 * the drag session, so it holds identities and the target, not the drag's data.
 */
export type PendingChoice = {
  drag: EntryDrag;
  target: TreeDropTarget;
  point: { x: number; y: number };
  returnFocus: () => void;
};

export function moveLabel({ destinationName, beside }: ReadyMove): string {
  const sibling = beside?.name ?? "";
  if (!beside) return t`Move to ${destinationName}`;
  return beside.kind === "before" ? t`Move before ${sibling}` : t`Move after ${sibling}`;
}

export function copyLabel({ destinationName, beside }: ReadyCopy): string {
  const sibling = beside?.name ?? "";
  if (!beside) return t`Copy to ${destinationName}`;
  return beside.kind === "before" ? t`Copy before ${sibling}` : t`Copy after ${sibling}`;
}

export function askLabel(label: string): string {
  return t`${label}…`;
}

export const noLongerThere = () => t`Some of these items are no longer there`;
export const insideItself = () => t`Can't go inside itself`;

function reason(
  action: DropAction,
  resolved: ResolvedDrop | null,
  plan: MovePlan | CopyPlan,
): string {
  if (!resolved) return t`That place is no longer available`;
  if (resolved.unavailable.length > 0) return noLongerThere();
  if (plan.kind === "inside-itself") return insideItself();
  if (action === "move") {
    return resolved.canMove ? t`Already there` : t`Can't move these from here`;
  }
  return t`Can't copy these`;
}

export function dropChoices(
  resolved: ResolvedDrop | null,
  target: TreeDropTarget,
): { items: readonly DropChoiceItem[]; plans: { move?: ReadyMove; copy?: ReadyCopy } } {
  const move = planMove(resolved);
  const copy = planCopy(resolved);
  const destinationName =
    resolved?.destinationName ?? target.folder?.name ?? schemeLabel(target.scheme);
  const moveItem: DropChoiceItem =
    move.kind === "ready"
      ? { action: "move", label: moveLabel(move), enabled: true }
      : {
          action: "move",
          label: t`Move to ${destinationName}`,
          enabled: false,
          reason: reason("move", resolved, move),
        };
  const copyItem: DropChoiceItem =
    copy.kind === "ready"
      ? { action: "copy", label: copyLabel(copy), enabled: true }
      : {
          action: "copy",
          label: t`Copy to ${destinationName}`,
          enabled: false,
          reason: reason("copy", resolved, copy),
        };
  return {
    items: target.scheme === "user" || resolved?.crossesLists ? [copyItem] : [moveItem, copyItem],
    plans: {
      ...(move.kind === "ready" ? { move } : {}),
      ...(copy.kind === "ready" ? { copy } : {}),
    },
  };
}
