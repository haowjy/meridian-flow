/** Builds whole-content candidate batches. */
import { randomUUID } from "node:crypto";
import type { UserId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
  BranchJournalRow,
  CandidateBatch,
  PublicationPayloads,
} from "./branch-push-contracts.js";

type CandidateSource = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
};

export function buildWholeBranchCandidates(input: {
  sources: readonly CandidateSource[];
  payloads?: PublicationPayloads;
  resetPolicy?: "auto";
  pushedByUserId?: UserId;
}): CandidateBatch {
  return {
    ...(input.payloads ? { payloads: input.payloads } : {}),
    candidates: input.sources.map((source) => ({
      branchId: source.branch.branchId,
      documentId: source.branch.documentId,
      rows: source.rows,
    })),
    receiptId: randomUUID(),
    ...(input.resetPolicy ? { resetPolicy: input.resetPolicy } : {}),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}
