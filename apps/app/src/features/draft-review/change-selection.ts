/**
 * change-selection — the changes one Apply or Discard acts on, built from what
 * a surface shows. A change is a selection of one class; the chat strip's
 * command is a selection of every actionable change of the chat. Pure data.
 */
import type { ChangeSelection } from "./review-command-types";
import type { ReviewChange } from "./review-changes";

/** The selection naming these changes' classes and every operation they hold. */
export function selectionOf(
  changes: readonly Pick<ReviewChange, "classId" | "operationIds" | "keys" | "operations">[],
): ChangeSelection {
  return {
    admissionTokens: changes.flatMap((change) =>
      change.operations.slice(0, 1).map((op) => op.admissionToken),
    ),
    classIds: changes.map((change) => change.classId),
    operationIds: changes.flatMap((change) => change.operationIds),
    keys: changes.flatMap((change) => change.keys),
  };
}

/** The selection covers every change displayed: nothing is left to review once it lands. */
export function coversEveryChange(
  selection: ChangeSelection,
  displayed: readonly Pick<ReviewChange, "classId">[],
): boolean {
  return displayed.every((change) => selection.classIds.includes(change.classId));
}
