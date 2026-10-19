// Receipts project accepted evidence. Reporting failure never changes acceptance.

import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { type BlockSnapshot, computeEcho, truncateSerializedBlock } from "../apply/echo.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import type { BlockItemId } from "../model/block-hash.js";
import type { StagedWriteRejectionReason } from "../ports/document-coordinator.js";
import type { CommandLinks } from "./command-links.js";
import type { DestructiveSweepReport } from "./commit-detection.js";
import { type CopySummary, copyEdgeLines } from "./copy-receipt.js";
import type { InternalWriteResult } from "./internal-result.js";
import { modelBlockItem, modelResult, type WriteRejection } from "./model-result.js";
import { removalPhrase, removedWriteMessage } from "./removal-copy.js";
import { type ApplySuccessResponseInput, formatApplySuccess } from "./response-format.js";
import type { DocumentCommandName, ResponseCommitDocumentResult } from "./types.js";

interface ReceiptIdentity {
  commandName: DocumentCommandName;
  writeId: string;
  durableWriteId: string;
  rejectionReason?: StagedWriteRejectionReason;
  refusedPassages?: readonly (readonly BlockItemId[])[];
}
interface AcceptedEdit extends ReceiptIdentity {
  touchedBlocks: readonly BlockItemId[];
  deletedBlocks: readonly BlockItemId[];
  copied?: CopySummary;
}
interface ReceiptCut {
  before: readonly (readonly BlockSnapshot[])[];
  after: readonly BlockSnapshot[];
  links: CommandLinks;
  lateSweep?: DestructiveSweepReport;
}

/** Also accepts future inverse outcomes without a lifecycle-specific rendering mode. */
export function settledReceipt(
  identity: ReceiptIdentity,
  revision: string | null,
  result: InternalWriteResult,
) {
  return {
    writeId: identity.writeId,
    settlementId: identity.durableWriteId,
    revision,
    result: modelResult({
      command: identity.commandName,
      ...(result.status === "success"
        ? { status: result.status, phase: result.phase }
        : { status: result.status }),
      ...(result.model ? { payload: result.model } : {}),
    }),
  };
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
  return withRefusedPassages(
    formatApplySuccess({
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
    }),
    edit.refusedPassages,
    after,
  );
}

export function renderSettledReceipts(
  accepted: readonly AcceptedEdit[],
  rejected: readonly ReceiptIdentity[],
  revision: string | null,
  capture: () => ReceiptCut | null,
): ResponseCommitDocumentResult["receipts"] {
  let receipts: ResponseCommitDocumentResult["receipts"];
  try {
    const cut = capture();
    receipts = cut
      ? accepted.map((edit, index) => {
          const result = renderReceipt(edit, cut.before[index], cut.after, {
            phase: "committed",
            writeId: edit.writeId,
            lateSweep: index === accepted.length - 1 ? cut.lateSweep : undefined,
          });
          return {
            ...settledReceipt(edit, revision, result),
            ...shownEvidence(renderedItems(result.model), cut.links),
          };
        })
      : degradedReceipts(accepted, revision);
  } catch {
    receipts = degradedReceipts(accepted, revision);
  }
  return [
    ...receipts,
    ...rejected.map((edit) => settledReceipt(edit, null, rejectedReceipt(edit))),
  ];
}

function degradedReceipts(accepted: readonly ReceiptIdentity[], revision: string | null) {
  return accepted.map((edit) =>
    settledReceipt(
      edit,
      revision,
      withRefusedPassages(
        formatApplySuccess({
          phase: "committed",
          writeId: edit.writeId,
          echo: [],
          awarenessDegraded: true,
        }),
        edit.refusedPassages,
      ),
    ),
  );
}

/**
 * A staged write the host refused, as its settled receipt says it. A removal names who removed
 * the file and asks for no retry.
 */
export function rejectedWriteResult(reason?: StagedWriteRejectionReason): InternalWriteResult {
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
 * A write the document's removal stopped before the reply saved it, whether the removal refused
 * the staged write or the save found the document gone. Null: no record (the file went with its
 * source or Work, or stands again).
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
function writeRejection(reason?: Exclude<StagedWriteRejectionReason, object>): WriteRejection {
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

export function rejectedWriteExplanation(reason?: StagedWriteRejectionReason): string {
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
      return "the staged write could not integrate with the current draft";
  }
}

/** Refused passages render only from the result's cut, never from staging-time text. */
export function withRefusedPassages(
  result: InternalWriteResult,
  passages: readonly (readonly BlockItemId[])[] | undefined,
  after?: readonly BlockSnapshot[],
): InternalWriteResult {
  if (!passages?.length) return result;
  const byId = new Map(after?.map((block, index) => [`${block.clientID}:${block.clock}`, index]));
  return {
    ...result,
    model: {
      ...result.model,
      blocks: [
        ...(result.model?.blocks ?? []),
        ...passages.map((passage) => {
          const indexes = passage.flatMap((id) => {
            const index = byId.get(`${id.clientID}:${id.clock}`);
            return index === undefined ? [] : [index];
          });
          // New paragraphs between surviving passage anchors belong to the saved passage too.
          const blocks = indexes.length
            ? (after?.slice(Math.min(...indexes), Math.max(...indexes) + 1) ?? [])
            : [];
          return {
            extent: "full" as const,
            relation: "not_reverted" as const,
            items: blocks.map((block) => modelBlockItem(block.serialized)),
          };
        }),
      ],
    },
  };
}

function rejectedReceipt(edit: ReceiptIdentity): InternalWriteResult {
  const result = rejectedWriteResult(edit.rejectionReason);
  if (!edit.refusedPassages?.length) return result;
  return {
    ...result,
    model: {
      ...result.model,
      message: [
        result.model?.message,
        ...edit.refusedPassages.map(
          () =>
            "Not reverted: this passage changed since you last saw it. Current text:\nCurrent text unavailable. Re-read this document.",
        ),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}
