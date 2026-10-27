/**
 * A Move as a notice follows it: "Moved chapter-3 to Act 2." with the rows the server refused
 * since taken out of the claim, and Undo while something is still where the move put it. The
 * replica can show a move just after it resolves, so Undo retires only once it has applied and
 * then stops applying.
 */
import { plural, t } from "@lingui/core/macro";
import { type MoveResult, undoMove } from "./execute-move";
import { entryNameNow, intentSettlement, type MoveEffect, planUndo } from "./move-plan";
import type { Failure, NoticeView, Operation } from "./operation-notice";

type MoveState = {
  /** What the move did, kept current as the server refuses rows. */
  result: MoveResult;
  destinationName: string;
  /** The moves the server has not settled yet; refusals are looked for only here. */
  unsettled: readonly MoveEffect[];
  /** The replica has shown the move; until then a missing row means "not yet", not "gone". */
  applied: boolean;
  /** Something is still where the move put it. */
  undoable: boolean;
};

export function moveOperation(result: MoveResult, destinationName: string): Operation {
  return operation({
    result,
    destinationName,
    unsettled: result.moved.filter((effect) => effect.operationId),
    applied: false,
    undoable: result.moved.length > 0,
  });
}

function operation(state: MoveState): Operation {
  const self: Operation = {
    rows: state.result.moved.map((effect) => effect.entry),
    message: describeMove(state.result, state.destinationName),
    undoable: state.undoable,
    settlement(view) {
      const next = settle(view, state);
      return next === state ? self : next && operation(next);
    },
    async undo(context) {
      const back = await undoMove(state.result.moved, context);
      return {
        failed: back.failed,
        followed: back.moved.flatMap((effect) =>
          effect.operationId
            ? [
                {
                  entry: effect.entry,
                  operationId: effect.operationId,
                  ifRefused: wentBack(effect),
                },
              ]
            : [],
        ),
      };
    },
    describeUndoFailure,
  };
  return self;
}

/**
 * The state after the replica's latest answers, or null once nothing is left to say. A row the
 * server refused went back to its source with its failure mark, so the notice stops claiming it
 * moved; "Couldn't move X." says what the writer did to X, so it goes once X is renamed or deleted.
 */
function settle(view: NoticeView, state: MoveState): MoveState | null {
  let next = state;
  const stale = next.result.failed.filter((item) => entryNameNow(view, item.entry) !== item.name);
  if (stale.length > 0) {
    const failed = next.result.failed.filter((item) => !stale.includes(item));
    if (failed.length === 0 && next.result.moved.length === 0) return null;
    next = { ...next, result: { ...next.result, failed } };
  }
  const { refused, pending } = intentSettlement(view, next.unsettled);
  if (refused.length > 0) {
    const gone = new Set(refused);
    const moved = next.result.moved.filter((effect) => !gone.has(effect));
    return {
      ...next,
      result: { moved, failed: [...next.result.failed, ...refused.map(wentBack)] },
      unsettled: pending,
      undoable: next.undoable && moved.length > 0,
    };
  }
  if (pending.length < next.unsettled.length) next = { ...next, unsettled: pending };
  if (!next.undoable) return next;
  const live = planUndo(view, next.result.moved).length > 0;
  if (live === next.applied) return next;
  return live ? { ...next, applied: true } : { ...next, undoable: false };
}

/** A refused row went back where it came from, under its name there. */
function wentBack(effect: MoveEffect): MoveResult["failed"][number] {
  return { entry: effect.entry, name: effect.previousName, action: effect.action };
}

/**
 * "Moved 3 items to Act 2." and, when the replica refused some, which. A lone
 * row that arrived under the next free name says so.
 */
function describeMove(result: MoveResult, destinationName: string): string {
  const { moved, failed } = result;
  const parts: string[] = [];
  const [first] = moved;
  if (moved.length === 1 && first?.action === "reorder") parts.push(t`Reordered ${first.name}.`);
  else if (moved.length > 1 && moved.every((effect) => effect.action === "reorder"))
    parts.push(
      plural(moved.length, {
        one: "Reordered # item.",
        other: "Reordered # items.",
      }),
    );
  else if (moved.length === 1 && first && first.previousName !== first.name)
    parts.push(t`Moved ${first.previousName} to ${destinationName} as ${first.name}.`);
  else if (moved.length === 1 && first) parts.push(t`Moved ${first.name} to ${destinationName}.`);
  else if (moved.length > 1)
    parts.push(
      plural(moved.length, {
        one: `Moved # item to ${destinationName}.`,
        other: `Moved # items to ${destinationName}.`,
      }),
    );
  const [lost] = failed;
  if (failed.length === 1 && lost?.action === "reorder")
    parts.push(t`Couldn't reorder ${lost.name}.`);
  else if (failed.length === 1 && lost) parts.push(t`Couldn't move ${lost.name}.`);
  else if (failed.length > 1)
    parts.push(
      plural(failed.length, { one: "Couldn't move # item.", other: "Couldn't move # items." }),
    );
  return parts.join(" ");
}

function describeUndoFailure(failed: readonly Failure[]): string {
  const [lost] = failed;
  if (failed.length === 0 || !lost) return t`Couldn't move it back.`;
  if (failed.length === 1 && lost.action === "reorder")
    return t`Couldn't restore ${lost.name}'s position.`;
  if (failed.length === 1) return t`Couldn't move ${lost.name} back.`;
  return plural(failed.length, {
    one: "Couldn't move # item back.",
    other: "Couldn't move # items back.",
  });
}
