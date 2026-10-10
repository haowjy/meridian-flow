/** Builds whole-content candidate batches with optional manifest membership companions. */
import { randomUUID } from "node:crypto";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type { BranchJournalRow, CandidateBatch } from "./branch-push-contracts.js";
import { manifestMembershipRowDocumentId } from "./manifest-membership-journal.js";

type CandidateSource = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
};

export function buildWholeBranchCandidates(input: {
  sources: readonly CandidateSource[];
  resetPolicy?: "auto";
  pushedByUserId?: UserId;
}): CandidateBatch {
  return {
    candidates: input.sources.map((source) => ({
      branchId: source.branch.branchId,
      documentId: source.branch.documentId,
      rows: source.rows,
      kind: "content" as const,
    })),
    receiptId: randomUUID(),
    ...(input.resetPolicy ? { resetPolicy: input.resetPolicy } : {}),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}

export function buildCompanionCandidates(input: {
  content: CandidateSource;
  manifest: CandidateSource;
  manifestEntryDocumentId: DocumentId;
  pushedByUserId?: UserId;
  resetPolicy?: "auto";
}): CandidateBatch {
  const manifestRows = input.manifest.rows.filter(
    (row) => manifestMembershipRowDocumentId(row) === input.manifestEntryDocumentId,
  );
  return {
    candidates: [
      {
        branchId: input.content.branch.branchId,
        documentId: input.content.branch.documentId,
        rows: input.content.rows,
        kind: "content",
      },
      ...(manifestRows.length > 0
        ? [
            {
              branchId: input.manifest.branch.branchId,
              documentId: input.manifest.branch.documentId,
              rows: manifestRows,
              kind: "manifest" as const,
            },
          ]
        : []),
    ],
    receiptId: randomUUID(),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
    ...(input.resetPolicy ? { resetPolicy: input.resetPolicy } : {}),
  };
}
