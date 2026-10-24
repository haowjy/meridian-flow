/**
 * A branch placement's tree writes in one source (contract §6.2, §12.5; D26): creates, and a
 * draft-mode chat's moves and deletes, which are facts on the branch's row. The port a branch
 * placement holds and a live placement never has. Postgres implements it over the tree view;
 * the in-memory composition has no branches and never builds a branch placement.
 */

import type { BranchId, DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts";
import type { RetractionCause } from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { BranchTreeChange, BranchTreeFault } from "../tree/branch-tree-changes.js";
import type {
  BinaryNode,
  BranchCreateResult,
  CreateFault,
  TrackedNode,
} from "../tree/hidden-node-types.js";

/** The drafting Work's active branch, locked by the command transaction that ensured it. */
export type EnsuredBranch = { id: BranchId; workId: WorkId };

/** A drafted move or delete as it changed the branch's row, for the caller's record (D76). */
export type RecordedBranchTreeChange = BranchTreeChange & { branchId: BranchId };

/** The chat whose call made a branch's change, recorded on its row. */
export type BranchChangeAuthor = { threadId: ThreadId; turnId?: TurnId };

export interface BranchTreePort {
  /** A hidden row (or, for text, another branch's, joined) and the branch's `created` row. */
  createInBranch(input: {
    branch: EnsuredBranch;
    dir: readonly string[];
    name: string;
    extension: string;
    node: TrackedNode | BinaryNode;
    /** The chat that made the create (§3.3), recorded on the change row; absent for a writer's. */
    createdBy?: BranchChangeAuthor;
  }): Promise<Result<BranchCreateResult, CreateFault>>;
  /** Reverse the branch's create of a document, unless another contribution makes it stand. */
  retractCreate(input: {
    branch: EnsuredBranch;
    documentId: DocumentId;
    cause: RetractionCause;
  }): Promise<"retracted" | "stands">;
  /** The branch places a document it shows at `dir/name.extension` in this source. */
  moveInBranch(input: {
    branch: EnsuredBranch;
    documentId: DocumentId;
    dir: readonly string[];
    name: string;
    extension: string;
    changedBy: BranchChangeAuthor;
  }): Promise<Result<BranchTreeChange, BranchTreeFault>>;
  /** The branch deletes a document it shows in this source. */
  deleteInBranch(input: {
    branch: EnsuredBranch;
    documentId: DocumentId;
    changedBy: BranchChangeAuthor;
  }): Promise<Result<BranchTreeChange, Extract<BranchTreeFault, { code: "not_found" }>>>;
}
