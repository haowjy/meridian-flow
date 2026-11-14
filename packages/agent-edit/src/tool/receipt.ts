// Receipts project accepted evidence. Reporting failure never changes acceptance.

import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { type BlockSnapshot, computeEcho, truncateSerializedBlock } from "../apply/echo.js";
import type { BlockItemId } from "../model/block-hash.js";
import type { WriteRefusalReason } from "../ports/document-coordinator.js";
import { type CopySummary, copyEdgeLines } from "./copy-receipt.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { WriteRejection } from "./model-result.js";
import { removalPhrase, removedWriteMessage } from "./removal-copy.js";
import { type ApplySuccessResponseInput, formatApplySuccess } from "./response-format.js";
import type { DocumentCommandName } from "./types.js";

interface AcceptedEdit {
  commandName: DocumentCommandName;
  writeId: string;
  durableWriteId: string;
  touchedBlocks: readonly BlockItemId[];
  deletedBlocks: readonly BlockItemId[];
  copied?: CopySummary;
}
/** Pure rendering over the owner's accepted cuts; no documents or admission operations. */
export function renderReceipt(
  edit: AcceptedEdit,
  before: readonly BlockSnapshot[],
  after: readonly BlockSnapshot[],
  outcome: Omit<ApplySuccessResponseInput, "echo" | "deletedBlocks" | "copied">,
): InternalWriteResult {
  const deletedIds = new Set(edit.deletedBlocks.map((id) => `${id.clientID}:${id.clock}`));
  const echo = computeEcho({
    before,
    after,
    agentTouchedBlocks: edit.touchedBlocks,
    agentDeletedBlocks: edit.deletedBlocks,
  });
  return formatApplySuccess({
    ...outcome,
    echo:
      echo.length || edit.commandName !== "create"
        ? echo
        : [
            {
              mode: "truncated",
              blocks: after.map((block) => truncateSerializedBlock(block.serialized)),
            },
          ],
    deletedBlocks: before
      .filter((block) => deletedIds.has(`${block.clientID}:${block.clock}`))
      .map((block) => block.hash),
    ...(after.length <= 1 && after.every((block) => !block.body.trim())
      ? { documentEmpty: true }
      : {}),
    ...(edit.copied
      ? { copied: { summary: edit.copied, edges: copyEdgeLines(edit.copied, after) } }
      : {}),
  });
}

/** A write the host refused, as the model reads it. A removal names who removed the file and asks for no retry. */
export function rejectedWriteResult(reason?: WriteRefusalReason): InternalWriteResult {
  if (typeof reason === "object")
    return { status: "invalid_write", model: removedWriteRefusal(reason.removed) };
  return {
    status: "invalid_write",
    model: {
      message: `Write did not land: ${rejectedWriteExplanation(reason)}. Re-read and retry.`,
      rejected: writeRejection(reason),
    },
  };
}

/**
 * A write the document's removal stopped. Null: no record (the file went with its source or
 * Work, or stands again).
 */
export function removedWriteRefusal(removal: DocumentRemovalRecord | null): {
  message: string;
  rejected: "removed";
  removal?: DocumentRemovalRecord;
} {
  return {
    message: removedWriteMessage(removal),
    rejected: "removed",
    ...(removal ? { removal } : {}),
  };
}

/** A refusal explains host evidence, not a guess from item visibility. */
function writeRejection(reason?: Exclude<WriteRefusalReason, object>): WriteRejection {
  switch (reason) {
    case "discard":
      return "discarded_edit";
    case "discarded_draft":
    case "discarded_document":
    case "discarded_edit":
    case "inverse":
      return reason;
    default:
      return "integration";
  }
}

export function rejectedWriteExplanation(reason?: WriteRefusalReason): string {
  if (typeof reason === "object") return `this file was ${removalPhrase(reason.removed)}`;
  switch (reason) {
    case "discard":
      return "the user discarded the text it edited";
    case "discarded_draft":
      return "the user discarded this draft";
    case "discarded_document":
      return "the user discarded this new document";
    case "discarded_edit":
      return "the user discarded the text it edited";
    case "inverse":
      return "an inverse removed the text it edited";
    default:
      return "the write could not integrate with the current draft";
  }
}
