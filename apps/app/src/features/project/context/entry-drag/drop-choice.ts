/**
 * The choice a row drop across systems asks for. A same-system drop moves at
 * once; a crossing one changes ownership, so the list holds the drop as a
 * `PendingChoice` and asks at the drop point. What the menu offers is data
 * (`DropChoiceItem`), derived from `resolveDrop` against the replica as it is
 * when the menu draws and again when the writer picks, so a destination renamed
 * or removed while the menu was open is judged by identity, not by what the drop
 * saw. Copy joins by adding an action here; the menu's mechanics don't change.
 */
import { t } from "@lingui/core/macro";
import type { NoticeSurface } from "../../shell/SurfaceNotice";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import type { DragEntry } from "./entry";
import {
  type MovePlan,
  type MoveView,
  planMove,
  type ResolvedDrop,
  resolveDrop,
} from "./move-plan";

export type DropAction = "move";

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

export type ReadyMove = Extract<MovePlan, { kind: "ready" }>;

/** The label a Move would carry on the hover hint and as a menu item. */
export function moveLabel({ destinationName, beside }: ReadyMove): string {
  const sibling = beside?.name ?? "";
  if (!beside) return t`Move to ${destinationName}`;
  return beside.kind === "before" ? t`Move before ${sibling}` : t`Move after ${sibling}`;
}

/** Why a Move can't run, for a drop that was acceptable when it was made. */
function moveReason(resolved: ResolvedDrop | null, plan: MovePlan): string {
  if (!resolved) return t`That place is no longer available`;
  if (resolved.unavailable.length > 0) return t`Some of these items are no longer there`;
  if (plan.kind === "inside-itself") return t`Can't go inside itself`;
  return t`Already there`;
}

/**
 * The menu for a pending drop and what each enabled item would do, both read
 * from the replica now.
 */
export function dropChoices(
  view: MoveView,
  { entries, target }: Pick<PendingChoice, "entries" | "target">,
): { items: readonly DropChoiceItem[]; plans: { move?: ReadyMove } } {
  const resolved = resolveDrop(view, entries, target);
  const move = planMove(view, resolved);
  if (move.kind === "ready")
    return {
      items: [{ action: "move", label: moveLabel(move), enabled: true }],
      plans: { move },
    };
  const destinationName =
    resolved?.destinationName ?? target.folder?.name ?? schemeLabel(target.scheme);
  return {
    items: [
      {
        action: "move",
        label: t`Move to ${destinationName}`,
        enabled: false,
        reason: moveReason(resolved, move),
      },
    ],
    plans: {},
  };
}
