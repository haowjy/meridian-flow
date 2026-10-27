/**
 * What a row drop across systems offers. A same-system drop moves at once; a
 * crossing one changes ownership, so the list holds the drop as a
 * `PendingChoice` and asks at the drop point: Move, Copy or Cancel. The hover
 * hint, the decision to ask and the menu all come from `dropChoices`, derived
 * from `resolveDrop` against the replica as it is when each asks, so a
 * destination renamed or removed while the menu was open is judged by
 * identity, not by what the drop saw. A new action is a new item here and a
 * branch in the list's `choose`; the menu's mechanics don't change.
 */
import { plural, t } from "@lingui/core/macro";
import type { NoticeSurface } from "../../shell/SurfaceNotice";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import type { DragEntry } from "./entry";
import {
  type CopyPlan,
  type MovePlan,
  type MoveView,
  planCopy,
  planMove,
  type ReadyCopy,
  type ReadyMove,
  type ResolvedDrop,
} from "./move-plan";

export type DropAction = "move" | "copy";

/** One choice in the menu, as data. A disabled item says why. */
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
  entries: readonly DragEntry[];
  target: TreeDropTarget;
  /** Where the pointer let go, in client coordinates; the menu hangs here. */
  point: { x: number; y: number };
  /** Where the chosen action's notice shows. */
  surface: NoticeSurface;
  /** Puts focus back in the list when the menu closes. */
  returnFocus: () => void;
};

/** The label a Move would carry on the hover hint and as a menu item. */
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

/** The hover hint for a drop that asks: an ellipsis says a choice follows the drop. */
export function askLabel(label: string): string {
  return t`${label}…`;
}

export const noLongerThere = () => t`Some of these items are no longer there`;
export const insideItself = () => t`Can't go inside itself`;

/** Why an action can't run, for a drop that was acceptable when it was made. */
function reason(
  action: DropAction,
  resolved: ResolvedDrop | null,
  plan: MovePlan | CopyPlan,
): string {
  if (!resolved) return t`That place is no longer available`;
  if (resolved.unavailable.length > 0) return noLongerThere();
  if (plan.kind === "inside-itself") return insideItself();
  if (action === "move") return resolved.canMove ? t`Already there` : t`Can't move these from here`;
  return t`Can't copy these`;
}

/**
 * The menu for a pending drop and what each enabled item would do, both read
 * from the replica now.
 */
export function dropChoices(
  view: MoveView,
  resolved: ResolvedDrop | null,
  target: TreeDropTarget,
): { items: readonly DropChoiceItem[]; plans: { move?: ReadyMove; copy?: ReadyCopy } } {
  const move = planMove(view, resolved);
  const copy = planCopy(view, resolved);
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
    items: [moveItem, copyItem],
    plans: {
      ...(move.kind === "ready" ? { move } : {}),
      ...(copy.kind === "ready" ? { copy } : {}),
    },
  };
}

/** The warning before a drop or pick whose rows would arrive renamed; null when none would. */
export function describeRenames(renamed: readonly { name: string; as: string }[]): string | null {
  const [only] = renamed;
  if (!only) return null;
  if (renamed.length === 1) return t`${only.name} will be renamed ${only.as}`;
  return plural(renamed.length, {
    one: "# item will be renamed",
    other: "# items will be renamed",
  });
}
