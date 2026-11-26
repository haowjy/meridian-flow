import type { ReturnedWhy } from "@meridian/contracts/commands";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { isEmptyDocument } from "@meridian/prosemirror-schema";
import { type BlockSnapshot, computeEcho, truncateSerializedBlock } from "../apply/echo.js";
import { type CopySummary, copyEdgeLines } from "./copy-receipt.js";
import type { InternalWriteResult } from "./internal-result.js";
import { removalPhrase } from "./removal-copy.js";
import { type ApplySuccessResponseInput, formatApplySuccess } from "./response-format.js";
import type { DocumentCommandName } from "./types.js";

interface AcceptedEdit {
  commandName: DocumentCommandName;
  writeId: string;
  durableWriteId: string;
  touchedBlocks: readonly string[];
  deletedBlocks: readonly string[];
  copied?: CopySummary;
}
export function renderReceipt(
  edit: AcceptedEdit,
  before: readonly BlockSnapshot[],
  after: readonly BlockSnapshot[],
  outcome: Omit<ApplySuccessResponseInput, "echo" | "deletedBlocks" | "copied">,
): InternalWriteResult {
  const deletedIds = new Set(edit.deletedBlocks);
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
    deletedBlocks: before.filter((block) => deletedIds.has(block.key)).map((block) => block.hash),
    ...(isEmptyDocument(after.map((block) => block.node)) ? { documentEmpty: true } : {}),
    ...(edit.copied
      ? { copied: { summary: edit.copied, edges: copyEdgeLines(edit.copied, after) } }
      : {}),
  });
}

/**
 * An edit that did not land because what it named changed, as the model reads it: nothing was
 * kept anywhere, and the text it was planned against is no longer what stands. The host adds
 * the document as it now stands after the message; none of this asks for a retry.
 */
export function returnedWriteResult(
  why: ReturnedWhy,
  detail: { removal?: DocumentRemovalRecord | null; work?: string; thisChat?: string } = {},
): InternalWriteResult {
  const work = detail.work ? `Work ${detail.work}` : "The Work";
  const message = (() => {
    switch (why) {
      case "document_removed":
        return `Not in the document: this file was ${removalPhrase(detail.removal, detail.thisChat)} and is in the trash, so this edit was not kept anywhere. It can be restored.`;
      case "work_archived":
        return `Not in the document: ${work} is archived, so its drafts take no new text and this edit was not kept anywhere.`;
      case "work_deleted":
        return `Not in the document: ${work} is deleted, so its drafts take no new text and this edit was not kept anywhere.`;
      case "block_gone":
        return "Not in the document: the block this edit named is gone (the writer deleted, merged or moved it), so it was not kept anywhere.";
    }
  })();
  return {
    status: "returned",
    model: {
      message,
      returned: { why, ...(detail.removal ? { removal: detail.removal } : {}) },
    },
  };
}
