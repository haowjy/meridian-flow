/** Immutable inputs shared by review preview and selective disposition. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "../branch-coordinator.js";
import type { BranchJournalRow } from "../branch-push-contracts.js";
import type { DraftReviewItem } from "../draft-review-items.js";
import type { HolderLinkScope } from "./document-link-scope.js";

/** What a caller names; the cut resolves it through the identity module, inside its snapshot. */
export type ReviewAddress = {
  projectId?: ProjectId;
  workId: WorkId;
  itemKey: string;
};

export type ReviewCut = Readonly<{
  branch: Readonly<BranchSnapshot>;
  history: readonly Readonly<BranchJournalRow>[];
  live: Readonly<{ state: Uint8Array; revision: string }>;
  /** The tree-derived item, never null: an unlisted active branch has one (M1). */
  item: DraftReviewItem;
  links: Readonly<{ live: HolderLinkScope; draft: HolderLinkScope }>;
  threadTitles: ReadonlyMap<string, string>;
}>;

/** Detached, privately owned bytes. Never provisions, repairs, or calls a room. */
export type ReadReviewCut = (address: ReviewAddress) => Promise<ReviewCut>;
