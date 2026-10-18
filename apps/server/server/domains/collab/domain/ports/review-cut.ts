/** Immutable inputs shared by review preview and selective disposition. */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { DraftReviewItem } from "../branch-review-items.js";
import type { DraftJournalRow } from "../draft-journal.js";
import type { DraftSnapshot } from "../draft-store.js";
import type { HolderLinkScope } from "./document-link-scope.js";

/** What a caller names; the cut resolves it through the identity module, inside its snapshot. */
export type ReviewAddress = {
  projectId?: ProjectId;
  workId: WorkId;
  itemKey: string;
};

/** The branch row with its content as the cut's snapshot read it through the read seam. */
export type ReviewCutDraft = Readonly<DraftSnapshot> & {
  /** Detached, privately owned bytes of checkpoint ⊕ tail at `revision`. */
  readonly state: Uint8Array;
};

export type ReviewCut = Readonly<{
  documentDraft: ReviewCutDraft;
  history: readonly Readonly<DraftJournalRow>[];
  live: Readonly<{ state: Uint8Array; revision: string }>;
  /** The tree-derived item, never null: an unlisted active branch has one (M1). */
  item: DraftReviewItem;
  links: Readonly<{ live: HolderLinkScope; draft: HolderLinkScope }>;
  threadTitles: ReadonlyMap<string, string>;
}>;

/** Detached, privately owned bytes. Never provisions, repairs, or calls a room. */
export type ReadReviewCut = (address: ReviewAddress) => Promise<ReviewCut>;
