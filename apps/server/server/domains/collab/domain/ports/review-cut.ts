/** Immutable inputs shared by review preview and selective disposition. */
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "../branch-coordinator.js";
import type { BranchJournalRow } from "../branch-push-contracts.js";
import type { HolderLinkScope } from "./document-link-scope.js";

export type ReviewAddress = {
  projectId?: ProjectId;
  documentId: DocumentId;
  workId: WorkId;
  draftId: string;
};

export type ReviewCut = Readonly<{
  branch: Readonly<BranchSnapshot>;
  history: readonly Readonly<BranchJournalRow>[];
  live: Readonly<{ state: Uint8Array; revision: string }>;
  membership: Readonly<{ live: readonly string[]; draft: readonly string[] }>;
  links: Readonly<{ live: HolderLinkScope; draft: HolderLinkScope }>;
  threadTitles: ReadonlyMap<string, string>;
}>;

/** Detached, privately owned bytes. Never provisions, repairs, or calls a room. */
export type ReadReviewCut = (address: ReviewAddress) => Promise<ReviewCut>;
