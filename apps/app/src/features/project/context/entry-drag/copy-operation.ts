/**
 * A Copy as a notice follows it: "Copying chapter-3 to Vault…" while the server has not
 * answered, "Copied chapter-3 to Vault." once it has, with Undo throughout. A refused Copy closes
 * the notice; the refusal notice (`CopyRefusalNotice`) takes over from the journal.
 *
 * The notice takes the answer's entries into its own state when it first sees them, because the
 * operation's record retires a while after it settles; a record that has gone after the notice
 * saw it is a Copy that settled. Undo deletes the copies, so it needs every entry the Copy
 * created, not only the roots the device named.
 */

import { plural, t } from "@lingui/core/macro";
import { copyReceipt } from "@meridian/resource-replica";
import type { EntryRef } from "./entry";
import { type CopyEffect, undoCopy } from "./execute-copy";
import { entryNameNow } from "./move-plan";
import type { NoticeView, Operation } from "./operation-notice";

type CopyState = {
  operationId: string;
  destinationName: string;
  copies: readonly CopyEffect[];
  /** A projection has listed the operation; before that, a missing record means "not yet", not "retired". */
  seen: boolean;
  /** The server's answer is in. `entries` is every identity it created, or null when the record was gone before the notice saw them. */
  answered: { entries: readonly EntryRef[] | null } | null;
  /** Some copy is still listed. */
  undoable: boolean;
};

export function copyOperation(input: {
  operationId: string;
  destinationName: string;
  copies: readonly CopyEffect[];
}): Operation {
  return operation({ ...input, seen: false, answered: null, undoable: true });
}

function operation(state: CopyState): Operation {
  const self: Operation = {
    rows: state.copies.map((copy) => copy.entry),
    message: describeCopy(state),
    undoable: state.undoable,
    settlement(view) {
      const next = settle(view, state);
      return next === state ? self : next && operation(next);
    },
    async undo(context) {
      const back = await undoCopy(
        state.answered?.entries ?? state.copies.map((copy) => copy.entry),
        context,
      );
      return {
        failed: back.failed.map((item) => ({ ...item, action: "delete" })),
        followed: back.deleted.flatMap((item) =>
          item.operationId
            ? [
                {
                  entry: item.entry,
                  operationId: item.operationId,
                  ifRefused: { entry: item.entry, name: item.name, action: "delete" },
                },
              ]
            : [],
        ),
      };
    },
    describeUndoFailure(failed) {
      const [lost] = failed;
      if (failed.length === 1 && lost) return t`Couldn't remove ${lost.name}.`;
      return plural(failed.length, {
        one: "Couldn't remove # copy.",
        other: "Couldn't remove # copies.",
      });
    },
  };
  return self;
}

/** The state after the journal's latest word, or null when the Copy was refused. */
function settle(view: NoticeView, state: CopyState): CopyState | null {
  if (!view.operations) return state;
  const record = view.operations.find((candidate) => candidate.operationId === state.operationId);
  const intent = record?.intents.find((candidate) => candidate.desired.kind === "copy");
  let next = state;
  if (record) {
    if (!intent) return state;
    switch (intent.state) {
      case "pending":
      case "submitted":
      case "received":
        if (!next.seen) next = { ...next, seen: true };
        break;
      case "settled":
        if (!next.answered)
          next = {
            ...next,
            seen: true,
            answered: {
              entries: copyReceipt(intent)?.entries.map(({ kind, id }) => ({ kind, id })) ?? null,
            },
          };
        break;
      default:
        return null;
    }
  } else if (next.seen && !next.answered) next = { ...next, answered: { entries: null } };
  if (next.seen && next.undoable) {
    const listed = next.copies.some((copy) => entryNameNow(view, copy.entry) !== null);
    if (!listed) next = { ...next, undoable: false };
  }
  return next;
}

function describeCopy({ copies, destinationName, answered }: CopyState): string {
  const [only] = copies;
  if (copies.length === 1 && only) {
    const { sourceName, name } = only;
    if (!answered) return t`Copying ${sourceName} to ${destinationName}…`;
    return sourceName === name
      ? t`Copied ${sourceName} to ${destinationName}.`
      : t`Copied ${sourceName} to ${destinationName} as ${name}.`;
  }
  return answered
    ? plural(copies.length, {
        one: `Copied # item to ${destinationName}.`,
        other: `Copied # items to ${destinationName}.`,
      })
    : plural(copies.length, {
        one: `Copying # item to ${destinationName}…`,
        other: `Copying # items to ${destinationName}…`,
      });
}
