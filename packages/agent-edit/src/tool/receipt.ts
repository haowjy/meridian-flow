// Receipts project accepted evidence. Reporting failure never changes acceptance.

import { type BlockSnapshot, computeEcho, truncateSerializedBlock } from "../apply/echo.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import type { StagedWriteRejectionReason } from "../ports/document-coordinator.js";
import type { CommandLinks } from "./command-links.js";
import { type CopySummary, copyEdgeLines } from "./copy-receipt.js";
import type { InternalWriteResult } from "./internal-result.js";
import { modelResult, type WriteRejection } from "./model-result.js";
import type { DestructiveSweepReport } from "./mutation-commit.js";
import { type ApplySuccessResponseInput, formatApplySuccess } from "./response-format.js";
import type { DocumentCommandName, ResponseCommitDocumentResult } from "./types.js";

interface ReceiptIdentity {
  commandName: DocumentCommandName;
  writeId: string;
  durableWriteId: string;
  rejectionReason?: StagedWriteRejectionReason;
}
interface AcceptedEdit extends ReceiptIdentity {
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
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
  const echo = computeEcho({
    before,
    after,
    agentTouchedHashes: edit.touchedHashes,
    agentDeletedHashes: edit.deletedHashes,
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
    deletedBlocks: [...edit.deletedHashes],
    ...(after.length <= 1 && after.every((block) => !block.body.trim())
      ? { documentEmpty: true }
      : {}),
    ...(edit.copied
      ? { copied: { summary: edit.copied, edges: copyEdgeLines(edit.copied, after) } }
      : {}),
  });
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
    ...rejected.map((edit) =>
      settledReceipt(edit, null, {
        status: "invalid_write",
        model: {
          message: `Write did not land: ${rejectedWriteExplanation(edit.rejectionReason)}. Re-read and retry.`,
          rejected: writeRejection(edit.rejectionReason),
        },
      }),
    ),
  ];
}

function degradedReceipts(accepted: readonly ReceiptIdentity[], revision: string | null) {
  return accepted.map((edit) =>
    settledReceipt(
      edit,
      revision,
      formatApplySuccess({
        phase: "committed",
        writeId: edit.writeId,
        echo: [],
        awarenessDegraded: true,
      }),
    ),
  );
}

/** A refusal explains host evidence, not a guess from item visibility. */
function writeRejection(reason?: StagedWriteRejectionReason): WriteRejection {
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
